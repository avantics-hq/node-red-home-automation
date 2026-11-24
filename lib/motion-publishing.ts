"use strict";

// The motion policy's MQTT and Home Assistant side: whether this node's
// motion lighting is enabled, and its vacancy delay, each as a retained
// state Home Assistant shows and a set topic it commands, plus availability.
// All of it is opt-in. The shared global enable is not exposed per node.

import type {TraceEntry} from "./bounded-trace";
import {
  DISCOVERY_ORIGIN,
  OFFLINE,
  ONLINE,
  discoveryDevice,
  discoveryEntity,
  type IdScheme
} from "./ha-discovery";
import type {MotionInput} from "./motion-policy";
import {areaId} from "./topic-names";

export interface MotionPublishingConfig {
  area: string;
  // Both off unless switched on: motion published nothing before.
  publishState?: boolean;
  discovery?: boolean;
  // Read with discoveryPrefixSetting, which gives Home Assistant's default.
  discoveryPrefix: string;
  nodeId?: string;
  idScheme?: IdScheme;
}

export interface MotionPublication {
  topic: string;
  payload: string;
  retain: true;
}

// The vacancy delays Home Assistant offers, in seconds: up to a day.
export const MAX_DELAY_SECONDS = 86400;

export function motionPublishesState(config: MotionPublishingConfig): boolean {
  return config.area !== "" && config.publishState === true;
}

export function motionPublishesDiscovery(config: MotionPublishingConfig): boolean {
  return motionPublishesState(config) && config.discovery === true;
}

function motionTopic(area: string, name: string): string {
  return "home/" + areaId(area) + "/motion/" + name;
}

export const motionEnabledTopic = (area: string, end: "state" | "set") => motionTopic(area, "enabled/" + end);
export const motionDelayTopic = (area: string, end: "state" | "set") => motionTopic(area, "delay/" + end);
export const motionAvailabilityTopic = (area: string) => motionTopic(area, "availability");

function retained(topic: string, payload: string): MotionPublication {
  return {topic, payload, retain: true};
}

// The enable switch and the vacancy delay number, on one device per node.
export function motionDiscovery(config: MotionPublishingConfig): MotionPublication[] {
  const device = {
    ...discoveryDevice(config, "motion"),
    name: config.area + " Motion Lighting",
    manufacturer: "Node-RED",
    model: "Motion lighting policy"
  };
  const entry = (component: string, entity: string, name: string, fields: Record<string, unknown>) => {
    const ids = discoveryEntity(config, component, entity);
    return retained(ids.topic, JSON.stringify({
      // Home Assistant shows it after the device's name, which has the area.
      name,
      unique_id: ids.uniqueId,
      default_entity_id: ids.defaultEntityId,
      ...fields,
      availability_topic: motionAvailabilityTopic(config.area),
      device,
      origin: DISCOVERY_ORIGIN
    }));
  };
  return [
    entry("switch", "motion_lighting", "Motion lighting", {
      icon: "mdi:motion-sensor",
      command_topic: motionEnabledTopic(config.area, "set"),
      state_topic: motionEnabledTopic(config.area, "state"),
      payload_on: "ON",
      payload_off: "OFF",
      optimistic: false
    }),
    entry("number", "vacancy_delay", "Vacancy delay", {
      icon: "mdi:timer-outline",
      command_topic: motionDelayTopic(config.area, "set"),
      state_topic: motionDelayTopic(config.area, "state"),
      device_class: "duration",
      unit_of_measurement: "s",
      min: 0,
      max: MAX_DELAY_SECONDS,
      step: 1,
      mode: "box",
      entity_category: "config"
    })
  ];
}

// This node's enable state and vacancy delay, whenever either may change.
export function motionStateOutputs(config: MotionPublishingConfig, state: {areaEnabled: boolean; delaySeconds: number}): MotionPublication[] {
  if (!motionPublishesState(config)) return [];
  return [
    retained(motionEnabledTopic(config.area, "state"), state.areaEnabled ? "ON" : "OFF"),
    retained(motionDelayTopic(config.area, "state"), String(state.delaySeconds))
  ];
}

// What the node publishes as it starts: its discovery entries, its
// availability and its state. Entries from before discovery was switched
// off are cleared by the node's record of what it published.
export function motionStartingOutputs(config: MotionPublishingConfig, state: {areaEnabled: boolean; delaySeconds: number}): MotionPublication[] {
  const outputs = motionPublishesDiscovery(config) ? motionDiscovery(config) : [];
  if (motionPublishesState(config)) outputs.push(retained(motionAvailabilityTopic(config.area), ONLINE));
  return [...outputs, ...motionStateOutputs(config, state)];
}

export function motionStoppingOutputs(config: MotionPublishingConfig): MotionPublication[] {
  return motionPublishesState(config) ? [retained(motionAvailabilityTopic(config.area), OFFLINE)] : [];
}

export function motionRetainedTopics(config: MotionPublishingConfig): string[] {
  const topics = motionPublishesDiscovery(config) ? motionDiscovery(config).map(({topic}) => topic) : [];
  if (motionPublishesState(config)) {
    topics.push(motionAvailabilityTopic(config.area), motionEnabledTopic(config.area, "state"), motionDelayTopic(config.area, "state"));
  }
  return topics;
}

// MQTT the node reads, as its own inputs: ON or OFF on the enable set topic,
// and a delay in seconds on the delay set topic. Read only while it
// publishes; retained messages and other payloads are ignored with a trace.
// Anything else passes through unchanged.
export function motionInbound(
  msg: {topic?: unknown; payload?: unknown; retain?: unknown},
  config: MotionPublishingConfig
): {input: MotionInput; traces: TraceEntry[]} | null {
  if (!motionPublishesState(config)) return null;
  const enabledSet = msg.topic === motionEnabledTopic(config.area, "set");
  const delaySet = msg.topic === motionDelayTopic(config.area, "set");
  if (!enabledSet && !delaySet) return null;
  const event = enabledSet ? "enabled-set" : "delay-set";
  const ignored = (reason: string, details: Record<string, unknown> = {}) =>
    ({input: {source: "ignored", payload: undefined}, traces: [{event, outcome: "ignored", reason, details}]});
  if (msg.retain === true) return ignored("retained-message");
  const text = typeof msg.payload === "string" ? msg.payload.trim() : typeof msg.payload === "number" ? String(msg.payload) : "";
  if (enabledSet) {
    const requested = text.toUpperCase();
    if (requested !== "ON" && requested !== "OFF") return ignored("not-on-or-off", {payload: text});
    return {input: {source: "area-enabled", payload: requested}, traces: []};
  }
  const seconds = text === "" ? NaN : Number(text);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DELAY_SECONDS) return ignored("not-a-delay", {payload: text});
  return {input: {source: "delay", payload: Math.round(seconds)}, traces: []};
}
