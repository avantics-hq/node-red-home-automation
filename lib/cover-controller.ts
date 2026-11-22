"use strict";

// Positions inside the reducer always mean 0 = closed, 100 = open. With
// `invert`, device positions are converted on the way in (observations) and
// on the way out (set_position commands), so the adapter never needs to know.

export type CoverMotion = "opening" | "closing" | "stopped";
export type CoverOperation = "set_position" | "stop" | "observe";

const MOTIONS: Record<CoverMotion, true> = {opening: true, closing: true, stopped: true};

export interface CoverConfig {
  positionTolerance: number;
  invert: boolean;
  travelTimeoutMs: number;
  maxAttempts: number;
  pollMs: number;
  // Without motion reports, a cover counts as settled only when the same
  // position is reported at least this long apart.
  settleMs: number;
}

export interface CoverDesired {
  requestId: string;
  generation: number;
  operation: "set_position" | "stop";
  // For stop, null until the stopped position is confirmed.
  position: number | null;
  source: string | null;
  requestedAt: string;
}

export interface CoverObservation {
  position: number;
  motion: CoverMotion | null;
  observedAt: string;
}

export interface CoverPending {
  operation: CoverOperation;
  attempt: number;
  issuedAt: number;
  deadlineAt: number;
  nextAt: number;
  // Last fresh position seen since the command, and the observation time it
  // was first seen at, to detect a settled cover without motion reports.
  stablePosition: number | null;
  stableSince: number | null;
  // Observed position when the command was issued, if known.
  startPosition: number | null;
  // Fresh evidence that the cover moved since the command was issued.
  moved: boolean;
  // Restart re-observation of an already confirmed target.
  verifying: boolean;
}

export interface CoverFailure {
  operation: CoverOperation;
  reason: string;
  occurredAt: string;
}

export interface CoverState {
  desired: CoverDesired | null;
  generation: number;
  phase: string;
  observed: CoverObservation | null;
  pending: CoverPending | null;
  failure: CoverFailure | null;
  blockedGeneration: number | null;
  classification: "manual_override" | null;
  lastAttempt: number;
}

interface IntentBase {
  requestId: string;
  generation: number;
  source?: string;
  requestedAt?: string;
}

export type CoverEvent =
  | (IntentBase & {kind: "set_position"; position: number})
  | (IntentBase & {kind: "open" | "close" | "stop"})
  | {kind: "observed"; position: number; motion?: CoverMotion; observedAt: string}
  | {kind: "command_result"; generation: number; ok: boolean; reason?: string}
  | {kind: "tick"; generation: number}
  | {kind: "startup" | "refresh"};

export interface CoverMessage {
  cover?: CoverEvent;
}

export interface CoverCommand {
  operation: CoverOperation;
  requestId: string;
  generation: number;
  // Device-space target for set_position (inverted when configured).
  position?: number;
  attempt: number;
}

export interface CoverOutputEvent {
  theatre: {
    kind: "target_state";
    target: "cover";
    requestId: string;
    generation: number;
    status: string;
    observedAt: string;
    details: {
      operation: "set_position" | "stop";
      position: number | null;
      observedPosition: number | null;
      motion: CoverMotion | null;
      source: string | null;
      recovery: Record<string, unknown>;
      metrics: {attempts: number; retries: number; fallbackUsed: boolean};
    };
    classification?: "manual_override";
    failure?: CoverFailure;
  };
}

export function normaliseCoverConfig(config: Partial<CoverConfig> = {}): CoverConfig {
  const tolerance = Number(config.positionTolerance);
  const pollMs = Math.max(250, Number(config.pollMs) || 5000);
  return {
    positionTolerance: Number.isFinite(tolerance) && tolerance >= 0 ? Math.min(tolerance, 50) : 2,
    invert: config.invert === true,
    travelTimeoutMs: Math.max(1000, Number(config.travelTimeoutMs) || 90000),
    maxAttempts: Math.max(1, Math.floor(Number(config.maxAttempts) || 2)),
    pollMs,
    settleMs: Math.max(250, Number(config.settleMs) || pollMs)
  };
}

