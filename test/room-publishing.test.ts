"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {scheduledLighting} from "../lib/circadian";
import {resolveSchedule} from "../lib/circadian-schedule";
import {transitionRoom, type RoomConfig} from "../lib/room-controller";
import {publishRoom, roomInbound, roomStartingOutputs} from "../lib/room-publishing";
import {houseRetainedTopics} from "../lib/house-schedule-publishing";

const config: RoomConfig = {
  area: "kitchen",
  displayName: "Kitchen",
  targets: [{id: "cooking", stateTopic: "k/cooking", commandTopic: "k/cooking/set"}],
  initialTransitionSeconds: 1,
  refreshTransitionSeconds: 60,
  initialSleep: false,
  lighting: scheduledLighting(resolveSchedule(), {maxBrightnessPct: 100, maxColorTempKelvin: 6500, sleepBrightnessPct: 1, sleepColorTempKelvin: 2200})
};
const now = new Date("2026-06-21T12:00:00Z");

test("the room controller decides about lights only; publishing adds the topics", () => {
  const decided = transitionRoom(undefined, {lighting: {kind: "startup"}}, config, now);
  assert.deepEqual(decided.outputs, [], "no topics from the controller itself");
  assert.deepEqual(decided.controlChanged, []);
  assert.deepEqual(publishRoom(undefined, {lighting: {kind: "startup"}}, config, now).outputs.map(({topic}) => topic), [
    "homeassistant/switch/kitchen_circadian_lighting/config",
    "homeassistant/switch/kitchen_sleep/config",
    "homeassistant/time/kitchen_wake_time/config",
    "homeassistant/time/kitchen_bed_time/config",
    "homeassistant/sensor/kitchen_cooking_control/config",
    "home/kitchen/lighting/availability",
    "home/kitchen/circadian/state",
    "home/kitchen/sleep/state",
    "home/kitchen/wake-time/state",
    "home/kitchen/bed-time/state",
    "home/kitchen/lighting/cooking/control"
  ]);
  // The controller reports which lights' control changed; publishing names the topic.
  const overridden = transitionRoom(undefined, {lighting: {kind: "intent", state: "ON", targets: ["cooking"], owner: "theatre"}}, config, now);
  assert.deepEqual(overridden.controlChanged, ["cooking"]);
  assert.ok(overridden.outputs.every(({topic}) => topic === "k/cooking/set"));
});

test("the circadian set topic becomes a room event before the controller sees it", () => {
  const msg = {topic: "home/kitchen/circadian/set", payload: "off"};
  assert.deepEqual(roomInbound(msg, config).msg.lighting, {kind: "circadian", enabled: false});
  assert.deepEqual(roomInbound(msg, {...config, publishState: false}).msg, msg, "not publishing: passed through");
  assert.equal(roomInbound({topic: "k/cooking", payload: "x"}, config).traces.length, 0);
});

test("a room following the house has no time entities of its own, ignores its own time set topics, and takes the house's", () => {
  const house = {...config, timesFrom: "house" as const};
  const startup = publishRoom(undefined, {lighting: {kind: "startup"}}, house, now).outputs;
  const published = startup.filter(({payload}) => payload !== "").map(({topic}) => topic);
  const cleared = startup.filter(({payload}) => payload === "").map(({topic}) => topic);
  assert.ok(!published.some((topic) => /wake|bed/.test(topic)), published.join());
  assert.deepEqual(cleared, [
    "homeassistant/time/kitchen_wake_time/config",
    "homeassistant/time/kitchen_bed_time/config",
    "home/kitchen/wake-time/state",
    "home/kitchen/bed-time/state"
  ]);
  // Its own set topic is not read.
  const own = publishRoom(undefined, {topic: "home/kitchen/wake-time/set", payload: "05:00:00"}, house, now);
  assert.deepEqual(own.state.schedule, {wakeTime: "07:00", bedTime: "23:00"});
  // The house's message is.
  const fromHouse = publishRoom(undefined, {lighting: {kind: "schedule", wakeTime: "06:00", bedTime: "22:00"}}, house, now);
  assert.deepEqual(fromHouse.state.schedule, {wakeTime: "06:00", bedTime: "22:00"});
  assert.ok(!fromHouse.outputs.some(({topic}) => /wake|bed/.test(String(topic))), "and no time state is published for it");
  // A room on its own times is as before.
  assert.ok(publishRoom(undefined, {lighting: {kind: "startup"}}, config, now).outputs.some(({topic}) => topic === "home/kitchen/wake-time/state"));
});

test("as the flows start, the room announces its discovery entries, as the startup message does, then its availability", () => {
  const topics = (settings: typeof config & {timesFrom?: "house"; discovery?: boolean; publishState?: boolean}) =>
    roomStartingOutputs(settings).map(({topic, payload}) => (payload === "" ? "clear " : "") + topic);
  const entries = (settings: typeof config & {timesFrom?: "house"}) => publishRoom(undefined, {lighting: {kind: "startup"}}, settings, now).outputs
    .filter(({topic}) => String(topic).endsWith("/config")).map(({topic}) => String(topic));
  assert.deepEqual(topics(config), [...entries(config), "home/kitchen/lighting/availability"]);
  assert.equal(topics(config).length, 6);
  // Following the house: no time entities, as at the startup message, which also clears them.
  const house = {...config, timesFrom: "house" as const};
  assert.deepEqual(topics(house), [
    "homeassistant/switch/kitchen_circadian_lighting/config",
    "homeassistant/switch/kitchen_sleep/config",
    "homeassistant/sensor/kitchen_cooking_control/config",
    "home/kitchen/lighting/availability"
  ]);
  // Discovery off: nothing announced; the startup message still removes the entries.
  assert.deepEqual(topics({...config, discovery: false}), ["home/kitchen/lighting/availability"]);
  assert.deepEqual(topics({...config, publishState: false}), []);
});

test("a house and a room of the same name don't share topics: the room's clear leaves the house's alone", () => {
  const room = {...config, area: "hall", timesFrom: "house" as const};
  const cleared = publishRoom(undefined, {lighting: {kind: "startup"}}, room, now).outputs.filter(({payload}) => payload === "").map(({topic}) => topic);
  const houseTopics = houseRetainedTopics({area: "hall", publishState: true, discovery: true, discoveryPrefix: "homeassistant", nodeId: "house1", idScheme: "node"});
  assert.ok(houseTopics.includes("home/hall/schedule/wake-time/state"), houseTopics.join());
  assert.deepEqual(cleared.filter((topic) => houseTopics.includes(topic)), []);
  // Its own set topics are the house's, not the room's.
  assert.deepEqual(publishRoom(undefined, {topic: "home/hall/schedule/wake-time/set", payload: "05:00"}, {...config, area: "hall"}, now).state.schedule,
    {wakeTime: "07:00", bedTime: "23:00"});
});
