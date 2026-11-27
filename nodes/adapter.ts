"use strict";

// Plain helpers shared by the Node-RED adapters, so each adapter keeps only
// what is particular to its node: config, message mapping and outputs.

import type {Node, NodeAPI, NodeMessage} from "node-red";
import {appendTrace, type TraceInput, type TraceMetadata} from "../lib/bounded-trace";
import {staleRetainedTopics, type RetainedClear} from "../lib/retained-topics";
import {onFlowsStarted} from "./flows-started";

export type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
export type InputMessage = NodeMessage & Record<string, unknown>;

// The object a message carries under a key, or undefined.
export function objectField<T>(msg: InputMessage, key: string): T | undefined {
  const value = msg[key];
  return value && typeof value === "object" ? value as T : undefined;
}

// The status an MQTT out node shows each time its broker connects, as
// Node-RED's Status node passes it on (Node-RED 5.0.10:
// nodes/core/network/10-mqtt.js, setStatusConnected; runtime/lib/flows/Flow.js,
// handleStatus, which adds status.source).
const MQTT_CONNECTED = "node-red:common.status.connected";

// Whether a message is a Status node's report that an MQTT out node has
// connected: until then, the broker drops what it is given to publish.
export function mqttConnected(msg: InputMessage): boolean {
  const status = objectField<{text?: unknown; source?: {type?: unknown}}>(msg, "status");
  return status?.text === MQTT_CONNECTED && status.source?.type === "mqtt out";
}

// Handle each input; an error is reported against the message and ends it.
// With a startup message, a node that announces itself takes a Status
// node's "MQTT out connected" as that startup message, so it announces again
// once the broker can take it; any other status message is ignored.
export function onInput(node: Node, handle: (msg: InputMessage, send: Send) => void, startup?: Record<string, unknown>): void {
  node.on("input", (msg, send, done) => {
    try {
      const input = msg as InputMessage;
      if (startup && objectField(input, "status")) {
        if (mqttConnected(input)) handle(structuredClone(startup) as InputMessage, send);
      } else {
        handle(input, send);
      }
      done();
    } catch (error) {
      // done(error) reports it against the message, once, so a Catch node
      // fires once (Node-RED 5.0.10 runtime/lib/nodes/Node.js:132-143).
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
  const stop = onFlowsStarted(RED.events, () => {
    stop();
    run();
  }, (error) => node.error(error));
  node.on("close", stop);
}

// Every retained topic a node publishes now or recorded at its last start,
// for clearing them all when it is deleted.
export function allRetainedTopics(node: Node, current: string[]): string[] {
  const recorded = node.context().get("retainedTopics") as string[] | undefined;
  return [...current, ...(recorded ?? [])];
}

// At a node's start: the empty retained messages that clear what it
// published before and no longer does, recording what it publishes now. The
// record is kept in the node's context, which Node-RED deletes when the node
// stops unless a context store is configured (see the README). `possible` is
// every topic the node could publish with its current names (area, IDs,
// prefix, targets) and its publishing switched on: those it doesn't publish
// now are cleared too, so switching publishing off clears its topics even
// with no record. Only a change of names needs the record.
//
// It runs twice: once the flows have started, so no startup message is
// needed, and again at the startup message. The first may go out before the
// MQTT broker has reconnected (after a full deploy or a restart), when the
// broker node drops it, so it keeps the cleared topics in the record and the
// second clears them again and settles the record. Clearing a topic twice
// does no harm.
export function clearStaleRetained(
  node: Node,
  current: string[],
  when: "flows-started" | "startup" = "startup",
  possible: string[] = []
): RetainedClear[] {
  const context = node.context();
  const recorded = context.get("retainedTopics") as string[] | undefined;
  const {clears, record} = staleRetainedTopics([...(recorded ?? []), ...possible], current, when === "flows-started");
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
