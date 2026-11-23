"use strict";

import type {
  Node,
  NodeDef,
  NodeInitializer,
  NodeStatusFill,
  NodeStatusShape
} from "node-red";
import {
  transitionBacklighting,
  type BacklightingConfig,
  type BacklightingMessage,
  type BacklightingState
} from "../lib/backlighting-controller";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";
import {numberSetting} from "../lib/settings";

interface BacklightingNodeConfig extends NodeDef {
  area?: string;
  pollMs?: number | string;
  confirmationTimeoutMs?: number | string;
  maxAttempts?: number | string;
}

interface BacklightingNode extends Node {}
type BacklightingStatus = ReturnType<typeof transitionBacklighting>["status"];

const registerBacklightingController: NodeInitializer = (RED) => {
  function HomeBacklightingController(this: BacklightingNode, config: BacklightingNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controllerConfig: BacklightingConfig;
    try {
      controllerConfig = {
        pollMs: numberSetting(config.pollMs, "poll interval", 2000),
        confirmationTimeoutMs: numberSetting(config.confirmationTimeoutMs, "confirmation timeout", 15000),
        maxAttempts: numberSetting(config.maxAttempts, "max attempts", 2)
      };
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    function updateStatus(status: BacklightingStatus) {
      const appearances: Record<string, {fill: NodeStatusFill; shape: NodeStatusShape}> = {
        idle: {fill: "grey", shape: "dot"},
        transitioning: {fill: "blue", shape: "dot"},
        confirming: {fill: "blue", shape: "ring"},
        ready: {fill: "green", shape: "dot"},
        failed: {fill: "red", shape: "ring"}
      };
      const appearance = appearances[status.phase] ?? {fill: "grey", shape: "ring"};
      node.status({...appearance, text: status.text});
    }

    function schedule(state: BacklightingState) {
      clearTimeout(timer);
      timer = undefined;
      if (!state.pending) return;
      const dueAt = Math.min(state.pending.nextAt, state.pending.deadlineAt);
      const delay = Math.max(0, dueAt - Date.now());
      timer = setTimeout(guarded(node, () => {
        process({backlighting: {kind: "tick", generation: state.generation}}, node.send.bind(node));
      }), delay);
    }

    function process(msg: BacklightingMessage, send: Send) {
      const result = runReducer(node, {area: optionalArea(config), component: "backlighting-controller"},
        (saved: Partial<BacklightingState> | undefined, now) =>
          transitionBacklighting(saved, msg, controllerConfig, now));
      if (result.commands.length) {
        send([
          result.commands.map((backlightingCommand) => ({payload: undefined, backlightingCommand})),
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
    if ((context.get("state") as Partial<BacklightingState> | undefined)?.pending) {
      timer = setTimeout(guarded(node, () => {
        process({backlighting: {kind: "startup"}}, node.send.bind(node));
      }), 0);
    }

    onInput(node, (msg, send) => {
      process({
        backlighting: objectField<BacklightingMessage["backlighting"]>(msg, "backlighting")
      }, send);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(timer);
      done();
    });
  }

  RED.nodes.registerType("home-backlighting-controller", HomeBacklightingController);
};

export = registerBacklightingController;
