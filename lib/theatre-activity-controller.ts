"use strict";

const PROFILE_NAME = /^[a-z][a-z0-9_-]*$/;
export const TARGETS = ["display", "avr", "source", "lighting", "backlighting"] as const;
const REQUIRED_TARGETS = ["display", "avr"] as const;
const OPTIONAL_TARGETS = ["lighting", "backlighting"] as const;

export type TheatreTarget = typeof TARGETS[number];
export type TargetStatus =
  | "discovering"
  | "transitioning"
  | "confirming"
  | "ready"
  | "waiting_for_source"
  | "failed"
  | "unavailable";
export type TargetClassification = "drift" | "manual_override";
export type TheatreAvailability = "unknown" | "available" | "degraded" | "unavailable";

const TARGET_STATUSES: Record<TargetStatus, true> = {
  discovering: true,
  transitioning: true,
  confirming: true,
  ready: true,
  waiting_for_source: true,
  failed: true,
  unavailable: true
};
const TARGET_CLASSIFICATIONS: Record<TargetClassification, true> = {
  drift: true,
  manual_override: true
};
const AVAILABILITIES: Record<TheatreAvailability, true> = {
  unknown: true,
  available: true,
  degraded: true,
  unavailable: true
};
const SOURCE_ACTIONS: Record<string, true> = {activate: true, deactivate: true};
const SOURCE_READINESS: Record<string, true> = {required: true, optional: true};

export interface ActivitySourceProfile extends Record<string, unknown> {
  action: "activate" | "deactivate";
  readiness: "required" | "optional";
  sourceId?: string | null;
}

export type ActivityProfile = Record<TheatreTarget, Record<string, unknown>> & {
  source: ActivitySourceProfile;
};
export type ActivityProfiles = Record<string, ActivityProfile>;

export interface TheatreDesired {
  requestId: string;
  generation: number;
  activity: string;
  requestedAt: string;
}

export interface TargetFailure {
  operation?: string | null;
  reason?: string;
  occurredAt?: string;
}

export interface TargetState {
  status: TargetStatus;
  observedAt: string;
  classification: TargetClassification | null;
  failure: TargetFailure | null;
  details: Record<string, unknown> | null;
}

export interface TheatreFailure {
  target: TheatreTarget;
  operation: string | null;
  reason: string;
  occurredAt: string;
}

export interface TheatreState {
  desired: TheatreDesired | null;
  currentActivity: string;
  generation: number;
  phase: string;
  targets: Record<TheatreTarget, TargetState | null>;
  refreshPending: Record<TheatreTarget, boolean>;
  failure: TheatreFailure | null;
  blockedGeneration: number | null;
  degraded: Array<{target: TheatreTarget; reason: string}>;
  availability: TheatreAvailability;
  transitionStartedAt: string | null;
  transitionCompletedAt: string | null;
}

export interface TheatreConfig {
  area: string;
  freshnessMs: number;
  activityProfiles: ActivityProfiles;
}

export type TheatreInputEvent =
  | {
    kind: "intent";
    requestId: string;
    generation: number;
    activity: string;
    requestedAt?: string;
  }
  | {
    kind: "target_state";
    target: TheatreTarget;
    generation: number;
    status: TargetStatus;
    observedAt: string;
    classification?: TargetClassification;
    failure?: TargetFailure;
    details?: Record<string, unknown>;
  }
  | {kind: "startup" | "refresh"}
  | {kind: "tick"; generation?: number};

export interface TheatreOutput {
  theatre: Record<string, unknown>;
}

export interface TheatreMessage {
  theatre?: TheatreInputEvent;
}

export interface TargetCommand extends Record<string, unknown> {
  target: TheatreTarget;
  kind: string;
  requestId: string | null;
  generation: number;
}

