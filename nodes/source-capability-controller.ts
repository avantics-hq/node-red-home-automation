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
  normaliseCapabilities,
  transitionSource,
  type SourceConfig,
  type SourceMessage,
  type SourceState
} from "../lib/source-capability-controller";

interface SourceControllerConfig extends NodeDef {
  area?: string;
  sources?: string;
  pollMs?: number | string;
  confirmationTimeoutMs?: number | string;
  maxAttempts?: number | string;
}

interface SourceControllerNode extends Node {}

type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
type SourceStatus = ReturnType<typeof transitionSource>["status"];

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const registerSourceCapabilityController: NodeInitializer = (RED) => {
  function HomeSourceCapabilityController(this: SourceControllerNode, config: SourceControllerConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let timer: ReturnType<typeof setTimeout> | undefined;

    let sources: SourceConfig["sources"];
    try {
      sources = normaliseCapabilities(JSON.parse(config.sources || "{}") as unknown);
    } catch (error) {
      node.status({fill: "red", shape: "ring", text: "invalid configuration"});
      node.error("invalid configuration: " + (error instanceof Error ? error.message : String(error)));
      return;
    }
    const controllerConfig: SourceConfig = {
      sources,
      pollMs: number(config.pollMs, 2000),
      confirmationTimeoutMs: number(config.confirmationTimeoutMs, 15000),
      maxAttempts: number(config.maxAttempts, 2)
    };

    function updateStatus(status: SourceStatus) {
      const appearances: Record<string, {fill: NodeStatusFill; shape: NodeStatusShape}> = {
        idle: {fill: "grey", shape: "dot"},
        transitioning: {fill: "blue", shape: "dot"},
        confirming: {fill: "blue", shape: "ring"},
        waiting_for_source: {fill: "yellow", shape: "ring"},
        ready: {fill: "green", shape: "dot"},
        unavailable: {fill: "yellow", shape: "dot"},
        failed: {fill: "red", shape: "ring"}
      };
      const appearance = appearances[status.phase] ?? {fill: "grey", shape: "ring"};
      node.status({...appearance, text: status.text});
    }

    function schedule(state: SourceState) {
      clearTimeout(timer);
      timer = undefined;
      if (!state.pending?.nextAt) return;
      const delay = Math.max(0, state.pending.nextAt - Date.now());
      timer = setTimeout(() => {
        try {
          process({sourceCapability: {kind: "tick", generation: state.generation}}, node.send.bind(node));
        } catch (error) {
          node.error(error);
        }
      }, delay);
    }

    function process(msg: SourceMessage, send: Send) {
      const now = new Date();
      const saved = context.get("state") as Partial<SourceState> | undefined;
      const result = transitionSource(saved, msg, controllerConfig, now);
      context.set("state", result.state);
      appendTrace(context, {
        area: config.area || "lounge",
        component: "source-capability-controller"
      }, result.traces, now);
      if (result.commands.length) {
        send([
          result.commands.map((sourceCommand) => ({payload: undefined, sourceCommand})),
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
    if ((context.get("state") as Partial<SourceState> | undefined)?.pending) {
      timer = setTimeout(() => {
        try {
          process({sourceCapability: {kind: "startup"}}, node.send.bind(node));
        } catch (error) {
          node.error(error);
        }
      }, 0);
    }

    node.on("input", (msg, send, done) => {
      try {
        process({
          sourceCapability: msg.sourceCapability && typeof msg.sourceCapability === "object"
            ? msg.sourceCapability as SourceMessage["sourceCapability"]
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

  RED.nodes.registerType("home-source-capability-controller", HomeSourceCapabilityController);
};

export = registerSourceCapabilityController;
