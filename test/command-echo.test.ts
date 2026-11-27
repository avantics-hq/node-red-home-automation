"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {checkCommandEcho, checkStateReport, fingerprint, rememberCommand, ECHO_QUEUE_LIMIT, ECHO_WINDOW_MS, commandSent, commandSkipped} from "../lib/command-echo";

test("fingerprints ignore key order", () => {
  assert.equal(fingerprint({state: "ON", brightness: 10}), fingerprint({brightness: 10, state: "ON"}));
  assert.notEqual(fingerprint({state: "ON"}), fingerprint({state: "OFF"}));
});

test("remembered commands expire and the queue stays bounded", () => {
  let queue = rememberCommand(undefined, {state: "ON"}, 0);
  assert.deepEqual(queue, [{fingerprint: fingerprint({state: "ON"}), expires: ECHO_WINDOW_MS, on: true, power: true}]);
  queue = rememberCommand(queue, {brightness: 10}, ECHO_WINDOW_MS + 1);
  assert.equal(queue.length, 1, "the first command expired");
  assert.equal(queue[0]!.on, undefined, "a non-power command sets no power");
  for (let index = 0; index < 20; index += 1) queue = rememberCommand(queue, {brightness: index}, ECHO_WINDOW_MS + 2);
  assert.equal(queue.length, ECHO_QUEUE_LIMIT);
});

test("our own echo is ours, as is a repeat of it in the echo window; someone else's is not", () => {
  const sent = rememberCommand(rememberCommand(undefined, {brightness: 10}, 0), {state: "ON"}, 0);
  const valueEcho = checkCommandEcho(sent, {brightness: 10}, 100);
  assert.equal(valueEcho.own, true);
  assert.equal(valueEcho.queue.length, 2, "an echoed command is kept until it expires");
  const powerEcho = checkCommandEcho(valueEcho.queue, {state: "ON"}, 100);
  assert.equal(powerEcho.own, true);
  assert.equal(powerEcho.queue[1]!.echoed, true, "a power command stays in flight until a state report");
  // Delivered twice (two subscriptions, a QoS redelivery): still ours.
  assert.deepEqual([checkCommandEcho(powerEcho.queue, {state: "ON"}, 200).own, checkCommandEcho(powerEcho.queue, {brightness: 10}, 200).own], [true, true]);
  assert.equal(checkCommandEcho(powerEcho.queue, {state: "ON"}, ECHO_WINDOW_MS + 1).own, false, "after the window it is someone else's");
  assert.equal(checkCommandEcho(sent, {state: "OFF"}, 100).own, false);
  assert.equal(checkCommandEcho(sent, {brightness: 20}, 100).own, false);
});

test("a state report confirms our command, is stale against it, or is someone else's change", () => {
  const sent = checkCommandEcho(rememberCommand(undefined, {state: "ON"}, 0), {state: "ON"}, 50).queue;
  const stale = checkStateReport(sent, false, 100);
  assert.equal(stale.verdict, "stale");
  assert.equal(stale.queue.length, 1, "the command is still pending");
  const confirms = checkStateReport(sent, true, 100);
  assert.equal(confirms.verdict, "confirms");
  assert.equal(confirms.queue[0]!.on, undefined, "a confirmed command is no longer pending");
  assert.equal(checkStateReport(confirms.queue, false, 200).verdict, "external");
  // Only power commands count: a pending value command is not a power command.
  assert.equal(checkStateReport(rememberCommand(undefined, {brightness: 10}, 0), true, 100).verdict, "external");
  // The input queue is not changed.
  assert.equal(sent[0]!.on, true);
});

test("our own command, changed on the way, still counts as ours: once", () => {
  const sent = rememberCommand(undefined, {state: "ON", brightness: 200, color_temp: 300, transition: 1}, 0);
  // Something on the command path cut it to the power state alone.
  const changed = checkCommandEcho(sent, {state: "ON"}, 100);
  assert.deepEqual([changed.own, changed.changed], [true, true]);
  // A second one is not ours: our command has had its echo.
  assert.deepEqual([checkCommandEcho(changed.queue, {state: "ON"}, 200).own], [false]);
  // A different power is not ours.
  assert.equal(checkCommandEcho(sent, {state: "OFF"}, 100).own, false);
  // The exact echo is ours and not changed.
  assert.deepEqual([checkCommandEcho(sent, {state: "ON", brightness: 200, color_temp: 300, transition: 1}, 100).changed], [false]);
  // Known even when the light confirmed the power before the echo came back.
  const confirmed = checkStateReport(sent, true, 50).queue;
  assert.equal(checkCommandEcho(confirmed, {state: "ON"}, 100).own, true);
  // No command of ours pending: someone else's bare ON.
  assert.equal(checkCommandEcho(undefined, {state: "ON"}, 100).own, false);
  assert.equal(checkCommandEcho(sent, {state: "ON"}, ECHO_WINDOW_MS + 1).own, false, "after the echo window");
});

test("a tentative restyle doesn't count towards the limit or push out an older command, until its adapter says it sent it", () => {
  let queue = Array.from({length: 8}).reduce<ReturnType<typeof rememberCommand>>((q, _, index) => rememberCommand(q, {state: "ON", n: index}, 1000, {id: String(index)}), []);
  queue = rememberCommand(queue, {state: "ON"}, 1000, {id: "r", tentative: true});
  assert.deepEqual(queue.map(({id}) => id), ["0", "1", "2", "3", "4", "5", "6", "7", "r"], "nothing pushed out yet");
  assert.deepEqual(commandSkipped(queue, "r", 1000).map(({id}) => id), ["0", "1", "2", "3", "4", "5", "6", "7"], "skipped: as if never sent");
  assert.deepEqual(commandSent(queue, "r", 1000).map(({id}) => id), ["1", "2", "3", "4", "5", "6", "7", "r"], "sent: an ordinary entry, the oldest goes");
});
