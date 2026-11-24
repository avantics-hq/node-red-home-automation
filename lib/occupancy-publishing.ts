"use strict";

// Occupancy fusion's MQTT and Home Assistant side: the room's occupancy as a
// retained ON/OFF state, its availability, and an occupancy binary sensor.
// All of it is opt-in (see publishing-node.ts); the fusion itself only
// decides occupancy.

import {areaId} from "./topic-names";
import {
  discoveryEntry,
  publishesState,
  publishingNode,
  retainedText,
  type OptInPublishingConfig,
  type RetainedText
} from "./publishing-node";

export type OccupancyPublishingConfig = OptInPublishingConfig;
export type OccupancyPublication = RetainedText;

function occupancyTopic(area: string, name: string): string {
  return "home/" + areaId(area) + "/occupancy/" + name;
}

export function occupancyStateTopic(area: string): string {
  return occupancyTopic(area, "state");
}

export function occupancyAvailabilityTopic(area: string): string {
  return occupancyTopic(area, "availability");
}

// The occupancy binary sensor's discovery entry.
export function occupancyDiscovery(config: OccupancyPublishingConfig): OccupancyPublication {
  return discoveryEntry(config, {kind: "occupancy", label: "Occupancy", model: "Occupancy fusion"}, occupancyAvailabilityTopic(config.area), {
    component: "binary_sensor",
    id: "occupancy",
    name: "Occupancy",
    fields: {device_class: "occupancy", state_topic: occupancyStateTopic(config.area), payload_on: "ON", payload_off: "OFF"}
  });
}

// The occupancy state, published whenever it changes.
export function occupancyStateOutputs(config: OccupancyPublishingConfig, occupied: boolean): OccupancyPublication[] {
  return publishesState(config) ? [retainedText(occupancyStateTopic(config.area), occupied ? "ON" : "OFF")] : [];
}

const occupancy = publishingNode<boolean>({
  entries: (config) => [occupancyDiscovery(config)],
  availabilityTopic: occupancyAvailabilityTopic,
  stateTopics: (config) => [occupancyStateTopic(config.area)],
  stateOutputs: occupancyStateOutputs
});

export const occupancyStartingOutputs = occupancy.starting;
export const occupancyStoppingOutputs = occupancy.stopping;
export const occupancyRetainedTopics = occupancy.retainedTopics;