function initialState(saved: Partial<CoverState> = {}): CoverState {
  return {
    desired: saved.desired && typeof saved.desired === "object" ? {...saved.desired} : null,
    generation: Number.isInteger(saved.generation) && (saved.generation ?? -1) >= 0 ? saved.generation! : 0,
    phase: typeof saved.phase === "string" ? saved.phase : "idle",
    observed: saved.observed && typeof saved.observed === "object" ? {...saved.observed} : null,
    pending: saved.pending && typeof saved.pending === "object" ? {...saved.pending} : null,
    failure: saved.failure && typeof saved.failure === "object" ? {...saved.failure} : null,
    blockedGeneration: Number.isInteger(saved.blockedGeneration) ? saved.blockedGeneration! : null,
    classification: saved.classification === "manual_override" ? "manual_override" : null,
    lastAttempt: Number.isInteger(saved.lastAttempt) && (saved.lastAttempt ?? -1) >= 0 ? saved.lastAttempt! : 0
  };
}

function validPosition(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be a number from 0 to 100`);
  }
  return value;
}

function statusFor(state: CoverState) {
  const target = state.desired?.operation === "stop" && state.desired.position === null
    ? "stop"
    : state.desired?.position ?? "none";
  return {phase: state.phase, text: `${target}: ${state.phase}`};
}

export function transitionCover(
  saved: Partial<CoverState> | undefined,
  msg: CoverMessage,
  suppliedConfig: Partial<CoverConfig> = {},
  nowValue: Date | string | number = new Date()
) {
  const config = normaliseCoverConfig(suppliedConfig);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("now must be a valid date");

  const state = initialState(saved);
  const event = msg?.cover;
  const commands: CoverCommand[] = [];
  const events: CoverOutputEvent[] = [];
  const traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [];

  if (!event || typeof event.kind !== "string") throw new Error("msg.cover.kind is required");

  function trace(name: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) {
    traces.push({event: name, outcome, reason, details});
  }

  function emit(operation: CoverOperation, attempt: number) {
    if (!state.desired) throw new Error("cover command requires desired state");
    const command: CoverCommand = {
      operation,
      requestId: state.desired.requestId,
      generation: state.generation,
      attempt
    };
    if (operation === "set_position" && state.desired.position !== null) {
      command.position = config.invert ? 100 - state.desired.position : state.desired.position;
    }
    commands.push(command);
    trace("command", "emitted", null, {operation, position: command.position ?? null, attempt});
  }

  function issue(operation: CoverOperation, attempt: number, verifying = false) {
    emit(operation, attempt);
    state.pending = {
      operation,
      attempt,
      issuedAt: nowMs,
      deadlineAt: nowMs + config.travelTimeoutMs,
      nextAt: nowMs + config.pollMs,
      stablePosition: null,
      stableSince: null,
      startPosition: state.observed?.position ?? null,
      moved: false,
      verifying
    };
    state.phase = operation === "set_position" ? "moving" : operation === "stop" ? "stopping" : "confirming";
    if (operation !== "observe") state.lastAttempt = Math.max(state.lastAttempt, attempt);
  }

  function retryOrFail(reason: string) {
    const pending = state.pending!;
    if (pending.operation !== "observe" && pending.attempt < config.maxAttempts) {
      issue(pending.operation, pending.attempt + 1);
      return;
    }
    state.pending = null;
    state.phase = "failed";
    state.blockedGeneration = state.generation;
    state.failure = {operation: pending.operation, reason, occurredAt: now.toISOString()};
    trace("cover", "failed", reason, {operation: pending.operation, position: state.desired?.position ?? null});
  }

  function ready(position: number) {
    state.desired!.position = position;
    state.pending = null;
    state.failure = null;
    state.blockedGeneration = null;
    state.classification = null;
    state.phase = "ready";
    trace("observation", "ready", null, {position});
  }

  function acceptIntent(intent: Extract<CoverEvent, IntentBase>) {
    if (typeof intent.requestId !== "string" || !intent.requestId) throw new Error("cover requestId is required");
    if (!Number.isInteger(intent.generation) || intent.generation < 1) {
      throw new Error("cover generation must be a positive integer");
    }
    const position = intent.kind === "set_position"
      ? validPosition(intent.position, "cover position")
      : intent.kind === "open" ? 100 : intent.kind === "close" ? 0 : null;
    const requestedAt = intent.requestedAt || now.toISOString();
    if (!Number.isFinite(Date.parse(requestedAt))) throw new Error("cover requestedAt must be an ISO timestamp");
    if (intent.generation < state.generation) {
      trace("intent", "ignored", "stale-generation");
      return;
    }
    if (intent.generation === state.generation && state.desired) {
      const duplicate = state.desired.requestId === intent.requestId;
      trace("intent", duplicate ? "duplicate" : "rejected", duplicate ? null : "generation-conflict");
      return;
    }
    state.desired = {
      requestId: intent.requestId,
      generation: intent.generation,
      operation: position === null ? "stop" : "set_position",
      position,
      source: typeof intent.source === "string" && intent.source ? intent.source : null,
      requestedAt
    };
    state.generation = intent.generation;
    state.failure = null;
    state.blockedGeneration = null;
    state.classification = null;
    state.lastAttempt = 0;
    issue(state.desired.operation, 1);
    trace("intent", "accepted", null, {kind: intent.kind, position, generation: intent.generation});
  }

  function acceptObservation(observation: Extract<CoverEvent, {kind: "observed"}>) {
    const devicePosition = validPosition(observation.position, "observed cover position");
    if (observation.motion !== undefined && !Object.hasOwn(MOTIONS, observation.motion)) {
      throw new Error("unknown observed cover motion");
    }
    const observedAt = Date.parse(observation.observedAt || "");
    if (!Number.isFinite(observedAt)) throw new Error("cover observedAt must be an ISO timestamp");
    const previousAt = Date.parse(state.observed?.observedAt || "");
    if (Number.isFinite(previousAt) && observedAt < previousAt) {
      trace("observation", "ignored", "out-of-order");
      return;
    }
    const position = config.invert ? 100 - devicePosition : devicePosition;
    const motion = observation.motion ?? null;
    const previous = state.observed;
    state.observed = {position, motion, observedAt: observation.observedAt};
    if (!state.desired) return;

    const pending = state.pending;
    const moving = motion === "opening" || motion === "closing";
    if (pending) {
      if (observedAt < pending.issuedAt) {
        trace("observation", "ignored", "stale-observation");
        return;
      }
      const changed = pending.stablePosition !== null && pending.stablePosition !== position;
      if (pending.stablePosition !== position) {
        pending.stablePosition = position;
        pending.stableSince = observedAt;
      }
      // A duplicate report mid-travel is not a stop: without motion reports,
      // the same position must hold for settleMs.
      const settled = motion === "stopped"
        || (motion === null && observedAt - (pending.stableSince ?? observedAt) >= config.settleMs);
      if (pending.operation === "stop" || (pending.operation === "observe" && state.desired.position === null)) {
        if (settled) {
          ready(position);
        } else {
          trace("observation", "accepted", "still-moving", {position, motion});
        }
        return;
      }
      const target = state.desired.position!;
      const within = Math.abs(position - target) <= config.positionTolerance;
      if (moving || changed
        || (pending.startPosition !== null && Math.abs(position - pending.startPosition) > config.positionTolerance)) {
        pending.moved = true;
      }
      if (within && !moving) {
        ready(target);
      } else if (pending.verifying && !moving) {
        latchManual("moved-while-offline", target, position);
      } else if (settled && pending.operation === "observe") {
        // Restart mid-travel and the cover has stopped off target: it answered,
        // so this is not a confirmation timeout.
        latchManual("stopped-while-offline", target, position);
      } else if (settled && pending.operation === "set_position" && pending.moved) {
        // Stopped short after moving: a person or an obstruction stopped it.
        // Never retry against that; a newer intent resumes automation.
        latchManual("stopped-short", target, position);
      } else {
        trace("observation", "accepted", "position-mismatch", {expected: target, observed: position, motion});
      }
      return;
    }

    if (state.desired.position === null) return;
    const within = Math.abs(position - state.desired.position) <= config.positionTolerance;
    if (state.phase === "ready" && !within) {
      latchManual(null, state.desired.position, position);
    } else if (state.phase === "manual_override" && within) {
      // Settled back at this generation's target (or a stopped-short latch that
      // was really still travelling): nothing to own, so the cover is ready
      // again. A hand move passing through the target is not settled.
      const settled = motion === "stopped" || (motion === null && previous !== null
        && previous.position === position && observedAt - Date.parse(previous.observedAt) >= config.settleMs);
      if (settled) ready(state.desired.position);
    }
  }

  function latchManual(reason: string | null, expected: number, observed: number) {
    state.pending = null;
    state.classification = "manual_override";
    state.phase = "manual_override";
    trace("observation", "manual_override", reason, {expected, observed});
  }

  if (event.kind === "set_position" || event.kind === "open" || event.kind === "close" || event.kind === "stop") {
    acceptIntent(event);
  } else if (event.kind === "observed") {
    acceptObservation(event);
  } else if (event.kind === "command_result") {
    if (!state.desired || event.generation !== state.generation || !state.pending) {
      trace("command-result", "ignored", "stale-generation");
    } else if (event.ok === true) {
      state.pending.nextAt = nowMs;
      trace("command-result", "accepted");
    } else {
      retryOrFail(typeof event.reason === "string" && event.reason ? event.reason : "command-failed");
    }
  } else if (event.kind === "tick") {
    if (!state.desired || event.generation !== state.generation || !state.pending) {
      trace("tick", "ignored", "stale-generation");
    } else if (nowMs >= state.pending.deadlineAt) {
      retryOrFail(state.pending.operation === "observe" ? "confirmation-timeout" : "travel-timeout");
    } else if (nowMs >= state.pending.nextAt) {
      emit("observe", state.pending.attempt);
      state.pending.nextAt = nowMs + config.pollMs;
    }
  } else if (event.kind === "startup" || event.kind === "refresh") {
    state.observed = null;
    if (!state.desired) {
      state.pending = null;
      trace(event.kind, "idle");
    } else if (state.phase === "failed") {
      state.pending = null;
      trace(event.kind, "blocked", "failed");
    } else if (state.classification === "manual_override") {
      state.pending = null;
      emit("observe", 0);
      trace(event.kind, "observing", "manual_override");
    } else {
      const verifying = state.phase === "ready" && !state.pending;
      issue("observe", 0, verifying);
      trace(event.kind, "observing", null, {position: state.desired.position, verifying});
    }
  } else {
    throw new Error("unknown cover event kind");
  }

  if (state.desired) {
    const theatre: CoverOutputEvent["theatre"] = {
      kind: "target_state",
      target: "cover",
      requestId: state.desired.requestId,
      generation: state.generation,
      // Theatre target statuses: cover phases moving/stopping/manual_override
      // are all "transitioning" there.
      status: state.phase === "failed" || state.phase === "ready" || state.phase === "confirming"
        ? state.phase
        : "transitioning",
      observedAt: now.toISOString(),
      details: {
        operation: state.desired.operation,
        position: state.desired.position,
        observedPosition: state.observed?.position ?? null,
        motion: state.observed?.motion ?? null,
        source: state.desired.source,
        recovery: state.observed ? {position: state.observed.position} : {},
        metrics: {
          attempts: state.lastAttempt,
          retries: Math.max(0, state.lastAttempt - 1),
          fallbackUsed: false
        }
      }
    };
    if (state.classification) theatre.classification = state.classification;
    if (state.failure) theatre.failure = {...state.failure};
    events.push({theatre});
  }

  return {state, commands, events, traces, status: statusFor(state)};
}
