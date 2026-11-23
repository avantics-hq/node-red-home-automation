"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {scheduledLighting} from "../lib/circadian";
import {resolveSchedule} from "../lib/circadian-schedule";
import {transitionRoom, type RoomConfig} from "../lib/room-controller";
import {publishRoom, roomInbound} from "../lib/room-publishing";

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
    "home/kitchen/lighting/availability",
    "home/kitchen/circadian/state",
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
