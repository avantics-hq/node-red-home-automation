"use strict";

// Plain helpers shared by the Node-RED adapters, so each adapter keeps only
// what is particular to its node: config, message mapping and outputs.

import type {Node, NodeMessage} from "node-red";
import {appendTrace, type TraceInput, type TraceMetadata} from "../lib/bounded-trace";

export type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
export type InputMessage = NodeMessage & Record<string, unknown>;

// The object a message carries under a key, or undefined.
export function objectField<T>(msg: InputMessage, key: string): T | undefined {
  const value = msg[key];
  return value && typeof value === "object" ? value as T : undefined;
}

// Handle each input; an error is reported against the message and ends it.
export function onInput(node: Node, handle: (msg: InputMessage, send: Send) => void): void {
  node.on("input", (msg, send, done) => {
    try {
      handle(msg as InputMessage, send);
      done();
    } catch (error) {
      node.error(error, msg);
      done(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// Work run from a timer, with any error reported on the node.
export function guarded(node: Node, work: () => void): () => void {
  return () => {
    try {
      work();
    } catch (error) {
      node.error(error);
    }
  };
}

// Run a reducer on the node's saved state, save the new state and append its
// traces.
export function runReducer<Saved, Result extends {state: unknown; traces: TraceInput[]}>(
  node: Node,
  trace: TraceMetadata,
  reduce: (saved: Saved | undefined, now: Date) => Result
): Result {
  const context = node.context();
  const now = new Date();
  const result = reduce(context.get("state") as Saved | undefined, now);
  context.set("state", result.state);
  appendTrace(context, trace, result.traces, now);
  return result;
}

// A node's area. Most nodes only use it as a label, so it is optional and an
// empty one means no area; there is never a default.
export function optionalArea(config: {area?: unknown}): string {
  return typeof config.area === "string" ? config.area.trim() : "";
}

// A publishing setting. A saved flow from before the setting existed has no
// value, and keeps publishing as it did; a node added since has an explicit
// true or false.
export function onUnlessOff(value: unknown): boolean {
  return value !== false && value !== "false";
}

// The one badge for a configuration the node cannot use, with the reason in
// the log.
export function invalidConfig(node: Node, reason: unknown): void {
  node.status({fill: "red", shape: "ring", text: "invalid configuration"});
  node.error("invalid configuration: " + (reason instanceof Error ? reason.message : String(reason)));
}
