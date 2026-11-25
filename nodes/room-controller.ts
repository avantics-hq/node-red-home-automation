"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  transitionRoom,
  type RoomConfig,
  type RoomMessage,
  type RoomState,
  type RoomTarget,
  LEGACY_LIGHT_UNITS
} from "../lib/room-controller";
import {scheduledLighting} from "../lib/circadian";
import {resolveSchedule} from "../lib/circadian-schedule";
import type {LightLevels} from "../lib/light-styling";
import {publishingLifecycle} from "./publishing-lifecycle";
import {publishRoom, roomRetainedTopics, roomStartingOutputs, roomStoppingOutputs, type RoomPublishingConfig} from "../lib/room-publishing";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, whenFlowsStarted, type Send} from "./adapter";
import {referencedSchedule} from "./shared-schedule";
import {booleanSetting, jsonSetting, numberSetting, optionalBooleanSetting, optionalChoiceSetting, textSetting} from "../lib/settings";
import {ID_SCHEMES, discoveryPrefixSetting} from "../lib/ha-discovery";
import {publishingArea} from "../lib/topic-names";

interface RoomControllerConfig extends NodeDef {
  idScheme?: string | null;
  // The house schedule it follows, a config node's ID; "" or absent: none.
  houseSchedule?: string | null;
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
    // A schedule that is set but not running, as when it was deleted: the
    // room keeps to its own times and says so.
    const {schedule: house, missing: houseMissing} = referencedSchedule(RED, config.houseSchedule);
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
        timesFrom: house ? "house" : "room",
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
        lighting: scheduledLighting(schedule, levels),
        schedule
      };
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

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
        fill: status.manualCount || houseMissing ? "yellow" : status.circadianEnabled ? "green" : "grey",
        shape: "dot",
        text: (houseMissing ? "schedule missing: own times · " : "") + (status.circadianEnabled
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
      // Once per deploy, so a flow still sending Zigbee2MQTT units is told
      // without filling the log.
      if (!warnedLegacyUnits && result.traces.some(({reason}) => reason === LEGACY_LIGHT_UNITS)) {
        warnedLegacyUnits = true;
        node.warn("lighting values in brightness (1-254) or color_temp (mireds) are deprecated and will stop working in 6.0: " +
          "send brightnessPct (0-100) and colorTempKelvin instead");
      }
      updateStatus(result.status);
      return result;
    }
    let warnedLegacyUnits = false;

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

    // Times taken from a house are the house's: a room that no longer follows
    // one, as when its schedule was set to none or deleted, goes back to its
    // own times rather than keeping the house's last ones.
    const roomTrace = {area: controllerConfig.area, component: "room-controller"};
    if (house) {
      node.context().set("followsHouse", true);
    } else if (node.context().get("followsHouse") === true) {
      node.context().set("followsHouse", false);
      runReducer(node, roomTrace, (saved: Partial<RoomState> | undefined) => ({
        state: {...saved, schedule: undefined, scheduleSetting: undefined},
        traces: [{event: "house-schedule", outcome: "changed", reason: "own-times", details: {}}]
      }));
    }
    if (house) {
      // The house's times: once the flows have started, as this room may
      // have restarted alone, and at every change until it stops.
      const follow = guarded(node, () => {
        process({lighting: {kind: "schedule", ...house.schedule()}}, node.send.bind(node));
      });
      whenFlowsStarted(RED, node, follow);
      node.on("close", house.subscribe(follow));
    } else if (houseMissing) {
      runReducer(node, roomTrace, (state: unknown) => ({
        state,
        traces: [{event: "house-schedule", outcome: "ignored", reason: "schedule-missing", details: {schedule: config.houseSchedule}}]
      }));
      node.status({fill: "yellow", shape: "ring", text: "schedule missing: own times"});
    }

    refreshTimer = setInterval(guarded(node, () => {
      process({lighting: {kind: "refresh"}}, node.send.bind(node));
    }), refreshSeconds * 1000);

    // Available again as soon as this node runs, as after a redeploy of it
    // alone, rather than waiting for the flow's startup message.
    node.on("close", (_removed: boolean, done: () => void) => {
      clearInterval(refreshTimer);
      done();
    });
  }

  RED.nodes.registerType("home-room-lighting-controller", HomeRoomLightingController);
};

export = registerRoomController;
