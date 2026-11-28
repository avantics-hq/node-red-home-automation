"use strict";

import {REMOVED_LIGHT_FIELDS} from "./z2m-light";
import {ADOPTED_MISMATCH, adoptableRefresh, isAdopted, readsOnly, savedAdoptedGeneration, adoptionReason, carryOn, answersRequest, savedCarried, type Carried} from "./adopted-request";
import type {TraceEntry} from "./bounded-trace";
import {numberSetting, textSetting} from "./settings";

import {boundObservedAt, isOutOfOrder, parseObservedAt} from "./observation-time";
import type {LightingEvent} from "./room-controller";
import {asTargetStatus, targetStateEvent, type TargetStateEvent} from "./target-state";

const PROFILE_NAME = /^[a-z][a-z0-9_-]*$/;
const TARGET_NAME = /^[a-z][a-z0-9_-]*$/;

export interface ActivityLightingProfile {
  targets: string[];
  values: Record<string, unknown>;
}

export type ActivityLightingProfiles = Record<string, ActivityLightingProfile>;

export interface ActivityLightingConfig {
  profiles: ActivityLightingProfiles;
  // Room-controller owner for the lights this node styles; one per node, so a
  // profile change keeps or releases lights under the same name.
  owner: string;
  confirmationTimeoutMs: number;
  maxAttempts: number;
}

export interface ActivityLightingDesired {
  requestId: string;
  generation: number;
  profile: string;
  requestedAt: string;
}

