"use strict";

import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import type {NodeAPI} from "node-red";
import {onFlowsStarted} from "../nodes/flows-started";

test("a callback that throws neither stops the others nor escapes the emit", () => {
  const events = new EventEmitter() as unknown as NodeAPI["events"];
  const ran: string[] = [];
  const reported: unknown[] = [];
  onFlowsStarted(events, () => {
    ran.push("first");
    throw new Error("boom");
  }, (error) => reported.push(error));
  onFlowsStarted(events, () => ran.push("second"), (error) => reported.push(error));
  // A reporter that throws as well is contained too.
  onFlowsStarted(events, () => {
    throw new Error("again");
  }, () => {
    throw new Error("report failed");
  });
  onFlowsStarted(events, () => ran.push("last"), (error) => reported.push(error));

  assert.doesNotThrow(() => (events as unknown as EventEmitter).emit("flows:started"));
  assert.deepEqual(ran, ["first", "second", "last"]);
  assert.deepEqual(reported.map(String), ["Error: boom"]);
  assert.equal((events as unknown as EventEmitter).listenerCount("flows:started"), 1);
});

test("a removed callback no longer runs, and the others still do", () => {
  const events = new EventEmitter() as unknown as NodeAPI["events"];
  const ran: string[] = [];
  const stop = onFlowsStarted(events, () => ran.push("removed"), () => {});
  onFlowsStarted(events, () => ran.push("kept"), () => {});
  stop();
  (events as unknown as EventEmitter).emit("flows:started");
  assert.deepEqual(ran, ["kept"]);
});
