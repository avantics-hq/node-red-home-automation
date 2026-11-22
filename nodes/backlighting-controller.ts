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
  transitionBacklighting,
  type BacklightingConfig,
  type BacklightingMessage,
  type BacklightingState
} from "../lib/backlighting-controller";

interface BacklightingNodeConfig extends NodeDef {
  area?: string;
  pollMs?: number | string;
  confirmationTimeoutMs?: number | string;
  maxAttempts?: number | string;
}

interface BacklightingNode extends Node {}
type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
type BacklightingStatus = ReturnType<typeof transitionBacklighting>["status"];

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const registerBacklightingController: NodeInitializer = (RED) => {
  function HomeBacklightingController(this: BacklightingNode, config: BacklightingNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controllerConfig: BacklightingConfig = {
      pollMs: number(config.pollMs, 2000),
      confirmationTimeoutMs: number(config.confirmationTimeoutMs, 15000),
      maxAttempts: number(config.maxAttempts, 2)
    };

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
      timer = setTimeout(() => {
        try {
          process({backlighting: {kind: "tick", generation: state.generation}}, node.send.bind(node));
        } catch (error) {
          node.error(error);
        }
      }, delay);
    }

    function process(msg: BacklightingMessage, send: Send) {
      const now = new Date();
      const saved = context.get("state") as Partial<BacklightingState> | undefined;
      const result = transitionBacklighting(saved, msg, controllerConfig, now);
      context.set("state", result.state);
      appendTrace(context, {
        area: config.area || "lounge",
        component: "backlighting-controller"
      }, result.traces, now);
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

    // Context survives a redeploy but timers do not: pick up any pending deadline.
    const savedState = context.get("state") as BacklightingState | undefined;
    if (savedState) schedule(savedState);

    node.on("input", (msg, send, done) => {
      try {
        process({
          backlighting: msg.backlighting && typeof msg.backlighting === "object"
            ? msg.backlighting as BacklightingMessage["backlighting"]
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

  RED.nodes.registerType("home-backlighting-controller", HomeBacklightingController);
};

export = registerBacklightingController;