// A light's reading, as its adapter gave it and the room passed it on.
export interface ActivityLightingObservation {
  target: string;
  on: boolean;
  manual: boolean;
  available: boolean;
  // It shows exactly the last command sent to it, as its adapter judged.
  showsLast: boolean;
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

// The lights this node last overrode, kept apart from desired so a release
// survives profiles being renamed or edited across a redeploy. targets null:
// state saved before this was recorded, with a profile no longer configured.
export interface ActivityLightingApplied {
  profile: string;
  targets: string[] | null;
}

export interface ActivityLightingState {
  desired: ActivityLightingDesired | null;
  applied: ActivityLightingApplied | null;
  generation: number;
  phase: string;
  observed: Record<string, ActivityLightingObservation>;
  pending: ActivityLightingPending | null;
  failure: ActivityLightingFailure | null;
  blockedGeneration: number | null;
  // The generation adopted from a refresh (see adopted-request.ts).
  adoptedGeneration: number | null;
  // The generation a request carried on from (see carryOn).
  carried?: Carried | null;
  // The value fields each light has reported since the node started, such
  // as brightness or color_temp. A light that has reported none of a
  // profile's fields, as one that only switches on and off, is confirmed by
  // being on; once it has reported one, it is held to the values.
  reported?: Record<string, string[]>;
  // The lights this request has seen held (on, and not a person's), and the
  // ones a person then took over (manual_override), which the next request
  // takes back.
  held?: string[];
  overridden?: string[];
  // Profile lights with no reading at all by the confirmation deadline (a
  // Zigbee2MQTT group with no retained state, say): the profile is ready
  // without them, and the theatre is told so. A reading clears one.
  unobserved?: string[];
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
    // From the light's adapter (light-contract.ts): the value fields it
    // reports at all (brightness, colorTemp), and whether it shows exactly
    // the last command sent to it.
    fields?: string[];
    showsLast?: boolean;
    observedAt: string;
  }
  | {kind: "command_result"; generation: number; ok: boolean; reason?: string}
  | {kind: "tick"; generation: number}
  | {kind: "startup"}
  // From the theatre activity controller, with the activity's wanted values.
  | {kind: "refresh"; requestId?: string | null; generation?: number; profile?: string};

export interface ActivityLightingMessage {
  activityLighting?: ActivityLightingEvent;
}

export interface ActivityLightingCommand {
  operation: "apply" | "observe" | "release";
  requestId: string;
  generation: number;
  profile: string;
  attempt: number;
  lighting?: LightingEvent;
}

export interface ActivityLightingOutputEvent {
  theatre: TargetStateEvent<"lighting", {
    profile: string;
    matched: number;
    preserved: number;
    expected: number;
    metrics: {attempts: number; retries: number; fallbackUsed: boolean};
  }, ActivityLightingFailure>;
}


// Whether a light's report shows the profile's values. Reports come in the
// light's own units, so the profile's are converted first (z2m-light).
// Traced when a light the profile gives values to has never reported any of
// them since start, so it is confirmed by being on: the node warns once.
export const VALUES_NOT_REPORTED = "values-not-reported";

// The reading fields that show a profile's values.
const PROFILE_FIELDS: Record<string, string> = {brightnessPct: "brightness", colorTempKelvin: "colorTemp"};

// Whether a light has reported any of the profile's fields since start; true
// when the profile sets none of them, as then there is nothing but on to
// check.
function reportsAnyOf(profileValues: Record<string, unknown>, reported: readonly string[]): boolean {
  const expected = Object.keys(profileValues).flatMap((key) => (PROFILE_FIELDS[key] ? [PROFILE_FIELDS[key]!] : []));
  return expected.length === 0 || expected.some((field) => reported.includes(field));
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
    // The package's own units, checked when deployed so a bad profile shows
    // on the node rather than leaving lights unstyled.
    const removed = (REMOVED_LIGHT_FIELDS as readonly string[]).filter((field) => Object.hasOwn(values, field));
    if (removed.length) {
      throw new Error(`lighting profile ${name} uses ${removed.join(" and ")}, removed in 6.0: use brightnessPct (0-100) and colorTempKelvin`);
    }
    const {brightnessPct, colorTempKelvin} = values as Record<string, unknown>;
    if (brightnessPct !== undefined &&
      (typeof brightnessPct !== "number" || !Number.isFinite(brightnessPct) || brightnessPct < 0 || brightnessPct > 100)) {
      throw new Error(`lighting profile ${name} brightnessPct must be a number from 0 to 100`);
    }
    if (colorTempKelvin !== undefined &&
      (typeof colorTempKelvin !== "number" || !Number.isFinite(colorTempKelvin) || colorTempKelvin <= 0)) {
      throw new Error(`lighting profile ${name} colorTempKelvin must be a number above 0`);
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
    owner: textSetting(config.owner, "owner", "activity"),
    confirmationTimeoutMs: Math.max(1000, numberSetting(config.confirmationTimeoutMs, "confirmation timeout", 15000)),
    maxAttempts: Math.max(1, Math.floor(numberSetting(config.maxAttempts, "max attempts", 2)))
  };
}

function initialState(
  saved: Partial<ActivityLightingState> = {},
  profiles: ActivityLightingProfiles = {}
): ActivityLightingState {
  const desired = saved.desired && Object.hasOwn(profiles, saved.desired.profile)
    ? {...saved.desired}
    : null;
  const legacyTargets = saved.desired ? profiles[saved.desired.profile]?.targets : undefined;
  const applied = saved.applied && typeof saved.applied === "object"
    ? {profile: saved.applied.profile, targets: Array.isArray(saved.applied.targets) ? [...saved.applied.targets] : null}
    : saved.desired
      ? {profile: saved.desired.profile, targets: legacyTargets ? [...legacyTargets] : null}
      : null;
  return {
    desired,
    applied,
    generation: Number.isInteger(saved.generation) && (saved.generation ?? -1) >= 0 ? saved.generation! : 0,
    phase: typeof saved.phase === "string" ? saved.phase : "idle",
    observed: Object.fromEntries(
      Object.entries(saved.observed || {}).map(([target, observation]) => [target, {...observation}])
    ),
    pending: saved.pending && typeof saved.pending === "object" ? {...saved.pending} : null,
    failure: saved.failure && typeof saved.failure === "object" ? {...saved.failure} : null,
    blockedGeneration: Number.isInteger(saved.blockedGeneration) ? saved.blockedGeneration! : null,
    adoptedGeneration: savedAdoptedGeneration(saved),
    carried: savedCarried(saved),
    reported: Object.fromEntries(Object.entries(saved.reported || {})
      .filter(([, fields]) => Array.isArray(fields)).map(([target, fields]) => [target, fields.map(String)])),
    held: Array.isArray(saved.held) ? saved.held.map(String) : [],
    overridden: Array.isArray(saved.overridden) ? saved.overridden.map(String) : [],
    unobserved: Array.isArray(saved.unobserved) ? saved.unobserved.map(String) : []
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
      owner: config.owner,
      updateOnOnly: true,
      preserveManual: true
    };
  }
  return command;
}

