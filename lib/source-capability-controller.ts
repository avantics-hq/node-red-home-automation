"use strict";

export type SourceAction = "activate" | "deactivate";
export type SourceControlMode = "command" | "external" | "unavailable";
export type SourceConfirmation = "active" | "available" | "unavailable";
export type SourceObservationStatus = "active" | "inactive" | "available" | "unavailable" | "unknown";

const ACTIONS: Record<SourceAction, true> = {activate: true, deactivate: true};
const CONTROL_MODES: Record<SourceControlMode, true> = {
  command: true,
  external: true,
  unavailable: true
};
const CONFIRMATIONS: Record<SourceConfirmation, true> = {
  active: true,
  available: true,
  unavailable: true
};
const OBSERVATION_STATUSES: Record<SourceObservationStatus, true> = {
  active: true,
  inactive: true,
  available: true,
  unavailable: true,
  unknown: true
};

export interface SourceDescriptor {
  activation: SourceControlMode;
  deactivation: SourceControlMode;
  confirmation: SourceConfirmation;
}

export type SourceCapabilities = Record<string, SourceDescriptor>;

export interface SourceConfig {
  sources: SourceCapabilities;
  pollMs: number;
  confirmationTimeoutMs: number;
  maxAttempts: number;
}

export interface SourceDesired {
  requestId: string;
  generation: number;
  sourceId: string | null;
  action: SourceAction;
}

export interface SourceObservation {
  sourceId: string;
  status: SourceObservationStatus;
  observedAt: string;
}

export interface SourcePending {
  operation: SourceAction | "observe";
  attempt: number;
  deadlineAt: number;
  nextAt: number;
}

export interface SourceFailure {
  operation: string;
  reason: string;
  occurredAt: string;
}

export interface SourceState {
  desired: SourceDesired | null;
  generation: number;
  phase: string;
  observed: SourceObservation | null;
  pending: SourcePending | null;
  failure: SourceFailure | null;
  blockedGeneration: number | null;
}

export type SourceEvent =
  | {
    kind: "intent";
    requestId: string;
    generation: number;
    sourceId: string | null;
    action: SourceAction;
  }
  | {
    kind: "observed";
    generation: number;
    sourceId: string;
    status: SourceObservationStatus;
    observedAt: string;
  }
  | {
    kind: "command_result";
    generation: number;
    sourceId: string;
    ok: boolean;
    reason?: string;
  }
  | {kind: "tick"; generation: number}
  | {kind: "startup" | "refresh"};

export interface SourceMessage {
  sourceCapability?: SourceEvent;
}

function iso(now: Date): string {
  return now.toISOString();
}

export function normaliseCapabilities(value: unknown): SourceCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sources must be an object");
  }
  const sources: SourceCapabilities = {};
  for (const [sourceId, descriptorValue] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(sourceId)) throw new Error(`invalid sourceId: ${sourceId}`);
    if (!descriptorValue || typeof descriptorValue !== "object" || Array.isArray(descriptorValue)) {
      throw new Error(`source ${sourceId} must be an object`);
    }
    const descriptor = descriptorValue as Record<string, unknown>;
    const activation = descriptor.activation;
    const deactivation = descriptor.deactivation;
    const confirmation = descriptor.confirmation;
    if (!Object.hasOwn(CONTROL_MODES, activation as PropertyKey)) {
      throw new Error(`source ${sourceId} has invalid activation capability`);
    }
    if (!Object.hasOwn(CONTROL_MODES, deactivation as PropertyKey)) {
      throw new Error(`source ${sourceId} has invalid deactivation capability`);
    }
    if (!Object.hasOwn(CONFIRMATIONS, confirmation as PropertyKey)) {
      throw new Error(`source ${sourceId} has invalid confirmation capability`);
    }
    sources[sourceId] = {
      activation: activation as SourceControlMode,
      deactivation: deactivation as SourceControlMode,
      confirmation: confirmation as SourceConfirmation
    };
  }
  if (Object.keys(sources).length === 0) throw new Error("sources must not be empty");
  return sources;
}

