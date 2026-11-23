"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {checkCommandEcho, checkStateReport, fingerprint, rememberCommand, ECHO_QUEUE_LIMIT, ECHO_WINDOW_MS} from "../lib/command-echo";

test("fingerprints ignore key order", () => {
  assert.equal(fingerprint({state: "ON", brightness: 10}), fingerprint({brightness: 10, state: "ON"}));
  assert.notEqual(fingerprint({state: "ON"}), fingerprint({state: "OFF"}));
});

test("remembered commands expire and the queue stays bounded", () => {
  let queue = rememberCommand(undefined, {state: "ON"}, 0);
  assert.deepEqual(queue, [{fingerprint: fingerprint({state: "ON"}), expires: ECHO_WINDOW_MS, on: true}]);
  queue = rememberCommand(queue, {brightness: 10}, ECHO_WINDOW_MS + 1);
  assert.equal(queue.length, 1, "the first command expired");
  assert.equal(queue[0]!.on, undefined, "a non-power command sets no power");
  for (let index = 0; index < 20; index += 1) queue = rememberCommand(queue, {brightness: index}, ECHO_WINDOW_MS + 2);
  assert.equal(queue.length, ECHO_QUEUE_LIMIT);
});

test("our own echo is recognised once; someone else's is not", () => {
  const sent = rememberCommand(rememberCommand(undefined, {brightness: 10}, 0), {state: "ON"}, 0);
  const valueEcho = checkCommandEcho(sent, {brightness: 10}, 100);
  assert.equal(valueEcho.own, true);
  assert.equal(valueEcho.queue.length, 1, "a value command is done once echoed");
  const powerEcho = checkCommandEcho(valueEcho.queue, {state: "ON"}, 100);
  assert.equal(powerEcho.own, true);
  assert.equal(powerEcho.queue[0]!.echoed, true, "a power command stays in flight until a state report");
  assert.equal(checkCommandEcho(powerEcho.queue, {state: "ON"}, 200).own, false, "a second identical command is someone else's");
  assert.equal(checkCommandEcho(sent, {state: "OFF"}, 100).own, false);
});

test("state reports while a power command is in flight", () => {
  const sent = checkCommandEcho(rememberCommand(undefined, {state: "ON"}, 0), {state: "ON"}, 50).queue;
  const stale = checkStateReport(sent, false, 100);
  assert.equal(stale.inFlight, true);
  assert.equal(stale.queue.length, 1);
  // A matching report confirms the command and clears it; it is still
  // reported as in flight, as the room controller has always treated it.
  const confirming = checkStateReport(sent, true, 100);
  assert.equal(confirming.inFlight, true);
  assert.deepEqual(confirming.queue, []);
  assert.deepEqual(checkStateReport(confirming.queue, false, 200), {queue: [], inFlight: false});
  // The input queue is not changed.
  assert.equal(sent[0]!.on, true);
});
