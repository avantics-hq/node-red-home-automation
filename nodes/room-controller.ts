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
import {guarded, invalidConfig, number, objectField, onInput, runReducer, type Send} from "./adapter";

interface RoomControllerConfig extends NodeDef {
  area?: string;
  displayName?: string;
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

function parseTargets(value: string | undefined): RoomTarget[] {
  const targets: unknown = JSON.parse(value || "[]");
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
    let refreshTimer: ReturnType<typeof setInterval> | undefined;

    let controllerConfig: RoomConfig;
    try {
      // Saved latitude, longitude and minimum settings from earlier versions
      // are ignored.
      const levels: LightLevels = {
        maxBrightnessPct: number(config.maxBrightnessPct, 100),
        maxColorTempKelvin: number(config.maxColorTempKelvin, 6500),
        sleepBrightnessPct: number(config.sleepBrightnessPct, 1),
        sleepColorTempKelvin: number(config.sleepColorTempKelvin, 2200)
      };
      const schedule = resolveSchedule(config.wakeTime, config.bedTime);
      controllerConfig = {
        area: config.area || "room",
        displayName: config.displayName || config.area || "Room",
        targets: parseTargets(config.targets),
        ...levels,
        ...schedule,
        initialTransitionSeconds: number(config.initialTransitionSeconds, 1),
        refreshTransitionSeconds: number(config.refreshTransitionSeconds, 60),
        initialSleep: config.initialSleep === true || config.initialSleep === "true",
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
        (saved: Partial<RoomState> | undefined, now) => transitionRoom(saved, msg, controllerConfig, now));
      if (result.outputs.length) {
        send([result.outputs.map((output) => ({...output, payload: output.payload}))]);
      }
      updateStatus(result.status);
      return result;
    }

    onInput(node, (msg, send) => {
      process({
        lighting: objectField<RoomMessage["lighting"]>(msg, "lighting"),
        topic: typeof msg.topic === "string" ? msg.topic : undefined,
        payload: msg.payload,
        retain: msg.retain === true
      }, send);
    });

    const refreshSeconds = Math.max(10, number(config.refreshSeconds, 60));
    refreshTimer = setInterval(guarded(node, () => {
      process({lighting: {kind: "refresh"}}, node.send.bind(node));
    }), refreshSeconds * 1000);

    node.on("close", (_removed: boolean, done: () => void) => {
      clearInterval(refreshTimer);
      done();
    });
  }

  RED.nodes.registerType("home-room-lighting-controller", HomeRoomLightingController);
};

export = registerRoomController;
