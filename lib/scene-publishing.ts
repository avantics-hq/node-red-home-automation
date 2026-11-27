"use strict";

// The scene's MQTT and Home Assistant side: a switch entity that shows
// whether the scene is on and turns it on and off, its state as retained
// text, and its set topic. What Home Assistant sends comes back to the scene
// node as a start or end like any other, so the scene acts only through its
// rooms and motion policies. All of it is opt-in (see publishing-node.ts).
//
// An area may have several scenes, so each is named in its topics:
// home/<area>/scene/<name>/...

import type {TraceEntry} from "./bounded-trace";
import {discoveryEntry, publishesState, publishingNode, retainedText, type OptInPublishingConfig, type RetainedText} from "./publishing-node";
import {areaId, homeTopic} from "./topic-names";

export interface ScenePublishingConfig extends OptInPublishingConfig {
  // The scene's name, such as "Bath".
  name: string;
}

function sceneTopic(config: {area: string; name: string}, path: string): string {
  return homeTopic(config.area, "scene", areaId(config.name), path);
}

export const sceneStateTopic = (config: {area: string; name: string}) => sceneTopic(config, "state");
export const sceneCommandTopic = (config: {area: string; name: string}) => sceneTopic(config, "set");
export const sceneAvailabilityTopic = (config: {area: string; name: string}) => sceneTopic(config, "availability");

export function sceneDiscovery(config: ScenePublishingConfig): RetainedText[] {
  return [
    discoveryEntry(config, {kind: "scene_" + areaId(config.name), label: "Scene " + config.name, model: "Scene"},
      sceneAvailabilityTopic(config), {
        component: "switch",
        id: "scene_" + areaId(config.name),
        name: config.name,
        fields: {
          icon: "mdi:palette",
          command_topic: sceneCommandTopic(config),
          state_topic: sceneStateTopic(config),
          payload_on: "ON",
          payload_off: "OFF",
          optimistic: false
        }
      })
  ];
}

export function sceneStateOutputs(config: ScenePublishingConfig, active: boolean): RetainedText[] {
  return publishesState(config) ? [retainedText(sceneStateTopic(config), active ? "ON" : "OFF")] : [];
}

const scene = publishingNode<boolean, ScenePublishingConfig>({
  entries: sceneDiscovery,
  availabilityTopic: (_area, config) => sceneAvailabilityTopic(config),
  stateTopics: (config) => [sceneStateTopic(config)],
  stateOutputs: sceneStateOutputs
});

export const sceneStartingOutputs = scene.starting;
export const sceneStoppingOutputs = scene.stopping;
export const sceneRetainedTopics = scene.retainedTopics;

// Home Assistant's ON or OFF on the scene's set topic, as a start or an end.
// Read only while it publishes; retained messages and anything else are
// ignored with a trace. Anything on another topic passes through (null).
export function sceneInbound(
  msg: {topic?: unknown; payload?: unknown; retain?: unknown},
  config: ScenePublishingConfig
): {kind: "start" | "end" | null; traces: TraceEntry[]} | null {
  if (!publishesState(config) || msg.topic !== sceneCommandTopic(config)) return null;
  const ignored = (reason: string, details: Record<string, unknown> = {}) =>
    ({kind: null, traces: [{event: "command-set", outcome: "ignored", reason, details}]});
  if (msg.retain === true) return ignored("retained-message");
  const text = typeof msg.payload === "string" ? msg.payload.trim().toUpperCase() : "";
  if (text === "ON") return {kind: "start", traces: []};
  if (text === "OFF") return {kind: "end", traces: []};
  return ignored("not-on-or-off", {payload: typeof msg.payload === "string" ? msg.payload : typeof msg.payload});
}
