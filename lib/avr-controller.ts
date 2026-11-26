"use strict";

import {ADOPTED_MISMATCH, adoptableRefresh, readsOnly, savedAdoptedGeneration, adoptionReason, carryOn} from "./adopted-request";
import type {TraceEntry} from "./bounded-trace";
import {numberSetting} from "./settings";
import {asTargetStatus, targetStateEvent, type TargetStateEvent} from "./target-state";
import {
  formatVolumeCommand,
  legacyVolumeDb,
  parseAvrLine,
  parseSourceCodes,
  POWER_ON,
  POWER_STANDBY,
  QUERY_COMMAND,
  roundVolume,
  selectSource,
  type AvrPower,
  type MainZone,
  VOLUME_MAX_DB,
  VOLUME_MIN_DB,
  ZONE_ON
} from "./denon-protocol";

export {
  QUERY_COMMAND,
  formatVolumeCommand,
  parseAvrLine,
  type AvrPower,
  type MainZone,
  type ParsedAvrLine
} from "./denon-protocol";
export type AvrField = "power" | "mainZone" | "source" | "volume";

export interface AvrConfig {
  area: string;
  sources: Record<string, string>;
  retryMs: number;
  maxAttempts: number;
  // The volume bounds, in dB.
  minVolumeDb: number;
  maxVolumeDb: number;
}

// Traced when a volume request gives `value` in the receiver's own units
// rather than `valueDb`: still read during 5.x, and the node warns.
export const LEGACY_VOLUME_UNITS = "legacy-volume-units";

export interface AvrObserved {
  power: AvrPower | null;
  mainZone: MainZone | null;
  source: string | null;
  sourceCode: string | null;
  volume: number | null;
  at: string | null;
}

export interface AvrDesired {
  requestId: string;
  generation: number;
  power: AvrPower;
  source: string | null;
}
export type AvrVolumeMode = "absolute" | "relative";

export interface AvrVolumeRequest {
  requestId: string;
  mode: AvrVolumeMode;
  requested: number;
  target: number | null;
  bounded: boolean;
}

export interface AvrVolumeMetrics {
  intents: number;
  commands: number;
  bounded: number;
  confirmations: number;
  externalChanges: number;
  failures: number;
}


export interface AvrPending {
  operation: string;
  payload: string;
  attempt: number;
  deadlineAt: number;
}

export interface AvrFailure {
  operation: string;
  attempts: number;
  at: string;
}

export interface AvrState {
  observed: AvrObserved;
  seen: Record<AvrField, boolean>;
  // When the receiver last reported each field.
  fieldObservedAt: Record<AvrField, string | null>;
  desired: AvrDesired | null;
  generation: number;
  pending: AvrPending | null;
  phase: string;
  failure: AvrFailure | null;
  blockedGeneration: number | null;
  querySentAt: number | null;
  classification: "manual_override" | null;
  volumeRequest: AvrVolumeRequest | null;
  recentVolumeRequestIds: string[];
  volumeMetrics: AvrVolumeMetrics;
  lastAttempt: number;
  // The generation adopted from a refresh (see adopted-request.ts).
  adoptedGeneration: number | null;
  // Volumes here are in dB. A state saved before 5.0 has none of this and
  // its volumes in the receiver's own 0-98, converted as it is restored.
  volumeUnits: "dB";
}

export type AvrInputEvent =
  | {kind: "startup"}
  // From the theatre activity controller, with the activity's wanted values.
  | {kind: "refresh"; requestId?: string | null; generation?: number; power?: string; source?: string | null}
  | {kind: "observed"; line?: unknown}
  | {
    kind: "intent";
    requestId: string;
    generation: number;
    power: AvrPower;
    source?: string | null;
  }
  | {
    kind: "volume";
    requestId: string;
    mode: AvrVolumeMode;
    // In dB: absolute, or a change for "relative". A numeric string counts.
    valueDb?: number | string;
    // Before 5.0: the receiver's own 0-98 for "absolute".
    value?: number | string;
  }
  | {kind: "tick"};

export interface AvrMessage {
  avr?: AvrInputEvent;
  payload?: unknown;
}

export interface AvrCommand {
  payload: string;
  avrCommand: {
    area: string;
    operation: string;
    requestId: string | null;
    generation: number;
    attempt: number;
  };
}

// The theatre activity controller's view of the receiver.
export type AvrTargetState = TargetStateEvent<"avr", Record<string, unknown>,
  {operation: string; reason: string; attempts: number; occurredAt: string}>;

export interface AvrOutputEvent {
  payload?: unknown;
  avr: {
    kind: string;
    reason?: string;
    [key: string]: unknown;
  };
}

