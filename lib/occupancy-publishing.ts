"use strict";

// Occupancy fusion's MQTT and Home Assistant side: the room's occupancy as a
// retained ON/OFF state, its availability, and an occupancy binary sensor.
// All of it is opt-in; the fusion itself only decides occupancy.

import {
  DEFAULT_DISCOVERY_PREFIX,
  DISCOVERY_ORIGIN,
  OFFLINE,
  ONLINE,
  discoveryDevice,
  discoveryEntity,
  type IdScheme
} from "./ha-discovery";
import {areaId} from "./topic-names";

export interface OccupancyPublishingConfig {
  area: string;
  // Both off unless switched on: occupancy published nothing before.
  publishState?: boolean;
  discovery?: boolean;
  discoveryPrefix?: string;
  nodeId?: string;
  idScheme?: IdScheme;
}

export interface OccupancyPublication {
  topic: string;
  payload: string;
  retain: true;
}

export function occupancyPublishesState(config: OccupancyPublishingConfig): boolean {
  return config.area !== "" && config.publishState === true;
}

export function occupancyPublishesDiscovery(config: OccupancyPublishingConfig): boolean {
  return occupancyPublishesState(config) && config.discovery === true;
}

function occupancyTopic(area: string, name: string): string {
  return "home/" + areaId(area) + "/occupancy/" + name;
}

export function occupancyStateTopic(area: string): string {
  return occupancyTopic(area, "state");
}

export function occupancyAvailabilityTopic(area: string): string {
  return occupancyTopic(area, "availability");
}

function retained(topic: string, payload: string): OccupancyPublication {
  return {topic, payload, retain: true};
}

// The occupancy binary sensor's discovery entry.
export function occupancyDiscovery(config: OccupancyPublishingConfig): OccupancyPublication {
  const owner = {...config, discoveryPrefix: config.discoveryPrefix ?? DEFAULT_DISCOVERY_PREFIX};
  const ids = discoveryEntity(owner, "binary_sensor", "occupancy");
  return retained(ids.topic, JSON.stringify({
    name: config.area + " Occupancy",
    unique_id: ids.uniqueId,
    default_entity_id: ids.defaultEntityId,
    device_class: "occupancy",
    state_topic: occupancyStateTopic(config.area),
    payload_on: "ON",
    payload_off: "OFF",
    availability_topic: occupancyAvailabilityTopic(config.area),
    device: {
      ...discoveryDevice(owner, "occupancy"),
      name: config.area + " Occupancy",
      manufacturer: "Node-RED",
      model: "Occupancy fusion"
    },
    origin: DISCOVERY_ORIGIN
  }));
}

// The occupancy state, published whenever it changes.
export function occupancyStateOutputs(config: OccupancyPublishingConfig, occupied: boolean): OccupancyPublication[] {
  return occupancyPublishesState(config) ? [retained(occupancyStateTopic(config.area), occupied ? "ON" : "OFF")] : [];
}

// What the node publishes as it starts: its discovery entry, its
// availability, and its current state. An entry from before discovery was
// switched off is cleared by the node's record of what it published.
export function occupancyStartingOutputs(config: OccupancyPublishingConfig, occupied: boolean): OccupancyPublication[] {
  const outputs: OccupancyPublication[] = [];
  if (occupancyPublishesDiscovery(config)) outputs.push(occupancyDiscovery(config));
  if (occupancyPublishesState(config)) {
    outputs.push(retained(occupancyAvailabilityTopic(config.area), ONLINE));
    outputs.push(...occupancyStateOutputs(config, occupied));
  }
  return outputs;
}

export function occupancyStoppingOutputs(config: OccupancyPublishingConfig): OccupancyPublication[] {
  return occupancyPublishesState(config) ? [retained(occupancyAvailabilityTopic(config.area), OFFLINE)] : [];
}

// Every retained topic the node publishes, for clearing those it no longer
// does after a change, or all of them when the node is deleted.
export function occupancyRetainedTopics(config: OccupancyPublishingConfig): string[] {
  const topics = occupancyPublishesDiscovery(config) ? [occupancyDiscovery(config).topic] : [];
  if (occupancyPublishesState(config)) topics.push(occupancyAvailabilityTopic(config.area), occupancyStateTopic(config.area));
  return topics;
}
