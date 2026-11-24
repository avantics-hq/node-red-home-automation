"use strict";

// A cover that can only be told to open, close or stop, with no reliable
// position: a curtain motor, say. Its state is open, closed, opening,
// closing, stopped (partway) or unknown, from what it reports: its motion
// and, if it reports one, its end state. Without an end state, a move that
// ran for the full travel time and then stopped counts as done, marked as
// judged from travel time. Nothing else is assumed: a cover that reports
// nothing is "unconfirmed", not ready.

import type {CoverMotion} from "./cover-controller";
import {boundObservedAt, isOutOfOrder, parseObservedAt} from "./observation-time";
import {numberSetting} from "./settings";
import {targetStateEvent, type TargetStateEvent, type TargetStatus} from "./target-state";

export type OpenCloseOperation = "open" | "close" | "stop" | "observe";
export type OpenClosePosition = "open" | "closed" | "stopped" | "unknown";
export type OpenCloseEvidence = "reported" | "travel-time";

const MOTIONS: Record<CoverMotion, true> = {opening: true, closing: true, stopped: true};

export interface OpenCloseConfig {
  // How long a full open or close takes.
  travelMs: number;
  // How long to wait beyond the travel time before trying again.
  marginMs: number;
  maxAttempts: number;
}

export function normaliseOpenCloseConfig(config: Partial<Record<keyof OpenCloseConfig, unknown>> = {}): OpenCloseConfig {
  return {
    travelMs: Math.max(1000, numberSetting(config.travelMs, "travel time", 30000)),
    marginMs: Math.max(1000, numberSetting(config.marginMs, "travel margin", 10000)),
    maxAttempts: Math.max(1, Math.floor(numberSetting(config.maxAttempts, "maximum attempts", 2)))
  };
}

export interface OpenCloseState {
  desired: {requestId: string; generation: number; operation: "open" | "close" | "stop"; source: string | null} | null;
  generation: number;
  phase: string;
  position: OpenClosePosition;
  evidence: OpenCloseEvidence | null;
  motion: CoverMotion | null;
  observedAt: string | null;
  // Whether this cover has reported anything since the last start.
  reports: boolean;
  pending: {
    operation: OpenCloseOperation;
    attempt: number;
    issuedAt: number;
    deadlineAt: number;
    // When it was first reported moving the requested way.
    movingSince: number | null;
    // Whether it has reported anything since this request was first sent.
    reported: boolean;
  } | null;
  failure: {reason: string; occurredAt: string} | null;
  classification: "manual_override" | null;
  // Whether the device says it is reachable, and the phase it was in when it
  // went offline.
  available: boolean;
  phaseBeforeUnavailable: string | null;
}

export type OpenCloseEvent =
  | {kind: "open" | "close" | "stop"; requestId: string; generation: number; source?: string; respectManual?: boolean}
  | {kind: "observed"; motion?: CoverMotion; state?: "open" | "closed"; observedAt: string}
  | {kind: "tick"; generation: number}
  | {kind: "availability"; online: boolean}
  | {kind: "startup" | "refresh"};

export interface OpenCloseCommand {
  operation: OpenCloseOperation;
  requestId: string | null;
  generation: number;
  attempt: number;
}

function initialState(saved: Partial<OpenCloseState> = {}): OpenCloseState {
  return {
    desired: saved.desired && typeof saved.desired === "object" ? {...saved.desired} : null,
    generation: Number.isInteger(saved.generation) && (saved.generation ?? -1) >= 0 ? saved.generation! : 0,
    phase: typeof saved.phase === "string" ? saved.phase : "idle",
    position: saved.position ?? "unknown",
    evidence: saved.evidence ?? null,
    motion: saved.motion ?? null,
    observedAt: typeof saved.observedAt === "string" ? saved.observedAt : null,
    reports: saved.reports === true,
    pending: saved.pending && typeof saved.pending === "object" ? {...saved.pending} : null,
    failure: saved.failure && typeof saved.failure === "object" ? {...saved.failure} : null,
    classification: saved.classification === "manual_override" ? "manual_override" : null,
    available: saved.available !== false,
    phaseBeforeUnavailable: typeof saved.phaseBeforeUnavailable === "string" ? saved.phaseBeforeUnavailable : null
  };
}

// Whether it is moving: as it reports, or while a move it was sent is
// unconfirmed and it reports nothing.
export function openCloseMoving(state: Pick<OpenCloseState, "motion" | "phase">): boolean {
  if (state.motion !== null) return state.motion !== "stopped";
  return state.phase === "moving" || state.phase === "stopping";
}