export function normaliseConfig(config: Partial<SourceConfig> & {sources?: unknown} = {}): SourceConfig {
  return {
    sources: normaliseCapabilities(config.sources),
    pollMs: Math.max(250, Number(config.pollMs) || 2000),
    confirmationTimeoutMs: Math.max(1000, Number(config.confirmationTimeoutMs) || 15000),
    maxAttempts: Math.max(1, Math.floor(Number(config.maxAttempts) || 2))
  };
}

function initialState(
  saved: Partial<SourceState> = {},
  sources: SourceCapabilities = {}
): SourceState {
  const desired = saved.desired &&
    (saved.desired.sourceId === null || Object.hasOwn(sources, saved.desired.sourceId))
    ? {...saved.desired}
    : null;
  return {
    desired,
    generation: Number.isInteger(saved.generation) && (saved.generation ?? -1) >= 0 ? saved.generation! : 0,
    phase: typeof saved.phase === "string" ? saved.phase : "idle",
    observed: saved.observed && typeof saved.observed === "object" ? {...saved.observed} : null,
    pending: saved.pending && typeof saved.pending === "object" ? {...saved.pending} : null,
    failure: saved.failure && typeof saved.failure === "object" ? {...saved.failure} : null,
    blockedGeneration: Number.isInteger(saved.blockedGeneration) ? saved.blockedGeneration! : null
  };
}

export interface SourceCommand {
  sourceId: string | null;
  operation: SourceAction | "observe";
  requestId: string;
  generation: number;
  attempt: number;
}
export interface SourceOutputEvent {
  theatre: {
    kind: "target_state";
    target: "source";
    requestId: string;
    generation: number;
    status: string;
    observedAt: string;
    sourceId: string | null;
    action: SourceAction;
    failure?: SourceFailure;
  };
}


function commandFor(
  state: SourceState,
  operation: SourceAction | "observe",
  attempt = 1
): SourceCommand {
  if (!state.desired) throw new Error("source command requires desired state");
  return {
    sourceId: state.desired.sourceId,
    operation,
    requestId: state.desired.requestId,
    generation: state.generation,
    attempt
  };
}

function targetStatus(phase: string): string {
  if (phase === "ready") return "ready";
  if (phase === "failed") return "failed";
  if (phase === "unavailable") return "unavailable";
  if (phase === "waiting_for_source") return "waiting_for_source";
  if (phase === "transitioning") return "transitioning";
  return "confirming";
}

function targetEvent(state: SourceState, now: Date): SourceOutputEvent | null {
  if (!state.desired) return null;
  const theatre: SourceOutputEvent["theatre"] = {
    kind: "target_state",
    target: "source",
    requestId: state.desired.requestId,
    generation: state.generation,
    status: targetStatus(state.phase),
    observedAt: iso(now),
    sourceId: state.desired.sourceId,
    action: state.desired.action
  };
  if (state.failure) theatre.failure = {...state.failure};
  return {theatre};
}

function statusFor(state: SourceState) {
  const sourceId = state.desired?.sourceId || "none";
  return {phase: state.phase, text: `${sourceId}: ${state.phase}`};
}

