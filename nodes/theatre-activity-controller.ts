"use strict";

import type {
  Node,
  NodeDef,
  NodeInitializer,
  NodeMessage,
  NodeStatusFill,
  NodeStatusShape
} from "node-red";
import {appendTrace} from "../lib/bounded-trace";
import {
  normaliseActivityProfiles,
  transitionTheatre,
  type TheatreConfig,
  type TheatreMessage,
  type TheatreState
} from "../lib/theatre-activity-controller";

interface TheatreActivityNodeConfig extends NodeDef {
  area?: string;
  freshnessMs?: number | string;
  activityProfiles?: string;
  recoveryOffActivity?: string;
}

interface TheatreActivityNode extends Node {}
type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
type TheatreStatus = ReturnType<typeof transitionTheatre>["status"];

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const registerTheatreActivityController: NodeInitializer = (RED) => {
  function HomeTheatreActivityController(this: TheatreActivityNode, config: TheatreActivityNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let timer: ReturnType<typeof setInterval> | undefined;

    let activityProfiles: TheatreConfig["activityProfiles"];
    try {
      activityProfiles = normaliseActivityProfiles(JSON.parse(config.activityProfiles || "{}") as unknown);
    } catch (error) {
      node.status({fill: "red", shape: "ring", text: "invalid activity profiles"});
      node.error(error);
      return;
    }
    const controllerConfig: TheatreConfig = {
      area: config.area || "lounge",
      freshnessMs: Math.max(1000, number(config.freshnessMs, 30000)),
      activityProfiles,
      recoveryOffActivity: config.recoveryOffActivity || "off"
    };

    function updateStatus(status: TheatreStatus) {
      const appearances: Record<string, {fill: NodeStatusFill; shape: NodeStatusShape}> = {
        idle: {fill: "grey", shape: "dot"},
        transitioning: {fill: "blue", shape: "dot"},
        confirming: {fill: "blue", shape: "ring"},
        waiting_for_source: {fill: "yellow", shape: "ring"},
        recovering: {fill: "yellow", shape: "ring"},
        manual_override: {fill: "yellow", shape: "ring"},
        ready: {fill: "green", shape: "dot"},
        failed: {fill: "red", shape: "ring"}
      };
      const appearance = appearances[status.phase] ?? {fill: "grey", shape: "ring"};
      node.status({...appearance, text: status.text});
    }

    function process(msg: TheatreMessage, send: Send) {
      const now = new Date();
      const saved = context.get("state") as Partial<TheatreState> | undefined;
      const result = transitionTheatre(saved, msg, controllerConfig, now);
      context.set("state", result.state);
      appendTrace(context, {
        area: controllerConfig.area,
        component: "theatre-activity-controller"
      }, result.traces, now);
      if (result.commands.length) {
        send([
          result.commands.map((theatreCommand) => ({payload: undefined, theatreCommand})),
          null
        ]);
      }
      if (result.events.length) {
        send([null, result.events.map((event) => ({payload: undefined, ...event}))]);
      }
      updateStatus(result.status);
      return result;
    }

    node.on("input", (msg, send, done) => {
      // Target controllers' output 2 also carries their own events (such as
      // msg.avr and msg.display) beside target state; only msg.theatre is
      // for this controller.
      if (!msg.theatre || typeof msg.theatre !== "object") {
        done();
        return;
      }
      try {
        process({
          theatre: msg.theatre && typeof msg.theatre === "object"
            ? msg.theatre as TheatreMessage["theatre"]
            : undefined
        }, send);
        done();
      } catch (error) {
        node.error(error, msg);
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });

    timer = setInterval(() => {
      const saved = context.get("state") as Partial<TheatreState> | undefined;
      // Recovering has no desired activity yet but still needs ticks to time out.
      if (!saved?.desired && saved?.phase !== "recovering") return;
      try {
        process({theatre: {kind: "tick", generation: saved.generation}}, node.send.bind(node));
      } catch (error) {
        node.error(error);
      }
    }, Math.max(1000, Math.floor(controllerConfig.freshnessMs / 2)));

    node.on("close", (_removed: boolean, done: () => void) => {
      clearInterval(timer);
      done();
    });
  }

  RED.nodes.registerType("home-theatre-activity-controller", HomeTheatreActivityController);
};

export = registerTheatreActivityController;