export function transitionOpenCloseCover(
  saved: Partial<OpenCloseState> | undefined,
  event: OpenCloseEvent,
  suppliedConfig: Partial<Record<keyof OpenCloseConfig, unknown>> = {},
  nowValue: Date | string | number = new Date()
) {
  const config = normaliseOpenCloseConfig(suppliedConfig);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const nowMs = now.getTime();
  const state = initialState(saved);
  const commands: OpenCloseCommand[] = [];
  const traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [];
  const trace = (name: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) =>
    traces.push({event: name, outcome, reason, details});

  function issue(operation: OpenCloseOperation, attempt: number) {
    commands.push({operation, requestId: state.desired?.requestId ?? null, generation: state.generation, attempt});
    // A retry of the same request keeps what was heard since it was first sent.
    const reported = attempt > 1 && state.pending?.operation === operation ? state.pending.reported : false;
    state.pending = {operation, attempt, issuedAt: nowMs, deadlineAt: nowMs + config.travelMs + config.marginMs, movingSince: null, reported};
    state.phase = operation === "stop" ? "stopping" : operation === "observe" ? "confirming" : "moving";
    trace("command", "emitted", null, {operation, attempt});
  }

  function settle(position: OpenClosePosition, evidence: OpenCloseEvidence | null, reason: string | null) {
    state.position = position;
    state.evidence = evidence;
    state.pending = null;
    state.failure = null;
    state.classification = null;
    state.phase = "ready";
    trace("cover", "ready", reason, {position, evidence});
  }

  function latchManual(reason: string, position: OpenClosePosition) {
    state.position = position;
    state.evidence = position === "stopped" ? null : state.evidence;
    state.pending = null;
    state.classification = "manual_override";
    state.phase = "manual_override";
    trace("cover", "manual_override", reason, {position});
  }

  // What it reported before is not trusted after a restart, or once it has
  // been offline: read it again.
  function reobserve(reason: string) {
    state.motion = null;
    state.observedAt = null;
    state.reports = false;
    state.position = "unknown";
    state.evidence = null;
    state.pending = null;
    if (state.phase !== "failed") state.phase = state.desired ? "confirming" : "idle";
    commands.push({operation: "observe", requestId: state.desired?.requestId ?? null, generation: state.generation, attempt: 0});
    trace(reason, "observing");
  }

  // Answers to requests not carried out: unavailable while offline, or held
  // by a person's move.
  const rejected: Array<{requestId: string; generation: number; operation: "open" | "close" | "stop"; reason: string}> = [];

  const target = (operation: "open" | "close"): OpenClosePosition => (operation === "open" ? "open" : "closed");
  const towards = (operation: "open" | "close"): CoverMotion => (operation === "open" ? "opening" : "closing");

  if (event.kind === "open" || event.kind === "close" || event.kind === "stop") {
    if (typeof event.requestId !== "string" || !event.requestId) throw new Error("cover requestId is required");
    if (!Number.isInteger(event.generation) || event.generation < 1) throw new Error("cover generation must be a positive integer");
    if (!state.available) {
      rejected.push({requestId: event.requestId, generation: event.generation, operation: event.kind, reason: "unavailable"});
      trace("intent", "rejected", "unavailable", {kind: event.kind});
    } else if (event.respectManual === true && state.classification === "manual_override") {
      rejected.push({requestId: event.requestId, generation: event.generation, operation: event.kind, reason: "manual-hold"});
      trace("intent", "rejected", "manual-hold", {kind: event.kind});
    } else if (event.generation <= state.generation && state.desired) {
      trace("intent", "ignored", event.generation === state.generation ? "duplicate" : "stale-generation");
    } else {
      state.desired = {requestId: event.requestId, generation: event.generation, operation: event.kind, source: event.source ?? null};
      state.generation = event.generation;
      state.failure = null;
      state.classification = null;
      if (event.kind !== "stop" && state.position === target(event.kind) && state.motion !== "opening" && state.motion !== "closing") {
        trace("intent", "accepted", "already-there", {kind: event.kind});
        settle(state.position, state.evidence, "already-there");
      } else {
        issue(event.kind, 1);
        trace("intent", "accepted", null, {kind: event.kind});
      }
    }
  } else if (event.kind === "observed") {
    if (event.motion !== undefined && !Object.hasOwn(MOTIONS, event.motion)) throw new Error("unknown observed cover motion");
    if (event.state !== undefined && event.state !== "open" && event.state !== "closed") throw new Error("unknown observed cover state");
    const parsedAt = parseObservedAt(event.observedAt);
    if (parsedAt === null) throw new Error("cover observedAt must be an ISO timestamp");
    const bounded = boundObservedAt(event.observedAt, parsedAt, nowMs);
    if (isOutOfOrder(bounded.ms, state.observedAt, nowMs)) {
      trace("observation", "ignored", "out-of-order");
    } else {
      state.reports = true;
      state.observedAt = bounded.observedAt;
      if (event.motion !== undefined) state.motion = event.motion;
      const pending = state.pending;
      const operation = state.desired?.operation;
      if (pending && bounded.ms >= pending.issuedAt) pending.reported = true;
      if (pending && bounded.ms < pending.issuedAt) {
        trace("observation", "ignored", "stale-observation");
      } else if (pending && (operation === "open" || operation === "close")) {
        if (event.motion === towards(operation) && pending.movingSince === null) pending.movingSince = bounded.ms;
        if (event.state !== undefined) {
          if (event.state === target(operation)) settle(event.state, "reported", null);
          else latchManual("ended-elsewhere", event.state);
        } else if (event.motion && event.motion !== "stopped" && event.motion !== towards(operation)) {
          latchManual("moved-the-other-way", "unknown");
        } else if (event.motion === "stopped" && pending.movingSince !== null) {
          if (bounded.ms - pending.movingSince >= config.travelMs) settle(target(operation), "travel-time", null);
          else latchManual("stopped-short", "stopped");
        }
      } else if (pending && operation === "stop") {
        if (event.state !== undefined) settle(event.state, "reported", null);
        else if (event.motion === "stopped") settle("stopped", null, null);
      } else if (event.state !== undefined && (state.phase === "unconfirmed" || state.phase === "failed") &&
        state.desired && state.desired.operation !== "stop" && event.state === target(state.desired.operation)) {
        // A late report of the end the request asked for settles it after all.
        settle(event.state, "reported", "late-report");
      } else if (event.state !== undefined) {
        // Not ours: an end state reported while nothing was asked.
        state.position = event.state;
        state.evidence = "reported";
        if (state.phase === "ready" && state.desired && state.desired.operation !== "stop" && event.state !== target(state.desired.operation)) {
          latchManual("moved-by-someone", event.state);
        }
      } else if (event.motion === "opening" || event.motion === "closing") {
        if (state.phase === "ready") latchManual("moved-by-someone", "unknown");
        else state.position = "unknown";
      }
    }
  } else if (event.kind === "tick") {
    const pending = state.pending;
    if (!pending || event.generation !== state.generation) {
      trace("tick", "ignored", "stale-generation");
    } else if (nowMs >= pending.deadlineAt) {
      if (pending.operation !== "observe" && pending.attempt < config.maxAttempts && pending.movingSince === null) {
        issue(pending.operation, pending.attempt + 1);
      } else {
        // Nothing it reported settles it. Without any reports, that is all we
        // can know, so it is unconfirmed rather than failed.
        state.pending = null;
        state.phase = pending.reported ? "failed" : "unconfirmed";
        state.failure = {reason: pending.reported ? "no-confirmation" : "no-reports", occurredAt: now.toISOString()};
        trace("cover", state.phase, state.failure.reason, {operation: pending.operation});
      }
    }
  } else if (event.kind === "availability") {
    if (event.online !== true && event.online !== false) throw new Error("cover availability online must be true or false");
    if (!event.online && state.available) {
      state.available = false;
      state.phaseBeforeUnavailable = state.phase;
      state.pending = null;
      state.motion = null;
      state.phase = "unavailable";
      trace("availability", "offline");
    } else if (event.online && !state.available) {
      state.available = true;
      state.phase = state.phaseBeforeUnavailable ?? "idle";
      state.phaseBeforeUnavailable = null;
      trace("availability", "online");
      reobserve("online");
    }
  } else if (!state.available) {
    trace(event.kind, "ignored", "unavailable");
  } else if (event.kind === "startup" || event.kind === "refresh") {
    reobserve(event.kind);
  } else {
    throw new Error("unknown cover event kind");
  }

  const moving = openCloseMoving(state);
  const evidenceNote = state.evidence === "travel-time" ? " (by travel time)" : "";
  return {
    state,
    commands,
    rejected,
    traces,
    status: {phase: state.phase, moving, text: `${state.position}${evidenceNote}: ${state.phase}`}
  };
}

