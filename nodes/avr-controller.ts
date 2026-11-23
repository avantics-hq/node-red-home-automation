"use strict";

import type {
  Node,
  NodeDef,
  NodeInitializer,
  NodeStatusFill,
  NodeStatusShape
} from "node-red";
import {
  normaliseAvrConfig,
  transitionAvr,
  type AvrConfig,
  type AvrMessage,
  type AvrState
} from "../lib/avr-controller";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";

interface AvrControllerConfig extends NodeDef {
  area?: string;
  sources?: string;
  retryMs?: number | string;
  maxAttempts?: number | string;
  minVolume?: number | string;
  maxVolume?: number | string;
}

interface AvrControllerNode extends Node {}

type AvrStatus = ReturnType<typeof transitionAvr>["status"];

function parseSources(value: string | undefined): unknown {
  const sources: unknown = JSON.parse(value || "{}");
  if (!sources || Array.isArray(sources) || typeof sources !== "object") {
    throw new Error("sources must be a JSON object");
  }
  return sources;
}

const registerAvrController: NodeInitializer = (RED) => {
  function HomeAvrController(this: AvrControllerNode, config: AvrControllerConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    let controllerConfig: AvrConfig;
    try {
      // The same validation the reducer applies, so a bad configuration
      // fails here at deploy rather than on every message.
      controllerConfig = normaliseAvrConfig({...config, area: optionalArea(config), sources: parseSources(config.sources)});
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    function updateStatus(status: AvrStatus) {
      const appearances: Record<string, {fill: NodeStatusFill; shape: NodeStatusShape}> = {
        discovering: {fill: "grey", shape: "ring"},
        idle: {fill: "grey", shape: "dot"},
        transitioning: {fill: "blue", shape: "dot"},
        ready: {fill: "green", shape: "dot"},
        manual_override: {fill: "yellow", shape: "ring"},
        failed: {fill: "red", shape: "ring"}
      };
      const appearance = appearances[status.phase] ?? {fill: "grey", shape: "ring"};
      node.status({...appearance, text: status.text});
    }

    function scheduleRetry(state: AvrState) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      if (!state.pending?.deadlineAt) return;
      const delay = Math.max(0, state.pending.deadlineAt - Date.now());
      retryTimer = setTimeout(guarded(node, () => {
        process({avr: {kind: "tick"}}, node.send.bind(node));
      }), delay);
    }

    function process(msg: AvrMessage, send: Send) {
      const result = runReducer(node, {area: controllerConfig.area, component: "avr-controller"},
        (saved: Partial<AvrState> | undefined, now) => transitionAvr(saved, msg, controllerConfig, now));
      const commands = result.commands.map((command) => ({
        payload: Buffer.from(command.payload, "utf8"),
        avr_command: command.avrCommand
      }));
      const outputs = [...result.events, ...result.targetStates];
      if (commands.length || outputs.length) {
        send([
          commands.length ? commands : null,
          outputs.length
            ? outputs.map((event) => ({payload: undefined, ...event}))
            : null
        ]);
      }
      updateStatus(result.status);
      scheduleRetry(result.state);
      return result;
    }

    // Context survives a redeploy but timers do not. Recover a pending
    // transition with the reducer's own startup (re-observe, never replay)
    // rather than ticking old state; a later startup from the flow repeats it.
    if ((context.get("state") as Partial<AvrState> | undefined)?.pending) {
      retryTimer = setTimeout(guarded(node, () => {
        process({avr: {kind: "startup"}}, node.send.bind(node));
      }), 0);
    }

    onInput(node, (msg, send) => {
      process({
        avr: objectField<AvrMessage["avr"]>(msg, "avr"),
        payload: msg.payload
      }, send);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(retryTimer);
      done();
    });
  }

  RED.nodes.registerType("home-avr-controller", HomeAvrController);
};

export = registerAvrController;
