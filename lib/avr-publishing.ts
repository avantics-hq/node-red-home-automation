"use strict";

// The receiver's MQTT and Home Assistant side: its observed power, source
// and volume as retained state, its availability, power and source sensors,
// and a volume number. All of it is opt-in (see publishing-node.ts); the
// receiver controller only commands and observes the receiver.

import type {AvrObserved} from "./avr-controller";
import {homeTopic} from "./topic-names";
import {
  discoveryEntry,
  publishesState,
  publishingNode,
  retainedText,
  type OptInPublishingConfig,
  type RetainedText
} from "./publishing-node";

export interface AvrPublishingConfig extends OptInPublishingConfig {
  // The configured volume bounds, which the volume number offers.
  minVolume: number;
  maxVolume: number;
}

export type AvrPublication = RetainedText;

type Field = "power" | "source" | "volume";
const FIELDS: Field[] = ["power", "source", "volume"];

const DEVICE = {kind: "receiver", label: "Receiver", model: "AV receiver controller"};

export function receiverTopic(area: string, name: string): string {
  return homeTopic(area, "receiver", name);
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
  const entry = (component: string, id: string, name: string, fields: Record<string, unknown>) =>
    discoveryEntry(config, DEVICE, receiverTopic(config.area, "availability"), {component, id, name, fields});
  return [
    entry("binary_sensor", "receiver_power", "Power", {device_class: "power", state_topic: receiverTopic(config.area, "power/state"), payload_on: "ON", payload_off: "OFF"}),
    entry("sensor", "receiver_source", "Source", {icon: "mdi:import", state_topic: receiverTopic(config.area, "source/state")}),
    entry("number", "receiver_volume", "Volume", {
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

// How long a volume from Home Assistant waits for a newer one. A slider,
// repeated taps or an automation can send several in a row; only the last
// becomes a request, so the receiver never chases steps already replaced.
export const VOLUME_SET_SETTLE_MS = 300;

// A volume from the volume number's set topic, as the receiver's own
// absolute volume request, so it takes the same bounded, confirmed path as
// any other request. Read only while the node publishes; retained messages
// and anything but a number are ignored with a trace.
export function avrVolumeRequest(
  msg: {topic?: unknown; payload?: unknown; retain?: unknown},
  config: AvrPublishingConfig
): {value: number} | {ignored: string; payload: string} | null {
  if (!publishesState(config) || msg.topic !== receiverTopic(config.area, "volume/set")) return null;
  const text = typeof msg.payload === "string" ? msg.payload.trim() : typeof msg.payload === "number" ? String(msg.payload) : "";
  if (msg.retain === true) return {ignored: "retained-message", payload: text};
  const value = text === "" ? NaN : Number(text);
  return Number.isFinite(value) ? {value} : {ignored: "not-a-number", payload: text};
}

// The observed fields that changed since `before` (all known fields when
// there's no `before`).
export function avrStateOutputs(
  config: AvrPublishingConfig,
  observed: Partial<AvrObserved> | undefined,
  before?: Partial<AvrObserved>
): AvrPublication[] {
  if (!publishesState(config)) return [];
  return FIELDS.flatMap((field) => {
    const value = fieldValue(observed, field);
    if (value === null || (before && fieldValue(before, field) === value)) return [];
    return [retainedText(receiverTopic(config.area, field + "/state"), value)];
  });
}

const receiver = publishingNode<Partial<AvrObserved> | undefined, AvrPublishingConfig>({
  entries: avrDiscovery,
  availabilityTopic: (area) => receiverTopic(area, "availability"),
  stateTopics: (config) => FIELDS.map((field) => receiverTopic(config.area, field + "/state")),
  stateOutputs: (config, observed) => avrStateOutputs(config, observed)
});

export const avrStartingOutputs = receiver.starting;
export const avrStoppingOutputs = receiver.stopping;
export const avrRetainedTopics = receiver.retainedTopics;
