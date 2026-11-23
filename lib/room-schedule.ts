"use strict";

// The room's wake and bed times while it runs: the configured times, or times
// set at runtime (from Home Assistant, say), which last until the node is
// deployed with a different setting for them. And the room's lighting on
// whichever times are in use.

import {DEFAULT_BED_TIME, DEFAULT_WAKE_TIME, clockMinutes, type DaySchedule} from "./circadian-schedule";
import type {RoomConfig, RoomState} from "./room-controller";
import {keptOverride} from "./settings";

function configuredSchedule(config: RoomConfig): DaySchedule {
  return config.schedule ?? {wakeTime: DEFAULT_WAKE_TIME, bedTime: DEFAULT_BED_TIME};
}

// Each saved time stands only while the setting it was based on is
// unchanged; state saved before times could change takes the settings.
export function savedSchedule(config: RoomConfig, saved: Partial<RoomState>): Pick<RoomState, "schedule" | "scheduleSetting"> {
  const setting = configuredSchedule(config);
  const kept = (key: keyof DaySchedule) => keptOverride(saved.schedule?.[key], saved.scheduleSetting?.[key], setting[key]);
  return {schedule: {wakeTime: kept("wakeTime"), bedTime: kept("bedTime")}, scheduleSetting: {...setting}};
}

// The room's settings with lighting that follows the times in use.
export function withActiveSchedule(config: RoomConfig, state: RoomState): RoomConfig {
  const setting = configuredSchedule(config);
  const same = state.schedule.wakeTime === setting.wakeTime && state.schedule.bedTime === setting.bedTime;
  if (same) return config;
  return {...config, lighting: config.lighting.withSchedule(state.schedule)};
}

// New times from a "schedule" message, each "HH:MM", with a time left out
// staying as it is; null if they aren't valid, different times.
export function requestedSchedule(current: DaySchedule, event: {wakeTime?: unknown; bedTime?: unknown}): DaySchedule | null {
  const next = {
    wakeTime: typeof event.wakeTime === "string" ? event.wakeTime.trim() : current.wakeTime,
    bedTime: typeof event.bedTime === "string" ? event.bedTime.trim() : current.bedTime
  };
  const wake = clockMinutes(next.wakeTime);
  const bed = clockMinutes(next.bedTime);
  return wake === null || bed === null || wake === bed ? null : next;
}
