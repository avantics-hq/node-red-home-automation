"use strict";

// What every opt-in publishing node shares (occupancy fusion, the motion
// policy, the AVR controller): publishing is off unless switched on and
// needs an area; discovery needs the state; each entity carries the node's
// IDs, availability, device and origin; and it publishes its entries, then
// online, then its state as it starts, and offline as it stops. Each node
// supplies only its own entries and state.
//
// The room lighting controller and the theatre state contract publish by
// default for older flows, and clear rather than omit entries with discovery
// off, so they keep their own rules.

import {DISCOVERY_ORIGIN, OFFLINE, ONLINE, discoveryDevice, discoveryEntity, type IdScheme} from "./ha-discovery";

export interface OptInPublishingConfig {
  area: string;
  // Both off unless switched on.
  publishState?: boolean;
  discovery?: boolean;
  // Read with discoveryPrefixSetting, which gives Home Assistant's default.
  discoveryPrefix: string;
  nodeId?: string;
  idScheme?: IdScheme;
}

export interface RetainedText {
  topic: string;
  payload: string;
  retain: true;
}

export function retainedText(topic: string, payload: string): RetainedText {
  return {topic, payload, retain: true};
}

export function publishesState(config: OptInPublishingConfig): boolean {
  return config.area !== "" && config.publishState === true;
}

export function publishesDiscovery(config: OptInPublishingConfig): boolean {
  return publishesState(config) && config.discovery === true;
}

// The node's device in Home Assistant: `kind` names it under the area scheme
// (nodered_<area>_<kind>), and `label` follows the area in its name.
export interface PublishingDevice {
  kind: string;
  label: string;
  model: string;
}

// One discovery entry on the node's device, with the IDs, availability and
// origin every entity carries.
export function discoveryEntry(
  config: OptInPublishingConfig,
  device: PublishingDevice,
  availabilityTopic: string,
  entity: {component: string; id: string; name: string; fields: Record<string, unknown>}
): RetainedText {
  const ids = discoveryEntity(config, entity.component, entity.id);
  return retainedText(ids.topic, JSON.stringify({
    // Home Assistant shows it after the device's name, which has the area.
    name: entity.name,
    unique_id: ids.uniqueId,
    default_entity_id: ids.defaultEntityId,
    ...entity.fields,
    availability_topic: availabilityTopic,
    device: {
      ...discoveryDevice(config, device.kind),
      name: config.area + " " + device.label,
      manufacturer: "Node-RED",
      model: device.model
    },
    origin: DISCOVERY_ORIGIN
  }));
}

// A node's own parts, from which its starting, stopping and topic lists are
// made.
export interface PublishingParts<State, Config extends OptInPublishingConfig> {
  entries(config: Config): RetainedText[];
  availabilityTopic(area: string): string;
  stateTopics(config: Config): string[];
  stateOutputs(config: Config, state: State): RetainedText[];
}

export function publishingNode<State, Config extends OptInPublishingConfig = OptInPublishingConfig>(parts: PublishingParts<State, Config>) {
  return {
    // Its entries, availability and state, as it starts. Entries from before
    // discovery was switched off are cleared by the node's record of what it
    // published.
    starting(config: Config, state: State): RetainedText[] {
      const outputs = publishesDiscovery(config) ? parts.entries(config) : [];
      if (publishesState(config)) outputs.push(retainedText(parts.availabilityTopic(config.area), ONLINE));
      return [...outputs, ...parts.stateOutputs(config, state)];
    },
    stopping(config: Config): RetainedText[] {
      return publishesState(config) ? [retainedText(parts.availabilityTopic(config.area), OFFLINE)] : [];
    },
    // Every retained topic it publishes, for clearing those it no longer
    // does after a change, or all of them when deleted.
    retainedTopics(config: Config): string[] {
      const topics = publishesDiscovery(config) ? parts.entries(config).map(({topic}) => topic) : [];
      if (publishesState(config)) topics.push(parts.availabilityTopic(config.area), ...parts.stateTopics(config));
      return topics;
    }
  };
}
