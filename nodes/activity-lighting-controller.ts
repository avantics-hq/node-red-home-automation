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
  normaliseLightingProfiles,
  transitionActivityLighting,
  type ActivityLightingConfig,
  type ActivityLightingMessage,
  type ActivityLightingState
} from "../lib/activity-lighting-controller";

interface ActivityLightingNodeConfig extends NodeDef {
  area?: string;
  profiles?: string;
  confirmationTimeoutMs?: number | string;
  maxAttempts?: number | string;
}

interface ActivityLightingNode extends Node {}
type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
type ActivityLightingStatus = ReturnType<typeof transitionActivityLighting>["status"];

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const registerActivityLightingController: NodeInitializer = (RED) => {
  function HomeActivityLightingController(this: ActivityLightingNode, config: ActivityLightingNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let timer: ReturnType<typeof setTimeout> | undefined;

    let profiles: ActivityLightingConfig["profiles"];
    try {
      profiles = normaliseLightingProfiles(JSON.parse(config.profiles || "{}") as unknown);
    } catch (error) {
      node.status({fill: "red", shape: "ring", text: "invalid profile JSON"});
      node.error(error);
      return;
    }
    const controllerConfig: ActivityLightingConfig = {
      profiles,
      confirmationTimeoutMs: number(config.confirmationTimeoutMs, 15000),
      maxAttempts: number(config.maxAttempts, 2)
    };

    function updateStatus(status: ActivityLightingStatus) {
      const appearances: Record<string, {fill: NodeStatusFill; shape: NodeStatusShape}> = {
        idle: {fill: "grey", shape: "dot"},
        transitioning: {fill: "blue", shape: "dot"},
        confirming: {fill: "blue", shape: "ring"},
        ready: {fill: "green", shape: "dot"},
        failed: {fill: "yellow", shape: "ring"}
      };
      const appearance = appearances[status.phase] ?? {fill: "grey", shape: "ring"};
      node.status({...appearance, text: status.text});
    }

    function schedule(state: ActivityLightingState) {
      clearTimeout(timer);
      timer = undefined;
      if (!state.pending?.deadlineAt) return;
      const delay = Math.max(0, state.pending.deadlineAt - Date.now());
      timer = setTimeout(() => {
        try {
          process({activityLighting: {kind: "tick", generation: state.generation}}, node.send.bind(node));
        } catch (error) {
          node.error(error);
        }
      }, delay);
    }

    function process(msg: ActivityLightingMessage, send: Send) {
      const now = new Date();
      const saved = context.get("state") as Partial<ActivityLightingState> | undefined;
      const result = transitionActivityLighting(saved, msg, controllerConfig, now);
      context.set("state", result.state);
      appendTrace(context, {
        area: config.area || "lounge",
        component: "activity-lighting-controller"
      }, result.traces, now);
      if (result.commands.length) {
        send([
          result.commands.map((activityLightingCommand) => ({
            payload: undefined,
            activityLightingCommand,
            ...(activityLightingCommand.lighting ? {lighting: activityLightingCommand.lighting} : {})
          })),
          null
        ]);
      }
      if (result.events.length) {
        send([null, result.events.map((event) => ({payload: undefined, ...event}))]);
      }
      updateStatus(result.status);
      schedule(result.state);
      return result;
    }

    // Context survives a redeploy but timers do not: pick up any pending deadline.
    const savedState = context.get("state") as ActivityLightingState | undefined;
    if (savedState) schedule(savedState);

    node.on("input", (msg, send, done) => {
      try {
        process({
          activityLighting: msg.activityLighting && typeof msg.activityLighting === "object"
            ? msg.activityLighting as ActivityLightingMessage["activityLighting"]
            : undefined
        }, send);
        done();
      } catch (error) {
        node.error(error, msg);
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(timer);
      done();
    });
  }

  RED.nodes.registerType("home-activity-lighting-controller", HomeActivityLightingController);
};

export = registerActivityLightingController;
