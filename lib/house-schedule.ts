"use strict";

// One wake and bed time for every room that follows the house. The house
// keeps the times in use, set at runtime (from Home Assistant, say) or from
// its settings, and says them to its rooms when the flows start and whenever
// they change. A time set at runtime lasts until the node is deployed with a
// different setting for it.

import type {DaySchedule} from "./circadian-schedule";
import {requestedSchedule} from "./room-schedule";
import {keptOverride} from "./settings";

export interface HouseScheduleState {
  schedule: DaySchedule;
  // The configured times the times in use were based on.
  scheduleSetting: DaySchedule;
}

export type HouseScheduleEvent =
  | {kind: "schedule"; wakeTime?: unknown; bedTime?: unknown}
  // Say the times to the rooms: when the flows start, or at a startup message.
  | {kind: "announce"};

export interface HouseScheduleMessage {
  lighting: {kind: "schedule"; wakeTime: string; bedTime: string};
}

// The times in use: each saved time while its setting is unchanged.
export function houseScheduleInUse(saved: Partial<HouseScheduleState> | undefined, setting: DaySchedule): DaySchedule {
  return {
    wakeTime: keptOverride(saved?.schedule?.wakeTime, saved?.scheduleSetting?.wakeTime, setting.wakeTime),
    bedTime: keptOverride(saved?.schedule?.bedTime, saved?.scheduleSetting?.bedTime, setting.bedTime)
  };
}

export function transitionHouseSchedule(saved: Partial<HouseScheduleState> | undefined, event: HouseScheduleEvent, setting: DaySchedule) {
  const state: HouseScheduleState = {schedule: houseScheduleInUse(saved, setting), scheduleSetting: {...setting}};
  const traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [];
  let announce = event.kind === "announce";
  if (event.kind === "schedule") {
    const next = requestedSchedule(state.schedule, event);
    if (!next) {
      traces.push({event: "schedule", outcome: "ignored", reason: "invalid-times", details: {wakeTime: event.wakeTime, bedTime: event.bedTime}});
    } else if (next.wakeTime !== state.schedule.wakeTime || next.bedTime !== state.schedule.bedTime) {
      state.schedule = next;
      traces.push({event: "schedule", outcome: "changed", reason: null, details: {...next}});
      announce = true;
    }
  }
  const outputs: HouseScheduleMessage[] = announce ? [{lighting: {kind: "schedule", ...state.schedule}}] : [];
  return {state, outputs, traces, status: {text: `wake ${state.schedule.wakeTime} · bed ${state.schedule.bedTime}`}};
}
