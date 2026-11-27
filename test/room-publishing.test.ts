"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {transitionRoom, type RoomConfig} from "../lib/room-controller";
import {publishRoom, roomStartingOutputs, withoutCircadianState} from "../lib/room-publishing";
import {houseRetainedTopics} from "../lib/house-schedule-publishing";

const config: RoomConfig = {
  area: "kitchen",
  displayName: "Kitchen",
  targets: [{id: "cooking", stateTopic: "k/cooking", commandTopic: "k/cooking/set"}],
  initialTransitionSeconds: 1
};
const now = new Date("2026-06-21T12:00:00Z");
const oldCircadian = [
  "homeassistant/switch/kitchen_circadian_lighting/config",
  "homeassistant/switch/kitchen_sleep/config",
  "homeassistant/time/kitchen_wake_time/config",
  "homeassistant/time/kitchen_bed_time/config"
];

test("the room controller decides about lights only; publishing adds the topics", () => {
  const decided = transitionRoom(undefined, {lighting: {kind: "startup"}}, config, now);
  assert.deepEqual(decided.outputs, [], "no topics from the controller itself");
  assert.deepEqual(decided.controlChanged, []);
  assert.deepEqual(publishRoom(undefined, {lighting: {kind: "startup"}}, config, now).outputs.map(({topic, payload}) => (payload === "" ? "clear " : "") + topic), [
    ...oldCircadian.map((topic) => "clear " + topic),
    "homeassistant/sensor/kitchen_cooking_control/config",
    "home/kitchen/lighting/availability",
    "home/kitchen/lighting/cooking/control"
  ]);
  // The controller reports which lights' control changed; publishing names the topic.
  const overridden = transitionRoom(undefined, {lighting: {kind: "intent", state: "ON", targets: ["cooking"], owner: "theatre"}}, config, now);
  assert.deepEqual(overridden.controlChanged, ["cooking"]);
  assert.ok(overridden.outputs.every(({topic}) => topic === "k/cooking/set"));
});

test("as the flows start, the room clears its old circadian entries, announces its own, then its availability", () => {
  const topics = (settings: typeof config & {discovery?: boolean; publishState?: boolean; idScheme?: "node"; nodeId?: string}) =>
    roomStartingOutputs(settings).map(({topic, payload}) => (payload === "" ? "clear " : "") + topic);
  assert.deepEqual(topics(config), [...oldCircadian.map((topic) => "clear " + topic), "homeassistant/sensor/kitchen_cooking_control/config", "home/kitchen/lighting/availability"]);
  // Named after its node: its own old entries.
  assert.deepEqual(topics({...config, idScheme: "node", nodeId: "r1"}).slice(0, 2),
    ["clear homeassistant/switch/nrha_r1_circadian_lighting/config", "clear homeassistant/switch/nrha_r1_sleep/config"]);
  // Discovery off: its entries are removed only at the startup message.
  assert.deepEqual(topics({...config, discovery: false}), [...oldCircadian.map((topic) => "clear " + topic), "home/kitchen/lighting/availability"]);
  assert.ok(publishRoom(undefined, {lighting: {kind: "startup"}}, {...config, discovery: false}, now).outputs
    .some(({topic, payload}) => topic === "homeassistant/sensor/kitchen_cooking_control/config" && payload === ""));
  // Publishing nothing, it cleared them itself before 6.0 when its publishing was switched off.
  assert.deepEqual(topics({...config, publishState: false, discovery: false}), []);
  assert.deepEqual(topics({...config, area: ""}), []);
});

test("the circadian lighting policy's state topics are never the room's to clear, even from a record saved before 6.0", () => {
  const recorded = ["home/kitchen/circadian/state", "home/kitchen/sleep/state", "home/kitchen/wake-time/state", "home/kitchen/bed-time/state",
    "home/kitchen/lighting/availability", "home/kitchen/lighting/cooking/control", ...oldCircadian];
  assert.deepEqual(withoutCircadianState(recorded), ["home/kitchen/lighting/availability", "home/kitchen/lighting/cooking/control", ...oldCircadian]);
  // What the room publishes now never includes them.
  assert.ok(!publishRoom(undefined, {lighting: {kind: "startup"}}, config, now).outputs.some(({topic}) => /\/(circadian|sleep|wake-time|bed-time)\/state$/.test(topic)));
});

test("a house and a room of the same name don't share topics: the room's clear leaves the house's alone", () => {
  const room = {...config, area: "hall"};
  const cleared = publishRoom(undefined, {lighting: {kind: "startup"}}, room, now).outputs.filter(({payload}) => payload === "").map(({topic}) => topic);
  const houseTopics = houseRetainedTopics({area: "hall", publishState: true, discovery: true, discoveryPrefix: "homeassistant", nodeId: "house1", idScheme: "node"});
  assert.ok(houseTopics.includes("home/hall/schedule/wake-time/state"), houseTopics.join());
  assert.deepEqual(cleared.filter((topic) => houseTopics.includes(topic)), []);
});
