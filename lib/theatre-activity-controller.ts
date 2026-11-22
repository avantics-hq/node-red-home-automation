"use strict";

import {boundObservedAt, isFresh as isFreshAt, isOutOfOrder, parseObservedAt} from "./observation-time";

const PROFILE_NAME = /^[a-z][a-z0-9_-]*$/;
export const TARGETS = ["display", "avr", "source", "lighting", "backlighting"] as const;
const REQUIRED_TARGETS = ["display", "avr", "backlighting"] as const;
const OPTIONAL_TARGETS = ["lighting"] as const;

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
const BACKLIGHTING_POWER: Record<ActivityBacklightingProfile["power"], true> = {
  on: true,
  off: true
};

export interface ActivitySourceProfile extends Record<string, unknown> {
  action: "activate" | "deactivate";
  readiness: "required" | "optional";
  sourceId?: string | null;
}

export interface ActivityLightingProfile extends Record<string, unknown> {
  profile: string;
}

export interface ActivityBacklightingProfile extends Record<string, unknown> {
  power: "on" | "off";
}

export type ActivityProfile = Record<TheatreTarget, Record<string, unknown>> & {
  source: ActivitySourceProfile;
  lighting: ActivityLightingProfile;
  backlighting: ActivityBacklightingProfile;
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

export interface TheatreTargetMetrics {
  attempts: number;
  retries: number;
  failures: number;
  manualOverrides: number;
  fallbackUses: number;
  fallbackUsed: boolean;
  lastConfirmationMs: number | null;
  observationAgeMs: number | null;
  availability: TheatreAvailability;
}

export interface TheatreMetrics {
  requests: number;
  ready: number;
  failed: number;
  superseded: number;
  manualOverrides: number;
  driftEvents: number;
  recoveriesAdopted: number;
  recoveriesSafeOff: number;
  lastTransitionMs: number | null;
  maxTransitionMs: number | null;
  lastOutcome: string | null;
  targets: Record<TheatreTarget, TheatreTargetMetrics>;
}

export interface RecoveryObservation {
  observedAt: string;
  values: Record<string, unknown>;
}

export type RecoveryObservations = Partial<Record<TheatreTarget, RecoveryObservation>>;

// A refresh sent to a target owner and not yet answered.
export interface RefreshPending {
  sentAt: number;
  attempts: number;
  exhausted: boolean;
}

export interface TheatreState {
  desired: TheatreDesired | null;
  currentActivity: string;
  generation: number;
  // The highest generation proposed by a request from outside (not
  // recovery). A new request proposing more than that is never lost to a
  // generation the controller used meanwhile; it gets the next free one.
  lastProposedGeneration: number;
  phase: string;
  targets: Record<TheatreTarget, TargetState | null>;
  refreshPending: Record<TheatreTarget, RefreshPending | null>;
  failure: TheatreFailure | null;
  blockedGeneration: number | null;
  degraded: Array<{target: TheatreTarget; reason: string}>;
  availability: TheatreAvailability;
  transitionStartedAt: string | null;
  transitionCompletedAt: string | null;
  metrics: TheatreMetrics;
}

export interface TheatreConfig {
  area: string;
  freshnessMs: number;
  activityProfiles: ActivityProfiles;
  recoveryOffActivity?: string;
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
  | {kind: "tick"; generation?: number}
  | {kind: "recover"; reason: "startup" | "manual_override"; observations: RecoveryObservations};

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
    const lighting = targets.lighting;
    if (typeof lighting.profile !== "string" || !PROFILE_NAME.test(lighting.profile)) {
      throw new Error(`activity profile ${name} has invalid lighting profile`);
    }
    const backlighting = targets.backlighting;
    if (!Object.hasOwn(BACKLIGHTING_POWER, backlighting.power as PropertyKey)) {
      throw new Error(`activity profile ${name} has invalid backlighting power`);
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

// A refresh is re-sent at this many attempts at most before the target is
// reported as not responding.
const REFRESH_ATTEMPTS = 3;

function emptyRefreshPending(
  saved: Partial<Record<TheatreTarget, RefreshPending | boolean | null>> = {}
): Record<TheatreTarget, RefreshPending | null> {
  return Object.fromEntries(TARGETS.map((target) => {
    const entry = saved[target];
    // Saved before retries existed: pending with no send time, so it retries.
    if (entry === true) return [target, {sentAt: 0, attempts: 1, exhausted: false}];
    if (entry && typeof entry === "object" && Number.isFinite(entry.sentAt) && Number.isInteger(entry.attempts)) {
      return [target, {sentAt: entry.sentAt, attempts: entry.attempts, exhausted: entry.exhausted === true}];
    }
    return [target, null];
  })) as Record<TheatreTarget, RefreshPending | null>;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableDuration(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function targetMetrics(
  saved: Partial<Record<TheatreTarget, Partial<TheatreTargetMetrics>>> = {}
): Record<TheatreTarget, TheatreTargetMetrics> {
  return Object.fromEntries(TARGETS.map((target) => {
    const metric = saved[target] || {};
    const availability = typeof metric.availability === "string" &&
      Object.hasOwn(AVAILABILITIES, metric.availability)
      ? metric.availability as TheatreAvailability
      : "unknown";
    return [target, {
      attempts: count(metric.attempts),
      retries: count(metric.retries),
      failures: count(metric.failures),
      manualOverrides: count(metric.manualOverrides),
      fallbackUses: count(metric.fallbackUses),
      fallbackUsed: metric.fallbackUsed === true,
      lastConfirmationMs: nullableDuration(metric.lastConfirmationMs),
      observationAgeMs: nullableDuration(metric.observationAgeMs),
      availability
    }];
  })) as Record<TheatreTarget, TheatreTargetMetrics>;
}

function createMetrics(saved: Partial<TheatreMetrics> = {}): TheatreMetrics {
  return {
    requests: count(saved.requests),
    ready: count(saved.ready),
    failed: count(saved.failed),
    superseded: count(saved.superseded),
    manualOverrides: count(saved.manualOverrides),
    driftEvents: count(saved.driftEvents),
    recoveriesAdopted: count(saved.recoveriesAdopted),
    recoveriesSafeOff: count(saved.recoveriesSafeOff),
    lastTransitionMs: nullableDuration(saved.lastTransitionMs),
    maxTransitionMs: nullableDuration(saved.maxTransitionMs),
    lastOutcome: typeof saved.lastOutcome === "string" ? saved.lastOutcome : null,
    targets: targetMetrics(saved.targets)
  };
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
    lastProposedGeneration: Number.isInteger(saved.lastProposedGeneration)
      ? saved.lastProposedGeneration!
      : savedDesired && !savedDesired.requestId.startsWith("recovery-") && Number.isInteger(savedDesired.generation)
        ? savedDesired.generation
        : 0,
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
      : null,
    metrics: createMetrics(saved.metrics)
  };
}

export function normaliseConfig(
  config: Partial<TheatreConfig> & {activityProfiles?: unknown} = {}
): TheatreConfig {
  const activityProfiles = normaliseActivityProfiles(config.activityProfiles);
  const recoveryOffActivity = typeof config.recoveryOffActivity === "string" &&
    config.recoveryOffActivity
    ? config.recoveryOffActivity
    : "off";
  return {
    area: typeof config.area === "string" && config.area ? config.area : "room",
    freshnessMs: Math.max(1000, Number(config.freshnessMs) || 30000),
    activityProfiles,
    recoveryOffActivity
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

function targetProbeCommands(): TargetCommand[] {
  return TARGETS.map((target) => targetCommand(target, "refresh", null));
}

function observationTime(targetState: {observedAt?: string} | null | undefined): number | null {
  return typeof targetState?.observedAt === "string" ? parseObservedAt(targetState.observedAt) : null;
}

function isFresh(targetState: {observedAt: string}, nowMs: number, freshnessMs: number): boolean {
  return isFreshAt(observationTime(targetState), nowMs, freshnessMs);
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
      requestedAt: state.desired?.requestedAt || null,
      currentActivity: state.currentActivity,
      phase: state.phase,
      availability: state.availability,
      transitionStartedAt: state.transitionStartedAt,
      transitionCompletedAt: state.transitionCompletedAt,
      targets: emptyTargets(state.targets),
      failure: state.failure ? {...state.failure} : null,
      degraded: state.degraded.map((entry) => ({...entry})),
      metrics: createMetrics(state.metrics)
    }
  };
}

const RECOVERY_TARGETS: readonly TheatreTarget[] = ["display", "avr", "source", "backlighting"];

function matchesExpected(expected: unknown, observed: unknown): boolean {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    return Object.is(expected, observed);
  }
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) return false;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
    matchesExpected(value, (observed as Record<string, unknown>)[key]));
}

function recoveryMatches(
  profile: ActivityProfile,
  observations: RecoveryObservations,
  nowMs: number,
  freshnessMs: number
): boolean {
  return RECOVERY_TARGETS.every((target) => {
    const observation = observations[target];
    if (!observation || !isFresh(observation, nowMs, freshnessMs)) return false;
    const expected = {...profile[target]};
    if (target === "source") delete expected.readiness;
    return matchesExpected(expected, observation.values);
  });
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

  function completeTransition(outcome: "ready" | "failed" | "manual_override") {
    const startedAt = Date.parse(state.transitionStartedAt || "");
    if (Number.isFinite(startedAt)) {
      const duration = Math.max(0, nowMs - startedAt);
      state.metrics.lastTransitionMs = duration;
      state.metrics.maxTransitionMs = Math.max(state.metrics.maxTransitionMs || 0, duration);
    }
    state.metrics.lastOutcome = outcome;
    if (outcome === "ready") state.metrics.ready += 1;
    if (outcome === "failed") state.metrics.failed += 1;
  }

  function resetTransitionMetrics() {
    for (const target of TARGETS) {
      const metric = state.metrics.targets[target];
      metric.attempts = 0;
      metric.retries = 0;
      metric.fallbackUsed = false;
      metric.lastConfirmationMs = null;
      metric.observationAgeMs = null;
      metric.availability = "unknown";
    }
  }

  function updateTargetMetrics(
    target: TheatreTarget,
    targetState: TargetState,
    previous: TargetState | null
  ) {
    const metric = state.metrics.targets[target];
    const details = targetState.details && typeof targetState.details === "object"
      ? targetState.details
      : {};
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
    const observedAt = observationTime(targetState);
    metric.observationAgeMs = observedAt === null ? null : Math.max(0, nowMs - observedAt);
    if (targetState.status === "ready") {
      const startedAt = Date.parse(state.transitionStartedAt || "");
      metric.lastConfirmationMs = Number.isFinite(startedAt) && observedAt !== null
        ? Math.max(0, observedAt - startedAt)
        : null;
      metric.availability = "available";
    } else if (targetState.status === "failed" || targetState.status === "unavailable") {
      metric.availability = "unavailable";
      if (previous?.status !== targetState.status) metric.failures += 1;
    } else {
      metric.availability = "degraded";
    }
  }

  function fail(target: TheatreTarget, targetState: TargetState) {
    const firstFailure = state.phase !== "failed";
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
    if (firstFailure) completeTransition("failed");
  }

  function reconcile() {
    const previousPhase = state.phase;
    const previousCurrent = state.currentActivity;
    state.degraded = [];

    if (!state.desired) {
      if (state.phase !== "recovering") state.phase = "idle";
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

    const manualTarget = TARGETS.find((target) => {
      const targetState = state.targets[target];
      return targetState?.classification === "manual_override" &&
        isFresh(targetState, nowMs, config.freshnessMs);
    });
    if (manualTarget) {
      state.phase = "manual_override";
      state.currentActivity = "unknown";
      state.availability = "degraded";
      if (previousPhase !== "manual_override") {
        completeTransition("manual_override");
        emit("manual_override", {target: manualTarget});
        trace("activity", "manual_override", null, {target: manualTarget});
      }
      return;
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

    // Once this activity is ready, a confirmed target that is only due for
    // re-confirmation keeps it ready; the staleness shows in degraded.
    const holdReady = previousPhase === "ready" && previousCurrent === state.desired.activity;
    const unverified = (target: TheatreTarget) => {
      state.degraded.push({target, reason: state.refreshPending[target]?.exhausted ? "no-response" : "stale"});
    };

    for (const target of REQUIRED_TARGETS) {
      const targetState = state.targets[target];
      if (targetState && holdReady && targetState.status === "ready" &&
        !isFresh(targetState, nowMs, config.freshnessMs)) {
        unverified(target);
        continue;
      }
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
      const staleButHeld = source && holdReady && source.status === "ready" &&
        !isFresh(source, nowMs, config.freshnessMs);
      if (staleButHeld) unverified("source");
      else if (!source || !isFresh(source, nowMs, config.freshnessMs) || source.status !== "ready") {
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
      // Only the first ready of a generation completes its transition.
      if (state.transitionCompletedAt === null) {
        state.transitionCompletedAt = now.toISOString();
        completeTransition("ready");
      }
      emit("ready");
      trace("activity", "ready", null, {activity: state.currentActivity});
    }
  }

  // Refresh each confirmed target at half its freshness window, so a settled
  // activity stays fresh, and re-send an unanswered refresh a bounded number
  // of times before reporting the target as not responding.
  function tickRefreshes() {
    const intervalMs = config.freshnessMs / 2;
    for (const target of TARGETS) {
      const pending = state.refreshPending[target];
      if (pending) {
        if (pending.exhausted || nowMs - pending.sentAt < intervalMs) continue;
        if (pending.attempts < REFRESH_ATTEMPTS) {
          commands.push(targetCommand(target, "refresh", state.desired));
          state.refreshPending[target] = {sentAt: nowMs, attempts: pending.attempts + 1, exhausted: false};
          trace("refresh", "retried", null, {target, attempt: pending.attempts + 1});
        } else {
          pending.exhausted = true;
          noResponse(target);
        }
        continue;
      }
      const targetState = state.targets[target];
      const observedAt = observationTime(targetState);
      if (state.desired && targetState && observedAt !== null && nowMs - observedAt >= intervalMs) {
        commands.push(targetCommand(target, "refresh", state.desired));
        state.refreshPending[target] = {sentAt: nowMs, attempts: 1, exhausted: false};
      }
    }
  }

  function noResponse(target: TheatreTarget) {
    state.metrics.targets[target].availability = "unavailable";
    trace("refresh", "no-response", null, {target, attempts: REFRESH_ATTEMPTS});
    // Before the activity first completes, an owner that never answers is
    // unavailable; afterwards it shows as degraded and does not undo ready.
    if (state.desired && state.transitionCompletedAt === null) {
      state.targets[target] = {
        status: "unavailable",
        observedAt: now.toISOString(),
        classification: null,
        failure: {operation: "refresh", reason: "no-response", occurredAt: now.toISOString()},
        details: null
      };
    }
  }

  function acceptIntent(event: Extract<TheatreInputEvent, {kind: "intent"}>, internal = false) {
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


    // The controller owns generations: a new request whose proposed number is
    // already taken (for example by a recovery) gets the next free one.
    let generation = event.generation;
    const taken = generation < state.generation || (generation === state.generation && state.desired !== null);
    if (taken && !internal && state.desired?.requestId !== event.requestId &&
      event.generation > state.lastProposedGeneration) {
      generation = state.generation + 1;
      trace("intent", "reassigned", "generation-taken", {requestId: event.requestId, proposed: event.generation, assigned: generation});
    } else if (event.generation < state.generation) {
      emit("rejected", {reason: "stale-generation", rejectedRequestId: event.requestId});
      trace("intent", "rejected", "stale-generation");
      return;
    }
    if (generation === state.generation && state.desired) {
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
      state.metrics.superseded += 1;
    }
    const requestedAt = event.requestedAt || now.toISOString();
    state.desired = {
      requestId: event.requestId,
      generation,
      activity: event.activity,
      requestedAt
    };
    state.generation = generation;
    if (!internal) state.lastProposedGeneration = Math.max(state.lastProposedGeneration, event.generation);
    state.phase = "preparing";
    state.currentActivity = "unknown";
    state.targets = emptyTargets();
    state.refreshPending = emptyRefreshPending();
    state.failure = null;
    state.blockedGeneration = null;
    state.availability = "unknown";
    state.transitionStartedAt = requestedAt;
    state.transitionCompletedAt = null;
    state.metrics.requests += 1;
    resetTransitionMetrics();
    commands.push(...targetIntentCommands(state.desired, config, previousDesired));
    trace("intent", "accepted", null, {activity: event.activity, generation});
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
    const bounded = boundObservedAt(event.observedAt, observationTime(event)!, nowMs);
    if (bounded.skewed) {
      trace("target-state", "adjusted", "clock-skew", {target: event.target, reported: event.observedAt, usedAt: bounded.observedAt});
    }
    if (previous && isOutOfOrder(bounded.ms, previous.observedAt, nowMs)) {
      trace("target-state", "ignored", "out-of-order", {target: event.target});
      return;
    }
    const drifted = state.phase === "ready" &&
      event.status !== "ready" && event.status !== "failed" && event.status !== "unavailable";
    const classification = event.classification || (drifted ? "drift" : null);
    state.targets[event.target] = {
      status: event.status,
      observedAt: bounded.observedAt,
      classification,
      failure: event.failure && typeof event.failure === "object" ? {...event.failure} : null,
      details: event.details && typeof event.details === "object" ? {...event.details} : null
    };
    updateTargetMetrics(event.target, state.targets[event.target]!, previous);
    if (classification === "manual_override" && previous?.classification !== classification) {
      state.metrics.manualOverrides += 1;
      state.metrics.targets[event.target].manualOverrides += 1;
    } else if (classification === "drift" && previous?.classification !== classification) {
      state.metrics.driftEvents += 1;
    }
    state.refreshPending[event.target] = null;
    if (classification) {
      emit(classification, {target: event.target});
      trace("target-state", "classified", classification, {target: event.target});
    } else {
      trace("target-state", "accepted", null, {target: event.target, status: event.status});
    }
    reconcile();
  }

  function acceptRecovery(event: Extract<TheatreInputEvent, {kind: "recover"}>) {
    if (!event.observations || typeof event.observations !== "object" ||
      Array.isArray(event.observations)) {
      throw new Error("recovery observations must be an object");
    }
    if (event.reason === "startup" && state.desired) {
      trace("recovery", "ignored", "active-desired-state");
      return;
    }
    if (event.reason === "manual_override" && state.phase !== "manual_override") {
      trace("recovery", "ignored", "manual-override-cleared");
      return;
    }

    const matches = Object.entries(config.activityProfiles)
      .filter(([, profile]) => recoveryMatches(profile, event.observations, nowMs, config.freshnessMs))
      .map(([activity]) => activity);
    if (matches.length === 1) {
      const activity = matches[0]!;
      const generation = state.generation + 1;
      const requestedAt = now.toISOString();
      state.desired = {
        requestId: `recovery-${event.reason}-${nowMs}`,
        generation,
        activity,
        requestedAt
      };
      state.generation = generation;
      state.targets = emptyTargets();
      state.refreshPending = emptyRefreshPending();
      state.failure = null;
      state.blockedGeneration = null;
      state.degraded = [];
      state.transitionStartedAt = requestedAt;
      state.transitionCompletedAt = requestedAt;
      resetTransitionMetrics();
      for (const target of TARGETS) {
        const observation = event.observations[target];
        state.targets[target] = {
          status: "ready",
          observedAt: observation?.observedAt || requestedAt,
          classification: null,
          failure: null,
          details: {
            recovery: observation?.values || {},
            ownership: target === "lighting" && !observation ? "preserved" : "observed"
          }
        };
        updateTargetMetrics(target, state.targets[target]!, null);
      }
      state.phase = "ready";
      state.currentActivity = activity;
      state.availability = "available";
      state.metrics.recoveriesAdopted += 1;
      completeTransition("ready");
      state.metrics.lastOutcome = "recovery_adopted";
      emit("recovery_adopted", {reason: event.reason, matchedActivity: activity});
      trace("recovery", "adopted", null, {reason: event.reason, activity});
      return;
    }

    if (event.reason === "startup") {
      if (!Object.hasOwn(config.activityProfiles, config.recoveryOffActivity!)) {
        throw new Error(`recovery off activity does not exist: ${config.recoveryOffActivity}`);
      }
      state.metrics.recoveriesSafeOff += 1;
      acceptIntent({
        kind: "intent",
        requestId: `recovery-safe-off-${nowMs}`,
        generation: state.generation + 1,
        activity: config.recoveryOffActivity!,
        requestedAt: now.toISOString()
      }, true);
      emit("recovery_safe_off", {
        matchCount: matches.length,
        matchedActivities: matches
      });
      trace("recovery", "safe_off", matches.length ? "ambiguous" : "no-clean-match", {
        matchedActivities: matches
      });
      return;
    }

    state.phase = "manual_override";
    state.currentActivity = "unknown";
    state.availability = "degraded";
    state.metrics.lastOutcome = "manual_override";
    emit("recovery_ambiguous", {
      matchCount: matches.length,
      matchedActivities: matches
    });
    trace("recovery", "held", matches.length ? "ambiguous" : "no-clean-match", {
      matchedActivities: matches
    });
  }

  if (event.kind === "intent") {
    acceptIntent(event);
  } else if (event.kind === "target_state") {
    acceptTargetState(event);
  } else if (event.kind === "recover") {
    acceptRecovery(event);
  } else if (event.kind === "startup" || event.kind === "refresh") {
    state.targets = emptyTargets();
    state.refreshPending = emptyRefreshPending();
    if (state.desired) {
      commands.push(...targetRefreshCommands(state.desired));
      for (const target of TARGETS) state.refreshPending[target] = {sentAt: nowMs, attempts: 1, exhausted: false};
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
      commands.push(...targetProbeCommands());
      for (const target of TARGETS) state.refreshPending[target] = {sentAt: nowMs, attempts: 1, exhausted: false};
      state.phase = "recovering";
      state.availability = "unknown";
      emit("recovery_required", {reason: "startup"});
    }
    trace(event.kind, state.desired ? "refreshing" : "recovering");
  } else if (event.kind === "tick") {
    if (Number.isInteger(event.generation) && state.desired && event.generation !== state.generation) {
      trace("tick", "ignored", "stale-generation", {generation: event.generation});
    } else {
      tickRefreshes();
      if (!state.desired && state.phase === "recovering" &&
        TARGETS.every((target) => state.refreshPending[target]?.exhausted === true)) {
        // Nobody supplied recovery observations: fall back as for no evidence.
        trace("recovery", "timed-out", "no-observations");
        acceptRecovery({kind: "recover", reason: "startup", observations: {}});
      } else {
        reconcile();
      }
    }
  } else {
    throw new Error("unknown theatre event kind");
  }

  events.unshift(stateEvent(state, config.area));
  return {state, commands, events, traces, status: statusFor(state)};
}
