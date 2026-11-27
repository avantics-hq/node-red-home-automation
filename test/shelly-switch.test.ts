"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  normaliseShellySwitchConfig,
  transitionShellySwitch,
  CONFIG_TIMEOUT_MS,
  type ShellySwitchConfig,
  type ShellySwitchMessage,
  type ShellySwitchState
} from "../lib/shelly-switch";
import {transitionSwitchPolicy, type SwitchPolicyConfig, type SwitchPolicyEffect, type SwitchPolicyState} from "../lib/switch-policy";

const auto = normaliseShellySwitchConfig({topicPrefix: "shellyplus1-test", channel: 0});
const at = (seconds: number): Date => new Date(Date.parse("2026-11-27T10:00:00Z") + seconds * 1000);

function apply(state: Partial<ShellySwitchState> | undefined, msg: ShellySwitchMessage, seconds = 0, config: ShellySwitchConfig = auto) {
  return transitionShellySwitch(state, msg, config, at(seconds));
}
const startup = {shellySwitch: {kind: "startup"}};
// The device's answer to this node's Shelly.GetConfig request, on <src>/rpc.
const configReply = (id: number, inMode: string, inputType: string) => ({
  topic: "shellyplus1-test/home-automation-switch-0/rpc",
  payload: JSON.stringify({id, src: "shellyplus1-test", dst: "shellyplus1-test/home-automation-switch-0",
    result: {"switch:0": {id: 0, in_mode: inMode}, "input:0": {id: 0, type: inputType}}})
});
const deviceStatus = (input: boolean | null, output: boolean) =>
  ({topic: "shellyplus1-test/status", payload: {"switch:0": {id: 0, output, source: "init"}, "input:0": {id: 0, state: input}}});
const notify = (params: Record<string, unknown>) => ({topic: "shellyplus1-test/events/rpc", payload: {method: "NotifyStatus", params: {ts: 1, ...params}}});
const pushed = (event: string, component = "input:0") =>
  ({topic: "shellyplus1-test/events/rpc", payload: {method: "NotifyEvent", params: {ts: 1, events: [{component, id: 0, event, ts: 1}]}}});

// A node that has read its device's configuration.
function setUp(inMode: string, inputType: string, config: ShellySwitchConfig = auto) {
  const started = apply(undefined, startup, 0, config);
  return apply(started.state, configReply(started.state.requestId, inMode, inputType), 0.1, config);
}

test("the settings name the device's prefix and switch, and a mode that defaults to auto", () => {
  assert.deepEqual(normaliseShellySwitchConfig({topicPrefix: " dev/ ", channel: "1"}), {topicPrefix: "dev", channel: 1, mode: "auto"});
  assert.equal(normaliseShellySwitchConfig({topicPrefix: "dev", mode: "relay"}).mode, "relay");
  assert.throws(() => normaliseShellySwitchConfig({}), /topic prefix is required/);
  assert.throws(() => normaliseShellySwitchConfig({topicPrefix: "dev", mode: "fancy"}), /auto, detached or relay/);
});

test("at startup it asks the device for its configuration, with the reply addressed under its own prefix, and for a baseline", () => {
  const result = apply(undefined, startup);
  const [request, status] = result.publications;
  assert.equal(request?.topic, "shellyplus1-test/rpc");
  assert.deepEqual(JSON.parse(request!.payload), {id: 1, src: "shellyplus1-test/home-automation-switch-0", method: "Shelly.GetConfig"});
  assert.deepEqual(status, {topic: "shellyplus1-test/command", payload: "status_update"});
  assert.equal(result.status.text, "reading the device's configuration");
});

test("the device's configuration sets the mode: detached with a switch or a button input, or the relay as the light", () => {
  assert.equal(setUp("detached", "switch").status.text, "detached, switch input");
  assert.equal(setUp("detached", "button").status.text, "detached, button input");
  assert.equal(setUp("follow", "switch").status.text, "follow, switch input");
  assert.equal(setUp("momentary", "button").status.text, "momentary, button input");
  // A reply to someone else's request is not ours.
  const started = apply(undefined, startup);
  assert.equal(apply(started.state, configReply(99, "detached", "switch")).status.text, "reading the device's configuration");
});

