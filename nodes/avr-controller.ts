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
  transitionAvr,
  type AvrConfig,
  type AvrMessage,
  type AvrState
} from "../lib/avr-controller";

interface AvrControllerConfig extends NodeDef {
  area?: string;
  sources?: string;
  retryMs?: number | string;
  maxAttempts?: number | string;
}

interface AvrControllerNode extends Node {}

type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
type AvrStatus = ReturnType<typeof transitionAvr>["status"];

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseSources(value: string | undefined): Record<string, string> {
  const sources: unknown = JSON.parse(value || "{}");
  if (!sources || Array.isArray(sources) || typeof sources !== "object") {
    throw new Error("sources must be a JSON object");
  }
  for (const [name, code] of Object.entries(sources)) {
    if (typeof name !== "string" || typeof code !== "string") {
      throw new Error("sources must map names to Denon source codes");
    }
  }
  return sources as Record<string, string>;
}

const registerAvrController: NodeInitializer = (RED) => {
  function HomeAvrController(this: AvrControllerNode, config: AvrControllerConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    let controllerConfig: AvrConfig;
    try {
      controllerConfig = {
        area: config.area || "room",
        sources: parseSources(config.sources),
        retryMs: Math.max(250, number(config.retryMs, 2000)),
        maxAttempts: Math.max(1, Math.floor(number(config.maxAttempts, 3)))
      };
    } catch (error) {
      node.status({fill: "red", shape: "ring", text: "invalid configuration"});
      node.error(error);
      return;
    }

    function updateStatus(status: AvrStatus) {
      const appearances: Record<string, {fill: NodeStatusFill; shape: NodeStatusShape}> = {
        discovering: {fill: "grey", shape: "ring"},
        idle: {fill: "grey", shape: "dot"},
        transitioning: {fill: "blue", shape: "dot"},
        ready: {fill: "green", shape: "dot"},
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
      retryTimer = setTimeout(() => {
        try {
          process({avr: {kind: "tick"}}, node.send.bind(node));
        } catch (error) {
          node.error(error);
        }
      }, delay);
    }

    function process(msg: AvrMessage, send: Send) {
      const now = new Date();
      const saved = context.get("state") as Partial<AvrState> | undefined;
      const result = transitionAvr(saved, msg, controllerConfig, now);
      context.set("state", result.state);
      appendTrace(context, {
        area: controllerConfig.area,
        component: "avr-controller"
      }, result.traces, now);
      const commands = result.commands.map((command) => ({
        payload: Buffer.from(command.payload, "utf8"),
        avr_command: command.avrCommand
      }));
      if (commands.length || result.events.length) {
        send([
          commands.length ? commands : null,
          result.events.length
            ? result.events.map((event) => ({payload: undefined, ...event}))
            : null
        ]);
      }
      updateStatus(result.status);
      scheduleRetry(result.state);
      return result;
    }

    node.on("input", (msg, send, done) => {
      try {
        process({
          avr: msg.avr && typeof msg.avr === "object"
            ? msg.avr as AvrMessage["avr"]
            : undefined,
          payload: msg.payload
        }, send);
        done();
      } catch (error) {
        node.error(error, msg);
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(retryTimer);
      done();
    });
  }

  RED.nodes.registerType("home-avr-controller", HomeAvrController);
};

export = registerAvrController;
