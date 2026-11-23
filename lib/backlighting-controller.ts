"use strict";

import {boundObservedAt, isOutOfOrder, parseObservedAt} from "./observation-time";
import {asTargetStatus, targetStateEvent, type TargetStateEvent} from "./target-state";

export type BacklightingPower = "on" | "off";

const POWERS: Record<BacklightingPower, true> = {on: true, off: true};

export interface BacklightingConfig {
  pollMs: number;
  confirmationTimeoutMs: number;
  maxAttempts: number;
}

export interface BacklightingDesired {
  requestId: string;
  generation: number;
  power: BacklightingPower;
  requestedAt: string;
}

export interface BacklightingObservation {
  power: BacklightingPower;
  observedAt: string;
}

export interface BacklightingPending {
  operation: "set_power" | "observe";
  attempt: number;
  deadlineAt: number;
  nextAt: number;
}

export interface BacklightingFailure {
  operation: "set_power" | "observe";
  reason: string;
  occurredAt: string;
}

export interface BacklightingState {
  desired: BacklightingDesired | null;
  generation: number;
  phase: string;
  observed: BacklightingObservation | null;
  pending: BacklightingPending | null;
  failure: BacklightingFailure | null;
  blockedGeneration: number | null;
  classification: "manual_override" | null;
  lastAttempt: number;
}

export type BacklightingEvent =
  | {
    kind: "intent";
    requestId: string;
    generation: number;
    power: BacklightingPower;
    requestedAt?: string;
  }
  | {
    kind: "observed";
    generation: number;
    power: BacklightingPower;
    observedAt: string;
  }
  | {kind: "command_result"; generation: number; ok: boolean; reason?: string}
  | {kind: "tick"; generation: number}
  | {kind: "startup" | "refresh"};

export interface BacklightingMessage {
  backlighting?: BacklightingEvent;
}

export interface BacklightingCommand {
  operation: "set_power" | "observe";
  requestId: string;
  generation: number;
  power: BacklightingPower;
  attempt: number;
}

export interface BacklightingOutputEvent {
  theatre: TargetStateEvent<"backlighting", {
    power: BacklightingPower;
    observedPower: BacklightingPower | null;
    recovery: Record<string, unknown>;
    metrics: {attempts: number; retries: number; fallbackUsed: boolean};
  }, BacklightingFailure>;
}

export function normaliseBacklightingConfig(config: Partial<BacklightingConfig> = {}): BacklightingConfig {
  return {
    pollMs: Math.max(250, Number(config.pollMs) || 2000),
    confirmationTimeoutMs: Math.max(1000, Number(config.confirmationTimeoutMs) || 15000),
    maxAttempts: Math.max(1, Math.floor(Number(config.maxAttempts) || 2))
  };
}

function initialState(saved: Partial<BacklightingState> = {}): BacklightingState {
  return {
    desired: saved.desired && typeof saved.desired === "object" ? {...saved.desired} : null,
    generation: Number.isInteger(saved.generation) && (saved.generation ?? -1) >= 0 ? saved.generation! : 0,
    phase: typeof saved.phase === "string" ? saved.phase : "idle",
    observed: saved.observed && typeof saved.observed === "object" ? {...saved.observed} : null,
    pending: saved.pending && typeof saved.pending === "object" ? {...saved.pending} : null,
    failure: saved.failure && typeof saved.failure === "object" ? {...saved.failure} : null,
    blockedGeneration: Number.isInteger(saved.blockedGeneration) ? saved.blockedGeneration! : null,
    classification: saved.classification === "manual_override" ? "manual_override" : null,
    lastAttempt: Number.isInteger(saved.lastAttempt) && (saved.lastAttempt ?? -1) >= 0
      ? saved.lastAttempt!
      : 0
  };
}

function commandFor(
  state: BacklightingState,
  operation: "set_power" | "observe",
  attempt: number
): BacklightingCommand {
  if (!state.desired) throw new Error("backlighting command requires desired state");
  return {
    operation,
    requestId: state.desired.requestId,
    generation: state.generation,
    power: state.desired.power,
    attempt
  };
}