test("a configuration that can't be read isn't guessed: the status says so, and the Mode setting decides", () => {
  // No reply in time.
  let result = apply(undefined, startup);
  result = apply(result.state, {shellySwitch: {kind: "tick"}}, CONFIG_TIMEOUT_MS / 1000);
  assert.deepEqual(result.status, {text: "configuration unreadable: set Mode", fill: "red"});
  // Nothing goes to the switch policy while the mode is unknown.
  assert.deepEqual(apply(result.state, notify({"input:0": {id: 0, state: true}}), 11).readings, []);
  // An error reply.
  const started = apply(undefined, startup);
  const failed = apply(started.state, {topic: "shellyplus1-test/home-automation-switch-0/rpc", payload: {id: 1, error: {code: -103, message: "x"}}});
  assert.equal(failed.status.text, "configuration unreadable: set Mode");
  // The setting overrides.
  const detached = normaliseShellySwitchConfig({topicPrefix: "shellyplus1-test", mode: "detached"});
  let overridden = apply(undefined, startup, 0, detached);
  overridden = apply(overridden.state, {shellySwitch: {kind: "tick"}}, 10, detached);
  assert.equal(overridden.status.text, "detached (set)");
  assert.deepEqual(apply(overridden.state, notify({"input:0": {id: 0, state: true}}), 11, detached).readings,
    [{source: "switch", payload: {state: true}, observedAt: at(11).toISOString()}]);
});

test("detached with a switch input: the status is a baseline, then each change an edge for the switch policy", () => {
  let result = setUp("detached", "switch");
  result = apply(result.state, deviceStatus(false, true), 1);
  assert.deepEqual(result.readings, [{source: "switch", payload: {state: false}, baseline: true, observedAt: at(1).toISOString()}]);
  result = apply(result.state, notify({"input:0": {id: 0, state: true}}), 2);
  assert.deepEqual(result.readings, [{source: "switch", payload: {state: true}, observedAt: at(2).toISOString()}]);
  // A status that arrived before the configuration still becomes the baseline once the mode is known.
  const started = apply(undefined, startup);
  const early = apply(started.state, deviceStatus(true, true), 0.05);
  assert.deepEqual(early.readings, []);
  assert.deepEqual(apply(early.state, configReply(1, "detached", "switch"), 0.1).readings,
    [{source: "switch", payload: {state: true}, baseline: true, observedAt: at(0.1).toISOString()}]);
});

test("detached with a button input: pushes become single, double and long actions", () => {
  const ready = setUp("detached", "button");
  for (const [event, action] of [["single_push", "single"], ["double_push", "double"], ["long_push", "long"]] as const) {
    assert.deepEqual(apply(ready.state, pushed(event), 3).readings, [{source: "switch-action", payload: {action}, observedAt: at(3).toISOString()}], event);
  }
  // Other events, and another input's, are not presses of this switch.
  assert.deepEqual(apply(ready.state, pushed("btn_down"), 3).readings, []);
  assert.deepEqual(apply(ready.state, pushed("single_push", "input:1"), 3).readings, []);
  // A button's state is null: no edge.
  assert.deepEqual(apply(ready.state, deviceStatus(null, true), 3).readings, []);
});

test("detached, the relay is never commanded, and a relay found off warns that the bulbs have no power", () => {
  let result = setUp("detached", "switch");
  result = apply(result.state, {switchCommand: {power: "off"}}, 1);
  assert.deepEqual(result.publications, []);
  assert.equal(result.traces.at(-1)?.reason, "detached");
  result = apply(result.state, notify({"switch:0": {id: 0, output: false, source: "button"}}), 2);
  assert.deepEqual(result.readings, []);
  assert.deepEqual(result.status, {text: "detached, switch input · relay off: bulbs unpowered", fill: "yellow"});
});

test("not detached, the relay is the light: its state is reported, a change at the switch as a person's, and on/off is sent", () => {
  let result = setUp("follow", "switch");
  result = apply(result.state, notify({"switch:0": {id: 0, output: true, source: "switch"}}), 1);
  assert.deepEqual(result.readings, [{switchState: {kind: "observed", on: true, person: true, observedAt: at(1).toISOString()}}]);
  result = apply(result.state, {switchCommand: {power: "off"}}, 2);
  assert.deepEqual(result.publications, [{topic: "shellyplus1-test/command/switch:0", payload: "off"}]);
  result = apply(result.state, notify({"switch:0": {id: 0, output: false, source: "MQTT"}}), 2.1);
  assert.deepEqual(result.readings, [{switchState: {kind: "observed", on: false, person: false, observedAt: at(2.1).toISOString()}}]);
  // Its input's changes and pushes don't go to the switch policy.
  assert.deepEqual(apply(result.state, notify({"input:0": {id: 0, state: true}}), 3).readings, []);
});

