"use strict";

import type {TraceEntry} from "./bounded-trace";
import {numberSetting} from "./settings";

// Motion handles occupancy, illuminance and whether it is enabled. Wall
// switches belong to the switch policy; the room controller keeps motion from
// switching off a light a person has just set.
export interface MotionConfig {
  defaultIlluminanceCutoff: number;
  defaultDelaySeconds: number;
  onTargets: string[];
  offTargets: string[];
}

export interface MotionState {
  areaEnabled: boolean;
  illuminance: number | null;
  illuminanceCutoff: number;
  delaySeconds: number;
  offTimerGeneration: number;
  offTimerDueAt: number | null;
  // When the room went vacant and the pending off-timer started.
  offTimerArmedAt: number | null;
}

export interface MotionInput {
  source: string;
  payload?: unknown;
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

export function booleanOn(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.toLowerCase() === "on");
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Saved wall-switch state from earlier versions (wallInput and the older
// switch* fields) is not read.
// A JSON array of target names from the editor, or the fallback when blank.
function targetList(value: unknown, fallback: string[]): string[] {
  const parsed: unknown = JSON.parse(typeof value === "string" && value ? value : JSON.stringify(fallback));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("targets must be a JSON array of strings");
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
}): MotionConfig {
  const onTargets = targetList(raw.onTargets, ["main"]);
  return {
    onTargets,
    offTargets: targetList(raw.offTargets, onTargets),
    defaultDelaySeconds: numberSetting(raw.defaultDelaySeconds, "vacancy delay", 120),
    defaultIlluminanceCutoff: numberSetting(raw.defaultIlluminanceCutoff, "illuminance cutoff", 10)
  };
}

export function createMotionState(
  config: MotionConfig,
  saved: Partial<MotionState> = {}
): MotionState {
  return {
    areaEnabled: saved.areaEnabled !== false,
    illuminance: saved.illuminance ?? null,
    illuminanceCutoff: saved.illuminanceCutoff ?? config.defaultIlluminanceCutoff,
    delaySeconds: saved.delaySeconds ?? config.defaultDelaySeconds,
    offTimerGeneration: Number(saved.offTimerGeneration) || 0,
    offTimerDueAt: Number(saved.offTimerDueAt) || null,
    offTimerArmedAt: Number(saved.offTimerArmedAt) || null
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

  function enabled() {
    return state.areaEnabled && nextGlobalEnabled;
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

  if (source === "global-enabled") {
    const previous = nextGlobalEnabled;
    nextGlobalEnabled = booleanOn(payload);
    if (previous !== nextGlobalEnabled) {
      trace("enabled", "changed", null, {scope: "global", enabled: nextGlobalEnabled});
    }
    if (!enabled()) cancelOffTimer("motion-disabled");
  } else if (source === "area-enabled") {
    const previous = state.areaEnabled;
    state.areaEnabled = booleanOn(payload);
    if (previous !== state.areaEnabled) {
      trace("enabled", "changed", null, {scope: "area", enabled: state.areaEnabled});
    }
    if (!enabled()) cancelOffTimer("motion-disabled");
  } else if (source === "delay") {
    const minutes = finiteNumber(payload);
    if (minutes !== null) state.delaySeconds = minutes * 60;
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
      emitIntent(lightingIntent(config.offTargets, "OFF", "motion", {vacantSince}), "off-timer");
    }
  } else if (source.startsWith("switch")) {
    trace("message", "ignored", "wall switches belong to the switch policy", {source});
  }

  return {
    state,
    globalEnabled: nextGlobalEnabled,
    effects,
    traces,
    status: {
      enabled: enabled(),
      illuminance: state.illuminance,
      delaySeconds: state.delaySeconds
    }
  };
}
