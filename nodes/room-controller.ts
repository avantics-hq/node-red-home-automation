"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  transitionRoom,
  movedCircadianSettings,
  type RoomConfig,
  type RoomMessage,
  type RoomState,
  type RoomTarget,
  INVALID_LIGHT_VALUES,
  MOVED_TO_CIRCADIAN,
  ON_OFF_ONLY,
  REMOVED_LIGHT_UNITS
} from "../lib/room-controller";
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

function parseTargets(value: unknown): RoomTarget[] {
  const targets = jsonSetting(value, "targets", []);
  if (!Array.isArray(targets) || targets.some((target) => {
    if (!target || typeof target !== "object") return true;
    const candidate = target as Record<string, unknown>;
    return typeof candidate.id !== "string" ||
      typeof candidate.stateTopic !== "string" ||
      typeof candidate.commandTopic !== "string";
  })) {
    throw new Error("targets must define id, stateTopic and commandTopic strings");
  }
  if (targets.some((target) => (target as Record<string, unknown>).onOffOnly !== undefined &&
    typeof (target as Record<string, unknown>).onOffOnly !== "boolean")) {
    throw new Error("a target's onOffOnly must be true or false");
  }
  const typedTargets = targets as RoomTarget[];
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
      const moved = movedCircadianSettings(config as unknown as Record<string, unknown>);
      if (moved.length) {
        throw new Error("circadian lighting moved to its own node in 6.0: add a circadian lighting policy wired to " +
          "this room, with this room's " + moved.join(", ") + ", then open and save this room");
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
      outputs: 1
    });

    function updateStatus(status: RoomStatus) {
      node.status({
        fill: status.manualCount ? "yellow" : status.styled ? "green" : "grey",
        shape: "dot",
        text: (status.styled ? "styled" : "unstyled") + " · " + status.onCount + " on · " + status.manualCount + " manual" +
          (status.overriddenCount ? " · " + status.overriddenCount + " overridden" : "")
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
      if (result.outputs.length) {
        send([result.outputs.map((output) => ({...output, payload: output.payload}))]);
      }
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
        topic: typeof msg.topic === "string" ? msg.topic : undefined,
        payload: msg.payload,
        retain: msg.retain === true
      }, send);
    });
  }

  RED.nodes.registerType("home-room-lighting-controller", HomeRoomLightingController);
};

export = registerRoomController;