function observedTime(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

// A number, or a finite numeric string, as a number; null otherwise.
function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

export function createAvrState(
  _config: AvrConfig,
  saved: Partial<AvrState> = {}
): AvrState {
  const observed = saved.observed || {} as Partial<AvrObserved>;
  const seen = saved.seen || {} as Partial<Record<AvrField, boolean>>;
  const volumeRequest = saved.volumeRequest && typeof saved.volumeRequest === "object"
    ? saved.volumeRequest
    : null;
  const volumeMetrics = saved.volumeMetrics || {} as Partial<AvrVolumeMetrics>;
  // A state saved before 5.0, from a context store, holds volumes in the
  // receiver's units; a relative request's `requested` is a change, the same
  // in both.
  const savedInReceiverUnits = Object.keys(saved).length > 0 && saved.volumeUnits !== "dB";
  const db = (value: number) => (savedInReceiverUnits ? legacyVolumeDb(value, "absolute") : value);
  return {
    volumeUnits: "dB",
    observed: {
      power: observed.power === "on" || observed.power === "standby" ? observed.power : null,
      mainZone: observed.mainZone === "on" || observed.mainZone === "off" ? observed.mainZone : null,
      source: typeof observed.source === "string" ? observed.source : null,
      sourceCode: typeof observed.sourceCode === "string" ? observed.sourceCode : null,
      volume: Number.isFinite(observed.volume) ? db(observed.volume!) : null,
      at: typeof observed.at === "string" ? observed.at : null
    },
    fieldObservedAt: {
      power: observedTime(saved.fieldObservedAt?.power),
      mainZone: observedTime(saved.fieldObservedAt?.mainZone),
      source: observedTime(saved.fieldObservedAt?.source),
      volume: observedTime(saved.fieldObservedAt?.volume)
    },
    seen: {
      power: seen.power === true,
      mainZone: seen.mainZone === true,
      source: seen.source === true,
      volume: seen.volume === true
    },
    desired: saved.desired && typeof saved.desired === "object" ? {...saved.desired} : null,
    generation: Number.isInteger(saved.generation) && (saved.generation ?? -1) >= 0 ? saved.generation! : 0,
    pending: saved.pending && typeof saved.pending === "object" ? {...saved.pending} : null,
    phase: typeof saved.phase === "string" ? saved.phase : "unknown",
    failure: saved.failure && typeof saved.failure === "object" ? {...saved.failure} : null,
    blockedGeneration: Number.isInteger(saved.blockedGeneration) ? saved.blockedGeneration! : null,
    querySentAt: Number.isFinite(saved.querySentAt) ? saved.querySentAt! : null,
    classification: saved.classification === "manual_override" ? "manual_override" : null,
    volumeRequest: volumeRequest && typeof volumeRequest.requestId === "string" &&
      (volumeRequest.mode === "absolute" || volumeRequest.mode === "relative")
      ? {
        requestId: volumeRequest.requestId,
        mode: volumeRequest.mode,
        requested: volumeRequest.mode === "absolute" && Number.isFinite(volumeRequest.requested)
          ? db(volumeRequest.requested)
          : Number(volumeRequest.requested) || 0,
        target: Number.isFinite(volumeRequest.target) ? db(volumeRequest.target!) : null,
        bounded: volumeRequest.bounded === true
      }
      : null,
    recentVolumeRequestIds: Array.isArray(saved.recentVolumeRequestIds)
      ? saved.recentVolumeRequestIds.filter((value): value is string => typeof value === "string").slice(-32)
      : [],
    volumeMetrics: {
      intents: Number(volumeMetrics.intents) || 0,
      commands: Number(volumeMetrics.commands) || 0,
      bounded: Number(volumeMetrics.bounded) || 0,
      confirmations: Number(volumeMetrics.confirmations) || 0,
      externalChanges: Number(volumeMetrics.externalChanges) || 0,
      failures: Number(volumeMetrics.failures) || 0
    },
    lastAttempt: Number.isInteger(saved.lastAttempt) && (saved.lastAttempt ?? -1) >= 0
      ? saved.lastAttempt!
      : 0,
    adoptedGeneration: savedAdoptedGeneration(saved)
  };
}

function sameVolume(left: number | null, right: number | null): boolean {
  return left !== null && right !== null && Math.abs(left - right) < 0.001;
}


// Validates AVR configuration and fills its defaults. The Node-RED adapter
// calls this at deploy, so a bad configuration shows on the node instead of
// failing every message.
// Settings may be editor strings. Missing or unusable numbers take their
// defaults: retry 2000 ms (at least 250), 3 attempts (at least 1) and volume
// bounds -80 to -20 dB. A flow saved before 5.0 has minVolume and maxVolume
// in the receiver's own 0-98, read when the dB settings are missing.
export function normaliseAvrConfig(rawConfig: {[K in keyof AvrConfig]?: unknown} & {minVolume?: unknown; maxVolume?: unknown}): AvrConfig {
  // The editor keeps the old keys, empty once the dialog saves dB ones.
  const given = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== "";
  const bound = (db: unknown, legacy: unknown, label: string, fallback: number) =>
    !given(db) && given(legacy)
      ? legacyVolumeDb(numberSetting(legacy, label, fallback - VOLUME_MIN_DB), "absolute")
      : numberSetting(db, label, fallback);
  const rawMinVolume = bound(rawConfig.minVolumeDb, rawConfig.minVolume, "minimum volume", -80);
  const rawMaxVolume = bound(rawConfig.maxVolumeDb, rawConfig.maxVolume, "maximum volume", -20);
  const minVolume = roundVolume(rawMinVolume);
  const maxVolume = roundVolume(rawMaxVolume);
  if (!Number.isFinite(rawMinVolume) || !Number.isFinite(rawMaxVolume) ||
      Math.abs(rawMinVolume - minVolume) > 0.001 || Math.abs(rawMaxVolume - maxVolume) > 0.001 ||
      minVolume < VOLUME_MIN_DB || maxVolume > VOLUME_MAX_DB || minVolume >= maxVolume) {
    throw new Error("volume bounds must be half-step values between -80 and 18 dB with minimum below maximum");
  }
  return {
    // Optional: an empty area means none.
    area: typeof rawConfig.area === "string" ? rawConfig.area.trim() : "",
    sources: parseSourceCodes(rawConfig.sources),
    retryMs: Math.max(250, numberSetting(rawConfig.retryMs, "retry interval", 2000)),
    maxAttempts: Math.max(1, Math.floor(numberSetting(rawConfig.maxAttempts, "max attempts", 3))),
    minVolumeDb: minVolume,
    maxVolumeDb: maxVolume
  };
}

export function transitionAvr(
  saved: Partial<AvrState> | undefined,
  msg: AvrMessage,
  rawConfig: Partial<AvrConfig>,
  nowValue: Date | string | number = new Date()
) {
  const config = normaliseAvrConfig(rawConfig);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const nowMs = now.getTime();
  const state = createAvrState(config, saved);
  const commands: AvrCommand[] = [];
  const events: AvrOutputEvent[] = [];
  const targetStates: Array<{theatre: AvrTargetState}> = [];
  const traces: TraceEntry[] = [];
  const event: AvrInputEvent | {kind: "unknown"} = msg.avr || {kind: "unknown"};
  const previousPhase = state.phase;
  // Fields the receiver reported in this event.
  const reportedFields = new Set<AvrField>();
  const before = JSON.stringify({
    observed: state.observed,
    seen: state.seen,
    fieldObservedAt: state.fieldObservedAt,
    desired: state.desired,
    generation: state.generation,
    pending: state.pending,
    phase: state.phase,
    failure: state.failure,
    blockedGeneration: state.blockedGeneration,
    classification: state.classification,
    volumeRequest: state.volumeRequest,
    recentVolumeRequestIds: state.recentVolumeRequestIds,
    volumeMetrics: state.volumeMetrics,
    lastAttempt: state.lastAttempt
  });
  let forceStateEvent = false;

  function trace(name: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) {
    traces.push({event: name, outcome, reason, details});
  }

  function requiredFields(): AvrField[] {
    if (!state.desired) return [];
    if (state.desired.power === "standby") return ["power"];
    const fields: AvrField[] = ["power", "mainZone"];
    if (state.desired.source) fields.push("source");
    return fields;
  }

  function hasFreshTargetState() {
    return requiredFields().every((field) => state.seen[field] === true);
  }

  function desiredSourceCode() {
    return state.desired?.source ? config.sources[state.desired.source] : null;
  }

  function targetSatisfied() {
    if (!state.desired || !hasFreshTargetState()) return false;
    if (state.desired.power === "standby") return state.observed.power === "standby";
    return state.observed.power === "on" &&
      state.observed.mainZone === "on" &&
      (!state.desired.source || state.observed.sourceCode === desiredSourceCode());
  }

  function operationSatisfied(operation: string): boolean {
    if (operation === "query") return hasFreshTargetState();
    if (operation === "volume-query") {
      return state.seen.power && state.seen.mainZone && state.seen.volume;
    }
    if (operation === "volume") {
      return state.seen.volume &&
        sameVolume(state.observed.volume, state.volumeRequest?.target ?? null);
    }
    if (operation === "power-on") return state.seen.power && state.observed.power === "on";
    if (operation === "main-zone-on") return state.seen.mainZone && state.observed.mainZone === "on";
    if (operation === "source") {
      return state.seen.source && state.observed.sourceCode === desiredSourceCode();
    }
    if (operation === "standby") return state.seen.power && state.observed.power === "standby";
    return false;
  }

  function isVolumeOperation(operation: string): boolean {
    return operation === "volume" || operation === "volume-query";
  }

  function emitCommand(operation: string, payload: string, attempt: number) {
    const volumeOperation = isVolumeOperation(operation);
    commands.push({
      payload,
      avrCommand: {
        area: config.area,
        operation,
        requestId: volumeOperation
          ? state.volumeRequest?.requestId || null
          : state.desired?.requestId || null,
        generation: state.desired?.generation ?? state.generation,
        attempt
      }
    });
    state.pending = {
      operation,
      payload,
      attempt,
      deadlineAt: nowMs + config.retryMs
    };
    state.phase = volumeOperation && blocked()
      ? "failed"
      : operation === "query" || operation === "volume-query"
        ? "discovering"
        : "transitioning";
    if (operation === "volume") state.volumeMetrics.commands += 1;
    trace("command", "emitted", null, {operation, attempt});
    state.lastAttempt = Math.max(state.lastAttempt, attempt);
  }

  function ready() {
    const desired = state.desired;
    if (!desired) throw new Error("AVR cannot become ready without desired state");
    const changed = state.phase !== "ready";
    state.pending = null;
    state.phase = "ready";
    state.failure = null;
    state.blockedGeneration = null;
    if (changed) {
      events.push({
        avr: {
          kind: "ready",
          area: config.area,
          requestId: desired.requestId,
          generation: desired.generation
        }
      });
      trace("request", "ready", null, {
        requestId: desired.requestId,
        generation: desired.generation
      });
    }
  }
  function clampVolume(value: number): {value: number; bounded: boolean} {
    const rounded = roundVolume(value);
    const bounded = Math.max(config.minVolumeDb, Math.min(config.maxVolumeDb, rounded));
    return {value: bounded, bounded: Math.abs(bounded - value) > 0.001};
  }

  // The phase once no volume work is in flight; a failed request stays failed.
  function blocked() {
    return state.desired !== null && state.blockedGeneration === state.desired.generation;
  }

  function restingPhase(): string {
    if (state.classification === "manual_override") return "manual_override";
    if (blocked()) return "failed";
    return state.desired && targetSatisfied() ? "ready" : "idle";
  }

  // Every failed volume request is reported in one shape; operation and
  // attempts are null when no command was involved (a restart).
  function volumeFailed(requestId: string | null, reason: "restart" | "attempts-exhausted",
    operation: string | null, attempts: number | null) {
    state.volumeMetrics.failures += 1;
    events.push({avr: {kind: "volume_failed", area: config.area, requestId, reason, operation, attempts}});
    trace("volume", "failed", reason, {requestId, operation, attempts});
  }

  function completeVolume() {
    const request = state.volumeRequest;
    if (!request || request.target === null) return;
    state.volumeMetrics.confirmations += 1;
    if (state.pending && isVolumeOperation(state.pending.operation)) state.pending = null;
    events.push({
      avr: {
        kind: "volume_ready",
        area: config.area,
        requestId: request.requestId,
        volume: request.target,
        bounded: request.bounded
      }
    });
    trace("volume", "ready", null, {
      requestId: request.requestId,
      volume: request.target,
      bounded: request.bounded
    });
    state.volumeRequest = null;
    state.phase = restingPhase();
  }

  function abandonVolume(reason: string, observed: number | null = state.observed.volume) {
    const request = state.volumeRequest;
    if (!request) return;
    if (state.pending && isVolumeOperation(state.pending.operation)) state.pending = null;
    events.push({
      avr: {
        kind: "volume_manual_override",
        area: config.area,
        requestId: request.requestId,
        reason,
        observed,
        target: request.target
      }
    });
    trace("volume", "manual_override", reason, {
      requestId: request.requestId,
      observed,
      target: request.target
    });
    state.volumeRequest = null;
    state.phase = restingPhase();
  }

  function resolveRelativeVolume() {
    const request = state.volumeRequest;
    if (!request || request.mode !== "relative" || request.target !== null ||
        !state.seen.volume || state.observed.volume === null) return;
    const resolved = clampVolume(state.observed.volume + request.requested);
    request.target = resolved.value;
    request.bounded ||= resolved.bounded;
    if (resolved.bounded) state.volumeMetrics.bounded += 1;
  }

  function reconcileVolume(allowQuery: boolean): boolean {
    if (!state.volumeRequest) return false;
    if (state.pending) return true;
    if (!state.seen.power || !state.seen.mainZone || !state.seen.volume) {
      if (allowQuery) emitCommand("volume-query", QUERY_COMMAND, 1);
      return true;
    }
    if (state.observed.power !== "on" || state.observed.mainZone !== "on") {
      const request = state.volumeRequest;
      events.push({
        avr: {
          kind: "volume_rejected",
          area: config.area,
          requestId: request.requestId,
          reason: "receiver-not-ready"
        }
      });
      trace("volume", "rejected", "receiver-not-ready", {
        requestId: request.requestId
      });
      state.volumeRequest = null;
      return false;
    }
    resolveRelativeVolume();
    if (state.volumeRequest.target !== null &&
        sameVolume(state.observed.volume, state.volumeRequest.target)) {
      completeVolume();
      return false;
    }
    if (state.volumeRequest.target === null) return true;
    emitCommand("volume", formatVolumeCommand(state.volumeRequest.target), 1);
    return true;
  }


  function reconcile(allowQuery = true) {
    if (state.pending && operationSatisfied(state.pending.operation)) {
      if (state.pending.operation === "volume") completeVolume();
      else state.pending = null;
    }
    if (state.pending) return;

    if (state.desired && state.classification !== "manual_override" &&
        state.phase === "ready" && !state.volumeRequest &&
        hasFreshTargetState() && !targetSatisfied()) {
      state.classification = "manual_override";
      state.phase = "manual_override";
      events.push({
        avr: {
          kind: "manual_override",
          area: config.area,
          requestId: state.desired.requestId,
          generation: state.desired.generation,
          observed: {...state.observed}
        }
      });
      trace("observation", "manual_override");
    }

    if (state.desired && state.classification !== "manual_override" && !targetSatisfied()) {
      // A failed request still answers volume: sent if the receiver is on,
      // rejected otherwise.
      if (blocked()) {
        reconcileVolume(allowQuery);
        return;
      }
      if (!hasFreshTargetState()) {
        state.phase = "discovering";
        if (allowQuery) emitCommand("query", QUERY_COMMAND, 1);
        return;
      }
      if (state.desired.power === "standby") {
        emitCommand("standby", POWER_STANDBY, 1);
      } else if (state.observed.power !== "on") {
        emitCommand("power-on", POWER_ON, 1);
      } else if (state.observed.mainZone !== "on") {
        emitCommand("main-zone-on", ZONE_ON, 1);
      } else if (state.desired.source && state.observed.sourceCode !== desiredSourceCode()) {
        emitCommand("source", selectSource(desiredSourceCode()!), 1);
      }
      return;
    }

    if (reconcileVolume(allowQuery)) return;

    if (state.desired) {
      if (state.classification === "manual_override") {
        state.phase = "manual_override";
      } else {
        ready();
      }
    } else {
      state.phase = Object.values(state.seen).some(Boolean) ? "idle" : "discovering";
    }
  }

  function validateIntent(intent: Extract<AvrInputEvent, {kind: "intent"}>): string | null {
    if (!intent.requestId || typeof intent.requestId !== "string") return "missing-request-id";
    if (!Number.isInteger(intent.generation) || intent.generation < 1) return "invalid-generation";
    if (intent.power !== "on" && intent.power !== "standby") return "invalid-power";
    if (intent.power === "standby" && intent.source) return "source-with-standby";
    if (intent.source && !Object.hasOwn(config.sources, intent.source)) return "unknown-source";
    return null;
  }
  function validateVolumeIntent(intent: Extract<AvrInputEvent, {kind: "volume"}>): string | null {
    if (!intent.requestId || typeof intent.requestId !== "string") return "missing-request-id";
    if (intent.mode !== "absolute" && intent.mode !== "relative") return "invalid-volume-mode";
    if (!Number.isFinite(intent.value)) return "invalid-volume-value";
    if (intent.mode === "relative" && intent.value === 0) return "zero-volume-delta";
    return null;
  }

  // A refresh with the activity's wanted values, reaching a node with
  // nothing desired (it started with nothing saved): adopt them, and
  // rediscover below as at startup (see adopted-request.ts).
  let replacedRequest = false;
  const adoptable = event.kind === "refresh" ? adoptableRefresh(event, state) : null;
  // The same wanted values as the work in hand: carry on under the new
  // request rather than adopting it read-only (see carryOn).
  const carried = event.kind === "refresh" && carryOn(state, adoptable,
    event.power === state.desired?.power && (event.source || null) === (state.desired?.source ?? null),
    state.classification === "manual_override" || state.phase === "failed" || state.blockedGeneration === state.desired?.generation);
  if (carried) trace("refresh", "continued", "same-request", {generation: state.generation});
  const adopted = !carried && adoptable !== null && event.kind === "refresh" &&
    validateIntent({kind: "intent", ...adoptable, power: event.power as AvrPower, source: event.source ?? null}) === null;
  if (adopted && event.kind === "refresh") {
    const reason = adoptionReason(state.desired);
    // Replacing a request the theatre already counts as ready, it answers
    // from its reading, not with an interim state the theatre would take as
    // drift.
    replacedRequest = reason === "newer-generation";
    // A request it replaces takes its classification and failure with it.
    state.failure = null;
    state.blockedGeneration = null;
    state.classification = null;
    state.lastAttempt = 0;
    state.desired = {...adoptable, power: event.power as AvrPower, source: event.source || null};
    state.generation = adoptable.generation;
    state.adoptedGeneration = adoptable.generation;
    trace("refresh", "adopted", reason, {power: event.power, source: event.source || null, generation: adoptable.generation});
  }

  if (event.kind === "refresh" && !adopted) {
    // Re-read the receiver without touching work in flight: desired state,
    // pending commands, the volume request and the phase all carry on.
    commands.push({
      payload: QUERY_COMMAND,
      avrCommand: {
        area: config.area,
        operation: "query",
        requestId: state.desired?.requestId || null,
        generation: state.desired?.generation ?? state.generation,
        attempt: 1
      }
    });
    trace("refresh", "querying", null, {pending: state.pending?.operation ?? null});
    forceStateEvent = true;
  } else if (event.kind === "startup" || adopted) {
    const requestBlocked = state.desired &&
      state.blockedGeneration === state.desired.generation;
    const abandonedVolumeRequest = state.volumeRequest?.requestId || null;
    // Not replayed after a restart: the caller hears it failed.
    if (abandonedVolumeRequest) volumeFailed(abandonedVolumeRequest, "restart", null, null);
    state.seen = {power: false, mainZone: false, source: false, volume: false};
    state.pending = null;
    state.volumeRequest = null;
    state.phase = requestBlocked ? "failed" : "discovering";
    state.querySentAt = nowMs;
    commands.push({
      payload: QUERY_COMMAND,
      avrCommand: {
        area: config.area,
        operation: "query",
        requestId: state.desired?.requestId || null,
        generation: state.desired?.generation ?? state.generation,
        attempt: 1
      }
    });
    state.lastAttempt = Math.max(state.lastAttempt, 1);
    if (state.desired && !requestBlocked && state.classification !== "manual_override") {
      state.pending = {
        operation: "query",
        payload: QUERY_COMMAND,
        attempt: 1,
        deadlineAt: nowMs + config.retryMs
      };
    }
    trace(event.kind, "querying", requestBlocked ? "request-remains-blocked" : null, {
      abandonedVolumeRequest
    });
    forceStateEvent = true;
  } else if (event.kind === "observed") {
    const value = event.line ?? msg.payload;
    const lines = String(value ?? "").split(/[\r\n]+/).filter(Boolean);
    let recognised = 0;
    for (const line of lines) {
      const parsed = parseAvrLine(line, config.sources);
      if (!parsed) continue;
      recognised += 1;
      let previous: string | number | null;
      let current: string | number | null;
      const wasFresh = state.seen[parsed.field];
      state.seen[parsed.field] = true;
      state.fieldObservedAt[parsed.field] = now.toISOString();
      reportedFields.add(parsed.field);
      if (parsed.field === "source") {
        previous = state.observed.sourceCode;
        state.observed.source = parsed.value;
        state.observed.sourceCode = parsed.sourceCode;
        current = parsed.sourceCode;
      } else if (parsed.field === "power") {
        previous = state.observed.power;
        state.observed.power = parsed.value;
        current = parsed.value;
      } else if (parsed.field === "mainZone") {
        previous = state.observed.mainZone;
        state.observed.mainZone = parsed.value;
        current = parsed.value;
      } else {
        previous = state.observed.volume;
        state.observed.volume = parsed.value;
        current = parsed.value;
        if (wasFresh && previous !== current) {
          if (state.volumeRequest && state.pending?.operation === "volume" &&
              !sameVolume(parsed.value, state.volumeRequest.target)) {
            state.volumeMetrics.externalChanges += 1;
            abandonVolume("unexpected-observation", parsed.value);
          } else if (!state.volumeRequest) {
            state.volumeMetrics.externalChanges += 1;
            events.push({
              avr: {
                kind: "volume_external",
                area: config.area,
                previous,
                observed: parsed.value
              }
            });
            trace("volume", "external", null, {previous, observed: parsed.value});
          } else if (state.volumeRequest.mode === "relative" &&
              state.pending?.operation !== "volume") {
            state.volumeRequest.target = null;
          }
        }
      }
      state.observed.at = now.toISOString();
      trace("observed", previous === current ? "unchanged" : "changed", null, {
        field: parsed.field,
        value: current
      });
    }
    if (recognised) {
      reconcile();
      forceStateEvent = true;
    }
  } else if (event.kind === "intent") {
    const reason = validateIntent(event);
    if (reason) {
      events.push({avr: {kind: "rejected", area: config.area, reason}});
      trace("intent", "rejected", reason);
    } else if (event.generation < state.generation) {
      events.push({
        avr: {
          kind: "rejected",
          area: config.area,
          requestId: event.requestId,
          generation: event.generation,
          reason: "stale-generation"
        }
      });
      trace("intent", "rejected", "stale-generation", {
        generation: event.generation,
        currentGeneration: state.generation
      });
    } else if (event.generation === state.generation && state.desired &&
      (state.desired.requestId !== event.requestId ||
        state.desired.power !== event.power ||
        state.desired.source !== (event.source || null))) {
      const conflict = state.desired.requestId === event.requestId
        ? "request-conflict"
        : "generation-conflict";
      events.push({
        avr: {
          kind: "rejected",
          area: config.area,
          requestId: event.requestId,
          generation: event.generation,
          reason: conflict
        }
      });
      trace("intent", "rejected", conflict);
    } else if (event.generation === state.generation &&
      state.desired && state.desired.requestId === event.requestId) {
      trace("intent", "duplicate", null, {requestId: event.requestId, generation: event.generation});
      reconcile();
    } else {
      if (state.desired) {
        events.push({
          avr: {
            kind: "superseded",
            area: config.area,
            requestId: state.desired.requestId,
            generation: state.desired.generation,
            supersededBy: event.requestId
          }
        });
      }
      state.generation = event.generation;
      state.desired = {
        requestId: event.requestId,
        generation: event.generation,
        power: event.power,
        source: event.source || null
      };
      state.pending = null;
      state.failure = null;
      state.blockedGeneration = null;
      state.classification = null;
      state.lastAttempt = 0;
      // Ready belonged to the previous request; left as it was, the drift
      // check would read this request's unmet target as a manual change.
      if (state.phase === "ready" || state.phase === "manual_override") state.phase = "idle";
      trace("intent", "accepted", null, {
        requestId: event.requestId,
        generation: event.generation,
        power: event.power,
        source: event.source || null
      });
      reconcile();
    }
    forceStateEvent = true;
  } else if (event.kind === "volume") {
    // In dB; a finite numeric string counts. `value` from before 5.0 is in
    // the receiver's own units, still read during 5.x and traced so the
    // node can warn; given with a usable valueDb, it is ignored and traced.
    const valueDb = numberValue(event.valueDb);
    const value = numberValue(event.value);
    const legacyUnits = valueDb === null && event.value !== undefined;
    const volume = {...event, value: valueDb !== null ? valueDb
      : value !== null && (event.mode === "absolute" || event.mode === "relative") ? legacyVolumeDb(value, event.mode)
        : value ?? NaN};
    if (legacyUnits) trace("volume", "accepted", LEGACY_VOLUME_UNITS, {requestId: event.requestId, value: event.value});
    if (valueDb !== null && event.value !== undefined) {
      trace("volume", "accepted", "legacy-volume-units-ignored", {requestId: event.requestId, value: event.value});
    }
    const reason = validateVolumeIntent(volume);
    if (reason) {
      events.push({
        avr: {
          kind: "volume_rejected",
          area: config.area,
          requestId: event.requestId,
          reason
        }
      });
      trace("volume", "rejected", reason, {requestId: event.requestId});
    } else if (state.recentVolumeRequestIds.includes(event.requestId)) {
      trace("volume", "duplicate", null, {requestId: event.requestId});
      reconcile();
    } else {
      const existing = state.volumeRequest;
      let mode = event.mode;
      let requested = volume.value;
      let target: number | null = null;
      let bounded = false;
      let boundedThisIntent = false;

      if (event.mode === "absolute") {
        const resolved = clampVolume(volume.value);
        target = resolved.value;
        bounded = resolved.bounded;
        boundedThisIntent = resolved.bounded;
      } else if (existing?.target !== null && existing?.target !== undefined) {
        const unresolvedTarget = existing.target + volume.value;
        const resolved = clampVolume(unresolvedTarget);
        mode = existing.mode;
        requested = existing.mode === "relative"
          ? existing.requested + volume.value
          : unresolvedTarget;
        target = resolved.value;
        bounded = existing.bounded || resolved.bounded;
        boundedThisIntent = resolved.bounded;
      } else if (existing?.mode === "relative") {
        requested = existing.requested + volume.value;
      } else if (state.seen.volume && state.observed.volume !== null) {
        const resolved = clampVolume(state.observed.volume + volume.value);
        target = resolved.value;
        bounded = resolved.bounded;
        boundedThisIntent = resolved.bounded;
      }

      state.volumeRequest = {
        requestId: event.requestId,
        mode,
        requested,
        target,
        bounded
      };
      state.recentVolumeRequestIds = [...state.recentVolumeRequestIds, event.requestId].slice(-32);
      state.volumeMetrics.intents += 1;
      if (boundedThisIntent) state.volumeMetrics.bounded += 1;
      if (state.pending?.operation === "volume") {
        state.pending = null;
        // The last reading predates the command in flight, so it cannot
        // confirm the new target: re-read before deciding.
        if (target !== null && sameVolume(state.observed.volume, target)) state.seen.volume = false;
      }
      trace("volume", "accepted", null, {
        requestId: event.requestId,
        mode: event.mode,
        value: volume.value,
        target,
        bounded
      });
      reconcile();
    }
    forceStateEvent = true;
  } else if (event.kind === "tick") {
    if (!state.pending) {
      reconcile();
    } else if (nowMs >= state.pending.deadlineAt) {
      if (operationSatisfied(state.pending.operation)) {
        if (state.pending.operation === "volume") completeVolume();
        else state.pending = null;
        reconcile();
      } else if (state.pending.attempt >= config.maxAttempts) {
        const failed = state.pending;
        state.pending = null;
        if (isVolumeOperation(failed.operation)) {
          const requestId = state.volumeRequest?.requestId || null;
          state.volumeRequest = null;
          state.phase = restingPhase();
          volumeFailed(requestId, "attempts-exhausted", failed.operation, failed.attempt);
          reconcile(false);
        } else {
          state.phase = "failed";
          state.failure = {
            operation: failed.operation,
            attempts: failed.attempt,
            at: now.toISOString()
          };
          state.blockedGeneration = state.desired?.generation ?? null;
          events.push({
            avr: {
              kind: "failed",
              area: config.area,
              requestId: state.desired?.requestId || null,
              generation: state.desired?.generation ?? state.generation,
              operation: failed.operation,
              attempts: failed.attempt
            }
          });
          trace("request", "failed", "attempts-exhausted", {
            operation: failed.operation,
            attempts: failed.attempt
          });
        }
      } else {
        emitCommand(state.pending.operation, state.pending.payload, state.pending.attempt + 1);
      }
    }
    forceStateEvent = true;
  }

  // An adopted request only reads the receiver (see adopted-request.ts): a
  // power, zone or source command means it isn't as wanted.
  const held = readsOnly(state, commands, (command) => command.avrCommand.operation === "query" || command.avrCommand.operation === "volume-query");
  if (held.mismatch) {
    commands.splice(0, commands.length, ...held.commands);
    state.pending = null;
    state.classification = "manual_override";
    state.phase = "manual_override";
    trace("command", "withheld", ADOPTED_MISMATCH);
  }

  const after = JSON.stringify({
    observed: state.observed,
    seen: state.seen,
    fieldObservedAt: state.fieldObservedAt,
    desired: state.desired,
    generation: state.generation,
    pending: state.pending,
    phase: state.phase,
    failure: state.failure,
    blockedGeneration: state.blockedGeneration,
    classification: state.classification,
    volumeRequest: state.volumeRequest,
    recentVolumeRequestIds: state.recentVolumeRequestIds,
    volumeMetrics: state.volumeMetrics,
    lastAttempt: state.lastAttempt
  });
  if (forceStateEvent || before !== after) {
    const payload = {
      area: config.area,
      phase: state.phase,
      generation: state.generation,
      observed: {...state.observed},
      fresh: {...state.seen},
      desired: state.desired ? {...state.desired} : null,
      pending: state.pending ? {
        operation: state.pending.operation,
        attempt: state.pending.attempt,
        deadlineAt: state.pending.deadlineAt
      } : null,
      failure: state.failure,
      classification: state.classification,
      volume: {
        request: state.volumeRequest ? {...state.volumeRequest} : null,
        bounds: {minimum: config.minVolumeDb, maximum: config.maxVolumeDb},
        metrics: {...state.volumeMetrics}
      },
      metrics: {
        attempts: state.lastAttempt,
        retries: Math.max(0, state.lastAttempt - 1),
        fallbackUsed: false,
        volume: {...state.volumeMetrics}
      }
    };
    events.unshift({payload, avr: {kind: "state", ...payload}});
  }

  const source = state.observed.source || state.observed.sourceCode || "unknown";
  const status = state.phase === "failed"
    ? {phase: "failed", text: "failed · " + (state.failure?.operation || "unknown")}
    : state.phase === "transitioning"
      ? {
        phase: "transitioning",
        text: (state.pending?.operation || "unknown") + " · " +
          (state.pending?.attempt || 0) + "/" + config.maxAttempts
      }
      : state.phase === "manual_override"
        ? {phase: "manual_override", text: "manual control"}
        : state.phase === "discovering"
          ? {phase: "discovering", text: "discovering"}
          : state.phase === "ready"
            ? {phase: "ready", text: (state.observed.power || "unknown") + " · " + source}
            : {phase: "idle", text: (state.observed.power || "unknown") + " · " + source};

  // The theatre activity controller's view of this target. Ready is stamped
  // with the oldest report among the fields the request needs, so it is only
  // as fresh as its least recent confirmation, and is re-sent only when the
  // receiver reports one of those fields.
  if (state.desired && !replacedRequest) {
    const fields = requiredFields();
    const status = state.phase === "manual_override"
      ? "transitioning"
      : asTargetStatus(state.phase, "confirming");
    const confirmedAt = fields
      .map((field) => state.fieldObservedAt[field])
      .reduce<string | null>((oldest, at) =>
        at === null || oldest === null ? null : Date.parse(at) < Date.parse(oldest) ? at : oldest,
      now.toISOString());
    const reported = fields.some((field) => reportedFields.has(field));
    if (status !== "ready" || ((previousPhase !== "ready" || reported) && confirmedAt !== null)) {
      const theatre: AvrTargetState = targetStateEvent({
        target: "avr",
        requestId: state.desired.requestId,
        generation: state.desired.generation,
        status,
        observedAt: status === "ready" && confirmedAt !== null ? confirmedAt : now.toISOString(),
        details: {
          power: state.desired.power,
          source: state.desired.source,
          observed: {
            power: state.observed.power,
            mainZone: state.observed.mainZone,
            source: state.observed.source
          },
          recovery: {power: state.observed.power, source: state.observed.source},
          metrics: {
            attempts: state.lastAttempt,
            retries: Math.max(0, state.lastAttempt - 1),
            fallbackUsed: false
          }
        },
        classification: state.classification,
        failure: state.failure && {
          operation: state.failure.operation,
          reason: "attempts-exhausted",
          attempts: state.failure.attempts,
          occurredAt: state.failure.at
        }
      });
      targetStates.push({theatre});
    }
  }

  return {state, commands, events, targetStates, traces, status};
}
