"use strict";

// Plain helpers shared by the Node-RED adapters, so each adapter keeps only
// what is particular to its node: config, message mapping and outputs.

import type {Node, NodeAPI, NodeMessage} from "node-red";
import {appendTrace, type TraceInput, type TraceMetadata} from "../lib/bounded-trace";
import {staleRetainedTopics, type RetainedClear} from "../lib/retained-topics";

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

// The one badge for a configuration the node cannot use, with the reason in
// the log.
export function invalidConfig(node: Node, reason: unknown): void {
  node.status({fill: "red", shape: "ring", text: "invalid configuration"});
  node.error("invalid configuration: " + (reason instanceof Error ? reason.message : String(reason)));
}

// Runs once every flow has started, when the node's outputs reach the nodes
// wired to them: Node-RED creates a flow's nodes one at a time, so a send
// from a constructor may find the next node not there yet. Stops waiting if
// the node closes first.
export function whenFlowsStarted(RED: NodeAPI, node: Node, action: () => void): void {
  const run = guarded(node, action);
  RED.events.once("flows:started", run);
  node.on("close", () => {
    RED.events.removeListener("flows:started", run);
  });
}

// Every retained topic a node publishes now or recorded at its last start,
// for clearing them all when it is deleted.
export function allRetainedTopics(node: Node, current: string[]): string[] {
  const recorded = node.context().get("retainedTopics") as string[] | undefined;
  return [...current, ...(recorded ?? [])];
}

// At a node's start: the empty retained messages that clear what it
// published before and no longer does, recording what it publishes now. The
// record is kept in the node's context, so it survives redeploys, which is
// when what a node publishes changes; it survives a restart only if the
// default context store persists.
//
// It runs twice: once the flows have started, so no startup message is
// needed, and again at the startup message. The first may go out before the
// MQTT broker has reconnected (after a full deploy or a restart), when the
// broker node drops it, so it keeps the cleared topics in the record and the
// second clears them again and settles the record. Clearing a topic twice
// does no harm.
export function clearStaleRetained(node: Node, current: string[], when: "flows-started" | "startup" = "startup"): RetainedClear[] {
  const context = node.context();
  const recorded = context.get("retainedTopics") as string[] | undefined;
  const {clears, record} = staleRetainedTopics(recorded, current, when === "flows-started");
  context.set("retainedTopics", record);
  return clears;
}

// Whether a closing node was deleted, rather than disabled or redeployed.
// Node-RED 5 reports `removed` for a deleted node and for a disabled node or
// flow alike. During a deploy, RED.nodes.eachNode already lists the new
// flows, which still hold a disabled node but not a deleted one. A node in a
// subflow instance is looked up by the subflow's own copy of it (_alias), so
// it never counts as deleted.
export function wasDeleted(RED: NodeAPI, node: Node, removed: boolean): boolean {
  if (!removed) return false;
  const id = (node as Node & {_alias?: string})._alias ?? node.id;
  let listed = false;
  RED.nodes.eachNode((entry) => {
    if (entry.id === id) listed = true;
  });
  return !listed;
}

// Runs every time the flows start, not only the first: a deploy of other
// nodes (a room added, say) starts the flows again without restarting this
// one. Stops when the node closes. The action must be safe to repeat.
export function onEveryFlowsStarted(RED: NodeAPI, node: Node, action: () => void): void {
  const run = guarded(node, action);
  RED.events.on("flows:started", run);
  node.on("close", () => {
    RED.events.removeListener("flows:started", run);
  });
}
