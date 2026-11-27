"use strict";

// The circadian lighting policy: how lights should look now, sent to rooms
// as a style. It owns the levels over the day, sleep mode and whether
// circadian lighting is on; the times it follows are its own or a house
// schedule's. A room keeps the latest style and uses it for lights it
// controls (room-controller.ts); a style is never a request to change a
// light.

import type {TraceEntry} from "./bounded-trace";
import type {CircadianLighting} from "./circadian";
import {requestedSchedule, type DaySchedule} from "./circadian-schedule";
import {NOT_TRUE_OR_FALSE, describeValue, enableValue} from "./enable-input";
import type {LightStyle} from "./light-styling";
import {keptOverride} from "./settings";

// A style is stale after this many restyle intervals, so a policy that
// stopped (deleted, disabled, crashed) stops affecting lights soon after.
export const STYLE_LIFETIME_INTERVALS = 3;

export interface CircadianConfig {
  // The curve on the configured times; the policy moves it onto the times in
  // use.
  lighting: CircadianLighting;
  // The configured wake and bed times, or the house's when it follows one.
  schedule: DaySchedule;
  // "house": the times are the house schedule's, not set here.
  timesFrom: "own" | "house";
  initialSleep: boolean;
  // The transition a room uses when it restyles a light that is on.
  transitionSeconds: number;
  // How often the policy sends its style.
  intervalSeconds: number;
}

export interface CircadianState {
  enabled: boolean;
  sleeping: boolean;
  // The times in use, and the configured times they were based on: a time
  // set at runtime lasts until the setting changes.
  schedule: DaySchedule;
  scheduleSetting: DaySchedule;
  // Whether those times were a house's: a policy that stops following a
  // house goes back to its own times, not the house's last ones.
  followsHouse?: boolean;
}

export interface CircadianEvent {
  kind?: string;
  enabled?: unknown;
  wakeTime?: unknown;
  bedTime?: unknown;
}

// What a room is sent: how lights should look, or null when circadian
// lighting is off. takeBack is set only as circadian is switched on: the
// room then takes back the lights a person set (the one time a style changes
// who controls a light).
export interface StyleMessage {
  kind: "style";
  source: string;
  values: LightStyle | null;
  transitionSeconds: number;
  until: string;
  takeBack?: true;
}

export function createCircadianState(config: CircadianConfig, saved: Partial<CircadianState> = {}): CircadianState {
  const kept = (key: keyof DaySchedule) => keptOverride(saved.schedule?.[key], saved.scheduleSetting?.[key], config.schedule[key]);
  return {
    enabled: saved.enabled !== false,
    sleeping: saved.sleeping === undefined ? config.initialSleep : saved.sleeping === true,
    // Following a house, its times are the house's last ones (the node passes
    // each change on as a "schedule" event), or the house's as it started.
    schedule: config.timesFrom === "house"
      ? {...(saved.followsHouse === true && saved.schedule ? saved.schedule : config.schedule)}
      : saved.followsHouse === true ? {...config.schedule} : {wakeTime: kept("wakeTime"), bedTime: kept("bedTime")},
    scheduleSetting: {...config.schedule},
    followsHouse: config.timesFrom === "house"
  };
}

// The style for this moment, as a room is sent it.
export function styleMessage(config: CircadianConfig, state: CircadianState, now: Date, takeBack = false): StyleMessage {
  return {
    kind: "style",
    source: "circadian",
    values: state.enabled ? config.lighting.withSchedule(state.schedule).styleAt(now, state.sleeping) : null,
    transitionSeconds: config.transitionSeconds,
    until: new Date(now.getTime() + STYLE_LIFETIME_INTERVALS * config.intervalSeconds * 1000).toISOString(),
    ...(takeBack ? {takeBack: true as const} : {})
  };
}

// One event: "circadian" or "sleep" with enabled true or false, "schedule"
// with new times, or "tick" (the interval, the flows starting, or a startup
// message) to send the style as it stands. Returns the style to send, if
// any, and whether the published state changed.
export function transitionCircadian(
  saved: Partial<CircadianState> | undefined,
  event: CircadianEvent,
  config: CircadianConfig,
  nowValue: Date | string | number = new Date()
) {
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const state = createCircadianState(config, saved);
  const traces: TraceEntry[] = [];
  let style: StyleMessage | null = null;
  let stateChanged = false;

  function trace(name: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) {
    traces.push({event: name, outcome, reason, details});
  }

  if ((event.kind === "circadian" || event.kind === "sleep") && enableValue(event.enabled) === null) {
    // Refused, never read as off: the node warns.
    trace(event.kind, "ignored", NOT_TRUE_OR_FALSE, {source: event.kind, payload: describeValue(event.enabled)});
  } else if (event.kind === "circadian") {
    const enabled = event.enabled === true;
    if (enabled !== state.enabled) {
      state.enabled = enabled;
      stateChanged = true;
      trace("circadian", "changed", null, {enabled});
      // Switched on, it takes back what a person set; switched off, rooms
      // stop styling.
      style = styleMessage(config, state, now, enabled);
    }
  } else if (event.kind === "sleep") {
    const sleeping = event.enabled === true;
    if (sleeping !== state.sleeping) {
      state.sleeping = sleeping;
      stateChanged = true;
      trace("sleep", "changed", null, {enabled: sleeping});
      if (state.enabled) style = styleMessage(config, state, now);
    }
  } else if (event.kind === "schedule") {
    const next = requestedSchedule(state.schedule, event);
    if (!next) {
      trace("schedule", "ignored", "invalid-times", {wakeTime: event.wakeTime, bedTime: event.bedTime});
    } else if (next.wakeTime !== state.schedule.wakeTime || next.bedTime !== state.schedule.bedTime) {
      state.schedule = next;
      stateChanged = true;
      trace("schedule", "changed", null, {...next});
      if (state.enabled) style = styleMessage(config, state, now);
    }
  } else if (event.kind === "tick") {
    // While off, a tick says so again, so a room that missed the change or
    // restarted without its saved style stops styling too.
    style = styleMessage(config, state, now);
  } else if (event.kind !== "ignored") {
    // "ignored": a set topic's message already traced as such.
    trace("input", "ignored", "unknown-kind", {kind: event.kind ?? null});
  }

  return {
    state,
    style,
    stateChanged,
    traces,
    status: {enabled: state.enabled, sleeping: state.sleeping, values: state.enabled ? styleMessage(config, state, now).values : null}
  };
}
