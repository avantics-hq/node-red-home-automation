"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {normaliseCoverConfig, transitionCover, type CoverState} from "../lib/cover-controller";
import {
  normaliseShellyCoverConfig,
  transitionShellyCover,
  type ShellyCoverMessage,
  type ShellyCoverState
} from "../lib/shelly-cover";

const config = normaliseShellyCoverConfig({topicPrefix: "shellyplus2pm-test", channel: 0});
const at = (seconds: number): Date => new Date(Date.parse("2026-11-26T10:00:00Z") + seconds * 1000);

function apply(state: Partial<ShellyCoverState> | undefined, msg: ShellyCoverMessage, seconds = 0) {
  return transitionShellyCover(state, msg, config, at(seconds));
}

const status = (fields: Record<string, unknown>) =>
  ({topic: "shellyplus2pm-test/status/cover:0", payload: JSON.stringify({id: 0, pos_control: true, ...fields})});
const notify = (change: Record<string, unknown>, ts = Date.parse("2026-11-26T10:00:05Z") / 1000) =>
  ({topic: "shellyplus2pm-test/events/rpc", payload: {src: "shellyplus2pm-test", dst: "x", method: "NotifyStatus", params: {ts, "cover:0": change}}});
const command = (operation: string, generation = 1, position?: number) =>
  ({cover_command: {operation, requestId: "r", generation, attempt: 1, ...(position === undefined ? {} : {position})}} as ShellyCoverMessage);

