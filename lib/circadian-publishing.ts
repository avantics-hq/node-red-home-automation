"use strict";

// The circadian lighting policy's MQTT and Home Assistant side: its
// circadian and sleep switches and, with its own times, its wake and bed
// times, each a retained state Home Assistant shows and a set topic it
// commands, plus availability. All of it is opt-in (see publishing-node.ts).
// The topics keep the names the room controller used before 6.0, so
// anything already writing them keeps working with the same area.

import type {TraceEntry} from "./bounded-trace";
import type {CircadianEvent, CircadianState} from "./circadian-policy";
import type {DaySchedule} from "./circadian-schedule";
import {discoveryEntity, timeEntityValue} from "./ha-discovery";
import {
  discoveryEntry,
  publishesDiscovery,
  publishesState,
  publishingNode,
  retainedText,
  type OptInPublishingConfig,
  type RetainedText
} from "./publishing-node";
import {homeTopic} from "./topic-names";

export interface CircadianPublishingConfig extends OptInPublishingConfig {
  // "house": the times are a house schedule's, which has its own entities.
  timesFrom: "own" | "house";
}

type Switch = "circadian" | "sleep";
type Time = "wake-time" | "bed-time";

export const circadianSwitchTopic = (area: string, which: Switch, end: "state" | "set") => homeTopic(area, which, end);
export const circadianTimeTopic = (area: string, which: Time, end: "state" | "set") => homeTopic(area, which, end);
export const circadianAvailabilityTopic = (area: string) => homeTopic(area, "circadian", "availability");

const DEVICE = {kind: "circadian", label: "Circadian Lighting", model: "Circadian lighting policy"};
const TIMES: Array<[Time, string, string, string]> = [
  ["wake-time", "wake_time", "Wake time", "mdi:weather-sunset-up"],
  ["bed-time", "bed_time", "Bed time", "mdi:weather-night"]
];

export function circadianDiscovery(config: CircadianPublishingConfig): RetainedText[] {
  const availability = circadianAvailabilityTopic(config.area);
  const toggle = (which: Switch, id: string, name: string, icon: string) => discoveryEntry(config, DEVICE, availability, {
    component: "switch", id, name, fields: {
      icon,
      command_topic: circadianSwitchTopic(config.area, which, "set"),
      state_topic: circadianSwitchTopic(config.area, which, "state"),
      payload_on: "ON",
      payload_off: "OFF",
      optimistic: false
    }
  });
  return [
    toggle("circadian", "circadian_lighting", "Circadian lighting", "mdi:clock-time-seven-outline"),
    toggle("sleep", "sleep", "Sleep", "mdi:sleep"),
    ...(config.timesFrom === "house" ? [] : TIMES.map(([which, id, name, icon]) => discoveryEntry(config, DEVICE, availability, {
      component: "time", id, name, fields: {
        icon,
        command_topic: circadianTimeTopic(config.area, which, "set"),
        state_topic: circadianTimeTopic(config.area, which, "state"),
        entity_category: "config"
      }
    })))
  ];
}

// The discovery topics of the circadian, sleep, wake and bed entities a room
// controller published under the area scheme before 6.0, which the policy
// clears before announcing its own, so Home Assistant can give the new
// entities the old entity IDs. (A room named after its node ID clears its
// own, at its start.)
export function roomCircadianDiscoveryTopics(config: {area: string; discoveryPrefix: string}, idScheme: "area" | "node" = "area", nodeId?: string): string[] {
  const owner = {area: config.area, discoveryPrefix: config.discoveryPrefix, idScheme, nodeId};
  return [
    discoveryEntity(owner, "switch", "circadian_lighting").topic,
    discoveryEntity(owner, "switch", "sleep").topic,
    discoveryEntity(owner, "time", "wake_time").topic,
    discoveryEntity(owner, "time", "bed_time").topic
  ];
}

// The state topics the policy publishes, which a room controller with the
// same area must never clear.
export function circadianStateTopics(area: string): string[] {
  return [
    circadianSwitchTopic(area, "circadian", "state"),
    circadianSwitchTopic(area, "sleep", "state"),
    circadianTimeTopic(area, "wake-time", "state"),
    circadianTimeTopic(area, "bed-time", "state")
  ];
}

// "HH:MM:SS", as Home Assistant's time entity reads it.
function timeState(time: string): string {
  return time + ":00";
}

