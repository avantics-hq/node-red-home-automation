"use strict";

import type {TraceEntry} from "./bounded-trace";
import {NOT_TRUE_OR_FALSE, describeValue, enableValue} from "./enable-input";
import {jsonSetting, keptOverride, numberSetting} from "./settings";


// Motion handles occupancy, illuminance and whether it is enabled. Wall
// switches belong to the switch policy; the room controller keeps motion from
// switching off a light a person has just set.
export interface MotionConfig {
  defaultIlluminanceCutoff: number;
  defaultDelaySeconds: number;
  onTargets: string[];
  offTargets: string[];
  // How long a pause lasts unless renewed, so one never sticks (seconds).
  // Absent means the default.
  maxPauseSeconds?: number;
}

export const DEFAULT_MAX_PAUSE_SECONDS = 600;

export interface MotionState {
  areaEnabled: boolean;
  illuminance: number | null;
  illuminanceCutoff: number;
  delaySeconds: number;
  // The configured cutoff and delay the two values above were based on. A
  // "delay" or "illuminance-cut-off" message overrides a value until the
  // node is redeployed with a different setting.
  illuminanceCutoffSetting: number | null;
  delaySecondsSetting: number | null;
  offTimerGeneration: number;
  offTimerDueAt: number | null;
  // When the room went vacant and the pending off-timer started.
  offTimerArmedAt: number | null;
  // When the room went vacant, until it is occupied again or its lights are
  // switched off: a vacancy that comes while motion is paused or disabled is
  // acted on when motion resumes.
  vacantSince: number | null;
  // Who is pausing motion lighting now, such as a moving cover, and until
  // when (epoch ms). Motion acts only while nobody is; this is apart from the
  // enables, which are the user's own and are never changed by a pause.
  pausedBy: Array<{owner: string; until: number}>;
}

export interface MotionInput {
  source: string;
  payload?: unknown;
  // Who sends a "pause", so several pausers each hold their own.
  owner?: string;
  generation?: number;
}

export interface LightingIntent {
  lighting: {
    kind: "intent";
    targets: string[];
    state: string;
    source: string;
    [key: string]: unknown;
  };
}