export function normaliseActivityProfiles(value: unknown): ActivityProfiles {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("activityProfiles must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error("activityProfiles must not be empty");

  const profiles: ActivityProfiles = {};
  for (const [name, profileValue] of entries) {
    if (!PROFILE_NAME.test(name)) throw new Error(`invalid activity profile name: ${name}`);
    if (!profileValue || typeof profileValue !== "object" || Array.isArray(profileValue)) {
      throw new Error(`activity profile ${name} must be an object`);
    }
    const profile = profileValue as Record<string, unknown>;
    const targets = {} as Record<TheatreTarget, Record<string, unknown>>;
    for (const target of TARGETS) {
      const desired = profile[target];
      if (!desired || typeof desired !== "object" || Array.isArray(desired)) {
        throw new Error(`activity profile ${name} must define ${target}`);
      }
      targets[target] = {...desired as Record<string, unknown>};
    }
    const source = targets.source;
    if (!Object.hasOwn(SOURCE_ACTIONS, source.action as PropertyKey)) {
      throw new Error(`activity profile ${name} has an invalid source action`);
    }
    if (!Object.hasOwn(SOURCE_READINESS, source.readiness as PropertyKey)) {
      throw new Error(`activity profile ${name} has invalid source readiness`);
    }
    if (source.action === "activate" &&
      (typeof source.sourceId !== "string" || !source.sourceId)) {
      throw new Error(`activity profile ${name} must define sourceId`);
    }
    profiles[name] = targets as ActivityProfile;
  }
  return profiles;
}

function emptyTargets(
  saved: Partial<Record<TheatreTarget, TargetState | null>> = {}
): Record<TheatreTarget, TargetState | null> {
  return Object.fromEntries(TARGETS.map((target) => [
    target,
    saved[target] && typeof saved[target] === "object" ? {...saved[target]} : null
  ])) as Record<TheatreTarget, TargetState | null>;
}

function emptyRefreshPending(
  saved: Partial<Record<TheatreTarget, boolean>> = {}
): Record<TheatreTarget, boolean> {
  return Object.fromEntries(TARGETS.map((target) => [target, saved[target] === true])) as
    Record<TheatreTarget, boolean>;
}

export function createTheatreState(
  saved: Partial<TheatreState> = {},
  activityProfiles: ActivityProfiles = {}
): TheatreState {
  const savedDesired = saved.desired && typeof saved.desired === "object" ? saved.desired : null;
  const desired = savedDesired && Object.hasOwn(activityProfiles, savedDesired.activity)
    ? {...savedDesired}
    : null;
  return {
    desired,
    currentActivity: typeof saved.currentActivity === "string" &&
      Object.hasOwn(activityProfiles, saved.currentActivity)
      ? saved.currentActivity
      : "unknown",
    generation: Number.isInteger(saved.generation) && (saved.generation ?? -1) >= 0 ? saved.generation! : 0,
    phase: typeof saved.phase === "string" ? saved.phase : "idle",
    targets: emptyTargets(saved.targets),
    refreshPending: emptyRefreshPending(saved.refreshPending),
    failure: saved.failure && typeof saved.failure === "object" ? {...saved.failure} : null,
    blockedGeneration: Number.isInteger(saved.blockedGeneration) ? saved.blockedGeneration! : null,
    degraded: Array.isArray(saved.degraded) ? saved.degraded.map((entry) => ({...entry})) : [],
    availability: saved.availability && Object.hasOwn(AVAILABILITIES, saved.availability)
      ? saved.availability
      : "unknown",
    transitionStartedAt: typeof saved.transitionStartedAt === "string"
      ? saved.transitionStartedAt
      : null,
    transitionCompletedAt: typeof saved.transitionCompletedAt === "string"
      ? saved.transitionCompletedAt
      : null
  };
}

export function normaliseConfig(
  config: Partial<TheatreConfig> & {activityProfiles?: unknown} = {}
): TheatreConfig {
  return {
    area: typeof config.area === "string" && config.area ? config.area : "room",
    freshnessMs: Math.max(1000, Number(config.freshnessMs) || 30000),
    activityProfiles: normaliseActivityProfiles(config.activityProfiles)
  };
}

function targetCommand(
  target: TheatreTarget,
  kind: string,
  desired: TheatreDesired | null,
  values: Record<string, unknown> = {}
): TargetCommand {
  return {
    target,
    kind,
    requestId: desired?.requestId || null,
    generation: desired?.generation || 0,
    ...values
  };
}

function targetIntentCommands(
  desired: TheatreDesired,
  config: TheatreConfig,
  previousDesired: TheatreDesired | null
): TargetCommand[] {
  const profile = config.activityProfiles[desired.activity];
  if (!profile) throw new Error("desired activity profile is missing");
  const previousSource = previousDesired
    ? config.activityProfiles[previousDesired.activity]?.source
    : null;
  return TARGETS.map((target) => {
    let values = profile[target];
    if (target === "source" && values.action === "deactivate" && !values.sourceId) {
      values = {...values, sourceId: previousSource?.sourceId || null};
    }
    return targetCommand(target, "intent", desired, values);
  });
}

function targetRefreshCommands(desired: TheatreDesired): TargetCommand[] {
  return TARGETS.map((target) => targetCommand(target, "refresh", desired));
}

function observationTime(targetState: {observedAt?: string} | null | undefined): number | null {
  const value = Date.parse(targetState?.observedAt || "");
  return Number.isFinite(value) ? value : null;
}

function isFresh(targetState: TargetState, nowMs: number, freshnessMs: number): boolean {
  const observedAt = observationTime(targetState);
  return observedAt !== null && nowMs - observedAt <= freshnessMs && observedAt <= nowMs + 1000;
}

function statusFor(state: TheatreState) {
  const activity = state.desired?.activity || "none";
  if (state.phase === "failed") {
    return {phase: "failed", text: `${activity}: ${state.failure?.reason || "failed"}`};
  }
  return {phase: state.phase, text: `${activity}: ${state.phase}`};
}

function stateEvent(state: TheatreState, area: string): TheatreOutput {
  return {
    theatre: {
      kind: "state",
      area,
      requestId: state.desired?.requestId || null,
      generation: state.generation,
      desiredActivity: state.desired?.activity || null,
      currentActivity: state.currentActivity,
      phase: state.phase,
      availability: state.availability,
      transitionStartedAt: state.transitionStartedAt,
      transitionCompletedAt: state.transitionCompletedAt,
      targets: emptyTargets(state.targets),
      failure: state.failure ? {...state.failure} : null,
      degraded: state.degraded.map((entry) => ({...entry}))
    }
  };
}

export function transitionTheatre(
  saved: Partial<TheatreState> | undefined,
  msg: TheatreMessage,
  suppliedConfig: Partial<TheatreConfig> & {activityProfiles?: unknown} = {},
  nowValue: Date | string | number = new Date()
) {
  const config = normaliseConfig(suppliedConfig);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("now must be a valid date");

  const state = createTheatreState(saved, config.activityProfiles);
  const event = msg?.theatre;
  const commands: TargetCommand[] = [];
  const events: TheatreOutput[] = [];
  const traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [];

  if (!event || typeof event.kind !== "string") throw new Error("msg.theatre.kind is required");

  function trace(name: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) {
    traces.push({event: name, outcome, reason, details});
  }

  function emit(kind: string, details: Record<string, unknown> = {}) {
    events.push({
      theatre: {
        kind,
        area: config.area,
        requestId: state.desired?.requestId || null,
        generation: state.generation,
        activity: state.desired?.activity || null,
        ...details
      }
    });
  }

  function fail(target: TheatreTarget, targetState: TargetState) {
    const failure = targetState.failure && typeof targetState.failure === "object"
      ? targetState.failure
      : {};
    state.failure = {
      target,
      operation: failure.operation || null,
      reason: failure.reason || (targetState.status === "unavailable" ? "unavailable" : "target-failed"),
      occurredAt: failure.occurredAt || targetState.observedAt || now.toISOString()
    };
    state.blockedGeneration = state.generation;
    state.currentActivity = "unknown";
    state.phase = "failed";
    state.availability = "unavailable";
    state.transitionCompletedAt = state.transitionCompletedAt || now.toISOString();
  }

  function reconcile() {
    const previousPhase = state.phase;
    const previousCurrent = state.currentActivity;
    state.degraded = [];

    if (!state.desired) {
      state.phase = "idle";
      state.currentActivity = "unknown";
      state.availability = "unknown";
      return;
    }
    if (state.blockedGeneration === state.generation) {
      state.phase = "failed";
      state.currentActivity = "unknown";
      state.availability = "unavailable";
      return;
    }

    const profile = config.activityProfiles[state.desired.activity];
    if (!profile) throw new Error("desired activity profile is missing");
    const sourceProfile = profile.source;
    for (const target of TARGETS) {
      const optional = (OPTIONAL_TARGETS as readonly TheatreTarget[]).includes(target) ||
        (target === "source" && sourceProfile.readiness === "optional");
      if (!optional) continue;
      const targetState = state.targets[target];
      if (!targetState) {
        state.degraded.push({target, reason: "unconfirmed"});
      } else if (!isFresh(targetState, nowMs, config.freshnessMs)) {
        state.degraded.push({target, reason: "stale"});
      } else if (targetState.status !== "ready") {
        state.degraded.push({target, reason: targetState.failure?.reason || targetState.status});
      }
    }

    for (const target of REQUIRED_TARGETS) {
      const targetState = state.targets[target];
      if (targetState && isFresh(targetState, nowMs, config.freshnessMs) &&
        (targetState.status === "failed" || targetState.status === "unavailable")) {
        fail(target, targetState);
        break;
      }
    }
    if (state.phase === "failed") {
      const failure = state.failure;
      if (!failure) throw new Error("failed theatre state is missing failure details");
      if (previousPhase !== "failed") {
        emit("failed", {failure});
        trace("activity", "failed", failure.reason, {target: failure.target});
      }
      return;
    }

    for (const target of REQUIRED_TARGETS) {
      const targetState = state.targets[target];
      if (!targetState || !isFresh(targetState, nowMs, config.freshnessMs)) {
        state.phase = "confirming";
        state.currentActivity = "unknown";
        state.availability = "unknown";
        return;
      }
      if (targetState.status !== "ready") {
        state.phase = targetState.status === "discovering" || targetState.status === "confirming"
          ? "confirming"
          : "transitioning";
        state.currentActivity = "unknown";
        state.availability = state.degraded.length ? "degraded" : "available";
        return;
      }
    }

    if (sourceProfile.readiness === "required") {
      const source = state.targets.source;
      if (!source || !isFresh(source, nowMs, config.freshnessMs) || source.status !== "ready") {
        state.phase = "waiting_for_source";
        state.currentActivity = "unknown";
        state.availability = "degraded";
        if (previousPhase !== "waiting_for_source") {
          emit("waiting_for_source", {
            sourceId: sourceProfile.sourceId,
            reason: source?.failure?.reason || source?.status || "unconfirmed"
          });
          trace("activity", "waiting", "source-unconfirmed");
        }
        return;
      }
    }

    state.failure = null;
    state.phase = "ready";
    state.currentActivity = state.desired.activity;
    state.availability = state.degraded.length ? "degraded" : "available";
    if (previousPhase !== "ready" || previousCurrent !== state.currentActivity) {
      state.transitionCompletedAt = now.toISOString();
      emit("ready");
      trace("activity", "ready", null, {activity: state.currentActivity});
    }
  }

  function acceptIntent(event: Extract<TheatreInputEvent, {kind: "intent"}>) {
    if (typeof event.requestId !== "string" || !event.requestId) {
      throw new Error("theatre requestId is required");
    }
    if (!Number.isInteger(event.generation) || event.generation < 1) {
      throw new Error("theatre generation must be a positive integer");
    }
    if (!Object.hasOwn(config.activityProfiles, event.activity)) {
      throw new Error("unknown theatre activity");
    }
    if (event.requestedAt && observationTime({observedAt: event.requestedAt}) === null) {
      throw new Error("theatre requestedAt must be an ISO timestamp");
    }


    if (event.generation < state.generation) {
      emit("rejected", {reason: "stale-generation", rejectedRequestId: event.requestId});
      trace("intent", "rejected", "stale-generation");
      return;
    }
    if (event.generation === state.generation && state.desired) {
      const duplicate = state.desired.requestId === event.requestId &&
        state.desired.activity === event.activity;
      if (duplicate) {
        trace("intent", "duplicate", null, {requestId: event.requestId});
        reconcile();
        return;
      }
      emit("rejected", {
        reason: state.desired.requestId === event.requestId ? "request-conflict" : "generation-conflict",
        rejectedRequestId: event.requestId
      });
      trace("intent", "rejected", "generation-conflict");
      return;
    }

    const previousDesired = state.desired;
    if (state.desired) {
      emit("superseded", {
        supersededRequestId: state.desired.requestId,
        supersededGeneration: state.desired.generation,
        supersededBy: event.requestId
      });
    }
    const requestedAt = event.requestedAt || now.toISOString();
    state.desired = {
      requestId: event.requestId,
      generation: event.generation,
      activity: event.activity,
      requestedAt
    };
    state.generation = event.generation;
    state.phase = "preparing";
    state.currentActivity = "unknown";
    state.targets = emptyTargets();
    state.refreshPending = emptyRefreshPending();
    state.failure = null;
    state.blockedGeneration = null;
    state.availability = "unknown";
    state.transitionStartedAt = requestedAt;
    state.transitionCompletedAt = null;
    commands.push(...targetIntentCommands(state.desired, config, previousDesired));
    trace("intent", "accepted", null, {activity: event.activity, generation: event.generation});
  }

  function acceptTargetState(event: Extract<TheatreInputEvent, {kind: "target_state"}>) {
    if (!TARGETS.includes(event.target)) throw new Error("unknown theatre target");
    if (!Number.isInteger(event.generation) || event.generation < 1) {
      throw new Error("target generation must be a positive integer");
    }
    if (!Object.hasOwn(TARGET_STATUSES, event.status)) throw new Error("unknown theatre target status");
    if (observationTime(event) === null) throw new Error("target observedAt must be an ISO timestamp");
    if (event.classification && !Object.hasOwn(TARGET_CLASSIFICATIONS, event.classification)) {
      throw new Error("unknown theatre target classification");
    }
    if (!state.desired || event.generation !== state.generation) {
      trace("target-state", "ignored", "stale-generation", {
        target: event.target,
        generation: event.generation
      });
      return;
    }

    const previous = state.targets[event.target];
    const eventTime = observationTime(event);
    const previousTime = observationTime(previous);
    if (previous && eventTime !== null && previousTime !== null && eventTime < previousTime) {
      trace("target-state", "ignored", "out-of-order", {target: event.target});
      return;
    }
    const drifted = state.phase === "ready" &&
      event.status !== "ready" && event.status !== "failed" && event.status !== "unavailable";
    const classification = event.classification || (drifted ? "drift" : null);
    state.targets[event.target] = {
      status: event.status,
      observedAt: event.observedAt,
      classification,
      failure: event.failure && typeof event.failure === "object" ? {...event.failure} : null,
      details: event.details && typeof event.details === "object" ? {...event.details} : null
    };
    state.refreshPending[event.target] = false;
    if (classification) {
      emit(classification, {target: event.target});
      trace("target-state", "classified", classification, {target: event.target});
    } else {
      trace("target-state", "accepted", null, {target: event.target, status: event.status});
    }
    reconcile();
  }

  if (event.kind === "intent") {
    acceptIntent(event);
  } else if (event.kind === "target_state") {
    acceptTargetState(event);
  } else if (event.kind === "startup" || event.kind === "refresh") {
    state.targets = emptyTargets();
    state.refreshPending = emptyRefreshPending();
    if (state.desired) {
      commands.push(...targetRefreshCommands(state.desired));
      for (const target of TARGETS) state.refreshPending[target] = true;
      state.phase = state.blockedGeneration === state.generation ? "failed" : "confirming";
      state.currentActivity = "unknown";
      state.availability = state.blockedGeneration === state.generation
        ? "unavailable"
        : "unknown";
      if (state.blockedGeneration !== state.generation) {
        state.transitionStartedAt = now.toISOString();
        state.transitionCompletedAt = null;
      }
    } else {
      state.phase = "idle";
      state.availability = "unknown";
    }
    trace(event.kind, state.desired ? "refreshing" : "idle");
  } else if (event.kind === "tick") {
    if (Number.isInteger(event.generation) && state.desired && event.generation !== state.generation) {
      trace("tick", "ignored", "stale-generation", {generation: event.generation});
    } else {
      for (const target of TARGETS) {
        const targetState = state.targets[target];
        if (targetState && !isFresh(targetState, nowMs, config.freshnessMs) && !state.refreshPending[target]) {
          commands.push(targetCommand(target, "refresh", state.desired));
          state.refreshPending[target] = true;
        }
      }
      reconcile();
    }
  } else {
    throw new Error("unknown theatre event kind");
  }

  events.unshift(stateEvent(state, config.area));
  return {state, commands, events, traces, status: statusFor(state)};
}
