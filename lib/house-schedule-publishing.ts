"use strict";

// The house schedule's MQTT and Home Assistant side: its wake and bed times
// as retained state, under home/<name>/wake-time and bed-time like a room's,
// with set topics Home Assistant commands and two time entities. Opt-in (see
// publishing-node.ts).

import type {TraceEntry} from "./bounded-trace";
import type {DaySchedule} from "./circadian-schedule";
import {timeEntityValue} from "./ha-discovery";
import type {HouseScheduleEvent} from "./house-schedule";
import {
  discoveryEntry,
  publishesState,
  publishingNode,
  type OptInPublishingConfig,
  type RetainedText
} from "./publishing-node";
import {roomTopic, scheduleCommandTopic, scheduleStateMessages, scheduleStateTopic, type ScheduleTime} from "./room-lighting-discovery";

// `area` is the house's name in topics, such as "house".
export type HouseSchedulePublishingConfig = OptInPublishingConfig;

const DEVICE = {kind: "schedule", label: "Schedule", model: "House schedule"};

export const houseAvailabilityTopic = (name: string) => roomTopic(name, "schedule/availability");

export function houseDiscovery(config: HouseSchedulePublishingConfig): RetainedText[] {
  const time = (which: ScheduleTime, id: string, name: string, icon: string) =>
    discoveryEntry(config, DEVICE, houseAvailabilityTopic(config.area), {component: "time", id, name, fields: {
      icon,
      command_topic: scheduleCommandTopic(config.area, which),
      state_topic: scheduleStateTopic(config.area, which),
      entity_category: "config"
    }});
  return [
    time("wake-time", "wake_time", "Wake time", "mdi:weather-sunset-up"),
    time("bed-time", "bed_time", "Bed time", "mdi:weather-night")
  ];
}

export function houseStateOutputs(config: HouseSchedulePublishingConfig, schedule: DaySchedule): RetainedText[] {
  return publishesState(config) ? scheduleStateMessages(config.area, schedule) as RetainedText[] : [];
}

const house = publishingNode<DaySchedule>({
  entries: houseDiscovery,
  availabilityTopic: houseAvailabilityTopic,
  stateTopics: (config) => [scheduleStateTopic(config.area, "wake-time"), scheduleStateTopic(config.area, "bed-time")],
  stateOutputs: houseStateOutputs
});

export const houseStartingOutputs = house.starting;
export const houseStoppingOutputs = house.stopping;
export const houseRetainedTopics = house.retainedTopics;

// A time from Home Assistant on the house's wake-time or bed-time set topic,
// as a schedule event; retained messages and anything but a time are
// ignored with a trace. Read only while the house publishes.
export function houseInbound(
  msg: {topic?: unknown; payload?: unknown; retain?: unknown},
  config: HouseSchedulePublishingConfig
): {event: HouseScheduleEvent | null; traces: TraceEntry[]} | null {
  if (!publishesState(config)) return null;
  const which: ScheduleTime | null = msg.topic === scheduleCommandTopic(config.area, "wake-time") ? "wake-time"
    : msg.topic === scheduleCommandTopic(config.area, "bed-time") ? "bed-time"
    : null;
  if (!which) return null;
  const name = which + "-set";
  if (msg.retain === true) return {event: null, traces: [{event: name, outcome: "ignored", reason: "retained-message", details: {}}]};
  const time = timeEntityValue(msg.payload);
  if (time === null) {
    return {event: null, traces: [{event: name, outcome: "ignored", reason: "not-a-time", details: {payload: typeof msg.payload === "string" ? msg.payload : null}}]};
  }
  return {event: which === "wake-time" ? {kind: "schedule", wakeTime: time} : {kind: "schedule", bedTime: time}, traces: []};
}
