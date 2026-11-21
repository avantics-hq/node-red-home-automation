"use strict";

import type {LightingEvent} from "./room-controller";

const PROFILE_NAME = /^[a-z][a-z0-9_-]*$/;
const TARGET_NAME = /^[a-z][a-z0-9_-]*$/;

export interface ActivityLightingProfile {
  targets: string[];
  values: Record<string, unknown>;
}

export type ActivityLightingProfiles = Record<string, ActivityLightingProfile>;

export interface ActivityLightingConfig {
  profiles: ActivityLightingProfiles;
  confirmationTimeoutMs: number;
  maxAttempts: number;
}

export interface ActivityLightingDesired {
  requestId: string;
  generation: number;
  profile: string;
  requestedAt: string;
}

export interface ActivityLightingObservation {
  target: string;
  on: boolean;
  manual: boolean;
  available: boolean;
  values: Record<string, unknown>;
  observedAt: string;
}

export interface ActivityLightingPending {
  attempt: number;
  deadlineAt: number;
}

export interface ActivityLightingFailure {
  operation: "apply";
  reason: string;
  occurredAt: string;
}

export interface ActivityLightingState {
  desired: ActivityLightingDesired | null;
  generation: number;
  phase: string;
  observed: Record<string, ActivityLightingObservation>;
  pending: ActivityLightingPending | null;
  failure: ActivityLightingFailure | null;
  blockedGeneration: number | null;
}

export type ActivityLightingEvent =
  | {
    kind: "intent";
    requestId: string;
    generation: number;
    profile: string;
    requestedAt?: string;
  }
  | {
    kind: "observed";
    generation: number;
    target: string;
    on: boolean;
    manual?: boolean;
    available?: boolean;
    values?: Record<string, unknown>;
    observedAt: string;
  }
  | {kind: "command_result"; generation: number; ok: boolean; reason?: string}
  | {kind: "tick"; generation: number}
  | {kind: "startup" | "refresh"};

export interface ActivityLightingMessage {
  activityLighting?: ActivityLightingEvent;
}

export interface ActivityLightingCommand {
  operation: "apply" | "observe";
  requestId: string;
  generation: number;
  profile: string;
  attempt: number;
  lighting?: LightingEvent;
}

export interface ActivityLightingOutputEvent {
  theatre: {
    kind: "target_state";
    target: "lighting";
    requestId: string;
    generation: number;
    status: string;
    observedAt: string;
    details: {
      profile: string;
      matched: number;
      preserved: number;
      expected: number;
    };
    failure?: ActivityLightingFailure;
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
  }
  return value;
}

function valuesMatch(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) =>
    Object.hasOwn(actual, key) && JSON.stringify(stable(actual[key])) === JSON.stringify(stable(value))
  );
}

export function normaliseLightingProfiles(value: unknown): ActivityLightingProfiles {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("lighting profiles must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error("lighting profiles must not be empty");

  const profiles: ActivityLightingProfiles = {};
  for (const [name, descriptorValue] of entries) {
    if (!PROFILE_NAME.test(name)) throw new Error(`invalid lighting profile name: ${name}`);
    if (!descriptorValue || typeof descriptorValue !== "object" || Array.isArray(descriptorValue)) {
      throw new Error(`lighting profile ${name} must be an object`);
    }
    const descriptor = descriptorValue as Record<string, unknown>;
    if (!Array.isArray(descriptor.targets) ||
      descriptor.targets.some((target) => typeof target !== "string" || !TARGET_NAME.test(target))) {
      throw new Error(`lighting profile ${name} has invalid targets`);
    }
    if (new Set(descriptor.targets).size !== descriptor.targets.length) {
      throw new Error(`lighting profile ${name} has duplicate targets`);
    }
    const values = descriptor.values ?? {};
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error(`lighting profile ${name} has invalid values`);
    }
    profiles[name] = {
      targets: [...descriptor.targets],
      values: {...values as Record<string, unknown>}
    };
  }
  return profiles;
}

export function normaliseActivityLightingConfig(
  config: Partial<ActivityLightingConfig> & {profiles?: unknown} = {}
): ActivityLightingConfig {
  return {
    profiles: normaliseLightingProfiles(config.profiles),
    confirmationTimeoutMs: Math.max(1000, Number(config.confirmationTimeoutMs) || 15000),
    maxAttempts: Math.max(1, Math.floor(Number(config.maxAttempts) || 2))
  };
}

