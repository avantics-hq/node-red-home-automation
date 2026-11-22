"use strict";
import {
  createWallInputState,
  transitionWallInput,
  wallInputStatus,
  type WallInputConfig,
  type WallInputState
} from "./wall-input";

export interface MotionConfig extends WallInputConfig {
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
  wallInput: WallInputState;
  offTimerGeneration: number;
  offTimerDueAt: number | null;
}

export interface MotionInput {
  source: string;
  observedAt?: unknown;
  payload?: unknown;
  generation?: number;
  switchAt?: number;
  retain?: boolean;
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
  | {kind: "cancel-switch-timer"}
  | {kind: "schedule-switch-timer"; delayMs: number; generation: number; switchAt: number}
  | {kind: "send"; message: LightingIntent};

export interface MotionTrace {
  event: string;
  outcome: string;
  reason: string | null;
  details: Record<string, unknown>;
}

export function booleanOn(value: unknown): boolean {
  return value === true || value === "on";
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function createMotionState(
  config: MotionConfig,
  saved: Partial<MotionState> = {}
): MotionState {
  const legacy = saved as Partial<MotionState> & {
    switchStateKnown?: boolean;
    switchState?: boolean | null;
    switchGeneration?: number;
    switchAt?: number;
    switchTimerDueAt?: number | null;
  };
  return {
    areaEnabled: saved.areaEnabled !== false,
    illuminance: saved.illuminance ?? null,
    illuminanceCutoff: saved.illuminanceCutoff ?? config.defaultIlluminanceCutoff,
    delaySeconds: saved.delaySeconds ?? config.defaultDelaySeconds,
    wallInput: createWallInputState(saved.wallInput ?? {
      baselineKnown: legacy.switchStateKnown,
      value: legacy.switchState === true,
      generation: legacy.switchGeneration,
      edgeAt: legacy.switchAt,
      timerDueAt: legacy.switchTimerDueAt
    }),
    offTimerGeneration: Number(saved.offTimerGeneration) || 0,
    offTimerDueAt: Number(saved.offTimerDueAt) || null
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
  const traces: MotionTrace[] = [];
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
    effects.push({kind: "cancel-off-timer"});
    if (wasActive && reason) trace("off-timer", "cancelled", reason);
  }

  function scheduleOffTimer() {
    cancelOffTimer("rescheduled");
    const delayMs = Math.max(0, state.delaySeconds) * 1000;
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
      scheduleOffTimer();
      trace("occupancy", "schedule-off", null, {
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
    } else {
      state.offTimerDueAt = null;
      emitIntent(lightingIntent(config.offTargets, "OFF", "motion"), "off-timer");
    }
  } else if (
    source === "switch-startup" ||
    source === "switch" ||
    source === "switch-availability" ||
    source === "switch-timer"
  ) {
    const wallInput = transitionWallInput(
      state.wallInput,
      source === "switch-startup"
        ? {kind: "startup"}
        : source === "switch"
          ? {
            kind: "observation",
            payload,
            retain: input.retain,
            observedAt: input.observedAt
          }
          : source === "switch-availability"
            ? {kind: "availability", payload}
            : {
              kind: "timer",
              generation: input.generation,
              edgeAt: input.switchAt
            },
      config,
      now
    );
    state.wallInput = wallInput.state;
    effects.push(...wallInput.effects);
    traces.push(...wallInput.traces);

    const startedGesture = source === "switch" && (
      wallInput.gesture === "double" ||
      wallInput.effects.some((effect) => effect.kind === "schedule-switch-timer")
    );
    if (startedGesture) cancelOffTimer("wall-switch");

    if (wallInput.gesture === "single") {
      emitIntent(lightingIntent(config.onTargets, "TOGGLE", "wall"), "switch");
    } else if (wallInput.gesture === "double") {
      emitIntent(lightingIntent(config.onTargets, "ON", "wall", {
        manual: true,
        values: {brightness: 254}
      }), "switch");
    }
  }

  return {
    state,
    globalEnabled: nextGlobalEnabled,
    effects,
    traces,
    status: {
      enabled: enabled(),
      illuminance: state.illuminance,
      delaySeconds: state.delaySeconds,
      switch: wallInputStatus(state.wallInput, config.switchFreshnessMs, now)
    }
  };
}
