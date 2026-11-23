"use strict";

import type {TraceEntry} from "./bounded-trace";
import {
  createWallInputState,
  isWallInputSource,
  transitionWallInput,
  wallGestureIntent,
  wallInputFor,
  wallInputStatus,
  type WallGestureIntent,
  type WallInputConfig,
  type WallInputInput,
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

export type SwitchLightingIntent = WallGestureIntent;

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

  // Feed wall-input an event and take on its state, effects and traces.
  function wallInput(event: WallInputInput) {
    const result = transitionWallInput(state.wallInput, event, config, now);
    state.wallInput = result.state;
    effects.push(...result.effects);
    traces.push(...result.traces);
    return result;
  }

  function emit(message: SwitchLightingIntent, event: string) {
    effects.push({kind: "send", message});
    trace(event, "emitted", null, {
      state: message.lighting.state,
      targets: message.lighting.targets,
      manual: message.lighting.manual === true
    });
  }

  if (isWallInputSource(input.source)) {
    const {gesture} = wallInput(wallInputFor(input.source, input));
    if (gesture) emit(wallGestureIntent(config.targets, gesture), "switch");
  } else if (input.source === "switch-action") {
    const action = String(
      input.payload && typeof input.payload === "object"
        ? (input.payload as Record<string, unknown>).action ?? ""
        : input.payload ?? ""
    ).toLowerCase();
    if (input.retain === true) {
      trace("switch-action", "ignored", "retained-message", {action});
    } else if (action === "single" || action === "double") {
      wallInput({kind: "cancel", reason: "explicit-action"});
      emit(wallGestureIntent(config.targets, action), "switch-action");
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