test("offline and online: availability for the switch policy, and back online the configuration is read again", () => {
  let result = setUp("detached", "switch");
  result = apply(result.state, {topic: "shellyplus1-test/online", payload: "false"}, 1);
  assert.deepEqual([result.readings, result.status.text], [[{source: "switch-availability", payload: "offline"}], "offline"]);
  result = apply(result.state, {topic: "shellyplus1-test/online", payload: true}, 2);
  assert.deepEqual(result.readings, [{source: "switch-availability", payload: "online"}]);
  assert.deepEqual(result.publications.map(({topic}) => topic), ["shellyplus1-test/rpc", "shellyplus1-test/command"]);
  // Relay mode: availability as the relay's.
  const relay = apply(setUp("flip", "switch").state, {topic: "shellyplus1-test/online", payload: false}, 1);
  assert.deepEqual(relay.readings, [{switchState: {kind: "availability", online: false}}]);
  // Its own request echoed back is ignored.
  assert.deepEqual(apply(result.state, {topic: "shellyplus1-test/rpc", payload: {id: 2, method: "Shelly.GetConfig"}}).readings, []);
});

test("a round trip through the real switch policy: wall switch presses become lighting intents", () => {
  const policyConfig: SwitchPolicyConfig = {targets: ["ceiling"], switchWindowMs: 500, switchFreshnessMs: 60_000};
  const sends = (effects: SwitchPolicyEffect[]) => effects.flatMap((effect) => (effect.kind === "send" ? [effect.message.lighting] : []));
  const run = (inputType: string, events: Array<[number, ShellySwitchMessage]>) => {
    let adapter = setUp("detached", inputType).state as Partial<ShellySwitchState>;
    let policy: Partial<SwitchPolicyState> | undefined = transitionSwitchPolicy(undefined, {source: "switch-startup"}, policyConfig, at(0).getTime()).state;
    const intents: unknown[] = [];
    type Timer = {generation: number; switchAt: number; dueAt: number};
    const pending: {timer: Timer | null} = {timer: null};
    const feed = (input: Record<string, unknown>, ms: number) => {
      const result = transitionSwitchPolicy(policy, input as never, policyConfig, ms);
      policy = result.state;
      intents.push(...sends(result.effects));
      for (const effect of result.effects) {
        if (effect.kind === "schedule-switch-timer") pending.timer = {generation: effect.generation, switchAt: effect.switchAt, dueAt: ms + effect.delayMs};
        if (effect.kind === "cancel-switch-timer") pending.timer = null;
      }
    };
    for (const [seconds, message] of events) {
      const ms = at(seconds).getTime();
      const due = pending.timer;
      if (due && due.dueAt <= ms) {
        pending.timer = null;
        feed({source: "switch-timer", generation: due.generation, switchAt: due.switchAt}, due.dueAt);
      }
      const result = apply(adapter, message, seconds);
      adapter = result.state;
      for (const reading of result.readings) feed(reading as Record<string, unknown>, ms);
    }
    return intents;
  };
  // A switch-type input: the baseline, then one flip (a toggle) and, later, two quick flips (full brightness).
  const flips = run("switch", [
    [1, deviceStatus(false, true)],
    [2, notify({"input:0": {id: 0, state: true}})],
    [5, notify({"input:0": {id: 0, state: false}})],
    [5.2, notify({"input:0": {id: 0, state: true}})],
    [8, deviceStatus(true, true)]
  ]);
  assert.deepEqual(flips, [
    {kind: "intent", targets: ["ceiling"], state: "TOGGLE", source: "wall", person: true},
    {kind: "intent", targets: ["ceiling"], state: "ON", source: "wall", person: true, manual: true, values: {brightnessPct: 100}}
  ]);
  // A button-type input: a single push toggles, a double push is full brightness.
  const pushes = run("button", [[1, pushed("single_push")], [3, pushed("double_push")], [4, pushed("long_push")]]);
  assert.deepEqual(pushes, [
    {kind: "intent", targets: ["ceiling"], state: "TOGGLE", source: "wall", person: true},
    {kind: "intent", targets: ["ceiling"], state: "ON", source: "wall", person: true, manual: true, values: {brightnessPct: 100}}
  ]);
});
