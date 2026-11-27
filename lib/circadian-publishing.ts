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

// The policy's announcement waits this long after the flows start, so the
// rooms' clears of their old circadian entities (sent as the flows start)
// reach Home Assistant first and the new entities keep the old entity IDs.
export const ANNOUNCE_DELAY_MS = 2000;

// As the flows start, everything but its discovery entries, which wait until
// the old room entries are cleared (see circadianAnnouncement).
export function circadianStartingOutputs(config: CircadianPublishingConfig, state: CircadianState): RetainedText[] {
  const entries = new Set(publishesDiscovery(config) ? circadianDiscovery(config).map(({topic}) => topic) : []);
  return circadian.starting(config, state).filter(({topic}) => !entries.has(topic));
}

// Its discovery: first the old room entries cleared, then its own, and,
// following a house, its own time entities cleared.
export function circadianAnnouncement(config: CircadianPublishingConfig): RetainedText[] {
  if (!publishesDiscovery(config)) return [];
  const own = circadianDiscovery(config);
  const clears = roomCircadianDiscoveryTopics(config).map((topic) => retainedText(topic, ""));
  if (config.timesFrom === "house") {
    const times = discoveryEntriesWithOwnTimes(config).filter((topic) => !own.some((entry) => entry.topic === topic));
    clears.push(...times.map((topic) => retainedText(topic, "")));
  }
  return [...clears, ...own];
}

function discoveryEntriesWithOwnTimes(config: CircadianPublishingConfig): string[] {
  return circadianDiscovery({...config, timesFrom: "own"}).map(({topic}) => topic);
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
