"use strict";

// The cover node's MQTT and Home Assistant side: an MQTT cover entity, its
// state (and position, for a position cover) as retained text, and the set
// topics Home Assistant commands. Those come back to the cover node as its
// own requests, so every move goes through its confirmed path; nothing
// commands the device through Home Assistant. All of it is opt-in (see
// publishing-node.ts).
//
// A room usually has several covers, so each is named in its topics:
// home/<area>/cover/<name>/..., apart from the device's own topics.

import type {TraceEntry} from "./bounded-trace";
import type {CoverView} from "./cover-models";
import {
  discoveryEntry,
  publishesState,
  publishingNode,
  retainedText,
  type OptInPublishingConfig,
  type RetainedText
} from "./publishing-node";
import {areaId, homeTopic} from "./topic-names";

export interface CoverPublishingConfig extends OptInPublishingConfig {
  // This cover's name in its topics, such as "left".
  name: string;
  // Whether it takes positions, or only open, close and stop.
  positions: boolean;
}

function coverTopic(config: {area: string; name: string}, path: string): string {
  return homeTopic(config.area, "cover", areaId(config.name), path);
}

export const coverStateTopic = (config: {area: string; name: string}) => coverTopic(config, "state");
export const coverPositionTopic = (config: {area: string; name: string}) => coverTopic(config, "position");
export const coverCommandTopic = (config: {area: string; name: string}) => coverTopic(config, "set");
export const coverSetPositionTopic = (config: {area: string; name: string}) => coverTopic(config, "position/set");
export const coverAvailabilityTopic = (config: {area: string; name: string}) => coverTopic(config, "availability");

function device(config: CoverPublishingConfig) {
  return {kind: "cover_" + areaId(config.name), label: "Cover " + config.name, model: "Cover controller"};
}

// One cover entity: open, close and stop always; set position and the
// position it reports for a position cover.
export function coverDiscovery(config: CoverPublishingConfig): RetainedText[] {
  const positions = config.positions ? {
    position_topic: coverPositionTopic(config),
    set_position_topic: coverSetPositionTopic(config),
    position_open: 100,
    position_closed: 0
  } : {};
  return [
    discoveryEntry(config, device(config), coverAvailabilityTopic(config), {
      component: "cover",
      id: "cover_" + areaId(config.name),
      name: config.name,
      fields: {
        command_topic: coverCommandTopic(config),
        payload_open: "OPEN",
        payload_close: "CLOSE",
        payload_stop: "STOP",
        state_topic: coverStateTopic(config),
        state_open: "open",
        state_opening: "opening",
        state_closed: "closed",
        state_closing: "closing",
        state_stopped: "stopped",
        optimistic: false,
        ...positions
      }
    })
  ];
}

// The cover's state, and its position when it has one, once it has
// reported; nothing before.
export function coverStateOutputs(config: CoverPublishingConfig, view: CoverView | null): RetainedText[] {
  if (!publishesState(config) || !view) return [];
  return [
    retainedText(coverStateTopic(config), view.state),
    ...(config.positions && view.position !== null ? [retainedText(coverPositionTopic(config), String(Math.round(view.position)))] : [])
  ];
}

const cover = publishingNode<CoverView | null, CoverPublishingConfig>({
  entries: coverDiscovery,
  availabilityTopic: (_area, config) => coverAvailabilityTopic(config),
  stateTopics: (config) => [coverStateTopic(config), ...(config.positions ? [coverPositionTopic(config)] : [])],
  stateOutputs: coverStateOutputs
});

export const coverStartingOutputs = cover.starting;
export const coverStoppingOutputs = cover.stopping;
export const coverRetainedTopics = cover.retainedTopics;

// A request from Home Assistant on the cover's set topics, as the payload the
// cover node takes from a flow: "open", "close", "stop" or a position. Read
// only while it publishes; retained messages and anything else are ignored
// with a trace. Anything else passes through (null).
export function coverInbound(
  msg: {topic?: unknown; payload?: unknown; retain?: unknown},
  config: CoverPublishingConfig
): {request: string | number | null; traces: TraceEntry[]} | null {
  if (!publishesState(config)) return null;
  const command = msg.topic === coverCommandTopic(config);
  const position = config.positions && msg.topic === coverSetPositionTopic(config);
  if (!command && !position) return null;
  const event = command ? "command-set" : "position-set";
  const ignored = (reason: string, details: Record<string, unknown> = {}) =>
    ({request: null, traces: [{event, outcome: "ignored", reason, details}]});
  if (msg.retain === true) return ignored("retained-message");
  const text = typeof msg.payload === "string" ? msg.payload.trim() : typeof msg.payload === "number" ? String(msg.payload) : "";
  if (command) {
    const requested = text.toUpperCase();
    if (requested !== "OPEN" && requested !== "CLOSE" && requested !== "STOP") return ignored("not-open-close-or-stop", {payload: text});
    return {request: requested.toLowerCase(), traces: []};
  }
  const value = text === "" ? NaN : Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 100) return ignored("not-a-position", {payload: text});
  return {request: Math.round(value), traces: []};
}
