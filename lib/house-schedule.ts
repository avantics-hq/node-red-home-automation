"use strict";

// One wake and bed time for every room that follows the house. The house
// schedule keeps the times in use, set at runtime (from Home Assistant, say)
// or from its settings, and tells the rooms using it whenever they change. A
// time set at runtime lasts until the schedule is deployed with a different
// setting for it.

import type {TraceEntry} from "./bounded-trace";
import type {DaySchedule} from "./circadian-schedule";
import {requestedSchedule} from "./room-schedule";
import {keptOverride} from "./settings";

export interface HouseScheduleState {
  schedule: DaySchedule;
  // The configured times the times in use were based on.
  scheduleSetting: DaySchedule;
}

// New times for the house, either one alone.
export interface HouseScheduleEvent {
  kind: "schedule";
  wakeTime?: unknown;
  bedTime?: unknown;
}

// What a room, or the node that publishes the schedule, needs from a shared
// house schedule: its name in topics, the times in use, a way to change them,
// and word of every change until it stops listening.
export interface SharedSchedule {
  readonly name: string;
  schedule(): DaySchedule;
  change(event: HouseScheduleEvent, traces?: TraceEntry[]): void;
  subscribe(listener: (schedule: DaySchedule) => void): () => void;
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
  const traces: TraceEntry[] = [];
  let changed = false;
  const next = requestedSchedule(state.schedule, event);
  if (!next) {
    traces.push({event: "schedule", outcome: "ignored", reason: "invalid-times", details: {wakeTime: event.wakeTime, bedTime: event.bedTime}});
  } else if (next.wakeTime !== state.schedule.wakeTime || next.bedTime !== state.schedule.bedTime) {
    state.schedule = next;
    traces.push({event: "schedule", outcome: "changed", reason: null, details: {...next}});
    changed = true;
  }
  return {state, changed, traces};
}
