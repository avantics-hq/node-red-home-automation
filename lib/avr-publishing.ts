"use strict";

// The receiver's MQTT and Home Assistant side: its observed power, source
// and volume as retained state, its availability, and sensors that show
// them. All of it is opt-in; the receiver controller only commands and
// observes the receiver.

import {DISCOVERY_ORIGIN, OFFLINE, ONLINE, discoveryDevice, discoveryEntity, type IdScheme} from "./ha-discovery";
import type {AvrObserved} from "./avr-controller";
import {areaId} from "./topic-names";

export interface AvrPublishingConfig {
  area: string;
  // Both off unless switched on: the receiver published nothing before.
  publishState?: boolean;
  discovery?: boolean;
  // Read with discoveryPrefixSetting, which gives Home Assistant's default.
  discoveryPrefix: string;
  nodeId?: string;
  idScheme?: IdScheme;
  // The configured volume bounds, which the volume number offers.
  minVolume: number;
  maxVolume: number;
}

export interface AvrPublication {
  topic: string;
  payload: string;
  retain: true;
}

type Field = "power" | "source" | "volume";
const FIELDS: Field[] = ["power", "source", "volume"];

export function avrPublishesState(config: AvrPublishingConfig): boolean {
  return config.area !== "" && config.publishState === true;
}

export function avrPublishesDiscovery(config: AvrPublishingConfig): boolean {
  return avrPublishesState(config) && config.discovery === true;
}

export function receiverTopic(area: string, name: string): string {
  return "home/" + areaId(area) + "/receiver/" + name;
}

function retained(topic: string, payload: string): AvrPublication {
  return {topic, payload, retain: true};
}

// A field's state as published, or null while it isn't known.
function fieldValue(observed: Partial<AvrObserved> | undefined, field: Field): string | null {
  const value = observed?.[field];
  if (value === null || value === undefined) return null;
  if (field === "power") return value === "on" ? "ON" : "OFF";
  return String(value);
}

// Power and source sensors, and a volume number that shows the volume and
// sets it, within the configured bounds, on one device per node.
export function avrDiscovery(config: AvrPublishingConfig): AvrPublication[] {
  return [
    avrEntity(config, "binary_sensor", "receiver_power", "Power", {device_class: "power", state_topic: receiverTopic(config.area, "power/state"), payload_on: "ON", payload_off: "OFF"}),
    avrEntity(config, "sensor", "receiver_source", "Source", {icon: "mdi:import", state_topic: receiverTopic(config.area, "source/state")}),
    avrEntity(config, "number", "receiver_volume", "Volume", {
      icon: "mdi:volume-high",
      state_topic: receiverTopic(config.area, "volume/state"),
      command_topic: receiverTopic(config.area, "volume/set"),
      min: config.minVolume,
      max: config.maxVolume,
      step: 0.5,
      mode: "slider"
    })
  ];
}

// A volume from the volume number's set topic, as the receiver's own
// absolute volume request, so it takes the same bounded, confirmed path as
// any other request. Read only while the node publishes; retained messages
// and anything but a number are ignored with a trace.
export function avrVolumeRequest(
  msg: {topic?: unknown; payload?: unknown; retain?: unknown},
  config: AvrPublishingConfig
): {value: number} | {ignored: string; payload: string} | null {
  if (!avrPublishesState(config) || msg.topic !== receiverTopic(config.area, "volume/set")) return null;
  const text = typeof msg.payload === "string" ? msg.payload.trim() : typeof msg.payload === "number" ? String(msg.payload) : "";
  if (msg.retain === true) return {ignored: "retained-message", payload: text};
  const value = text === "" ? NaN : Number(text);
  return Number.isFinite(value) ? {value} : {ignored: "not-a-number", payload: text};
}

export function avrEntity(config: AvrPublishingConfig, component: string, entity: string, name: string, fields: Record<string, unknown>): AvrPublication {
  const ids = discoveryEntity(config, component, entity);
  return retained(ids.topic, JSON.stringify({
    // Home Assistant shows it after the device's name, which has the area.
    name,
    unique_id: ids.uniqueId,
    default_entity_id: ids.defaultEntityId,
    ...fields,
    availability_topic: receiverTopic(config.area, "availability"),
    device: {
      ...discoveryDevice(config, "receiver"),
      name: config.area + " Receiver",
      manufacturer: "Node-RED",
      model: "AV receiver controller"
    },
    origin: DISCOVERY_ORIGIN
  }));
}

// The observed fields that changed since `before` (all known fields when
// there's no `before`).
export function avrStateOutputs(
  config: AvrPublishingConfig,
  observed: Partial<AvrObserved> | undefined,
  before?: Partial<AvrObserved>
): AvrPublication[] {
  if (!avrPublishesState(config)) return [];
  return FIELDS.flatMap((field) => {
    const value = fieldValue(observed, field);
    if (value === null || (before && fieldValue(before, field) === value)) return [];
    return [retained(receiverTopic(config.area, field + "/state"), value)];
  });
}

// What the node publishes as it starts: its discovery entries, its
// availability and what it knows of the receiver.
export function avrStartingOutputs(config: AvrPublishingConfig, observed: Partial<AvrObserved> | undefined, extraEntities: AvrPublication[] = []): AvrPublication[] {
  const outputs = avrPublishesDiscovery(config) ? [...avrDiscovery(config), ...extraEntities] : [];
  if (avrPublishesState(config)) outputs.push(retained(receiverTopic(config.area, "availability"), ONLINE));
  return [...outputs, ...avrStateOutputs(config, observed)];
}

export function avrStoppingOutputs(config: AvrPublishingConfig): AvrPublication[] {
  return avrPublishesState(config) ? [retained(receiverTopic(config.area, "availability"), OFFLINE)] : [];
}

export function avrRetainedTopics(config: AvrPublishingConfig, extraEntities: AvrPublication[] = []): string[] {
  const topics = avrPublishesDiscovery(config) ? [...avrDiscovery(config), ...extraEntities].map(({topic}) => topic) : [];
  if (avrPublishesState(config)) {
    topics.push(receiverTopic(config.area, "availability"), ...FIELDS.map((field) => receiverTopic(config.area, field + "/state")));
  }
  return topics;
}