function statusFor(state: ActivityLightingState) {
  return {
    phase: state.phase,
    text: `${state.desired?.profile || "none"}: ${state.phase}` +
      (state.unobserved?.length ? ` · ${state.unobserved.length} unobserved` : "")
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
  const traces: TraceEntry[] = [];
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
    const command = commandFor(state, config, "apply", attempt);
    // Lights a person took over from the last request: taken back, so not
    // skipped as a person's (preserveManual). Every other light as before.
    const reclaim = (state.overridden ?? []).filter((target) => command.lighting?.targets?.includes(target));
    if (reclaim.length && command.lighting) {
      const rest = command.lighting.targets!.filter((target) => !reclaim.includes(target));
      if (rest.length) commands.push({...command, lighting: {...command.lighting, targets: rest}});
      const {preserveManual: _preserve, ...taken} = command.lighting;
      commands.push({...command, lighting: {...taken, targets: reclaim}});
      trace("command", "emitted", "taking-back", {targets: reclaim});
    } else {
      commands.push(command);
    }
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
      if (!observation && state.unobserved?.includes(target)) continue;
      if (!observation) {
        state.phase = state.phase === "transitioning" ? "transitioning" : "confirming";
        return;
      }
      if (!observation.available) {
        fail("lighting-unavailable");
        return;
      }
      if (observation.manual && state.held?.includes(target)) {
        // A person changed a light this request held: theirs now, as on the
        // other theatre targets. The next request takes it back.
        state.pending = null;
        state.phase = "manual_override";
        if (!state.overridden?.includes(target)) state.overridden = [...(state.overridden ?? []), target];
        trace("observation", "manual_override", "person-changed", {target});
        return;
      }
      if (observation.manual || !observation.on) {
        // A person's before this request (or off): left as it is.
        counts.preserved += 1;
        continue;
      }
      // A light that has never reported any of the profile's fields (one
      // that only switches on and off) is confirmed by being on, and traced so
      // the node can say its values may not apply.
      if (!reportsAnyOf(profile.values, state.reported?.[target] ?? [])) {
        trace("observation", "confirmed", VALUES_NOT_REPORTED, {target});
        counts.matched += 1;
        continue;
      }
      // It shows the profile's values when it shows the last command sent to
      // it: the profile's, as the activity holds the light.
      if (!observation.showsLast) {
        if (isAdopted(state)) {
          // An adopted request the lights don't match: someone else's, and
          // never re-applied.
          state.pending = null;
          state.phase = "manual_override";
          trace("observation", "manual_override", ADOPTED_MISMATCH, {target});
          return;
        }
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
      preserved: counts.preserved,
      ...(state.unobserved?.length ? {unobserved: state.unobserved} : {})
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
    // Hand back lights this node overrode that the new profile does not style.
    // Unknown applied targets release every light held under this owner.
    const nextTargets = config.profiles[intent.profile]!.targets;
    const previous = state.applied;
    const released = previous?.targets === null ? null
      : (previous?.targets ?? []).filter((target) => !nextTargets.includes(target));
    state.applied = {profile: intent.profile, targets: [...nextTargets]};
    state.desired = {
      requestId: intent.requestId,
      generation: intent.generation,
      profile: intent.profile,
      requestedAt
    };
    if (previous && (released === null || released.length)) {
      commands.push({
        operation: "release",
        requestId: intent.requestId,
        generation: intent.generation,
        profile: previous.profile,
        attempt: 1,
        lighting: released === null
          ? {kind: "release", owner: config.owner, source: "activity"}
          : {kind: "release", owner: config.owner, targets: released, source: "activity"}
      });
      trace("command", "emitted", null, {operation: "release", profile: previous.profile, targets: released});
    }
    state.generation = intent.generation;
    state.observed = {};
    state.held = [];
    state.unobserved = [];
    state.pending = null;
    state.failure = null;
    state.blockedGeneration = null;
    if (profileFor(state, config).targets.length === 0) reconcile();
    else issueApply(1);
    // Taken back with this request's apply (above), or no longer styled.
    state.overridden = [];
    trace("intent", "accepted", null, {profile: intent.profile, generation: intent.generation});
  }

  function acceptObservation(observation: Extract<ActivityLightingEvent, {kind: "observed"}>) {
    if (!Number.isInteger(observation.generation) || observation.generation < 1) {
      throw new Error("activity lighting observation generation must be a positive integer");
    }
    if (!TARGET_NAME.test(observation.target)) throw new Error("invalid activity lighting target");
    const parsedAt = parseObservedAt(observation.observedAt);
    if (parsedAt === null || typeof observation.observedAt !== "string") {
      throw new Error("activity lighting observedAt must be an ISO timestamp");
    }
    if (!state.desired || !answersRequest(state.carried, state.generation, observation.generation)) {
      trace("observation", "ignored", "stale-generation");
      return;
    }
    const profile = profileFor(state, config);
    if (!profile.targets.includes(observation.target)) {
      trace("observation", "ignored", "not-profile-target", {target: observation.target});
      return;
    }
    const bounded = boundObservedAt(observation.observedAt, parsedAt, nowMs);
    if (bounded.skewed) trace("observation", "adjusted", "clock-skew", {reported: observation.observedAt, usedAt: bounded.observedAt});
    if (bounded.ms < Date.parse(state.desired.requestedAt)) {
      trace("observation", "ignored", "stale-observation", {target: observation.target});
      return;
    }
    if (isOutOfOrder(bounded.ms, state.observed[observation.target]?.observedAt, nowMs)) {
      trace("observation", "ignored", "out-of-order", {target: observation.target});
      return;
    }
    // What it reports since start: which fields, for the profiles' values.
    const fields = Array.isArray(observation.fields) ? observation.fields.map(String) : [];
    const known = state.reported?.[observation.target] ?? [];
    if (fields.some((field) => !known.includes(field))) {
      state.reported = {...state.reported, [observation.target]: [...new Set([...known, ...fields])]};
    }
    // Held by this request: on, and not a person's.
    if (observation.on === true && observation.manual !== true && !(state.held ?? []).includes(observation.target)) {
      state.held = [...(state.held ?? []), observation.target];
    }
    state.observed[observation.target] = {
      target: observation.target,
      on: observation.on === true,
      manual: observation.manual === true,
      available: observation.available !== false,
      showsLast: observation.showsLast === true,
      observedAt: bounded.observedAt
    };
    if (state.unobserved?.includes(observation.target)) {
      state.unobserved = state.unobserved.filter((target) => target !== observation.target);
    }
    trace("observation", "accepted", null, {target: observation.target});
    reconcile();
  }

  // A refresh with the activity's wanted values, reaching a node with
  // nothing desired (it started with nothing saved): adopt them, and observe
  // below as at startup (see adopted-request.ts). Which lights it held is
  // unknown, so the next activity releases every light it holds.
  let answerWithReading = false;
  const adoptable = event.kind === "refresh" ? adoptableRefresh(event, state) : null;
  // The same wanted values as the work in hand: carry on under the new
  // request rather than adopting it read-only (see carryOn).
  const carried = event.kind === "refresh" && carryOn(state, adoptable, event.profile === state.desired?.profile,
    state.phase === "manual_override" || state.phase === "failed" || state.blockedGeneration === state.desired?.generation);
  if (carried) trace("refresh", "continued", "same-request", {generation: state.generation});
  const adopted = !carried && adoptable !== null && event.kind === "refresh" && typeof event.profile === "string" && Object.hasOwn(config.profiles, event.profile);
  if (adopted && event.kind === "refresh") {
    const reason = adoptionReason(state.desired);
    // Replacing a request the theatre already counts as ready, it answers
    // from its reading, not with an interim state the theatre would take as
    // drift.
    answerWithReading = reason === "newer-generation";
    // A request it replaces takes its failure with it.
    state.failure = null;
    state.blockedGeneration = null;
    state.desired = {...adoptable, profile: event.profile as string, requestedAt: now.toISOString()};
    state.generation = adoptable.generation;
    state.adoptedGeneration = adoptable.generation;
    state.applied = {profile: event.profile as string, targets: null};
    trace("refresh", "adopted", reason, {profile: event.profile, generation: adoptable.generation});
  }

  if (event.kind === "intent") {
    acceptIntent(event);
  } else if (event.kind === "observed") {
    acceptObservation(event);
  } else if (event.kind === "command_result") {
    if (!state.desired || !answersRequest(state.carried, state.generation, event.generation) || !state.pending) {
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
      // A light with no reading at all by now isn't going to answer: it is
      // unobserved, not re-applied, and fails nothing. The others go on as
      // before: re-applied, then failed.
      const attempt = state.pending.attempt;
      const missing = profileFor(state, config).targets.filter((target) => !state.observed[target]);
      if (missing.length) {
        state.unobserved = [...new Set([...(state.unobserved ?? []), ...missing])];
        trace("lighting", "unobserved", "no-reading", {targets: missing});
        reconcile();
      }
      // Still waiting on a light that reported (reconcile ends the deadline
      // once ready or a person's).
      if (state.pending) {
        if (attempt < config.maxAttempts) issueApply(attempt + 1);
        else fail("confirmation-timeout");
      }
    }
  } else if (event.kind === "refresh" && state.desired && state.phase === "ready" && !state.pending &&
    profileFor(state, config).targets.length > 0) {
    // A settled, ready profile is re-read without leaving ready, as the
    // display, source and receiver are: its target state follows the
    // readings, which reconcile as any reading after ready does.
    commands.push(commandFor(state, config, "observe", 0));
    answerWithReading = true;
    trace("refresh", "observing", "ready", {profile: state.desired.profile});
  } else if (event.kind === "startup" || event.kind === "refresh") {
    state.observed = {};
    // Since start: what each light reports is learned again.
    if (event.kind === "startup") state.reported = {};
    state.unobserved = [];
    state.pending = null;
    if (state.desired) {
      if (profileFor(state, config).targets.length === 0) reconcile();
      else {
        commands.push(commandFor(state, config, "observe", 0));
        state.phase = "confirming";
        // After a restart or a refresh nothing else would end an unanswered
        // observe: give it a deadline, by which a light with no reading is
        // unobserved, and one that doesn't match is re-applied and then
        // failed, as for a live request.
        if (state.blockedGeneration !== state.generation) {
          state.pending = {attempt: 0, deadlineAt: nowMs + config.confirmationTimeoutMs};
        }
        trace(event.kind, "observing", null, {profile: state.desired.profile});
      }
    } else {
      trace(event.kind, "idle");
    }
  } else {
    throw new Error("unknown activity lighting event kind");
  }

  // An adopted request only reads the lights (see adopted-request.ts): an
  // apply means they aren't as wanted.
  const held = readsOnly(state, commands, (command) => command.operation === "observe");
  if (held.mismatch) {
    commands.splice(0, commands.length, ...held.commands);
    state.pending = null;
    state.phase = "manual_override";
    trace("command", "withheld", ADOPTED_MISMATCH);
  }

  if (state.desired && !answerWithReading) {
    const manual = state.phase === "manual_override";
    const theatre = targetStateEvent({
      target: "lighting",
      requestId: state.desired.requestId,
      generation: state.generation,
      status: manual ? "transitioning" : asTargetStatus(state.phase, "confirming"),
      classification: manual ? "manual_override" : null,
      observedAt: now.toISOString(),
      details: {
        profile: state.desired.profile,
        matched: counts.matched,
        preserved: counts.preserved,
        expected: profileFor(state, config).targets.length,
        ...(state.unobserved?.length ? {unobserved: [...state.unobserved]} : {}),
        metrics: {
          attempts: state.pending?.attempt ?? 0,
          retries: Math.max(0, (state.pending?.attempt ?? 1) - 1),
          fallbackUsed: false
        }
      },
      failure: state.failure
    });
    events.push({theatre});
  }

  return {state, commands, events, traces, status: statusFor(state)};
}
