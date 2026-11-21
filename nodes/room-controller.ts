"use strict";

import type {Node, NodeDef, NodeInitializer, NodeMessage} from "node-red";
import {appendTrace} from "../lib/bounded-trace";
import {
  transitionRoom,
  type RoomConfig,
  type RoomMessage,
  type RoomState,
  type RoomTarget
} from "../lib/room-controller";

interface RoomControllerConfig extends NodeDef {
  area?: string;
  displayName?: string;
  targets?: string;
  latitude?: number | string;
  longitude?: number | string;
  minBrightnessPct?: number | string;
  maxBrightnessPct?: number | string;
  minColorTempKelvin?: number | string;
  maxColorTempKelvin?: number | string;
  sleepBrightnessPct?: number | string;
  sleepColorTempKelvin?: number | string;
  initialTransitionSeconds?: number | string;
  refreshTransitionSeconds?: number | string;
  refreshSeconds?: number | string;
  initialSleep?: boolean | string;
}

interface RoomControllerNode extends Node {}

type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
type RoomStatus = ReturnType<typeof transitionRoom>["status"];

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requiredNumber(value: unknown, name: string): number {
  if (value === "" || value === null || value === undefined) {
    throw new Error(`${name} is required`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

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
    const context = node.context();
    let refreshTimer: ReturnType<typeof setInterval> | undefined;

    let controllerConfig: RoomConfig;
    try {
      controllerConfig = {
        area: config.area || "room",
        displayName: config.displayName || config.area || "Room",
        targets: parseTargets(config.targets),
        latitude: requiredNumber(config.latitude, "latitude"),
        longitude: requiredNumber(config.longitude, "longitude"),
        minBrightnessPct: number(config.minBrightnessPct, 1),
        maxBrightnessPct: number(config.maxBrightnessPct, 100),
        minColorTempKelvin: number(config.minColorTempKelvin, 2000),
        maxColorTempKelvin: number(config.maxColorTempKelvin, 5500),
        sleepBrightnessPct: number(config.sleepBrightnessPct, 1),
        sleepColorTempKelvin: number(config.sleepColorTempKelvin, 1000),
        initialTransitionSeconds: number(config.initialTransitionSeconds, 1),
        refreshTransitionSeconds: number(config.refreshTransitionSeconds, 45),
        initialSleep: config.initialSleep === true || config.initialSleep === "true"
      };
    } catch (error) {
      node.status({fill: "red", shape: "ring", text: "invalid configuration"});
      node.error(error);
      return;
    }

    function updateStatus(status: RoomStatus) {
      node.status({
        fill: status.manualCount ? "yellow" : status.circadianEnabled ? "green" : "grey",
        shape: "dot",
        text: (status.circadianEnabled
          ? (status.sleeping ? "sleep" : "circadian")
          : "manual only") + " · " + status.onCount + " on · " + status.manualCount + " manual"
      });
    }

    function process(msg: RoomMessage, send: Send) {
      const now = new Date();
      const saved = context.get("state") as Partial<RoomState> | undefined;
      const result = transitionRoom(saved, msg, controllerConfig, now);
      context.set("state", result.state);
      appendTrace(context, {
        area: controllerConfig.area,
        component: "room-controller"
      }, result.traces, now);
      if (result.outputs.length) {
        send([result.outputs.map((output) => ({...output, payload: output.payload}))]);
      }
      updateStatus(result.status);
      return result;
    }

    node.on("input", (msg, send, done) => {
      try {
        process({
          lighting: msg.lighting && typeof msg.lighting === "object"
            ? msg.lighting as RoomMessage["lighting"]
            : undefined,
          topic: typeof msg.topic === "string" ? msg.topic : undefined,
          payload: msg.payload,
          retain: msg.retain === true
        }, send);
        done();
      } catch (error) {
        node.error(error, msg);
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const refreshSeconds = Math.max(10, number(config.refreshSeconds, 90));
    refreshTimer = setInterval(() => {
      try {
        process({lighting: {kind: "refresh"}}, node.send.bind(node));
      } catch (error) {
        node.error(error);
      }
    }, refreshSeconds * 1000);

    node.on("close", (_removed: boolean, done: () => void) => {
      clearInterval(refreshTimer);
      done();
    });
  }

  RED.nodes.registerType("home-room-lighting-controller", HomeRoomLightingController);
};

export = registerRoomController;
