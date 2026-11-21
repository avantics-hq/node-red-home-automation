"use strict";

export interface SwitchPolicyConfig {
  targets: string[];
  switchWindowMs: number;
}

export interface SwitchPolicyState {
  switchStateKnown: boolean;
  switchState: boolean;
  generation: number;
  switchAt: number;
  timerDueAt: number | null;
}

export interface SwitchPolicyInput {
  source: string;
  payload?: unknown;
  retain?: boolean;
  generation?: number;
  switchAt?: number;
}

export interface SwitchLightingIntent {
  lighting: {
    kind: "intent";
    targets: string[];
    state: "ON" | "TOGGLE";
    source: "wall";
    manual?: boolean;
    values?: {brightness: number};
  };
}

export type SwitchPolicyEffect =
  | {kind: "cancel-switch-timer"}
  | {kind: "schedule-switch-timer"; delayMs: number; generation: number; switchAt: number}
  | {kind: "send"; message: SwitchLightingIntent};

export interface SwitchPolicyTrace {
  event: string;
  outcome: string;
  reason: string | null;
  details: Record<string, unknown>;
}

export function createSwitchPolicyState(saved: Partial<SwitchPolicyState> = {}): SwitchPolicyState {
  return {
    switchStateKnown: saved.switchStateKnown === true,
    switchState: saved.switchState === true,
    generation: Number(saved.generation) || 0,
    switchAt: Number(saved.switchAt) || 0,
    timerDueAt: typeof saved.timerDueAt === "number" ? saved.timerDueAt : null
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
      ...(manual ? {manual: true, values: {brightness: 254}} : {})
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
  const traces: SwitchPolicyTrace[] = [];

  function trace(event: string, outcome: string, reason: string | null, details: Record<string, unknown> = {}) {
    traces.push({event, outcome, reason, details});
  }

  function cancelTimer(reason: string | null) {
    const wasActive = Number(state.timerDueAt) > now;
    state.generation += 1;
    state.timerDueAt = null;
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

  if (input.source === "switch") {
    const nextState = input.payload && typeof input.payload === "object"
      ? (input.payload as Record<string, unknown>).state
      : undefined;
    if (typeof nextState !== "boolean") {
      trace("switch", "ignored", "invalid-state");
    } else {
      const firstState = !state.switchStateKnown;
      const changed = firstState || nextState !== state.switchState;
      state.switchStateKnown = true;
      state.switchState = nextState;
      if (input.retain === true) {
        if (state.timerDueAt !== null || state.switchAt) {
          state.switchAt = 0;
          cancelTimer("retained-baseline");
        }
        trace("switch", "ignored", "retained-baseline", {changed});
      } else if (!changed) {
        trace("switch", "ignored", "unchanged");
      } else if (state.switchAt && now - state.switchAt <= config.switchWindowMs) {
        state.switchAt = 0;
        cancelTimer("double-edge");
        emit(intent(config.targets, "ON", true), "switch");
      } else {
        cancelTimer("new-edge");
        state.switchAt = now;
        state.timerDueAt = now + config.switchWindowMs;
        effects.push({
          kind: "schedule-switch-timer",
          delayMs: config.switchWindowMs,
          generation: state.generation,
          switchAt: now
        });
        trace("switch-timer", "scheduled", null, {
          dueAt: new Date(state.timerDueAt).toISOString(),
          targets: config.targets
        });
      }
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
      state.switchAt = 0;
      cancelTimer("explicit-action");
      emit(intent(config.targets, action === "single" ? "TOGGLE" : "ON", action === "double"), "switch-action");
    } else {
      trace("switch-action", "ignored", "unsupported-action", {action});
    }
  } else if (input.source === "switch-timer") {
    const current = input.generation === state.generation &&
      input.switchAt === state.switchAt &&
      state.timerDueAt !== null;
    if (!current) {
      trace("switch-timer", "ignored", "stale-generation", {generation: input.generation});
    } else {
      state.switchAt = 0;
      state.timerDueAt = null;
      emit(intent(config.targets, "TOGGLE"), "switch-timer");
    }
  } else {
    trace("message", "ignored", "unsupported-source", {source: input.source});
  }

  return {state, effects, traces};
}
