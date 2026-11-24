"use strict";

import {applyCoverAvailability} from "./cover-availability";
import type {TraceEntry} from "./bounded-trace";
import {boundObservedAt, isOutOfOrder, parseObservedAt} from "./observation-time";
import {booleanSetting, numberSetting} from "./settings";
import {targetStateEvent, type TargetStateEvent} from "./target-state";

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
  // Reported facts the cover never acts on, when the device reports them.
  battery?: number | null;
  charging?: string | null;
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
  // Whether the device says it is reachable, and the phase it was in when
  // it went offline, to pick up from when it is back.
  available: boolean;
  phaseBeforeUnavailable: string | null;
}

interface IntentBase {
  requestId: string;
  generation: number;
  source?: string;
  requestedAt?: string;
  // An automatic target (from a schedule or a computed position, say): it
  // waits while a person's move holds the cover, which only a request
  // without this overrides.
  respectManual?: boolean;
}

export type CoverEvent =
  | (IntentBase & {kind: "set_position"; position: number})
  | (IntentBase & {kind: "open" | "close" | "stop"})
  | {kind: "observed"; position: number; motion?: CoverMotion; observedAt: string; battery?: number; charging?: string}
  | {kind: "command_result"; generation: number; ok: boolean; reason?: string}
  | {kind: "availability"; online: boolean}
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
  theatre: TargetStateEvent<"cover", {
    operation: "set_position" | "stop";
    position: number | null;
    observedPosition: number | null;
    motion: CoverMotion | null;
    source: string | null;
    recovery: Record<string, unknown>;
    metrics: {attempts: number; retries: number; fallbackUsed: boolean};
  }, CoverFailure>;
}

export function normaliseCoverConfig(config: Partial<Record<keyof CoverConfig, unknown>> = {}): CoverConfig {
  const tolerance = numberSetting(config.positionTolerance, "position tolerance", 2);
  if (tolerance < 0) throw new Error("position tolerance must not be negative");
  const pollMs = Math.max(250, numberSetting(config.pollMs, "poll interval", 5000));
  return {
    positionTolerance: Math.min(tolerance, 50),
    invert: booleanSetting(config.invert, "invert", false),
    travelTimeoutMs: Math.max(1000, numberSetting(config.travelTimeoutMs, "travel timeout", 90000)),
    maxAttempts: Math.max(1, Math.floor(numberSetting(config.maxAttempts, "maximum attempts", 2))),
    pollMs,
    settleMs: Math.max(250, numberSetting(config.settleMs, "settle time", pollMs))
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
    lastAttempt: Number.isInteger(saved.lastAttempt) && (saved.lastAttempt ?? -1) >= 0 ? saved.lastAttempt! : 0,
    available: saved.available !== false,
    phaseBeforeUnavailable: typeof saved.phaseBeforeUnavailable === "string" ? saved.phaseBeforeUnavailable : null
  };
}

