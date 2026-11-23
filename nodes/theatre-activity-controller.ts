"use strict";

import type {
  Node,
  NodeDef,
  NodeInitializer,
  NodeStatusFill,
  NodeStatusShape
} from "node-red";
import {
  normaliseActivityProfiles,
  transitionTheatre,
  type TheatreConfig,
  type TheatreMessage,
  type TheatreState
} from "../lib/theatre-activity-controller";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";
import {numberSetting} from "../lib/settings";

interface TheatreActivityNodeConfig extends NodeDef {
  area?: string;
  freshnessMs?: number | string;
  activityProfiles?: string;
  recoveryOffActivity?: string;
}

interface TheatreActivityNode extends Node {}
type TheatreStatus = ReturnType<typeof transitionTheatre>["status"];

const registerTheatreActivityController: NodeInitializer = (RED) => {
  function HomeTheatreActivityController(this: TheatreActivityNode, config: TheatreActivityNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let timer: ReturnType<typeof setInterval> | undefined;

    let controllerConfig: TheatreConfig;
    try {
      controllerConfig = {
        area: optionalArea(config),
        freshnessMs: Math.max(1000, numberSetting(config.freshnessMs, "freshness", 30000)),
        activityProfiles: normaliseActivityProfiles(JSON.parse(config.activityProfiles || "{}") as unknown),
        recoveryOffActivity: config.recoveryOffActivity || "off"
      };
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

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
      const result = runReducer(node, {area: controllerConfig.area, component: "theatre-activity-controller"},
        (saved: Partial<TheatreState> | undefined, now) => transitionTheatre(saved, msg, controllerConfig, now));
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

    onInput(node, (msg, send) => {
      // Target controllers' output 2 also carries their own events (such as
      // msg.avr and msg.display) beside target state; only msg.theatre is
      // for this controller.
      if (!msg.theatre || typeof msg.theatre !== "object") {
        return;
      }
      process({
        theatre: objectField<TheatreMessage["theatre"]>(msg, "theatre")
      }, send);
    });

    timer = setInterval(guarded(node, () => {
      const saved = context.get("state") as Partial<TheatreState> | undefined;
      // Recovering has no desired activity yet but still needs ticks to time out.
      if (!saved?.desired && saved?.phase !== "recovering") return;
      process({theatre: {kind: "tick", generation: saved.generation}}, node.send.bind(node));
    }), Math.max(1000, Math.floor(controllerConfig.freshnessMs / 2)));

    node.on("close", (_removed: boolean, done: () => void) => {
      clearInterval(timer);
      done();
    });
  }

  RED.nodes.registerType("home-theatre-activity-controller", HomeTheatreActivityController);
};

export = registerTheatreActivityController;
