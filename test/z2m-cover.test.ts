"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {openCloseCover, positionCover, type CoverModel} from "../lib/cover-models";
import {normaliseZ2mCoverConfig, transitionZ2mCover, type Z2mCoverMessage, type Z2mCoverState} from "../lib/z2m-cover";

// Not the default base topic, so no test names a Zigbee2MQTT device topic.
const config = normaliseZ2mCoverConfig({baseTopic: "z2m", friendlyName: "test-cover"});
const at = (seconds: number): Date => new Date(Date.parse("2026-11-26T10:00:00Z") + seconds * 1000);

function apply(state: Partial<Z2mCoverState> | undefined, msg: Z2mCoverMessage, seconds = 0) {
  return transitionZ2mCover(state, msg, config, at(seconds));
}
const report = (payload: unknown) => ({topic: "z2m/test-cover", payload});
const command = (operation: string, position?: number) =>
  ({cover_command: {operation, requestId: "r", generation: 1, attempt: 1, ...(position === undefined ? {} : {position})}});

test("the settings name Zigbee2MQTT's base topic (zigbee2mqtt by default) and the device, with no default device", () => {
  assert.deepEqual(normaliseZ2mCoverConfig({friendlyName: " living/blind "}), {baseTopic: "zigbee2mqtt", friendlyName: "living/blind"});
  assert.deepEqual(normaliseZ2mCoverConfig({baseTopic: "/z2m/", friendlyName: "a"}), {baseTopic: "z2m", friendlyName: "a"});
  assert.throws(() => normaliseZ2mCoverConfig({}), /friendly name is required/);
  assert.throws(() => normaliseZ2mCoverConfig({friendlyName: "a/#"}), /\+ or #/);
});

test("the controller's commands become Zigbee2MQTT set and get messages", () => {
  const sent = (msg: Z2mCoverMessage, state?: Partial<Z2mCoverState>) =>
    apply(state, msg).publications.map(({topic, payload}) => [topic, JSON.parse(payload)]);
  assert.deepEqual(sent(command("set_position", 42.6)), [["z2m/test-cover/set", {position: 43}]]);
  assert.deepEqual(sent(command("stop")), [["z2m/test-cover/set", {state: "STOP"}]]);
  assert.deepEqual(sent(command("open")), [["z2m/test-cover/set", {state: "OPEN"}]]);
  assert.deepEqual(sent(command("close")), [["z2m/test-cover/set", {state: "CLOSE"}]]);
  // observe asks the device for a fresh read: its position, or a cover with none, its state.
  assert.deepEqual(sent(command("observe")), [["z2m/test-cover/get", {position: ""}]]);
  assert.deepEqual(sent(command("observe"), {reportsPosition: false}), [["z2m/test-cover/get", {state: ""}]]);
  assert.deepEqual(sent(command("dance")), []);
});

test("a state report becomes a reading: position, motion from whichever field the device has, and the time received", () => {
  const read = (payload: unknown) => apply(undefined, report(payload), 1).readings.map(({cover}) => cover);
  const observedAt = at(1).toISOString();
  for (const [fields, motion] of [
    [{motor_state: "opening"}, "opening"], [{motor_state: "closing"}, "closing"], [{motor_state: "stopped"}, "stopped"],
    [{moving: "UP"}, "opening"], [{moving: "DOWN"}, "closing"], [{moving: "STOP"}, "stopped"],
    [{running: false}, "stopped"], [{motor_state: "pause"}, "stopped"]
  ] as const) {
    assert.deepEqual(read({position: 37, state: "OPEN", ...fields}), [{kind: "observed", position: 37, motion, observedAt}], JSON.stringify(fields));
  }
  // No motion field (or running true, with no direction): no motion is made up.
  assert.deepEqual(read({position: 37, state: "OPEN"}), [{kind: "observed", position: 37, observedAt}]);
  assert.deepEqual(read({position: 37, running: true}), [{kind: "observed", position: 37, observedAt}]);
  // Ends: an end state only at 0 and 100; OPEN alone at 37 is not "open".
  assert.deepEqual(read({position: 100, state: "OPEN"})[0], {kind: "observed", position: 100, state: "open", observedAt});
  assert.deepEqual(read({position: 0, state: "CLOSE"})[0], {kind: "observed", position: 0, state: "closed", observedAt});
  // Battery and charging are passed on; a report with nothing about the cover is ignored.
  assert.deepEqual(read(JSON.stringify({position: 5, battery: 87, charging_status: "false"}))[0],
    {kind: "observed", position: 5, observedAt, battery: 87, charging: "false"});
  assert.deepEqual(read({linkquality: 120}), []);
  // A binary charging status, as Zigbee2MQTT publishes true or false, is passed on as text too.
  assert.equal(read({position: 5, charging_status: true})[0]?.kind === "observed" && (read({position: 5, charging_status: true})[0] as {charging?: string}).charging, "true");
  // Paused without a position: stopped, so its end state counts.
  assert.deepEqual(read({state: "CLOSE", motor_state: "pause"}), [{kind: "observed", state: "closed", motion: "stopped", observedAt}]);
});

test("a cover with no position reports its end state once stopped, and is then read by state", () => {
  let result = apply(undefined, report({state: "OPEN", moving: "STOP"}), 2);
  assert.deepEqual(result.readings.map(({cover}) => cover), [{kind: "observed", state: "open", motion: "stopped", observedAt: at(2).toISOString()}]);
  // Moving, or with no motion reported, its OPEN or CLOSE may be where it is going, not where it is.
  assert.deepEqual(apply(undefined, report({state: "CLOSE", moving: "UP"}), 2).readings.map(({cover}) => cover),
    [{kind: "observed", motion: "opening", observedAt: at(2).toISOString()}]);
  assert.deepEqual(apply(undefined, report({state: "OPEN"}), 2).readings, []);
  result = apply(result.state, command("observe"));
  assert.deepEqual(result.publications.map(({payload}) => JSON.parse(payload)), [{state: ""}]);
});

test("availability, as Zigbee2MQTT's JSON or plain text, becomes the cover's availability", () => {
  for (const [payload, online] of [[{state: "online"}, true], ['{"state":"offline"}', false], ["online", true], [Buffer.from("offline"), false]] as const) {
    assert.deepEqual(apply(undefined, {topic: "z2m/test-cover/availability", payload}).readings, [{cover: {kind: "availability", online}}]);
  }
  assert.throws(() => apply(undefined, {topic: "z2m/test-cover/availability", payload: "maybe"}), /online or offline/);
  // Other topics, such as our own set echoed back, are ignored.
  assert.deepEqual(apply(undefined, {topic: "z2m/test-cover/set", payload: {position: 3}}).readings, []);
});

// A Zigbee2MQTT cover, enough for a round trip: it moves 25 % a second and
// publishes its state each second while moving (and once it stops), with
// motion in `motion` ("motor_state", "moving" or none), and answers a get.
// With `positions` false it reports only OPEN or CLOSE.
function z2mDevice({motion = "motor_state" as "motor_state" | "moving" | "none", positions = true} = {}) {
  const device = {position: 0, target: null as number | null};
  const state = () => {
    const moving = device.target === null ? "stopped" : device.target > device.position ? "opening" : "closing";
    const fields: Record<string, unknown> = positions ? {position: device.position} : {};
    fields.state = device.position > 0 ? "OPEN" : "CLOSE";
    if (motion === "motor_state") fields.motor_state = moving;
    if (motion === "moving") fields.moving = moving === "opening" ? "UP" : moving === "closing" ? "DOWN" : "STOP";
    return {topic: "z2m/test-cover", payload: JSON.stringify(fields)};
  };
  return {
    device,
    receive(topic: string, payload: string) {
      const message = JSON.parse(payload) as Record<string, unknown>;
      if (topic.endsWith("/get")) return [state()];
      if (typeof message.position === "number") device.target = message.position;
      else if (message.state === "OPEN") device.target = 100;
      else if (message.state === "CLOSE") device.target = 0;
      else if (message.state === "STOP") device.target = null;
      return [state()];
    },
    second() {
      if (device.target === null) return [];
      device.position = Math.abs(device.target - device.position) <= 25 ? device.target : device.position + (device.target > device.position ? 25 : -25);
      if (device.position === device.target) device.target = null;
      return [state()];
    }
  };
}

// The adapter between a real cover model and the device, with messages
// delivered in order as Node-RED's wires would.
function roundTrip(model: CoverModel, shelly: ReturnType<typeof z2mDevice>, request: Record<string, unknown>) {
  let cover: unknown;
  let adapter: Partial<Z2mCoverState> | undefined;
  const results: string[] = [];
  const queue: Array<{to: "cover" | "adapter" | "device"; message: unknown}> = [];
  const run = (seconds: number) => {
    while (queue.length) {
      const {to, message} = queue.shift()!;
      if (to === "cover") {
        const result = model.transition(cover, message, at(seconds));
        cover = result.state;
        for (const event of result.events) results.push(String((event.theatre as {status?: string} | undefined)?.status));
        for (const entry of result.commands) queue.push({to: "adapter", message: {cover_command: entry}});
      } else if (to === "adapter") {
        const result = apply(adapter, message as Z2mCoverMessage, seconds);
        adapter = result.state;
        for (const reading of result.readings) queue.push({to: "cover", message: reading.cover});
        for (const publication of result.publications) queue.push({to: "device", message: publication});
      } else {
        const {topic, payload} = message as {topic: string; payload: string};
        for (const reply of shelly.receive(topic, payload)) queue.push({to: "adapter", message: reply});
      }
    }
  };
  queue.push({to: "adapter", message: {topic: "z2m/test-cover/availability", payload: {state: "online"}}}, {to: "cover", message: {kind: "startup"}});
  run(0);
  queue.push({to: "cover", message: {requestId: "evening", generation: 1, ...request}});
  run(1);
  for (let seconds = 2; seconds <= 30; seconds += 1) {
    for (const message of shelly.second()) queue.push({to: "adapter", message});
    const tick = model.tickAt(cover);
    if (tick && tick.at <= at(seconds).getTime()) queue.push({to: "cover", message: {kind: "tick", generation: tick.generation}});
    run(seconds);
  }
  return {view: model.view(cover), results, device: shelly.device};
}

test("round trips through the real cover controller: a position cover with motion, one without, and an open/close-only cover", () => {
  const settings = {travelTimeoutMs: 30000, pollMs: 1000, settleMs: 2000};
  for (const motion of ["motor_state", "none"] as const) {
    const {view, results, device} = roundTrip(positionCover(settings), z2mDevice({motion}), {kind: "set_position", position: 60});
    assert.equal(device.position, 60, motion);
    assert.deepEqual(view, {state: "open", position: 60}, motion);
    assert.equal(results.at(-1), "ready", `${motion}: ${results.join(",")}`);
    assert.ok(!results.includes("failed"), motion);
  }
  const openClose = roundTrip(openCloseCover({travelMs: 10000, marginMs: 5000}), z2mDevice({motion: "moving", positions: false}), {kind: "open"});
  assert.equal(openClose.device.position, 100);
  assert.equal(openClose.view?.state, "open");
  assert.equal(openClose.results.at(-1), "ready", openClose.results.join(","));
});
