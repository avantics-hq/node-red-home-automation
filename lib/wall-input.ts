"use strict";

export interface WallInputConfig {
  switchWindowMs: number;
  switchFreshnessMs: number;
}

export interface WallInputState {
  baselineKnown: boolean;
  value: boolean;
  observedAt: number | null;
  sessionObserved: boolean;
  available: boolean | null;
  rebaselineRequired: boolean;
  generation: number;
  edgeAt: number;
  timerDueAt: number | null;
}

export type WallInputInput =
  | {kind: "startup"}
  | {kind: "observation"; payload?: unknown; retain?: boolean; baseline?: boolean; observedAt?: unknown}
  | {kind: "availability"; payload?: unknown}
  | {kind: "timer"; generation?: number; edgeAt?: number};

export type WallInputEffect =
  | {kind: "cancel-switch-timer"}
  | {kind: "schedule-switch-timer"; delayMs: number; generation: number; switchAt: number};

export interface WallInputTrace {
  event: string;
  outcome: string;
  reason: string | null;
  details: Record<string, unknown>;
}

export interface WallInputStatus {
  phase: "awaiting-baseline" | "unavailable" | "stale" | "fresh";
  reason: "no-baseline" | "reported-unavailable" | "startup-unconfirmed" | "timestamp-unknown" | "expired" | null;
  baselineKnown: boolean;
  available: boolean | null;
  observedAt: number | null;
  ageMs: number | null;
}

export function createWallInputState(saved: Partial<WallInputState> = {}): WallInputState {
  return {
    baselineKnown: saved.baselineKnown === true,
    value: saved.value === true,
    observedAt: typeof saved.observedAt === "number" && Number.isFinite(saved.observedAt)
      ? saved.observedAt
      : null,
    sessionObserved: saved.sessionObserved === true,
    available: typeof saved.available === "boolean" ? saved.available : null,
    rebaselineRequired: saved.rebaselineRequired === true,
    generation: Number(saved.generation) || 0,
    edgeAt: Number(saved.edgeAt) || 0,
    timerDueAt: typeof saved.timerDueAt === "number" ? saved.timerDueAt : null
  };
}

