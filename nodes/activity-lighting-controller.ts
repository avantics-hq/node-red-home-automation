"use strict";

import type {
  Node,
  NodeDef,
  NodeInitializer,
  NodeStatusFill,
  NodeStatusShape
} from "node-red";
import {
  normaliseLightingProfiles,
  transitionActivityLighting,
  type ActivityLightingConfig,
  type ActivityLightingMessage,
  type ActivityLightingState
} from "../lib/activity-lighting-controller";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";
import {jsonSetting, numberSetting, textSetting} from "../lib/settings";

interface ActivityLightingNodeConfig extends NodeDef {
  area?: string;
  profiles?: string;
  owner?: string;
  confirmationTimeoutMs?: number | string;
  maxAttempts?: number | string;
}

interface ActivityLightingNode extends Node {}
type ActivityLightingStatus = ReturnType<typeof transitionActivityLighting>["status"];

const registerActivityLightingController: NodeInitializer = (RED) => {
  function HomeActivityLightingController(this: ActivityLightingNode, config: ActivityLightingNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let timer: ReturnType<typeof setTimeout> | undefined;

    let controllerConfig: ActivityLightingConfig;
    try {
      controllerConfig = {
        profiles: normaliseLightingProfiles(jsonSetting(config.profiles, "profiles", {})),
        owner: textSetting(config.owner, "owner", "activity"),
        confirmationTimeoutMs: numberSetting(config.confirmationTimeoutMs, "confirmation timeout", 15000),
        maxAttempts: numberSetting(config.maxAttempts, "max attempts", 2)
      };
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

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
      timer = setTimeout(guarded(node, () => {
        process({activityLighting: {kind: "tick", generation: state.generation}}, node.send.bind(node));
      }), delay);
    }

    function process(msg: ActivityLightingMessage, send: Send) {
      const result = runReducer(node, {area: optionalArea(config), component: "activity-lighting-controller"},
        (saved: Partial<ActivityLightingState> | undefined, now) =>
          transitionActivityLighting(saved, msg, controllerConfig, now));
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

    // Context survives a redeploy but timers do not. Recover a pending
    // transition with the reducer's own startup (re-observe, never replay)
    // rather than ticking old state; a later startup from the flow repeats it.
    if ((context.get("state") as Partial<ActivityLightingState> | undefined)?.pending) {
      timer = setTimeout(guarded(node, () => {
        process({activityLighting: {kind: "startup"}}, node.send.bind(node));
      }), 0);
    }

    onInput(node, (msg, send) => {
      process({
        activityLighting: objectField<ActivityLightingMessage["activityLighting"]>(msg, "activityLighting")
      }, send);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(timer);
      done();
    });
  }

  RED.nodes.registerType("home-activity-lighting-controller", HomeActivityLightingController);
};

export = registerActivityLightingController;
