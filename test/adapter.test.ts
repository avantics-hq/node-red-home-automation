"use strict";

import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import type {Node} from "node-red";
import {guarded, invalidConfig, number, objectField, onInput, runReducer, type InputMessage} from "../nodes/adapter";

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

test("number keeps finite values and falls back otherwise", () => {
  assert.equal(number("12", 5), 12);
  assert.equal(number(0, 5), 0);
  // A cleared editor field means "use the default", not 0.
  assert.equal(number("", 5), 5);
  assert.equal(number("  ", 5), 5);
  assert.equal(number(null, 5), 5);
  assert.equal(number("twelve", 5), 5);
  assert.equal(number(undefined, 5), 5);
});

test("objectField returns only objects", () => {
  const msg = {payload: 1, avr: {kind: "tick"}, text: "x", empty: null} as unknown as InputMessage;
  assert.deepEqual(objectField(msg, "avr"), {kind: "tick"});
  assert.equal(objectField(msg, "text"), undefined);
  assert.equal(objectField(msg, "empty"), undefined);
  assert.equal(objectField(msg, "missing"), undefined);
});

test("onInput ends each message, reporting an error against it", () => {
  const {node, asNode} = fakeNode();
  const handled: unknown[] = [];
  onInput(asNode, (msg) => {
    if (msg.payload === "bad") throw new Error("boom");
    handled.push(msg.payload);
  });
  const done: unknown[] = [];
  node.emit("input", {payload: "good"}, () => {}, (error?: Error) => done.push(error));
  node.emit("input", {payload: "bad"}, () => {}, (error?: Error) => done.push(error));
  assert.deepEqual(handled, ["good"]);
  assert.equal(done[0], undefined);
  assert.match(String(done[1]), /boom/);
  assert.equal(node.errors.length, 1);
  assert.deepEqual(node.errors[0]![1], {payload: "bad"});
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
