"use strict";

// The motion policy's MQTT and Home Assistant side: whether this node's
// motion lighting is enabled, and its vacancy delay, each as a retained
// state Home Assistant shows and a set topic it commands, plus availability.
// All of it is opt-in (see publishing-node.ts). The shared global enable is
// not exposed per node.

import type {TraceEntry} from "./bounded-trace";
import type {MotionInput} from "./motion-policy";
import {areaId} from "./topic-names";
import {
  discoveryEntry,
  publishesState,
  publishingNode,
  retainedText,
  type OptInPublishingConfig,
  type RetainedText
} from "./publishing-node";

export type MotionPublishingConfig = OptInPublishingConfig;
export type MotionPublication = RetainedText;

// The vacancy delays Home Assistant offers, in seconds: up to a day.
export const MAX_DELAY_SECONDS = 86400;

function motionTopic(area: string, name: string): string {
  return "home/" + areaId(area) + "/motion/" + name;
}

export const motionEnabledTopic = (area: string, end: "state" | "set") => motionTopic(area, "enabled/" + end);
export const motionDelayTopic = (area: string, end: "state" | "set") => motionTopic(area, "delay/" + end);
export const motionAvailabilityTopic = (area: string) => motionTopic(area, "availability");

const DEVICE = {kind: "motion", label: "Motion Lighting", model: "Motion lighting policy"};

// The enable switch and the vacancy delay number, on one device per node.
export function motionDiscovery(config: MotionPublishingConfig): MotionPublication[] {
  const availability = motionAvailabilityTopic(config.area);
  return [
    discoveryEntry(config, DEVICE, availability, {component: "switch", id: "motion_lighting", name: "Motion lighting", fields: {
      icon: "mdi:motion-sensor",
      command_topic: motionEnabledTopic(config.area, "set"),
      state_topic: motionEnabledTopic(config.area, "state"),
      payload_on: "ON",
      payload_off: "OFF",
      optimistic: false
    }}),
    discoveryEntry(config, DEVICE, availability, {component: "number", id: "vacancy_delay", name: "Vacancy delay", fields: {
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
    }})
  ];
}

// This node's enable state and vacancy delay, whenever either may change.
export function motionStateOutputs(config: MotionPublishingConfig, state: {areaEnabled: boolean; delaySeconds: number}): MotionPublication[] {
  if (!publishesState(config)) return [];
  return [
    retainedText(motionEnabledTopic(config.area, "state"), state.areaEnabled ? "ON" : "OFF"),
    retainedText(motionDelayTopic(config.area, "state"), String(state.delaySeconds))
  ];
}

const motion = publishingNode<{areaEnabled: boolean; delaySeconds: number}>({
  entries: motionDiscovery,
  availabilityTopic: motionAvailabilityTopic,
  stateTopics: (config) => [motionEnabledTopic(config.area, "state"), motionDelayTopic(config.area, "state")],
  stateOutputs: motionStateOutputs
});

export const motionStartingOutputs = motion.starting;
export const motionStoppingOutputs = motion.stopping;
export const motionRetainedTopics = motion.retainedTopics;

// MQTT the node reads, as its own inputs: ON or OFF on the enable set topic,
// and a delay in seconds on the delay set topic. Read only while it
// publishes; retained messages and other payloads are ignored with a trace.
// Anything else passes through unchanged.
export function motionInbound(
  msg: {topic?: unknown; payload?: unknown; retain?: unknown},
  config: MotionPublishingConfig
): {input: MotionInput; traces: TraceEntry[]} | null {
  if (!publishesState(config)) return null;
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
