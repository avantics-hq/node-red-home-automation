"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  transitionRoom,
  movedCircadianSettings,
  targetsWithTopics,
  type RoomConfig,
  type RoomMessage,
  type RoomState,
  type RoomTarget,
  INVALID_LIGHT_VALUES,
  MOVED_TO_CIRCADIAN,
  ON_OFF_ONLY,
  REMOVED_LIGHT_UNITS
} from "../lib/room-controller";
import {isLightReading} from "../lib/light-contract";
import {publishingLifecycle} from "./publishing-lifecycle";
import {publishRoom, roomRetainedTopics, roomStartingOutputs, roomStoppingOutputs, withoutCircadianState, type RoomPublishingConfig} from "../lib/room-publishing";
import {invalidConfig, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";
import {jsonSetting, numberSetting, optionalBooleanSetting, optionalChoiceSetting} from "../lib/settings";
import {ID_SCHEMES, discoveryPrefixSetting} from "../lib/ha-discovery";
import {publishingArea} from "../lib/topic-names";

interface RoomControllerConfig extends NodeDef {
  idScheme?: string | null;
  area?: string;
  publishState?: boolean | string;
  discovery?: boolean | string;
  displayName?: string;
  discoveryPrefix?: string;
  targets?: string;
  initialTransitionSeconds?: number | string;
}

interface RoomControllerNode extends Node {}

type RoomStatus = ReturnType<typeof transitionRoom>["status"];

// The room's lights: an id each, and onOffOnly for one that only switches.
// Their devices are reached through their adapters.
function parseTargets(value: unknown): RoomTarget[] {
  const targets = jsonSetting(value, "targets", []);
  if (!Array.isArray(targets) || targets.some((target) => !target || typeof target !== "object" ||
    typeof (target as Record<string, unknown>).id !== "string" || (target as Record<string, unknown>).id === "")) {
    throw new Error("targets must each have an id");
  }
  if (targets.some((target) => (target as Record<string, unknown>).onOffOnly !== undefined &&
    typeof (target as Record<string, unknown>).onOffOnly !== "boolean")) {
    throw new Error("a target's onOffOnly must be true or false");
  }
  const typedTargets = (targets as Array<Record<string, unknown>>)
    .map(({id, onOffOnly}) => ({id: id as string, ...(onOffOnly === true ? {onOffOnly: true} : {})}));
  if (new Set(typedTargets.map((target) => target.id)).size !== typedTargets.length) {
    throw new Error("target ids must be unique");
  }
  return typedTargets;
}

const registerRoomController: NodeInitializer = (RED) => {
  function HomeRoomLightingController(this: RoomControllerNode, config: RoomControllerConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const area = optionalArea(config);

    let controllerConfig: RoomConfig & RoomPublishingConfig;
    try {
      // A room saved before 6.0 still has its circadian settings, which moved
      // to the circadian lighting policy: it runs only once migrated, so it
      // can't quietly lose its styling.
      // Its lights' topics moved to their light adapters likewise: one
      // migration covers both.
      const moved = movedCircadianSettings(config as unknown as Record<string, unknown>);
      const lights = targetsWithTopics(config.targets);
      if (moved.length || lights.length) {
        throw new Error("this room was saved before 6.0: " + [
          ...(moved.length ? ["circadian lighting moved to its own node (add a circadian lighting policy wired to this room, " +
            "with its " + moved.join(", ") + ")"] : []),
          ...(lights.length ? ["its lights are reached through light adapters (add one for " + lights.join(", ") +
            ": a zigbee2mqtt light, or your own on the neutral light contract, and remove their topics from Targets JSON)"] : [])
        ].join(", and ") + "; then open and save this room");
      }
      // Not set (null, or absent from a flow saved before these settings)
      // means on, so an older flow keeps publishing as before.
      const publishState = optionalBooleanSetting(config.publishState, "publish state") ?? true;
      const discovery = optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? true;
      // Both publish under topics and IDs named after the area; otherwise the
      // area is only a label.
      if (publishState || discovery) publishingArea(area, true);
      controllerConfig = {
        nodeId: node.id,
        // Not set: a node saved before node IDs, which keeps its area-named
        // entities. The editor gives new nodes "node".
        idScheme: optionalChoiceSetting(config.idScheme, "ID scheme", ID_SCHEMES) ?? "area",
        area,
        displayName: config.displayName || area,
        discoveryPrefix: discoveryPrefixSetting(config.discoveryPrefix),
        publishState,
        discovery,
        targets: parseTargets(config.targets),
        initialTransitionSeconds: numberSetting(config.initialTransitionSeconds, "initial transition", 1)
      };
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    // A room saved before 6.0 recorded the circadian and sleep state topics
    // as its own. The circadian lighting policy publishes them now, so they
    // leave the record: neither this room's start nor its deletion clears
    // them.
    const recorded = node.context().get("retainedTopics");
    if (Array.isArray(recorded)) node.context().set("retainedTopics", withoutCircadianState(recorded as string[]));

    // Available, and clear of what it no longer publishes, as soon as it
    // runs; offline as it stops; nothing left behind when deleted.
    const lifecycle = publishingLifecycle(RED, node, {
      retainedTopics: () => roomRetainedTopics(controllerConfig),
      starting: () => roomStartingOutputs(controllerConfig),
      stopping: () => roomStoppingOutputs(controllerConfig),
      output: 0,
      outputs: 3
    });

    function updateStatus(status: RoomStatus) {
      node.status({
        fill: status.manualCount ? "yellow" : status.styled ? "green" : "grey",
        shape: "dot",
        text: (status.styled ? "styled" : "unstyled") + " · " + status.onCount + " on · " + status.manualCount + " manual" +
          (status.overriddenCount ? " · " + status.overriddenCount + " overridden" : "") +
          (status.offlineCount ? " · " + status.offlineCount + " offline" : "")
      });
    }

    // Each once per deploy, so a flow still sending them is told without
    // filling the log.
    const warnings: Array<[string, string]> = [
      [REMOVED_LIGHT_UNITS, "lighting values in brightness (1-254) or color_temp (mireds) were removed in 6.0 and are left out: " +
        "send brightnessPct (0-100) and colorTempKelvin instead"],
      [INVALID_LIGHT_VALUES, "lighting values left out: brightnessPct must be a number and colorTempKelvin a number above 0"],
      [ON_OFF_ONLY, "lighting values sent to a light marked onOffOnly are left out: it only switches on and off"],
      [MOVED_TO_CIRCADIAN, "circadian, sleep and schedule messages go to the circadian lighting policy since 6.0: this room ignores them"]
    ];
    const warned = new Set<string>();

    function process(msg: RoomMessage, send: Send) {
      const result = runReducer(node, {area: controllerConfig.area, component: "room-controller"},
        (saved: Partial<RoomState> | undefined, now) => publishRoom(saved, msg, controllerConfig, now));
      // Output 1: MQTT publications (control states, availability,
      // discovery). Output 2: light commands, for the lights' adapters.
      // Output 3: each light's reading passed on with its control state, for
      // activity lighting.
      const reading = isLightReading(msg.light) && msg.light.kind === "observed" &&
        controllerConfig.targets.some(({id}) => id === (msg.light as {target: string}).target) ? msg.light : null;
      const control = reading ? result.status.control[reading.target] : undefined;
      const outputs = [
        result.outputs.length ? result.outputs.map((output) => ({...output, payload: output.payload})) : null,
        result.commands.length ? result.commands.map((light) => ({payload: undefined, light})) : null,
        reading ? {payload: undefined, light: {...reading, control, manual: control === "manual"}} : null
      ];
      if (outputs.some((output) => output !== null)) send(outputs);
      for (const [reason, text] of warnings) {
        if (!warned.has(reason) && result.traces.some((entry) => entry.reason === reason)) {
          warned.add(reason);
          node.warn(text);
        }
      }
      updateStatus(result.status);
      return result;
    }

    onInput(node, (msg, send) => {
      // The startup's own announcement comes from publishRoom.
      if (objectField<RoomMessage["lighting"]>(msg, "lighting")?.kind === "startup") lifecycle.startup(send);
      process({
        lighting: objectField<RoomMessage["lighting"]>(msg, "lighting"),
        light: msg.light,
        topic: typeof msg.topic === "string" ? msg.topic : undefined,
        payload: msg.payload,
        retain: msg.retain === true
      }, send);
    });
  }

  RED.nodes.registerType("home-room-lighting-controller", HomeRoomLightingController);
};

export = registerRoomController;