// The theatre's target state for the current request, and for each request
// answered unavailable. A cover that never reported, and so stays
// unconfirmed, is failed for the theatre, with the reason saying why.
export function openCloseTargetStates(
  result: ReturnType<typeof transitionOpenCloseCover>,
  now: Date
): Array<{theatre: TargetStateEvent<"cover">}> {
  const {state} = result;
  const status = (phase: string): TargetStatus =>
    phase === "ready" || phase === "failed" || phase === "confirming" || phase === "unavailable" ? phase
      : phase === "unconfirmed" ? "failed"
      : "transitioning";
  const details = (operation: string) => ({
    operation,
    state: state.position,
    evidence: state.evidence,
    motion: state.motion
  });
  const events = result.rejected.map((request) => ({theatre: targetStateEvent({
    target: "cover" as const,
    requestId: request.requestId,
    generation: request.generation,
    status: request.reason === "unavailable" ? "unavailable" as const : "failed" as const,
    observedAt: now.toISOString(),
    details: details(request.operation),
    failure: {operation: request.operation, reason: request.reason, occurredAt: now.toISOString()}
  })}));
  if (state.desired) {
    events.push({theatre: targetStateEvent({
      target: "cover" as const,
      requestId: state.desired.requestId,
      generation: state.generation,
      status: status(state.phase),
      observedAt: now.toISOString(),
      details: details(state.desired.operation),
      classification: state.classification,
      failure: state.failure ? {operation: state.desired.operation, ...state.failure} : null
    })});
  }
  return events;
}