function initialState(
  saved: Partial<ActivityLightingState> = {},
  profiles: ActivityLightingProfiles = {}
): ActivityLightingState {
  const desired = saved.desired && Object.hasOwn(profiles, saved.desired.profile)
    ? {...saved.desired}
    : null;
  return {
    desired,
    generation: Number.isInteger(saved.generation) && (saved.generation ?? -1) >= 0 ? saved.generation! : 0,
    phase: typeof saved.phase === "string" ? saved.phase : "idle",
    observed: Object.fromEntries(
      Object.entries(saved.observed || {}).map(([target, observation]) => [target, {...observation}])
    ),
    pending: saved.pending && typeof saved.pending === "object" ? {...saved.pending} : null,
    failure: saved.failure && typeof saved.failure === "object" ? {...saved.failure} : null,
    blockedGeneration: Number.isInteger(saved.blockedGeneration) ? saved.blockedGeneration! : null
  };
}

function profileFor(state: ActivityLightingState, config: ActivityLightingConfig): ActivityLightingProfile {
  if (!state.desired) throw new Error("activity lighting profile requires desired state");
  const profile = config.profiles[state.desired.profile];
  if (!profile) throw new Error("activity lighting profile is missing");
  return profile;
}

function commandFor(
  state: ActivityLightingState,
  config: ActivityLightingConfig,
  operation: "apply" | "observe",
  attempt: number
): ActivityLightingCommand {
  if (!state.desired) throw new Error("activity lighting command requires desired state");
  const profile = profileFor(state, config);
  const command: ActivityLightingCommand = {
    operation,
    requestId: state.desired.requestId,
    generation: state.generation,
    profile: state.desired.profile,
    attempt
  };
  if (operation === "apply") {
    command.lighting = {
      kind: "intent",
      targets: [...profile.targets],
      state: "ON",
      values: {...profile.values},
      source: "activity",
      updateOnOnly: true,
      preserveManual: true
    };
  }
  return command;
}

function statusFor(state: ActivityLightingState) {
  return {
    phase: state.phase,
    text: `${state.desired?.profile || "none"}: ${state.phase}`
  };
}