test("the settings name the device's prefix and cover, with no default device", () => {
  assert.deepEqual(normaliseShellyCoverConfig({topicPrefix: " /shellies/cover-a/ ", channel: "1"}), {topicPrefix: "shellies/cover-a", channel: 1});
  assert.deepEqual(normaliseShellyCoverConfig({topicPrefix: "x"}), {topicPrefix: "x", channel: 0});
  assert.throws(() => normaliseShellyCoverConfig({}), /topic prefix is required/);
  assert.throws(() => normaliseShellyCoverConfig({topicPrefix: "a/#"}), /\+ or #/);
  assert.throws(() => normaliseShellyCoverConfig({topicPrefix: "a", channel: "-1"}), /whole number/);
});

test("the controller's commands become the device's MQTT control commands on its cover topic", () => {
  const sent = (msg: ShellyCoverMessage, state?: Partial<ShellyCoverState>) => apply(state, msg).publications;
  assert.deepEqual(sent(command("set_position", 1, 42)), [{topic: "shellyplus2pm-test/command/cover:0", payload: "pos,42"}]);
  assert.deepEqual(sent(command("set_position", 1, 42.6)), [{topic: "shellyplus2pm-test/command/cover:0", payload: "pos,43"}]);
  assert.deepEqual(sent(command("stop")), [{topic: "shellyplus2pm-test/command/cover:0", payload: "stop"}]);
  // observe asks the device for a fresh status rather than replaying the last one.
  assert.deepEqual(sent(command("observe")), [{topic: "shellyplus2pm-test/command/cover:0", payload: "status_update"}]);
  assert.deepEqual(sent(command("dance")), []);
  const second = normaliseShellyCoverConfig({topicPrefix: "dev", channel: 1});
  assert.deepEqual(transitionShellyCover(undefined, command("stop"), second, at(0)).publications, [{topic: "dev/command/cover:1", payload: "stop"}]);
});

test("a status becomes a position reading, with each Shelly state as a motion", () => {
  for (const [state, motion] of [["opening", "opening"], ["closing", "closing"], ["open", "stopped"], ["closed", "stopped"], ["stopped", "stopped"]]) {
    const result = apply(undefined, status({state, current_pos: 37}), 1);
    assert.deepEqual(result.readings, [{cover: {kind: "observed", position: 37, motion, observedAt: at(1).toISOString()}}], state);
  }
  // Calibrating: no reading until it is done.
  assert.deepEqual(apply(undefined, status({state: "calibrating", current_pos: 10})).readings, []);
});

test("an uncalibrated cover, or one that doesn't know its position, fails the command in hand instead of reporting a position", () => {
  // Uncalibrated: no current_pos and pos_control false.
  let result = apply(undefined, command("observe", 4));
  result = apply(result.state, status({state: "stopped", pos_control: false}));
  assert.deepEqual(result.readings, [{cover: {kind: "command_result", generation: 4, ok: false, reason: "not-calibrated"}}]);
  assert.equal(result.status.text, "not calibrated");
  // A position isn't sent to a cover known to be uncalibrated, which would refuse it.
  const refused = apply(result.state, command("set_position", 5, 50));
  assert.deepEqual([refused.publications, refused.readings], [[], [{cover: {kind: "command_result", generation: 5, ok: false, reason: "not-calibrated"}}]]);
  // Calibrated but position lost.
  result = apply(undefined, command("stop", 6));
  result = apply(result.state, status({state: "stopped", current_pos: null}));
  assert.deepEqual(result.readings, [{cover: {kind: "command_result", generation: 6, ok: false, reason: "position-unknown"}}]);
  // With no command in hand there is nothing to fail, and still no made-up position.
  assert.deepEqual(apply(undefined, status({state: "stopped", pos_control: false})).readings, []);
});

test("change notifications are laid over the last status, timed when received", () => {
  let result = apply(undefined, status({state: "stopped", current_pos: 0}), 0);
  result = apply(result.state, notify({id: 0, state: "opening"}), 5);
  assert.deepEqual(result.readings, [{cover: {kind: "observed", position: 0, motion: "opening", observedAt: at(5).toISOString()}}]);
  result = apply(result.state, notify({id: 0, current_pos: 40}), 6);
  assert.deepEqual(result.readings, [{cover: {kind: "observed", position: 40, motion: "opening", observedAt: at(6).toISOString()}}]);
  // Power and other updates mid-travel aren't new readings.
  assert.deepEqual(apply(result.state, notify({id: 0, apower: 120.5}), 6.5).readings, []);
  result = apply(result.state, notify({id: 0, state: "open", current_pos: 100, target_pos: null}), 10);
  assert.deepEqual(result.readings[0]?.cover, {kind: "observed", position: 100, motion: "stopped", observedAt: at(10).toISOString()});
  assert.equal(Object.hasOwn(result.state.status!, "target_pos"), false, "a key reported as null has gone");
  // Another cover's change, or another notification, is not this cover's.
  assert.deepEqual(apply(result.state, {topic: "shellyplus2pm-test/events/rpc", payload: {method: "NotifyStatus", params: {ts: 1, "cover:1": {current_pos: 3}}}}).readings, []);
  assert.deepEqual(apply(result.state, {topic: "shellyplus2pm-test/events/rpc", payload: {method: "NotifyEvent", params: {ts: 1, events: []}}}).readings, []);
});

test("a change with no full status yet asks the device for one, and doesn't fail the command as uncalibrated", () => {
  let result = apply(undefined, command("set_position", 2, 60));
  // Only what changed: the cover started opening, with no position.
  result = apply(result.state, notify({id: 0, state: "opening", target_pos: 60}), 1);
  assert.deepEqual(result.readings, []);
  assert.deepEqual(result.publications, [{topic: "shellyplus2pm-test/command/cover:0", payload: "status_update"}]);
  // The full status then gives the reading.
  result = apply(result.state, status({state: "opening", current_pos: 5}), 1.2);
  assert.deepEqual(result.readings, [{cover: {kind: "observed", position: 5, motion: "opening", observedAt: at(1.2).toISOString()}}]);
  // A change that says outright the cover isn't calibrated needs no full status.
  const told = apply(apply(undefined, command("observe", 3)).state, notify({id: 0, pos_control: false}));
  assert.deepEqual(told.readings, [{cover: {kind: "command_result", generation: 3, ok: false, reason: "not-calibrated"}}]);
});

test("the device's online topic is the cover's availability, as text, Buffer or parsed", () => {
  for (const [payload, online] of [["true", true], [false, false], [Buffer.from("false"), false]] as const) {
    const result = apply(undefined, {topic: "shellyplus2pm-test/online", payload});
    assert.deepEqual(result.readings, [{cover: {kind: "availability", online}}]);
    // Back online, its position may have changed while away: ask for it.
    assert.deepEqual(result.publications, online ? [{topic: "shellyplus2pm-test/command/cover:0", payload: "status_update"}] : []);
  }
  assert.throws(() => apply(undefined, {topic: "shellyplus2pm-test/online", payload: "maybe"}), /true or false/);
  // Anything else, such as its own command topic echoed back by a wildcard subscription, is ignored.
  const echo = apply(undefined, {topic: "shellyplus2pm-test/command/cover:0", payload: "stop"});
  assert.deepEqual([echo.readings, echo.publications], [[], []]);
});

// A device in cover mode as its MQTT API behaves, enough for a round trip:
// pos,N moves at 25 %/s with a notification each second; stop halts;
// status_update publishes the full status.
function shellyDevice(clockBehindSeconds = 0) {
  const device = {state: "stopped", current_pos: 0, target: null as number | null};
  const deviceTs = (seconds: number) => (at(seconds).getTime() / 1000) - clockBehindSeconds;
  const full = () => ({topic: "shellyplus2pm-test/status/cover:0", payload: JSON.stringify({id: 0, state: device.state, current_pos: device.current_pos, pos_control: true})});
  return {
    device,
    receive(payload: string, seconds = 0) {
      if (payload === "status_update") return [full()];
      if (payload === "stop") {
        device.state = "stopped";
        device.target = null;
        return [notify({id: 0, state: "stopped"}, deviceTs(seconds))];
      }
      return this.move(Number(payload.split(",")[1]), seconds);
    },
    // A move, from a command or from the device's own wall switch.
    move(position: number, seconds: number) {
      device.target = position;
      device.state = position > device.current_pos ? "opening" : "closing";
      return [notify({id: 0, state: device.state, target_pos: position}, deviceTs(seconds))];
    },
    second(seconds: number) {
      if (device.target === null) return [];
      const step = device.target > device.current_pos ? 25 : -25;
      device.current_pos = Math.abs(device.target - device.current_pos) <= 25 ? device.target : device.current_pos + step;
      if (device.current_pos === device.target) {
        device.state = device.current_pos === 100 ? "open" : device.current_pos === 0 ? "closed" : "stopped";
        device.target = null;
      }
      return [notify({id: 0, state: device.state, current_pos: device.current_pos}, deviceTs(seconds))];
    }
  };
}

// The adapter between the real cover controller and a simulated device,
// with messages delivered in order as Node-RED's wires would: startup, a
// request to 60, then (if `wallSwitchAt`) someone closing the cover from its
// own switch. The device's clock may be behind.
function roundTrip({clockBehindSeconds = 0, wallSwitchAt = null as number | null} = {}) {
  const coverConfig = normaliseCoverConfig({travelTimeoutMs: 30000, pollMs: 1000, settleMs: 2000});
  const shelly = shellyDevice(clockBehindSeconds);
  let cover: ReturnType<typeof transitionCover> | undefined;
  let adapter: ReturnType<typeof transitionShellyCover> | undefined;
  const results: string[] = [];
  const queue: Array<{to: "cover" | "adapter" | "device"; message: unknown}> = [];
  const run = (seconds: number) => {
    while (queue.length) {
      const {to, message} = queue.shift()!;
      if (to === "cover") {
        cover = transitionCover(cover?.state as Partial<CoverState> | undefined, {cover: message as never}, coverConfig, at(seconds));
        for (const entry of cover.events) results.push(String(entry.theatre?.status));
        for (const entry of cover.commands) queue.push({to: "adapter", message: {cover_command: entry}});
      } else if (to === "adapter") {
        adapter = apply(adapter?.state, message as ShellyCoverMessage, seconds);
        for (const reading of adapter.readings) queue.push({to: "cover", message: reading.cover});
        for (const publication of adapter.publications) queue.push({to: "device", message: publication.payload});
      } else {
        for (const reply of shelly.receive(message as string, seconds)) queue.push({to: "adapter", message: reply});
      }
    }
  };
  queue.push({to: "adapter", message: {topic: "shellyplus2pm-test/online", payload: "true"}}, {to: "cover", message: {kind: "startup"}});
  run(0);
  queue.push({to: "cover", message: {kind: "set_position", requestId: "evening", generation: 1, position: 60}});
  run(1);
  for (let seconds = 2; seconds <= 40; seconds += 1) {
    if (seconds === wallSwitchAt) for (const message of shelly.move(0, seconds)) queue.push({to: "adapter", message});
    for (const message of shelly.second(seconds)) queue.push({to: "adapter", message});
    queue.push({to: "cover", message: {kind: "tick", generation: 1}});
    run(seconds);
    if (wallSwitchAt === null && cover!.state.phase === "ready") break;
  }
  return {cover: cover!.state, device: shelly.device, results};
}

test("a round trip through the cover controller: a request moves the device and is confirmed from its own reports", () => {
  const {cover, device, results} = roundTrip();
  assert.equal(device.current_pos, 60);
  assert.equal(cover.phase, "ready", JSON.stringify(cover));
  assert.equal(cover.observed?.position, 60);
  assert.ok(!results.includes("failed"), results.join(","));
});

test("a device clock minutes behind changes nothing: moves are confirmed, and a person's move is seen", () => {
  for (const clockBehindSeconds of [0, 300]) {
    const confirmed = roundTrip({clockBehindSeconds});
    assert.deepEqual([confirmed.cover.phase, confirmed.cover.observed?.position], ["ready", 60], `${clockBehindSeconds} s behind`);
    // Closed from the wall switch after the move was confirmed.
    const moved = roundTrip({clockBehindSeconds, wallSwitchAt: 20});
    assert.equal(moved.device.current_pos, 0);
    assert.deepEqual([moved.cover.phase, moved.cover.observed?.position], ["manual_override", 0], `${clockBehindSeconds} s behind`);
  }
});