function observationTimestamp(input: Extract<WallInputInput, {kind: "observation"}>, now: number): number | null {
  const payloadTimestamp = input.payload && typeof input.payload === "object"
    ? (input.payload as Record<string, unknown>).observedAt
    : undefined;
  const candidate = input.observedAt ?? payloadTimestamp;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
  if (typeof candidate === "string") {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return input.retain === true ? null : now;
}

function availability(value: unknown): boolean | null {
  if (value === true || value === "online" || value === "available" || value === "on") return true;
  if (value === false || value === "offline" || value === "unavailable" || value === "off") return false;
  return null;
}

export function wallInputStatus(
  saved: Partial<WallInputState> | undefined,
  freshnessMs: number,
  now = Date.now()
): WallInputStatus {
  const state = createWallInputState(saved);
  const ageMs = state.observedAt === null ? null : Math.max(0, now - state.observedAt);
  let phase: WallInputStatus["phase"];
  let reason: WallInputStatus["reason"];

  if (state.available === false) {
    phase = "unavailable";
    reason = "reported-unavailable";
  } else if (!state.baselineKnown) {
    phase = "awaiting-baseline";
    reason = "no-baseline";
  } else if (!state.sessionObserved) {
    phase = "stale";
    reason = "startup-unconfirmed";
  } else if (ageMs === null) {
    phase = "stale";
    reason = "timestamp-unknown";
  } else if (ageMs > freshnessMs) {
    phase = "stale";
    reason = "expired";
  } else {
    phase = "fresh";
    reason = null;
  }

  return {
    phase,
    reason,
    baselineKnown: state.baselineKnown,
    available: state.available,
    observedAt: state.observedAt,
    ageMs
  };
}

export function transitionWallInput(
  saved: Partial<WallInputState> | undefined,
  input: WallInputInput,
  config: WallInputConfig,
  now = Date.now()
) {
  const state = createWallInputState(saved);
  const effects: WallInputEffect[] = [];
  const traces: WallInputTrace[] = [];
  let gesture: "single" | "double" | null = null;

  function trace(event: string, outcome: string, reason: string | null, details: Record<string, unknown> = {}) {
    traces.push({event, outcome, reason, details});
  }

  function cancelTimer(reason: string | null) {
    const wasActive = Number(state.timerDueAt) > now;
    state.generation += 1;
    state.timerDueAt = null;
    effects.push({kind: "cancel-switch-timer"});
    if (wasActive && reason) trace("switch-timer", "cancelled", reason);
  }

  if (input.kind === "startup") {
    state.sessionObserved = false;
    state.available = null;
    state.edgeAt = 0;
    cancelTimer("startup");
    trace("switch-startup", state.baselineKnown ? "baseline-preserved" : "awaiting-baseline", null, {
      observedAt: state.observedAt
    });
  } else if (input.kind === "availability") {
    const nextAvailability = availability(input.payload);
    if (nextAvailability === null) {
      trace("switch-availability", "ignored", "invalid-availability");
    } else {
      const changed = state.available !== nextAvailability;
      state.available = nextAvailability;
      if (!nextAvailability) {
        state.baselineKnown = false;
        state.sessionObserved = false;
        state.rebaselineRequired = true;
        state.edgeAt = 0;
        cancelTimer("input-unavailable");
      }
      trace("switch-availability", changed ? "changed" : "unchanged", null, {available: nextAvailability});
    }
  } else if (input.kind === "observation") {
    const nextState = input.payload && typeof input.payload === "object"
      ? (input.payload as Record<string, unknown>).state
      : undefined;
    if (typeof nextState !== "boolean") {
      trace("switch", "ignored", "invalid-state");
    } else {
      const firstState = !state.baselineKnown;
      const changed = firstState || nextState !== state.value;
      const shouldBaseline = input.retain === true ||
        input.baseline === true ||
        state.rebaselineRequired;
      state.available = true;
      state.sessionObserved = true;
      state.observedAt = observationTimestamp(input, now);
      state.baselineKnown = true;
      state.rebaselineRequired = false;
      state.value = nextState;

      if (shouldBaseline) {
        if (state.timerDueAt !== null || state.edgeAt) {
          state.edgeAt = 0;
          cancelTimer(input.retain === true ? "retained-baseline" : "explicit-baseline");
        }
        trace("switch", "baseline", input.retain === true ? "retained-observation" : "explicit-observation", {
          changed,
          observedAt: state.observedAt
        });
      } else if (!changed) {
        trace("switch", "refreshed", "unchanged", {observedAt: state.observedAt});
      } else if (state.edgeAt && now - state.edgeAt <= config.switchWindowMs) {
        state.edgeAt = 0;
        cancelTimer("double-edge");
        gesture = "double";
        trace("switch", "gesture", null, {gesture});
      } else {
        cancelTimer("new-edge");
        state.edgeAt = now;
        state.timerDueAt = now + config.switchWindowMs;
        effects.push({
          kind: "schedule-switch-timer",
          delayMs: config.switchWindowMs,
          generation: state.generation,
          switchAt: now
        });
        trace("switch-timer", "scheduled", null, {dueAt: new Date(state.timerDueAt).toISOString()});
      }
    }
  } else {
    const current = input.generation === state.generation &&
      input.edgeAt === state.edgeAt &&
      state.timerDueAt !== null;
    if (!current) {
      trace("switch-timer", "ignored", "stale-generation", {generation: input.generation});
    } else {
      state.edgeAt = 0;
      state.timerDueAt = null;
      gesture = "single";
      trace("switch", "gesture", null, {gesture});
    }
  }

  return {
    state,
    effects,
    traces,
    gesture,
    status: wallInputStatus(state, config.switchFreshnessMs, now)
  };
}
