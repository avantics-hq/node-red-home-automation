"use strict";

import {numberSetting} from "./settings";

export type TheatreSloStatus = "learning" | "healthy" | "at_risk" | "breached";
export type TheatreSloOutcome = "ready" | "failed";

export interface TheatreSloConfig {
  windowSize: number;
  minimumSamples: number;
  latencyBudgetMs: number;
  successObjectivePct: number;
}

export interface TheatreSloSample {
  generation: number;
  activity: string;
  outcome: TheatreSloOutcome;
  transitionMs: number | null;
  completedAt: string;
}

export interface TheatreSloState {
  samples: TheatreSloSample[];
}

export interface TheatreSloSnapshot {
  generation: number;
  desiredActivity: string | null;
  phase: string;
  transitionStartedAt: string | null;
  transitionCompletedAt: string | null;
  metrics?: {lastTransitionMs?: number | null};
}

export interface TheatreSloAssessment {
  status: TheatreSloStatus;
  reason: string;
  sampleCount: number;
  windowSize: number;
  minimumSamples: number;
  latencyBudgetMs: number;
  successObjectivePct: number;
  successRatePct: number | null;
  p50TransitionMs: number | null;
  p95TransitionMs: number | null;
  lastActivity: string | null;
  lastOutcome: TheatreSloOutcome | null;
  lastTransitionMs: number | null;
  evaluatedAt: string;
}

function boundedInteger(value: unknown, label: string, fallback: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(numberSetting(value, label, fallback))));
}

export function normaliseTheatreSloConfig(
  config: Partial<TheatreSloConfig> = {}
): TheatreSloConfig {
  const windowSize = boundedInteger(config.windowSize, "SLO window", 20, 5, 100);
  return {
    windowSize,
    minimumSamples: boundedInteger(config.minimumSamples, "minimum samples", 5, 1, windowSize),
    latencyBudgetMs: boundedInteger(config.latencyBudgetMs, "latency budget", 60000, 1000, 3600000),
    successObjectivePct: boundedInteger(config.successObjectivePct, "success objective", 95, 50, 100)
  };
}

function duration(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function createState(saved: Partial<TheatreSloState> | undefined): TheatreSloState {
  const samples = Array.isArray(saved?.samples)
    ? saved.samples.flatMap((sample) => {
      if (!sample || typeof sample !== "object") return [];
      const generation = Number(sample.generation);
      const completedAt = timestamp(sample.completedAt);
      if (!Number.isInteger(generation) || generation < 0 || !completedAt ||
        typeof sample.activity !== "string" ||
        (sample.outcome !== "ready" && sample.outcome !== "failed")) return [];
      return [{
        generation,
        activity: sample.activity,
        outcome: sample.outcome,
        transitionMs: duration(sample.transitionMs),
        completedAt
      }];
    })
    : [];
  return {samples};
}

function percentile(values: number[], percentage: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * percentage) - 1);
  return sorted[index] ?? null;
}

function transitionDuration(snapshot: TheatreSloSnapshot): number | null {
  const metric = duration(snapshot.metrics?.lastTransitionMs);
  if (metric !== null) return metric;
  const startedAt = Date.parse(snapshot.transitionStartedAt || "");
  const completedAt = Date.parse(snapshot.transitionCompletedAt || "");
  return Number.isFinite(startedAt) && Number.isFinite(completedAt)
    ? Math.max(0, completedAt - startedAt)
    : null;
}

export function evaluateTheatreSlo(
  saved: Partial<TheatreSloState> | undefined,
  snapshot: TheatreSloSnapshot,
  suppliedConfig: Partial<TheatreSloConfig> = {},
  nowValue: Date | string | number = new Date()
): {state: TheatreSloState; assessment: TheatreSloAssessment} {
  const config = normaliseTheatreSloConfig(suppliedConfig);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("now must be a valid date");
  const state = createState(saved);

  if ((snapshot.phase === "ready" || snapshot.phase === "failed") && snapshot.desiredActivity) {
    const completedAt = timestamp(snapshot.transitionCompletedAt) || now.toISOString();
    const sample: TheatreSloSample = {
      generation: snapshot.generation,
      activity: snapshot.desiredActivity,
      outcome: snapshot.phase,
      transitionMs: transitionDuration(snapshot),
      completedAt
    };
    const existing = state.samples.findIndex(({generation}) => generation === snapshot.generation);
    if (existing >= 0) state.samples[existing] = sample;
    else state.samples.push(sample);
  }
  state.samples = state.samples
    .sort((left, right) => left.generation - right.generation)
    .slice(-config.windowSize);

  const readyDurations = state.samples.flatMap((sample) =>
    sample.outcome === "ready" && sample.transitionMs !== null ? [sample.transitionMs] : []);
  const readyCount = state.samples.filter(({outcome}) => outcome === "ready").length;
  const successRatePct = state.samples.length
    ? Math.round(readyCount * 1000 / state.samples.length) / 10
    : null;
  const p50TransitionMs = percentile(readyDurations, 0.5);
  const p95TransitionMs = percentile(readyDurations, 0.95);
  const last = state.samples.at(-1) || null;

  let status: TheatreSloStatus = "learning";
  let reason = "minimum_samples";
  const startedAt = Date.parse(snapshot.transitionStartedAt || "");
  const transitionAgeMs = Number.isFinite(startedAt) ? Math.max(0, nowMs - startedAt) : null;
  const timedPhase = ["requested", "preparing", "transitioning", "confirming", "recovering"]
    .includes(snapshot.phase);

  if (snapshot.phase === "failed") {
    status = "breached";
    reason = "transition_failed";
  } else if (timedPhase && transitionAgeMs !== null && transitionAgeMs > config.latencyBudgetMs) {
    status = "breached";
    reason = "transition_timeout";
  } else if (state.samples.length >= config.minimumSamples) {
    if (successRatePct !== null && successRatePct < config.successObjectivePct) {
      status = "breached";
      reason = "success_objective";
    } else if (p95TransitionMs !== null && p95TransitionMs > config.latencyBudgetMs) {
      status = "breached";
      reason = "latency_budget";
    } else if ((successRatePct !== null && successRatePct < 100) ||
      (p95TransitionMs !== null && p95TransitionMs >= config.latencyBudgetMs * 0.8)) {
      status = "at_risk";
      reason = successRatePct !== null && successRatePct < 100
        ? "error_budget_consumed"
        : "latency_headroom";
    } else {
      status = "healthy";
      reason = "objectives_met";
    }
  }

  return {
    state,
    assessment: {
      status,
      reason,
      sampleCount: state.samples.length,
      windowSize: config.windowSize,
      minimumSamples: config.minimumSamples,
      latencyBudgetMs: config.latencyBudgetMs,
      successObjectivePct: config.successObjectivePct,
      successRatePct,
      p50TransitionMs,
      p95TransitionMs,
      lastActivity: last?.activity || null,
      lastOutcome: last?.outcome || null,
      lastTransitionMs: last?.transitionMs ?? null,
      evaluatedAt: now.toISOString()
    }
  };
}