function validPosition(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be a number from 0 to 100`);
  }
  return value;
}

// Whether the cover is moving: as the device reports it, or, from a device
// without motion reports, while a move or stop it was sent is unconfirmed.
export function coverMoving(state: Pick<CoverState, "observed" | "phase">): boolean {
  const motion = state.observed?.motion ?? null;
  if (motion !== null) return motion !== "stopped";
  return state.phase === "moving" || state.phase === "stopping";
}

function statusFor(state: CoverState) {
  const target = state.desired?.operation === "stop" && state.desired.position === null
    ? "stop"
    : state.desired?.position ?? "none";
  return {phase: state.phase, text: `${target}: ${state.phase}`, moving: coverMoving(state)};
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
  const traces: TraceEntry[] = [];

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

  // A request not carried out: nothing is sent, the request is answered
  // with why (unavailable while offline, failed otherwise), and what the
  // cover was doing before is kept.
  function rejectRequest(intent: Extract<CoverEvent, IntentBase>, reason: string) {
    const position = intent.kind === "set_position" ? intent.position : intent.kind === "open" ? 100 : intent.kind === "close" ? 0 : null;
    const operation = position === null ? "stop" : "set_position";
    events.push({theatre: {
      kind: "target_state",
      target: "cover",
      requestId: intent.requestId,
      generation: intent.generation,
      status: reason === "unavailable" ? "unavailable" : "failed",
      observedAt: now.toISOString(),
      details: {
        operation,
        position,
        observedPosition: null,
        motion: null,
        source: typeof intent.source === "string" && intent.source ? intent.source : null,
        recovery: {},
        metrics: {attempts: 0, retries: 0, fallbackUsed: false}
      },
      failure: {operation, reason, occurredAt: now.toISOString()}
    }});
    trace("intent", "rejected", reason, {kind: intent.kind});
  }

  // Read the cover again rather than trust what it reported before: after a
  // restart, or when it is back online.
  function reobserve(reason: "startup" | "refresh" | "online") {
    state.observed = null;
    if (!state.desired) {
      state.pending = null;
      trace(reason, "idle");
    } else if (state.phase === "failed") {
      state.pending = null;
      trace(reason, "blocked", "failed");
    } else if (state.classification === "manual_override") {
      state.pending = null;
      emit("observe", 0);
      trace(reason, "observing", "manual_override");
    } else {
      const verifying = state.phase === "ready" && !state.pending;
      issue("observe", 0, verifying);
      trace(reason, "observing", null, {position: state.desired.position, verifying});
    }
  }

  function acceptIntent(intent: Extract<CoverEvent, IntentBase>) {
    if (!state.available) {
      rejectRequest(intent, "unavailable");
      return;
    }
    if (intent.respectManual === true && state.classification === "manual_override") {
      rejectRequest(intent, "manual-hold");
      return;
    }
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
    // Already there and still: confirmed from what the cover reported since
    // the last start, with nothing to send.
    const observed = state.observed;
    if (position !== null && observed && observed.motion !== "opening" && observed.motion !== "closing" &&
      Math.abs(observed.position - position) <= config.positionTolerance) {
      state.pending = null;
      trace("intent", "accepted", "already-there", {kind: intent.kind, position, generation: intent.generation});
      ready(position);
      return;
    }
    issue(state.desired.operation, 1);
    trace("intent", "accepted", null, {kind: intent.kind, position, generation: intent.generation});
  }

  function acceptObservation(observation: Extract<CoverEvent, {kind: "observed"}>) {
    const devicePosition = validPosition(observation.position, "observed cover position");
    if (observation.motion !== undefined && !Object.hasOwn(MOTIONS, observation.motion)) {
      throw new Error("unknown observed cover motion");
    }
    const parsedAt = parseObservedAt(observation.observedAt);
    if (parsedAt === null || typeof observation.observedAt !== "string") {
      throw new Error("cover observedAt must be an ISO timestamp");
    }
    const bounded = boundObservedAt(observation.observedAt, parsedAt, nowMs);
    if (bounded.skewed) trace("observation", "adjusted", "clock-skew", {reported: observation.observedAt, usedAt: bounded.observedAt});
    if (isOutOfOrder(bounded.ms, state.observed?.observedAt, nowMs)) {
      trace("observation", "ignored", "out-of-order");
      return;
    }
    const observedAt = bounded.ms;
    const position = config.invert ? 100 - devicePosition : devicePosition;
    const motion = observation.motion ?? null;
    const previous = state.observed;
    state.observed = {
      position,
      motion,
      observedAt: bounded.observedAt,
      battery: typeof observation.battery === "number" && Number.isFinite(observation.battery) ? observation.battery : previous?.battery ?? null,
      charging: typeof observation.charging === "string" ? observation.charging : previous?.charging ?? null
    };
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
      // A move confirms only once the cover has stopped at the target: some
      // transports echo the requested position as soon as the command goes,
      // before the motor moves, so a report at the target is not enough. A
      // reliable "stopped", or the same position held for settleMs, is.
      // Re-reading after a restart or an outage keeps confirming at once.
      if (within && !moving && (pending.operation !== "set_position" || settled)) {
        ready(target);
      } else if (within && !moving) {
        // Settled once it holds here for settleMs, with or without another
        // report: the tick then confirms it (see settledAtTarget).
        pending.nextAt = Math.min(pending.nextAt, (pending.stableSince ?? observedAt) + config.settleMs);
        trace("observation", "accepted", "awaiting-settle", {position, motion});
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

  // A set_position move whose last report is at the target, not moving, and
  // has held there for settleMs. Travel reports after an echo reset the
  // hold, so an echo alone settles only if nothing follows it for settleMs.
  function settledAtTarget(): boolean {
    const pending = state.pending;
    const observed = state.observed;
    if (!pending || pending.operation !== "set_position" || !observed || state.desired?.position === null || state.desired?.position === undefined) return false;
    if (observed.motion === "opening" || observed.motion === "closing") return false;
    if (pending.stableSince === null || pending.stablePosition !== observed.position) return false;
    return Math.abs(observed.position - state.desired.position) <= config.positionTolerance && nowMs - pending.stableSince >= config.settleMs;
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
    } else if (settledAtTarget()) {
      // At the target for settleMs, with no newer report: a cover that
      // reports once on arrival, and doesn't answer polls, is done too.
      trace("tick", "settled", "held-at-target", {position: state.observed!.position});
      ready(state.desired.position!);
    } else if (nowMs >= state.pending.deadlineAt) {
      retryOrFail(state.pending.operation === "observe" ? "confirmation-timeout" : "travel-timeout");
    } else if (nowMs >= state.pending.nextAt) {
      emit("observe", state.pending.attempt);
      state.pending.nextAt = nowMs + config.pollMs;
    }
  } else if (event.kind === "availability") {
    const change = applyCoverAvailability(state, event.online);
    if (change === "offline") state.observed = null;
    if (change) trace("availability", change);
    if (change === "online") reobserve("online");
  } else if (!state.available) {
    // Offline: nothing to observe or retry until it is back.
    trace(event.kind, "ignored", "unavailable");
  } else if (event.kind === "startup" || event.kind === "refresh") {
    reobserve(event.kind);
  } else {
    throw new Error("unknown cover event kind");
  }

  if (state.desired) {
    const theatre = targetStateEvent({
      target: "cover",
      requestId: state.desired.requestId,
      generation: state.generation,
      // Theatre target statuses: cover phases moving/stopping/manual_override
      // are all "transitioning" there.
      status: state.phase === "failed" || state.phase === "ready" || state.phase === "confirming" || state.phase === "unavailable"
        ? state.phase
        : "transitioning" as const,
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
      },
      classification: state.classification,
      failure: state.failure
    });
    events.push({theatre});
  }

  return {state, commands, events, traces, status: statusFor(state)};
}
