"use strict";

import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import type {Node} from "node-red";
import {guarded, invalidConfig, mqttConnected, objectField, onInput, runReducer, type InputMessage} from "../nodes/adapter";

// The parts of a Node-RED node the helpers use.
function fakeNode() {
  const emitter = new EventEmitter();
  const values = new Map<string, unknown>();
  const node = {
    errors: [] as unknown[][],
    statuses: [] as unknown[],
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    error: (...args: unknown[]) => node.errors.push(args),
    status: (status: unknown) => node.statuses.push(status),
    context: () => ({get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value)})
  };
  return {node, asNode: node as unknown as Node, values};
}

test("objectField returns only objects", () => {
  const msg = {payload: 1, avr: {kind: "tick"}, text: "x", empty: null} as unknown as InputMessage;
  assert.deepEqual(objectField(msg, "avr"), {kind: "tick"});
  assert.equal(objectField(msg, "text"), undefined);
  assert.equal(objectField(msg, "empty"), undefined);
  assert.equal(objectField(msg, "missing"), undefined);
});

test("onInput ends each message, reporting an error against it once", () => {
  const {node, asNode} = fakeNode();
  const handled: unknown[] = [];
  onInput(asNode, (msg) => {
    if (msg.payload === "bad") throw new Error("boom");
    handled.push(msg.payload);
  });
  const done: unknown[] = [];
  // As Node-RED's done does: done(error) reports the error against the
  // message, which is what a Catch node hears.
  const input = (msg: InputMessage) => node.emit("input", msg, () => {}, (error?: Error) => {
    done.push(error);
    if (error) node.error(error, msg);
  });
  input({payload: "good"} as InputMessage);
  input({payload: "bad"} as InputMessage);
  assert.deepEqual(handled, ["good"]);
  assert.equal(done[0], undefined);
  assert.match(String(done[1]), /boom/);
  assert.equal(node.errors.length, 1, "one report, so a Catch node fires once");
  assert.deepEqual(node.errors[0]![1], {payload: "bad"});
});

// A Status node's message, as Node-RED 5.0.10 builds it (runtime/lib/flows/Flow.js handleStatus).
const statusOf = (type: string, fill: string, text: string) =>
  ({status: {fill, shape: fill === "green" ? "dot" : "ring", text, source: {id: "out-1", type, name: ""}}}) as unknown as InputMessage;
const connected = statusOf("mqtt out", "green", "node-red:common.status.connected");

test("only a Status node's report of an MQTT out node connecting counts as connected", () => {
  assert.equal(mqttConnected(connected), true);
  assert.equal(mqttConnected(statusOf("mqtt out", "yellow", "node-red:common.status.connecting")), false);
  assert.equal(mqttConnected(statusOf("mqtt out", "red", "node-red:common.status.disconnected")), false);
  assert.equal(mqttConnected(statusOf("mqtt in", "green", "node-red:common.status.connected")), false);
  assert.equal(mqttConnected(statusOf("home-room-lighting-controller", "green", "node-red:common.status.connected")), false);
  assert.equal(mqttConnected({status: {text: "node-red:common.status.connected"}} as unknown as InputMessage), false, "no source");
  assert.equal(mqttConnected({payload: "node-red:common.status.connected"} as InputMessage), false);
});

test("with a startup message, MQTT out connecting is handled as that startup message; other status messages are ignored", () => {
  const {node, asNode, values} = fakeNode();
  const handled: unknown[] = [];
  const startup = {lighting: {kind: "startup"}};
  onInput(asNode, (msg) => { handled.push(msg); }, {message: startup, trace: {area: "hall", component: "room-controller"}});
  const done: unknown[] = [];
  const input = (msg: InputMessage) => node.emit("input", msg, () => {}, (error?: Error) => done.push(error));
  input(statusOf("mqtt out", "yellow", "node-red:common.status.connecting"));
  input(statusOf("mqtt in", "green", "node-red:common.status.connected"));
  input(connected);
  input(connected);
  input({payload: 1} as InputMessage);
  // A status object that isn't a Status node's (no source) is the user's own message.
  const own = {status: {text: "node-red:common.status.connected"}, payload: 2} as unknown as InputMessage;
  input(own);
  assert.deepEqual(handled, [startup, startup, {payload: 1}, own], "every connect announces again; other messages as before");
  assert.notEqual(handled[0], handled[1], "a fresh copy each time");
  assert.deepEqual(done, [undefined, undefined, undefined, undefined, undefined, undefined], "each message ended");
  const traced = (values.get("trace") as Array<{event: string; outcome: string; reason: string; details: unknown; component: string}>)
    .map(({event, outcome, reason, details, component}) => [component, event, outcome, reason, details]);
  assert.deepEqual(traced, [
    ["room-controller", "input", "ignored", "status-message", {text: "node-red:common.status.connecting", source: "mqtt out"}],
    ["room-controller", "input", "ignored", "status-message", {text: "node-red:common.status.connected", source: "mqtt in"}]
  ], "the Status node messages it ignored, in its trace");

  // Without a startup message, a status message is handled like any other.
  const plain = fakeNode();
  const seen: unknown[] = [];
  onInput(plain.asNode, (msg) => { seen.push(msg); });
  plain.node.emit("input", connected, () => {}, () => {});
  assert.deepEqual(seen, [connected]);
});

test("guarded reports a timer's error on the node instead of throwing", () => {
  const {node, asNode} = fakeNode();
  guarded(asNode, () => {
    throw new Error("late");
  })();
  assert.match(String(node.errors[0]![0]), /late/);
});

test("runReducer saves the new state and appends its traces", () => {
  const {asNode, values} = fakeNode();
  values.set("state", {count: 1});
  const result = runReducer(asNode, {area: "room", component: "test"}, (saved: {count: number} | undefined, now) => ({
    state: {count: (saved?.count ?? 0) + 1},
    traces: [{event: "step", outcome: "done", details: {at: now.toISOString()}}]
  }));
  assert.deepEqual(result.state, {count: 2});
  assert.deepEqual(values.get("state"), {count: 2});
  const trace = values.get("trace") as Array<{event: string; area: string; component: string}>;
  assert.equal(trace.length, 1);
  assert.equal(trace[0]!.event, "step");
  assert.equal(trace[0]!.component, "test");
});

test("invalidConfig shows the one badge and logs the reason", () => {
  const {node, asNode} = fakeNode();
  invalidConfig(asNode, new Error("sources must be JSON"));
  assert.deepEqual(node.statuses, [{fill: "red", shape: "ring", text: "invalid configuration"}]);
  assert.deepEqual(node.errors, [["invalid configuration: sources must be JSON"]]);
});