function statusFor(state: BacklightingState) {
  return {
    phase: state.phase,
    text: `${state.desired?.power || "none"}: ${state.phase}`
  };
}

export function transitionBacklighting(
  saved: Partial<BacklightingState> | undefined,
  msg: BacklightingMessage,
  suppliedConfig: Partial<BacklightingConfig> = {},
  nowValue: Date | string | number = new Date()
) {
  const config = normaliseBacklightingConfig(suppliedConfig);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("now must be a valid date");

  const state = initialState(saved);
  const event = msg?.backlighting;
  const commands: BacklightingCommand[] = [];
  const events: BacklightingOutputEvent[] = [];
  const traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [];

  if (!event || typeof event.kind !== "string") throw new Error("msg.backlighting.kind is required");

  function trace(name: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) {
    traces.push({event: name, outcome, reason, details});
  }

  function fail(operation: "set_power" | "observe", reason: string) {
    state.pending = null;
    state.phase = "failed";
    state.blockedGeneration = state.generation;
    state.failure = {operation, reason, occurredAt: now.toISOString()};
    trace("backlighting", "failed", reason, {operation, power: state.desired?.power ?? null});
  }

  function issue(operation: "set_power" | "observe", attempt: number) {
    commands.push(commandFor(state, operation, attempt));
    state.pending = {
      operation,
      attempt,
      deadlineAt: nowMs + config.confirmationTimeoutMs,
      nextAt: nowMs + config.pollMs
    };
    state.phase = operation === "set_power" ? "transitioning" : "confirming";
    trace("command", "emitted", null, {operation, power: state.desired?.power, attempt});
    state.lastAttempt = Math.max(state.lastAttempt, attempt);
  }

  function acceptIntent(intent: Extract<BacklightingEvent, {kind: "intent"}>) {
    if (typeof intent.requestId !== "string" || !intent.requestId) {
      throw new Error("backlighting requestId is required");
    }
    if (!Number.isInteger(intent.generation) || intent.generation < 1) {
      throw new Error("backlighting generation must be a positive integer");
    }
    if (!Object.hasOwn(POWERS, intent.power)) throw new Error("unknown backlighting power");
    const requestedAt = intent.requestedAt || now.toISOString();
    if (!Number.isFinite(Date.parse(requestedAt))) throw new Error("backlighting requestedAt must be an ISO timestamp");
    if (intent.generation < state.generation) {
      trace("intent", "ignored", "stale-generation");
      return;
    }
    if (intent.generation === state.generation && state.desired) {
      const duplicate = state.desired.requestId === intent.requestId && state.desired.power === intent.power;
      trace("intent", duplicate ? "duplicate" : "rejected", duplicate ? null : "generation-conflict");
      return;
    }
    state.desired = {
      requestId: intent.requestId,
      generation: intent.generation,
      power: intent.power,
      requestedAt
    };
    state.generation = intent.generation;
    state.observed = null;
    state.pending = null;
    state.failure = null;
    state.blockedGeneration = null;
    state.classification = null;
    state.lastAttempt = 0;
    issue("set_power", 1);
    trace("intent", "accepted", null, {power: intent.power, generation: intent.generation});
  }

  function acceptObservation(observation: Extract<BacklightingEvent, {kind: "observed"}>) {
    if (!Number.isInteger(observation.generation) || observation.generation < 1) {
      throw new Error("backlighting observation generation must be a positive integer");
    }
    if (!Object.hasOwn(POWERS, observation.power)) throw new Error("unknown observed backlighting power");
    const parsedAt = parseObservedAt(observation.observedAt);
    if (parsedAt === null || typeof observation.observedAt !== "string") {
      throw new Error("backlighting observedAt must be an ISO timestamp");
    }
    if (!state.desired || observation.generation !== state.generation) {
      trace("observation", "ignored", "stale-generation");
      return;
    }
    const bounded = boundObservedAt(observation.observedAt, parsedAt, nowMs);
    if (bounded.skewed) trace("observation", "adjusted", "clock-skew", {reported: observation.observedAt, usedAt: bounded.observedAt});
    if (bounded.ms < Date.parse(state.desired.requestedAt)) {
      trace("observation", "ignored", "stale-observation");
      return;
    }
    if (isOutOfOrder(bounded.ms, state.observed?.observedAt, nowMs)) {
      trace("observation", "ignored", "out-of-order");
      return;
    }
    const wasReady = state.phase === "ready" && !state.pending;
    state.observed = {power: observation.power, observedAt: bounded.observedAt};
    if (observation.power === state.desired.power) {
      state.pending = null;
      state.failure = null;
      state.blockedGeneration = null;
      state.classification = null;
      state.phase = "ready";
      trace("observation", "ready", null, {power: observation.power});
    } else if (wasReady) {
      state.pending = null;
      state.classification = "manual_override";
      state.phase = "manual_override";
      trace("observation", "manual_override", null, {
        expected: state.desired.power,
        observed: observation.power
      });
    } else if (state.classification === "manual_override") {
      state.pending = null;
      state.phase = "manual_override";
    } else {
      state.phase = "confirming";
      trace("observation", "accepted", "power-mismatch", {
        expected: state.desired.power,
        observed: observation.power
      });
    }
  }

  if (event.kind === "intent") {
    acceptIntent(event);
  } else if (event.kind === "observed") {
    acceptObservation(event);
  } else if (event.kind === "command_result") {
    if (!state.desired || event.generation !== state.generation || !state.pending) {
      trace("command-result", "ignored", "stale-generation");
    } else if (event.ok === true) {
      state.phase = "confirming";
      state.pending.nextAt = nowMs;
      trace("command-result", "accepted");
    } else if (state.pending.operation === "set_power" && state.pending.attempt < config.maxAttempts) {
      issue("set_power", state.pending.attempt + 1);
    } else {
      fail(state.pending.operation, typeof event.reason === "string" && event.reason ? event.reason : "command-failed");
    }
  } else if (event.kind === "tick") {
    if (!state.desired || event.generation !== state.generation || !state.pending) {
      trace("tick", "ignored", "stale-generation");
    } else if (nowMs >= state.pending.deadlineAt) {
      if (state.pending.operation === "set_power" && state.pending.attempt < config.maxAttempts) {
        issue("set_power", state.pending.attempt + 1);
      } else {
        fail(state.pending.operation, "confirmation-timeout");
      }
    } else if (nowMs >= state.pending.nextAt) {
      commands.push(commandFor(state, "observe", state.pending.attempt));
      state.pending.nextAt = nowMs + config.pollMs;
      state.phase = "confirming";
      trace("command", "emitted", null, {operation: "observe", power: state.desired.power});
    }
  } else if (event.kind === "startup" || event.kind === "refresh") {
    state.observed = null;
    state.pending = null;
    if (state.desired) {
      if (state.classification === "manual_override") {
        commands.push(commandFor(state, "observe", 0));
        state.pending = null;
        state.phase = "manual_override";
      } else {
        issue("observe", 0);
      }
      trace(event.kind, "observing", null, {power: state.desired.power});
    } else {
      trace(event.kind, "idle");
    }
  } else {
    throw new Error("unknown backlighting event kind");
  }

  if (state.desired) {
    const theatre = targetStateEvent({
      target: "backlighting",
      requestId: state.desired.requestId,
      generation: state.generation,
      status: state.phase === "manual_override" ? "transitioning" : asTargetStatus(state.phase, "confirming"),
      observedAt: now.toISOString(),
      details: {
        power: state.desired.power,
        observedPower: state.observed?.power ?? null,
        recovery: state.observed ? {power: state.observed.power} : {},
        metrics: {
          attempts: state.lastAttempt,
          retries: Math.max(0, state.lastAttempt - 1),
          fallbackUsed: false
        }
      },
      classification: state.classification,
      failure: state.failure
    });
    events.push({theatre});
  }

  return {state, commands, events, traces, status: statusFor(state)};
}