export function transitionActivityLighting(
  saved: Partial<ActivityLightingState> | undefined,
  msg: ActivityLightingMessage,
  suppliedConfig: Partial<ActivityLightingConfig> & {profiles?: unknown} = {},
  nowValue: Date | string | number = new Date()
) {
  const config = normaliseActivityLightingConfig(suppliedConfig);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("now must be a valid date");

  const state = initialState(saved, config.profiles);
  const event = msg?.activityLighting;
  const commands: ActivityLightingCommand[] = [];
  const events: ActivityLightingOutputEvent[] = [];
  const traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [];
  let counts = {matched: 0, preserved: 0, expected: 0};

  if (!event || typeof event.kind !== "string") {
    throw new Error("msg.activityLighting.kind is required");
  }

  function trace(name: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) {
    traces.push({event: name, outcome, reason, details});
  }

  function fail(reason: string) {
    state.pending = null;
    state.phase = "failed";
    state.blockedGeneration = state.generation;
    state.failure = {operation: "apply", reason, occurredAt: now.toISOString()};
    trace("lighting", "failed", reason, {profile: state.desired?.profile ?? null});
  }

  function issueApply(attempt: number) {
    commands.push(commandFor(state, config, "apply", attempt));
    state.pending = {attempt, deadlineAt: nowMs + config.confirmationTimeoutMs};
    state.phase = "transitioning";
    trace("command", "emitted", null, {operation: "apply", profile: state.desired?.profile, attempt});
  }

  function reconcile() {
    if (!state.desired) return;
    const profile = profileFor(state, config);
    counts = {matched: 0, preserved: 0, expected: profile.targets.length};
    if (profile.targets.length === 0) {
      state.pending = null;
      state.failure = null;
      state.phase = "ready";
      trace("lighting", "ready", null, {profile: state.desired.profile, preserved: 0});
      return;
    }
    for (const target of profile.targets) {
      const observation = state.observed[target];
      if (!observation) {
        state.phase = state.phase === "transitioning" ? "transitioning" : "confirming";
        return;
      }
      if (!observation.available) {
        fail("lighting-unavailable");
        return;
      }
      if (observation.manual || !observation.on) {
        counts.preserved += 1;
        continue;
      }
      if (!valuesMatch(profile.values, observation.values)) {
        state.phase = "confirming";
        return;
      }
      counts.matched += 1;
    }
    state.pending = null;
    state.failure = null;
    state.blockedGeneration = null;
    state.phase = "ready";
    trace("lighting", "ready", null, {
      profile: state.desired.profile,
      matched: counts.matched,
      preserved: counts.preserved
    });
  }

  function acceptIntent(intent: Extract<ActivityLightingEvent, {kind: "intent"}>) {
    if (typeof intent.requestId !== "string" || !intent.requestId) {
      throw new Error("activity lighting requestId is required");
    }
    if (!Number.isInteger(intent.generation) || intent.generation < 1) {
      throw new Error("activity lighting generation must be a positive integer");
    }
    if (!Object.hasOwn(config.profiles, intent.profile)) throw new Error("unknown activity lighting profile");
    const requestedAt = intent.requestedAt || now.toISOString();
    if (!Number.isFinite(Date.parse(requestedAt))) throw new Error("activity lighting requestedAt must be an ISO timestamp");
    if (intent.generation < state.generation) {
      trace("intent", "ignored", "stale-generation");
      return;
    }
    if (intent.generation === state.generation && state.desired) {
      const duplicate = state.desired.requestId === intent.requestId && state.desired.profile === intent.profile;
      trace("intent", duplicate ? "duplicate" : "rejected", duplicate ? null : "generation-conflict");
      return;
    }
    state.desired = {
      requestId: intent.requestId,
      generation: intent.generation,
      profile: intent.profile,
      requestedAt
    };
    state.generation = intent.generation;
    state.observed = {};
    state.pending = null;
    state.failure = null;
    state.blockedGeneration = null;
    if (profileFor(state, config).targets.length === 0) reconcile();
    else issueApply(1);
    trace("intent", "accepted", null, {profile: intent.profile, generation: intent.generation});
  }

  function acceptObservation(observation: Extract<ActivityLightingEvent, {kind: "observed"}>) {
    if (!Number.isInteger(observation.generation) || observation.generation < 1) {
      throw new Error("activity lighting observation generation must be a positive integer");
    }
    if (!TARGET_NAME.test(observation.target)) throw new Error("invalid activity lighting target");
    const observedAt = Date.parse(observation.observedAt || "");
    if (!Number.isFinite(observedAt)) throw new Error("activity lighting observedAt must be an ISO timestamp");
    if (!state.desired || observation.generation !== state.generation) {
      trace("observation", "ignored", "stale-generation");
      return;
    }
    const profile = profileFor(state, config);
    if (!profile.targets.includes(observation.target)) {
      trace("observation", "ignored", "not-profile-target", {target: observation.target});
      return;
    }
    if (observedAt < Date.parse(state.desired.requestedAt)) {
      trace("observation", "ignored", "stale-observation", {target: observation.target});
      return;
    }
    const previousAt = Date.parse(state.observed[observation.target]?.observedAt || "");
    if (Number.isFinite(previousAt) && observedAt < previousAt) {
      trace("observation", "ignored", "out-of-order", {target: observation.target});
      return;
    }
    state.observed[observation.target] = {
      target: observation.target,
      on: observation.on === true,
      manual: observation.manual === true,
      available: observation.available !== false,
      values: observation.values && typeof observation.values === "object" ? {...observation.values} : {},
      observedAt: observation.observedAt
    };
    trace("observation", "accepted", null, {target: observation.target});
    reconcile();
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
      trace("command-result", "accepted");
    } else if (state.pending.attempt < config.maxAttempts) {
      issueApply(state.pending.attempt + 1);
    } else {
      fail(typeof event.reason === "string" && event.reason ? event.reason : "command-failed");
    }
  } else if (event.kind === "tick") {
    if (!state.desired || event.generation !== state.generation || !state.pending) {
      trace("tick", "ignored", "stale-generation");
    } else if (nowMs >= state.pending.deadlineAt) {
      if (state.pending.attempt < config.maxAttempts) issueApply(state.pending.attempt + 1);
      else fail("confirmation-timeout");
    }
  } else if (event.kind === "startup" || event.kind === "refresh") {
    state.observed = {};
    state.pending = null;
    if (state.desired) {
      if (profileFor(state, config).targets.length === 0) reconcile();
      else {
        commands.push(commandFor(state, config, "observe", 0));
        state.phase = "confirming";
        trace(event.kind, "observing", null, {profile: state.desired.profile});
      }
    } else {
      trace(event.kind, "idle");
    }
  } else {
    throw new Error("unknown activity lighting event kind");
  }

  if (state.desired) {
    const theatre: ActivityLightingOutputEvent["theatre"] = {
      kind: "target_state",
      target: "lighting",
      requestId: state.desired.requestId,
      generation: state.generation,
      status: state.phase === "failed" ? "failed" : state.phase === "ready" ? "ready" : state.phase,
      observedAt: now.toISOString(),
      details: {
        profile: state.desired.profile,
        matched: counts.matched,
        preserved: counts.preserved,
        expected: profileFor(state, config).targets.length
      }
    };
    if (state.failure) theatre.failure = {...state.failure};
    events.push({theatre});
  }

  return {state, commands, events, traces, status: statusFor(state)};
}
