"use strict";

// Recording the theatre's metrics. Each function updates the metrics record
// it is given, which belongs to the controller's state for this event.

import {TARGETS} from "./theatre-profiles";
import {count, type TargetState, type TheatreMetrics, type TheatreTargetMetrics} from "./theatre-state";

// An outcome; a finished transition's duration, when timed, as well.
export function recordOutcome(
  metrics: TheatreMetrics,
  outcome: "ready" | "failed" | "manual_override",
  transitionMs: number | null
): void {
  if (transitionMs !== null) {
    metrics.lastTransitionMs = transitionMs;
    metrics.maxTransitionMs = Math.max(metrics.maxTransitionMs || 0, transitionMs);
  }
  metrics.lastOutcome = outcome;
  if (outcome === "ready") metrics.ready += 1;
  if (outcome === "failed") metrics.failed += 1;
}

// Per-target figures that describe one transition start again at the next.
export function resetTransitionMetrics(metrics: TheatreMetrics): void {
  for (const target of TARGETS) {
    const metric = metrics.targets[target];
    metric.attempts = 0;
    metric.retries = 0;
    metric.fallbackUsed = false;
    metric.lastConfirmationMs = null;
    metric.observationAgeMs = null;
    metric.availability = "unknown";
  }
}

// A target's report: its attempts, fallback use, how old its observation is
// and, once ready, how long after the transition started it confirmed.
export function recordTargetReport(
  metric: TheatreTargetMetrics,
  report: TargetState,
  previous: TargetState | null,
  observedAt: number | null,
  transitionStartedAt: string | null,
  nowMs: number
): void {
  const details = report.details && typeof report.details === "object" ? report.details : {};
  const detailMetrics = details.metrics && typeof details.metrics === "object" &&
    !Array.isArray(details.metrics)
    ? details.metrics as Record<string, unknown>
    : {};
  const attempts = count(detailMetrics.attempts ?? details.attempt);
  metric.attempts = Math.max(metric.attempts, attempts);
  metric.retries = Math.max(metric.retries, Math.max(0, attempts - 1));
  const fallbackUsed = detailMetrics.fallbackUsed === true;
  if (fallbackUsed && !metric.fallbackUsed) metric.fallbackUses += 1;
  metric.fallbackUsed ||= fallbackUsed;
  metric.observationAgeMs = observedAt === null ? null : Math.max(0, nowMs - observedAt);
  if (report.status === "ready") {
    const startedAt = Date.parse(transitionStartedAt || "");
    metric.lastConfirmationMs = Number.isFinite(startedAt) && observedAt !== null
      ? Math.max(0, observedAt - startedAt)
      : null;
    metric.availability = "available";
  } else if (report.status === "failed" || report.status === "unavailable") {
    metric.availability = "unavailable";
    if (previous?.status !== report.status) metric.failures += 1;
  } else {
    metric.availability = "degraded";
  }
}
