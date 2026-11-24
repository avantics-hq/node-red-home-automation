"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  transitionRoom,
  type RoomConfig,
  type RoomMessage,
  type RoomState,
  type RoomTarget
} from "../lib/room-controller";
import {scheduledLighting} from "../lib/circadian";
import {resolveSchedule} from "../lib/circadian-schedule";
import type {LightLevels} from "../lib/light-styling";
import {publishRoom, roomRetainedTopics, roomStartingOutputs, roomStoppingOutputs, type RoomPublishingConfig} from "../lib/room-publishing";
import {retainedClears} from "../lib/retained-topics";
import {allRetainedTopics, clearStaleRetained, wasDeleted, guarded, invalidConfig, whenFlowsStarted, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";
import {booleanSetting, jsonSetting, numberSetting, optionalBooleanSetting, optionalChoiceSetting, textSetting} from "../lib/settings";
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
  maxBrightnessPct?: number | string;
  maxColorTempKelvin?: number | string;
  sleepBrightnessPct?: number | string;
  sleepColorTempKelvin?: number | string;
  initialTransitionSeconds?: number | string;
  refreshTransitionSeconds?: number | string;
  refreshSeconds?: number | string;
  initialSleep?: boolean | string;
  wakeTime?: string;
  bedTime?: string;
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
    let refreshTimer: ReturnType<typeof setInterval> | undefined;

    let controllerConfig: RoomConfig & RoomPublishingConfig;
    let refreshSeconds: number;
    try {
      // Not set (null, or absent from a flow saved before these settings)
      // means on, so an older flow keeps publishing as before.
      const publishState = optionalBooleanSetting(config.publishState, "publish state") ?? true;
      const discovery = optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? true;
      // Both publish under topics and IDs named after the area; otherwise the
      // area is only a label.
      if (publishState || discovery) publishingArea(area, true);
      refreshSeconds = Math.max(10, numberSetting(config.refreshSeconds, "refresh interval", 60));
      // Saved latitude, longitude and minimum settings from earlier versions
      // are ignored.
      const levels: LightLevels = {
        maxBrightnessPct: numberSetting(config.maxBrightnessPct, "daytime brightness", 100),
        maxColorTempKelvin: numberSetting(config.maxColorTempKelvin, "daytime colour temperature", 6500),
        sleepBrightnessPct: numberSetting(config.sleepBrightnessPct, "sleep brightness", 1),
        sleepColorTempKelvin: numberSetting(config.sleepColorTempKelvin, "sleep colour temperature", 2200)
      };
      const schedule = resolveSchedule(textSetting(config.wakeTime, "wake time", "07:00"), textSetting(config.bedTime, "bed time", "23:00"));
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
        initialTransitionSeconds: numberSetting(config.initialTransitionSeconds, "initial transition", 1),
        refreshTransitionSeconds: numberSetting(config.refreshTransitionSeconds, "refresh transition", 60),
        initialSleep: booleanSetting(config.initialSleep, "initial sleep", false),
        // The adapter picks the circadian lighting; the controller only asks
        // it how a light should look.
        lighting: scheduledLighting(schedule, levels)
      };
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    function updateStatus(status: RoomStatus) {
      node.status({
        fill: status.manualCount ? "yellow" : status.circadianEnabled ? "green" : "grey",
        shape: "dot",
        text: (status.circadianEnabled
          ? (status.sleeping ? "sleep" : "circadian")
          : "manual only") + " · " + status.onCount + " on · " + status.manualCount + " manual" +
          (status.overriddenCount ? " · " + status.overriddenCount + " overridden" : "")
      });
    }

    function process(msg: RoomMessage, send: Send) {
      const result = runReducer(node, {area: controllerConfig.area, component: "room-controller"},
        (saved: Partial<RoomState> | undefined, now) => publishRoom(saved, msg, controllerConfig, now));
      if (result.outputs.length) {
        send([result.outputs.map((output) => ({...output, payload: output.payload}))]);
      }
      updateStatus(result.status);
      return result;
    }

    onInput(node, (msg, send) => {
      if (objectField<RoomMessage["lighting"]>(msg, "lighting")?.kind === "startup") {
        const clears = clearStaleRetained(node, roomRetainedTopics(controllerConfig));
        if (clears.length) send([clears.map((clear) => ({...clear}))]);
      }
      process({
        lighting: objectField<RoomMessage["lighting"]>(msg, "lighting"),
        topic: typeof msg.topic === "string" ? msg.topic : undefined,
        payload: msg.payload,
        retain: msg.retain === true
      }, send);
    });

    refreshTimer = setInterval(guarded(node, () => {
      process({lighting: {kind: "refresh"}}, node.send.bind(node));
    }), refreshSeconds * 1000);

    // Available again as soon as this node runs, as after a redeploy of it
    // alone, rather than waiting for the flow's startup message.
    whenFlowsStarted(RED, node, () => {
      const clears = clearStaleRetained(node, roomRetainedTopics(controllerConfig), "flows-started");
      const starting = [...clears, ...roomStartingOutputs(controllerConfig)];
      if (starting.length) node.send([starting.map((output) => ({...output}))]);
    });

    node.on("close", (removed: boolean, done: () => void) => {
      clearInterval(refreshTimer);
      // Reaches the broker only if the MQTT out node is still running, as in a
      // deploy of modified nodes or flows; the broker's own Close and Will
      // messages cover a full deploy, a restart and a crash (see the README).
      // A deleted node removes its entities and retained state instead.
      const stopping = wasDeleted(RED, node, removed)
        ? retainedClears(allRetainedTopics(node, roomRetainedTopics(controllerConfig)))
        : roomStoppingOutputs(controllerConfig);
      if (stopping.length) node.send([stopping.map((output) => ({...output}))]);
      done();
    });
  }

  RED.nodes.registerType("home-room-lighting-controller", HomeRoomLightingController);
};

export = registerRoomController;