export type MotionEffect =
  | {kind: "cancel-off-timer"}
  | {kind: "schedule-off-timer"; delayMs: number; generation: number}
  | {kind: "send"; message: LightingIntent};

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// A JSON array of target names from the editor, or the fallback when the
// setting is absent from an older saved flow.
function targetList(value: unknown, label: string, fallback: string[]): string[] {
  const parsed = jsonSetting(value, label, fallback);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a JSON array of strings`);
  }
  return parsed as string[];
}

// The motion policy's settings from a node's editor values: on targets
// default to ["main"] and off targets to the on targets; the vacancy delay
// (120 s) and illuminance cutoff (10) take their defaults only when absent
// from an older saved flow. Throws on settings it cannot use.
export function normaliseMotionConfig(raw: {
  onTargets?: unknown;
  offTargets?: unknown;
  defaultDelaySeconds?: unknown;
  defaultIlluminanceCutoff?: unknown;
  maxPauseSeconds?: unknown;
}): MotionConfig {
  const onTargets = targetList(raw.onTargets, "on targets", ["main"]);
  return {
    onTargets,
    offTargets: targetList(raw.offTargets, "off targets", onTargets),
    defaultDelaySeconds: numberSetting(raw.defaultDelaySeconds, "vacancy delay", 120),
    defaultIlluminanceCutoff: numberSetting(raw.defaultIlluminanceCutoff, "illuminance cutoff", 10),
    maxPauseSeconds: Math.max(1, numberSetting(raw.maxPauseSeconds, "maximum pause", DEFAULT_MAX_PAUSE_SECONDS))
  };
}

// Saved wall-switch state from earlier versions (wallInput and the older
// switch* fields) is not read.
export function createMotionState(
  config: MotionConfig,
  saved: Partial<MotionState> = {}
): MotionState {
  return {
    areaEnabled: saved.areaEnabled !== false,
    pausedBy: Array.isArray(saved.pausedBy)
      ? saved.pausedBy.filter((pause) => typeof pause?.owner === "string" && Number.isFinite(pause.until)).map((pause) => ({...pause}))
      : [],
    illuminance: saved.illuminance ?? null,
    illuminanceCutoff: keptOverride(saved.illuminanceCutoff, saved.illuminanceCutoffSetting, config.defaultIlluminanceCutoff),
    delaySeconds: keptOverride(saved.delaySeconds, saved.delaySecondsSetting, config.defaultDelaySeconds),
    illuminanceCutoffSetting: config.defaultIlluminanceCutoff,
    delaySecondsSetting: config.defaultDelaySeconds,
    offTimerGeneration: Number(saved.offTimerGeneration) || 0,
    offTimerDueAt: Number(saved.offTimerDueAt) || null,
    offTimerArmedAt: Number(saved.offTimerArmedAt) || null,
    vacantSince: Number(saved.vacantSince) || null
  };
}

export function lightingIntent(
  targets: string[],
  state: string,
  source: string,
  extra: Record<string, unknown> = {}
): LightingIntent {
  return {
    lighting: {
      kind: "intent",
      targets,
      state,
      source,
      ...extra
    }
  };
}

export function transitionMotion(
  saved: Partial<MotionState> | undefined,
  input: MotionInput,
  config: MotionConfig,
  globalEnabled: boolean,
  now = Date.now()
) {
  const state = createMotionState(config, saved);
  const effects: MotionEffect[] = [];
  const traces: TraceEntry[] = [];
  let nextGlobalEnabled = globalEnabled !== false;
  // Whether motion could act before this input, counting a pause that has
  // just run out, so its running out resumes motion like a release.
  const wasEnabled = state.areaEnabled && nextGlobalEnabled && state.pausedBy.length === 0;

  // A pause past its time counts as released, even if its owner never said.
  for (const pause of state.pausedBy.filter(({until}) => until <= now)) {
    traces.push({event: "pause", outcome: "expired", reason: null, details: {owner: pause.owner}});
  }
  state.pausedBy = state.pausedBy.filter(({until}) => until > now);

  function enabled() {
    return state.areaEnabled && nextGlobalEnabled && state.pausedBy.length === 0;
  }

  function trace(event: string, outcome: string, reason: string | null, details: Record<string, unknown> = {}) {
    traces.push({event, outcome, reason, details});
  }

  function cancelOffTimer(reason: string | null) {
    const wasActive = Number(state.offTimerDueAt) > now;
    state.offTimerGeneration += 1;
    state.offTimerDueAt = null;
    state.offTimerArmedAt = null;
    effects.push({kind: "cancel-off-timer"});
    if (wasActive && reason) trace("off-timer", "cancelled", reason);
  }

  function scheduleOffTimer() {
    cancelOffTimer("rescheduled");
    const delayMs = Math.max(0, state.delaySeconds) * 1000;
    state.offTimerArmedAt = now;
    state.offTimerDueAt = now + delayMs;
    effects.push({
      kind: "schedule-off-timer",
      delayMs,
      generation: state.offTimerGeneration
    });
    trace("off-timer", "scheduled", null, {
      delaySeconds: state.delaySeconds,
      dueAt: new Date(state.offTimerDueAt).toISOString(),
      targets: config.offTargets
    });
  }


  function emitIntent(message: LightingIntent, event = "intent") {
    effects.push({kind: "send", message});
    trace(event, "emitted", null, {
      source: message.lighting.source,
      state: message.lighting.state,
      targets: message.lighting.targets
    });
  }

  const source = input.source;
  const payload = input.payload;

  if ((source === "global-enabled" || source === "area-enabled" || source === "pause") && enableValue(payload) === null) {
    // Refused, never read as off: the node warns and says so on its status.
    trace(source === "pause" ? "pause" : "enabled", "ignored", NOT_TRUE_OR_FALSE, {source, payload: describeValue(payload)});
  } else if (source === "global-enabled") {
    const previous = nextGlobalEnabled;
    nextGlobalEnabled = payload === true;
    if (previous !== nextGlobalEnabled) {
      trace("enabled", "changed", null, {scope: "global", enabled: nextGlobalEnabled});
    }
    if (!enabled()) cancelOffTimer("motion-disabled");
  } else if (source === "pause") {
    // true pauses for this owner until the maximum pause (sending it again
    // renews it), false releases it; motion resumes once every owner has
    // released, or their pauses have run out.
    const owner = typeof input.owner === "string" ? input.owner.trim() : "";
    if (!owner) {
      trace("pause", "ignored", "owner-required");
    } else {
      const pause = payload === true;
      const held = state.pausedBy.some((entry) => entry.owner === owner);
      const others = state.pausedBy.filter((entry) => entry.owner !== owner);
      const until = now + (config.maxPauseSeconds ?? DEFAULT_MAX_PAUSE_SECONDS) * 1000;
      state.pausedBy = pause ? [...others, {owner, until}] : others;
      trace("pause", pause ? (held ? "renewed" : "paused") : held ? "released" : "unchanged", null, {owner, until: pause ? until : null});
      if (!enabled()) cancelOffTimer("motion-paused");
    }
  } else if (source === "area-enabled") {
    const previous = state.areaEnabled;
    state.areaEnabled = payload === true;
    if (previous !== state.areaEnabled) {
      trace("enabled", "changed", null, {scope: "area", enabled: state.areaEnabled});
    }
    if (!enabled()) cancelOffTimer("motion-disabled");
  } else if (source === "delay") {
    // Seconds, the same unit as the vacancy setting.
    const seconds = finiteNumber(payload);
    if (seconds !== null) state.delaySeconds = seconds;
  } else if (source === "illuminance-cut-off") {
    const cutoff = finiteNumber(payload);
    if (cutoff !== null) state.illuminanceCutoff = cutoff;
  } else if (source === "illuminance") {
    const payloadRecord = payload && typeof payload === "object"
      ? payload as Record<string, unknown>
      : {};
    const value = payloadRecord.illuminance ?? payloadRecord.illuminanceLux ?? payload;
    const illuminance = finiteNumber(value);
    if (illuminance !== null) state.illuminance = illuminance;
  } else if (source === "occupancy") {
    const payloadRecord = payload && typeof payload === "object"
      ? payload as Record<string, unknown>
      : {};
    const occupied = payloadRecord.occupied === true;
    if (occupied) {
      state.vacantSince = null;
      cancelOffTimer("occupancy-detected");
      const darkEnough = state.illuminance === null || state.illuminance <= state.illuminanceCutoff;
      const shouldEmit = enabled() && darkEnough;
      const intentSource = typeof payloadRecord.trigger === "string" ? payloadRecord.trigger : "occupancy";
      if (shouldEmit) effects.push({kind: "send", message: lightingIntent(config.onTargets, "ON", intentSource)});
      trace("occupancy", shouldEmit ? "emit-on" : "suppressed", shouldEmit ? null : !enabled() ? "disabled" : "too-bright", {
        occupied: true,
        trigger: payloadRecord.trigger ?? null,
        areaEnabled: state.areaEnabled,
        globalEnabled: nextGlobalEnabled,
        illuminance: state.illuminance,
        illuminanceCutoff: state.illuminanceCutoff,
        targets: config.onTargets
      });
    } else {
      state.vacantSince = now;
      if (enabled()) scheduleOffTimer();
      else cancelOffTimer("motion-disabled");
      trace("occupancy", enabled() ? "schedule-off" : "suppressed", enabled() ? null : "disabled", {
        occupied: false,
        areaEnabled: state.areaEnabled,
        globalEnabled: nextGlobalEnabled,
        illuminance: state.illuminance,
        illuminanceCutoff: state.illuminanceCutoff,
        targets: config.offTargets
      });
    }
  } else if (source === "light") {
    let parsed: Record<string, unknown> = {};
    if (typeof payload === "string") {
      try {
        const decoded: unknown = JSON.parse(payload);
        if (decoded && typeof decoded === "object") parsed = decoded as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    } else if (payload && typeof payload === "object") {
      parsed = payload as Record<string, unknown>;
    }
    if (String(parsed.state || "").toUpperCase() === "OFF") {
      cancelOffTimer("light-observed-off");
    }
  } else if (source === "off-timer") {
    if (input.generation !== state.offTimerGeneration || state.offTimerDueAt === null) {
      trace("off-timer", "ignored", "stale-generation", {generation: input.generation});
    } else if (!enabled()) {
      // The global switch is shared, so a timer scheduled before another node
      // disabled motion can still fire here.
      state.offTimerDueAt = null;
      trace("off-timer", "suppressed", "disabled", {
        areaEnabled: state.areaEnabled,
        globalEnabled: nextGlobalEnabled
      });
    } else {
      // vacantSince lets the room controller keep a light a person set after
      // the room went vacant.
      const vacantSince = new Date(state.offTimerArmedAt ?? now).toISOString();
      state.offTimerDueAt = null;
      state.offTimerArmedAt = null;
      state.vacantSince = null;
      emitIntent(lightingIntent(config.offTargets, "OFF", "motion", {vacantSince}), "off-timer");
    }
  } else if (source === "pause-check") {
    // The node's own wake-up as a pause runs out: dropped above, and motion
    // resumes below.
  } else if (source === "cold-start") {
    // Started with nothing saved: a first deploy, or a redeploy or restart
    // without a context store, when a running off-timer was lost. Whether the
    // room is occupied is unknown, so vacancy starts now: the off-timer runs
    // unless occupancy is reported first, so lights left on are never on for
    // good.
    if (enabled()) scheduleOffTimer();
    trace("start", enabled() ? "schedule-off" : "suppressed", enabled() ? "no-saved-state" : "disabled", {targets: config.offTargets});
  } else if (source.startsWith("switch")) {
    trace("message", "ignored", "wall switches belong to the switch policy", {source});
  }

  // Motion resumed (a pause released or run out, or enabled again) in a room
  // that went vacant meanwhile: the vacancy delay starts now, and the off
  // intent names when the room went vacant.
  if (!wasEnabled && enabled() && state.vacantSince !== null && state.offTimerDueAt === null) {
    const vacantSince = state.vacantSince;
    scheduleOffTimer();
    state.offTimerArmedAt = vacantSince;
    trace("off-timer", "scheduled", "resumed-vacant", {vacantSince: new Date(vacantSince).toISOString()});
  }

  return {
    state,
    globalEnabled: nextGlobalEnabled,
    effects,
    traces,
    status: {
      enabled: enabled(),
      paused: state.pausedBy.length > 0,
      illuminance: state.illuminance,
      delaySeconds: state.delaySeconds
    }
  };
}
