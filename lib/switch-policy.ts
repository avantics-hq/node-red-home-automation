"use strict";

import type {TraceEntry} from "./bounded-trace";
import {
  createWallInputState,
  transitionWallInput,
  wallInputStatus,
  type WallInputConfig,
  type WallInputState
} from "./wall-input";


export interface SwitchPolicyConfig extends WallInputConfig {
  targets: string[];
}

export interface SwitchPolicyState {
  wallInput: WallInputState;
}

export interface SwitchPolicyInput {
  source: string;
  payload?: unknown;
  retain?: boolean;
  baseline?: boolean;
  generation?: number;
  switchAt?: number;
  observedAt?: unknown;
}

export interface SwitchLightingIntent {
  lighting: {
    kind: "intent";
    targets: string[];
    state: "ON" | "TOGGLE";
    source: "wall";
    person: true;
    manual?: boolean;
    values?: {brightnessPct: number};
  };
}

export type SwitchPolicyEffect =
  | {kind: "cancel-switch-timer"}
  | {kind: "schedule-switch-timer"; delayMs: number; generation: number; switchAt: number}
  | {kind: "send"; message: SwitchLightingIntent};

export function createSwitchPolicyState(saved: Partial<SwitchPolicyState> = {}): SwitchPolicyState {
  const legacy = saved as Partial<SwitchPolicyState> & {
    switchStateKnown?: boolean;
    switchState?: boolean;
    generation?: number;
    switchAt?: number;
    timerDueAt?: number | null;
  };
  return {
    wallInput: createWallInputState(saved.wallInput ?? {
      baselineKnown: legacy.switchStateKnown,
      value: legacy.switchState,
      generation: legacy.generation,
      edgeAt: legacy.switchAt,
      timerDueAt: legacy.timerDueAt
    })
  };
}

function intent(
  targets: string[],
  state: "ON" | "TOGGLE",
  manual = false
): SwitchLightingIntent {
  return {
    lighting: {
      kind: "intent",
      targets: [...targets],
      state,
      source: "wall",
      person: true,
      ...(manual ? {manual: true, values: {brightnessPct: 100}} : {})
    }
  };
}

export function transitionSwitchPolicy(
  saved: Partial<SwitchPolicyState> | undefined,
  input: SwitchPolicyInput,
  config: SwitchPolicyConfig,
  now = Date.now()
) {
  const state = createSwitchPolicyState(saved);
  const effects: SwitchPolicyEffect[] = [];
  const traces: TraceEntry[] = [];

  function trace(event: string, outcome: string, reason: string | null, details: Record<string, unknown> = {}) {
    traces.push({event, outcome, reason, details});
  }

  function cancelTimer(reason: string | null) {
    const wasActive = Number(state.wallInput.timerDueAt) > now;
    state.wallInput.generation += 1;
    state.wallInput.edgeAt = 0;
    state.wallInput.timerDueAt = null;
    effects.push({kind: "cancel-switch-timer"});
    if (wasActive && reason) trace("switch-timer", "cancelled", reason);
  }

  function emit(message: SwitchLightingIntent, event: string) {
    effects.push({kind: "send", message});
    trace(event, "emitted", null, {
      state: message.lighting.state,
      targets: message.lighting.targets,
      manual: message.lighting.manual === true
    });
  }

  if (
    input.source === "switch-startup" ||
    input.source === "switch" ||
    input.source === "switch-availability" ||
    input.source === "switch-timer"
  ) {
    const wallInput = transitionWallInput(
      state.wallInput,
      input.source === "switch-startup"
        ? {kind: "startup"}
        : input.source === "switch"
          ? {
            kind: "observation",
            payload: input.payload,
            retain: input.retain,
            baseline: input.baseline,
            observedAt: input.observedAt
          }
          : input.source === "switch-availability"
            ? {kind: "availability", payload: input.payload}
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
    if (wallInput.gesture === "single") {
      emit(intent(config.targets, "TOGGLE"), "switch");
    } else if (wallInput.gesture === "double") {
      emit(intent(config.targets, "ON", true), "switch");
    }
  } else if (input.source === "switch-action") {
    const action = String(
      input.payload && typeof input.payload === "object"
        ? (input.payload as Record<string, unknown>).action ?? ""
        : input.payload ?? ""
    ).toLowerCase();
    if (input.retain === true) {
      trace("switch-action", "ignored", "retained-message", {action});
    } else if (action === "single" || action === "double") {
      cancelTimer("explicit-action");
      emit(intent(config.targets, action === "single" ? "TOGGLE" : "ON", action === "double"), "switch-action");
    } else {
      trace("switch-action", "ignored", "unsupported-action", {action});
    }
  } else {
    trace("message", "ignored", "unsupported-source", {source: input.source});
  }

  return {
    state,
    effects,
    traces,
    status: wallInputStatus(state.wallInput, config.switchFreshnessMs, now)
  };
}