export function transitionSource(
  saved: Partial<SourceState> | undefined,
  msg: SourceMessage,
  suppliedConfig: Partial<SourceConfig> & {sources?: unknown} = {},
  nowValue: Date | string | number = new Date()
) {
  const config = normaliseConfig(suppliedConfig);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("now must be a valid date");

  const state = initialState(saved, config.sources);
  const event = msg?.sourceCapability;
  const commands: SourceCommand[] = [];
  const events: SourceOutputEvent[] = [];
  const traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [];

  if (!event || typeof event.kind !== "string") {
    throw new Error("msg.sourceCapability.kind is required");
  }

  function trace(name: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) {
    traces.push({event: name, outcome, reason, details});
  }

  function descriptor(): SourceDescriptor | null {
    if (!state.desired || state.desired.sourceId === null) return null;
    return config.sources[state.desired.sourceId] ?? null;
  }

  function markUnavailable(reason: string) {
    state.pending = null;
    state.phase = "unavailable";
    state.failure = {
      operation: state.desired?.action ?? "observe",
      reason,
      occurredAt: iso(now)
    };
    trace("source", "unavailable", reason, {sourceId: state.desired?.sourceId ?? null});
  }

  function fail(operation: string, reason: string) {
    state.pending = null;
    state.phase = "failed";
    state.blockedGeneration = state.generation;
    state.failure = {operation, reason, occurredAt: iso(now)};
    trace("source", "failed", reason, {sourceId: state.desired?.sourceId ?? null, operation});
  }

  function issue(operation: SourceAction | "observe", attempt = 1) {
    const command = commandFor(state, operation, attempt);
    state.pending = {
      operation,
      attempt,
      deadlineAt: nowMs + config.confirmationTimeoutMs,
      nextAt: nowMs + config.pollMs
    };
    state.phase = "transitioning";
    commands.push(command);
    trace("command", "emitted", null, {sourceId: state.desired?.sourceId ?? null, operation, attempt});
  }

  function observationSatisfies(observation: SourceObservation | null): boolean {
    if (!state.desired || !observation) return false;
    if (state.desired.action === "deactivate") return observation.status === "inactive";
    const confirmation = descriptor()?.confirmation;
    if (confirmation === "active") return observation.status === "active";
    if (confirmation === "available") {
      return observation.status === "active" || observation.status === "available";
    }
    return false;
  }

  function reconcileObservation() {
    if (!state.desired || !state.observed) return;
    if (state.observed.status === "unavailable") {
      markUnavailable("adapter-unavailable");
      return;
    }
    if (observationSatisfies(state.observed)) {
      state.pending = null;
      state.failure = null;
      state.blockedGeneration = null;
      state.phase = "ready";
      trace("observation", "ready", null, {
        sourceId: state.desired.sourceId,
        status: state.observed.status
      });
    } else if (state.phase !== "transitioning") {
      state.phase = "waiting_for_source";
    }
  }

  function acceptIntent(event: Extract<SourceEvent, {kind: "intent"}>) {
    if (typeof event.requestId !== "string" || !event.requestId) {
      throw new Error("source requestId is required");
    }
    if (!Number.isInteger(event.generation) || event.generation < 1) {
      throw new Error("source generation must be a positive integer");
    }
    if (!Object.hasOwn(ACTIONS, event.action)) throw new Error("unknown source action");
    const unknownSource = event.sourceId === null && event.action === "deactivate";
    if (!unknownSource &&
      (typeof event.sourceId !== "string" || !Object.hasOwn(config.sources, event.sourceId))) {
      throw new Error("unknown sourceId");
    }
    if (event.generation < state.generation) {
      trace("intent", "ignored", "stale-generation", {generation: event.generation});
      return;
    }
    if (event.generation === state.generation && state.desired) {
      const duplicate = state.desired.requestId === event.requestId &&
        state.desired.sourceId === event.sourceId && state.desired.action === event.action;
      trace("intent", duplicate ? "duplicate" : "rejected", duplicate ? null : "generation-conflict");
      return;
    }

    state.desired = {
      requestId: event.requestId,
      generation: event.generation,
      sourceId: event.sourceId,
      action: event.action
    };
    state.generation = event.generation;
    state.observed = null;
    state.pending = null;
    state.failure = null;
    state.blockedGeneration = null;
    if (unknownSource) {
      markUnavailable("unknown-active-source");
      return;
    }

    const source = descriptor();
    if (!source) throw new Error("source descriptor is missing");
    const control = event.action === "activate" ? source.activation : source.deactivation;
    if (source.confirmation === "unavailable" || control === "unavailable") {
      markUnavailable(event.action === "activate" ? "unobservable-source" : "unsupported-deactivation");
      return;
    }
    if (control === "command") {
      issue(event.action);
    } else {
      state.phase = "waiting_for_source";
      commands.push(commandFor(state, "observe"));
      trace("intent", "waiting", "external-control", {sourceId: event.sourceId});
    }
  }

  function acceptObservation(event: Extract<SourceEvent, {kind: "observed"}>) {
    if (!Number.isInteger(event.generation) || event.generation < 1) {
      throw new Error("source observation generation must be a positive integer");
    }
    if (!Object.hasOwn(config.sources, event.sourceId)) throw new Error("unknown sourceId");
    if (!Object.hasOwn(OBSERVATION_STATUSES, event.status)) throw new Error("unknown source observation status");
    const observedAt = Date.parse(event.observedAt || "");
    if (!Number.isFinite(observedAt)) throw new Error("source observedAt must be an ISO timestamp");
    if (!state.desired || event.generation !== state.generation || event.sourceId !== state.desired.sourceId) {
      trace("observation", "ignored", "stale-generation", {generation: event.generation});
      return;
    }
    const previousAt = Date.parse(state.observed?.observedAt || "");
    if (Number.isFinite(previousAt) && observedAt < previousAt) {
      trace("observation", "ignored", "out-of-order");
      return;
    }
    state.observed = {
      sourceId: event.sourceId,
      status: event.status,
      observedAt: event.observedAt
    };
    reconcileObservation();
  }

  function acceptCommandResult(event: Extract<SourceEvent, {kind: "command_result"}>) {
    if (!state.desired || event.generation !== state.generation ||
      event.sourceId !== state.desired.sourceId || !state.pending) {
      trace("command-result", "ignored", "stale-generation");
      return;
    }
    if (event.ok === true) {
      state.phase = "confirming";
      state.pending.nextAt = nowMs;
      trace("command-result", "accepted");
      return;
    }
    const reason = typeof event.reason === "string" && event.reason ? event.reason : "command-failed";
    if (state.pending.attempt < config.maxAttempts) {
      issue(state.pending.operation, state.pending.attempt + 1);
    } else {
      fail(state.pending.operation, reason);
    }
  }

  function tick(event: Extract<SourceEvent, {kind: "tick"}>) {
    if (!state.desired || event.generation !== state.generation || !state.pending) {
      trace("tick", "ignored", "stale-generation");
      return;
    }
    if (nowMs >= state.pending.deadlineAt) {
      if (state.pending.attempt < config.maxAttempts) {
        issue(state.pending.operation, state.pending.attempt + 1);
      } else {
        fail(state.pending.operation, "confirmation-timeout");
      }
      return;
    }
    if (nowMs >= state.pending.nextAt) {
      commands.push(commandFor(state, "observe", state.pending.attempt));
      state.pending.nextAt = nowMs + config.pollMs;
      state.phase = "confirming";
      trace("command", "emitted", null, {sourceId: state.desired.sourceId, operation: "observe"});
    }
  }

  if (event.kind === "intent") {
    acceptIntent(event);
  } else if (event.kind === "observed") {
    acceptObservation(event);
  } else if (event.kind === "command_result") {
    acceptCommandResult(event);
  } else if (event.kind === "tick") {
    tick(event);
  } else if (event.kind === "startup" || event.kind === "refresh") {
    if (state.desired) {
      if (state.desired.sourceId === null || descriptor()?.confirmation === "unavailable") {
        markUnavailable(state.desired.sourceId === null ? "unknown-active-source" : "unobservable-source");
      } else {
        commands.push(commandFor(state, "observe"));
        state.pending = null;
        state.phase = "confirming";
        trace(event.kind, "querying", null, {sourceId: state.desired.sourceId});
      }
    } else {
      trace(event.kind, "idle");
    }
  } else {
    throw new Error("unknown source capability event kind");
  }

  const outputEvent = targetEvent(state, now);
  if (outputEvent) events.push(outputEvent);
  return {state, commands, events, traces, status: statusFor(state)};
}