export function circadianStateOutputs(config: CircadianPublishingConfig, state: Pick<CircadianState, "enabled" | "sleeping"> & {schedule: DaySchedule}): RetainedText[] {
  if (!publishesState(config)) return [];
  const outputs = [
    retainedText(circadianSwitchTopic(config.area, "circadian", "state"), state.enabled ? "ON" : "OFF"),
    retainedText(circadianSwitchTopic(config.area, "sleep", "state"), state.sleeping ? "ON" : "OFF")
  ];
  if (config.timesFrom !== "house") {
    outputs.push(
      retainedText(circadianTimeTopic(config.area, "wake-time", "state"), timeState(state.schedule.wakeTime)),
      retainedText(circadianTimeTopic(config.area, "bed-time", "state"), timeState(state.schedule.bedTime))
    );
  }
  return outputs;
}

const circadian = publishingNode<CircadianState, CircadianPublishingConfig>({
  entries: circadianDiscovery,
  availabilityTopic: circadianAvailabilityTopic,
  stateTopics: (config) => circadianStateTopics(config.area).filter((topic) =>
    config.timesFrom !== "house" || !/\/(wake|bed)-time\/state$/.test(topic)),
  stateOutputs: circadianStateOutputs
});

// What it publishes as the flows start and at its startup message. First,
// with discovery on, the circadian, sleep, wake and bed entries older room
// controllers published before 6.0 under its area, cleared: those named
// after the area, and those named after each room node with its area
// (`roomNodeIds`, found in the flows, migrated or not). Then its own entries,
// availability and state, in the same batch, so Home Assistant always
// removes the old entities before it sees the new ones and can give them the
// old entity IDs. Following a house, its own time entities are cleared too.
export function circadianStartingOutputs(config: CircadianPublishingConfig, state: CircadianState, roomNodeIds: readonly string[] = []): RetainedText[] {
  return [...circadianClears(config, roomNodeIds), ...circadian.starting(config, state)];
}

function circadianClears(config: CircadianPublishingConfig, roomNodeIds: readonly string[]): RetainedText[] {
  if (!publishesDiscovery(config)) return [];
  const topics = [
    ...roomCircadianDiscoveryTopics(config),
    ...roomNodeIds.flatMap((nodeId) => roomCircadianDiscoveryTopics(config, "node", nodeId))
  ];
  if (config.timesFrom === "house") {
    topics.push(...circadianDiscovery({...config, timesFrom: "own"}).map(({topic}) => topic).filter((topic) => /\/time\//.test(topic)));
  }
  return [...new Set(topics)].map((topic) => retainedText(topic, ""));
}

export const circadianStoppingOutputs = circadian.stopping;
export const circadianRetainedTopics = circadian.retainedTopics;

// MQTT the policy reads, as its own events: ON or OFF on the circadian and
// sleep set topics, and a time on its own wake and bed set topics. Read only
// while it publishes; retained messages and other payloads are ignored with a
// trace. Anything else is not for these topics.
export function circadianInbound(
  msg: {topic?: unknown; payload?: unknown; retain?: unknown},
  config: CircadianPublishingConfig
): {event: CircadianEvent; traces: TraceEntry[]} | null {
  if (!publishesState(config) || typeof msg.topic !== "string") return null;
  const area = config.area;
  const sets: Array<[string, string, (text: string) => CircadianEvent | null, string]> = [
    [circadianSwitchTopic(area, "circadian", "set"), "circadian-set", (text) => onOff("circadian", text), "not-on-or-off"],
    [circadianSwitchTopic(area, "sleep", "set"), "sleep-set", (text) => onOff("sleep", text), "not-on-or-off"]
  ];
  if (config.timesFrom !== "house") {
    sets.push(
      [circadianTimeTopic(area, "wake-time", "set"), "wake-time-set", (text) => time("wakeTime", text), "not-a-time"],
      [circadianTimeTopic(area, "bed-time", "set"), "bed-time-set", (text) => time("bedTime", text), "not-a-time"]
    );
  }
  const set = sets.find(([topic]) => topic === msg.topic);
  if (!set) return null;
  const [, name, read, invalid] = set;
  const ignored = (reason: string, details: Record<string, unknown> = {}) =>
    ({event: {kind: "ignored"}, traces: [{event: name, outcome: "ignored", reason, details}]});
  if (msg.retain === true) return ignored("retained-message");
  const text = typeof msg.payload === "string" ? msg.payload.trim() : "";
  const event = read(text);
  return event ? {event, traces: []} : ignored(invalid, {payload: text});
}

function onOff(kind: Switch, text: string): CircadianEvent | null {
  const requested = text.toUpperCase();
  return requested === "ON" || requested === "OFF" ? {kind, enabled: requested === "ON"} : null;
}

function time(key: "wakeTime" | "bedTime", text: string): CircadianEvent | null {
  const value = timeEntityValue(text);
  return value === null ? null : {kind: "schedule", [key]: value};
}
