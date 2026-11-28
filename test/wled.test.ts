"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {normaliseWledConfig, transitionWled, type WledMessage, type WledState} from "../lib/wled";

const config = normaliseWledConfig({deviceTopic: "home/test/light/strip"});
const at = (seconds: number) => new Date(Date.parse("2026-11-28T10:00:00Z") + seconds * 1000);
const apply = (state: Partial<WledState> | undefined, msg: WledMessage, seconds = 0) => transitionWled(state, msg, config, at(seconds));

test("WLED settings: its device topic, which has no default", () => {
  assert.deepEqual(normaliseWledConfig({deviceTopic: " /wled/strip/ "}), {deviceTopic: "wled/strip"});
  assert.throws(() => normaliseWledConfig({}), /device topic is required/);
  assert.throws(() => normaliseWledConfig({deviceTopic: "wled/#"}), /\+ or #/);
});

test("set_power becomes WLED's ON or OFF, and its brightness reports become the controller's readings", () => {
  let result = apply(undefined, {backlightingCommand: {operation: "set_power", generation: 3, power: "on"}});
  assert.deepEqual(result.publications, [{topic: "home/test/light/strip", payload: "ON"}]);
  assert.deepEqual(result.readings, [{backlighting: {kind: "command_result", generation: 3, ok: true}}]);
  result = apply(result.state, {topic: "home/test/light/strip/g", payload: Buffer.from("128")}, 1);
  assert.deepEqual(result.readings, [{backlighting: {kind: "observed", generation: 3, power: "on", observedAt: at(1).toISOString()}}]);
  // Anyone's change is read the same: 0 is off.
  result = apply(result.state, {topic: "home/test/light/strip/g", payload: "0"}, 2);
  assert.equal(result.readings[0]?.backlighting.kind === "observed" && result.readings[0].backlighting.power, "off");
  result = apply(result.state, {backlightingCommand: {operation: "set_power", generation: 4, power: "off"}}, 3);
  assert.equal(result.publications[0]?.payload, "OFF");
});

test("observe is answered from WLED's last report while it is online; before any, and offline, it isn't", () => {
  let result = apply(undefined, {backlightingCommand: {operation: "observe", generation: 1}});
  assert.deepEqual(result.readings, [], "no report since start");
  result = apply(result.state, {topic: "home/test/light/strip/g", payload: "200"}, 1);
  result = apply(result.state, {backlightingCommand: {operation: "observe", generation: 2}}, 5);
  assert.deepEqual(result.readings, [{backlighting: {kind: "observed", generation: 2, power: "on", observedAt: at(5).toISOString()}}]);
  // The recovery probe's observe (generation 0) is answered the same way.
  result = apply(result.state, {backlightingCommand: {operation: "observe", generation: 0}}, 6);
  assert.equal(result.readings[0]?.backlighting.generation, 0);
  result = apply(result.state, {topic: "home/test/light/strip/status", payload: "offline"}, 7);
  result = apply(result.state, {backlightingCommand: {operation: "observe", generation: 3}}, 8);
  assert.deepEqual(result.readings, []);
  result = apply(result.state, {backlightingCommand: {operation: "set_power", generation: 3, power: "on"}}, 9);
  assert.deepEqual([result.publications, result.readings],
    [[], [{backlighting: {kind: "command_result", generation: 3, ok: false, reason: "unavailable"}}]]);
  result = apply(result.state, {topic: "home/test/light/strip/status", payload: "online"}, 10);
  assert.equal(result.state.online, true);
});

test("a report before the controller's first command passes nothing on; other topics are ignored", () => {
  let result = apply(undefined, {topic: "home/test/light/strip/g", payload: "64"});
  assert.deepEqual([result.readings, result.state.power], [[], "on"]);
  result = apply(result.state, {topic: "home/test/light/strip/c", payload: "#ff0000"});
  assert.equal(result.traces[0]?.reason, "other-topic");
  assert.throws(() => apply(undefined, {topic: "home/test/light/strip/g", payload: "bright"}), /brightness/);
});
