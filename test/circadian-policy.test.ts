"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {scheduledLighting} from "../lib/circadian";
import {createCircadianState, transitionCircadian, type CircadianConfig} from "../lib/circadian-policy";
import {
  circadianInbound,
  circadianRetainedTopics,
  circadianStartingOutputs,
  circadianStateTopics,
  roomCircadianDiscoveryTopics,
  type CircadianPublishingConfig
} from "../lib/circadian-publishing";
import {resolveSchedule} from "../lib/circadian-schedule";
import {lightCommand} from "../lib/z2m-light";

const levels = {maxBrightnessPct: 90, maxColorTempKelvin: 5000, sleepBrightnessPct: 2, sleepColorTempKelvin: 2200};
const schedule = resolveSchedule("06:30", "00:30");
const config: CircadianConfig = {
  lighting: scheduledLighting(schedule, levels),
  schedule,
  timesFrom: "own",
  initialSleep: false,
  transitionSeconds: 45,
  intervalSeconds: 60
};
// Local time, so these run under any TZ.
const at = (time: string) => new Date(`2026-06-21T${time}:00`);

test("the style gives the lights exactly what the room's own circadian lighting sent before 6.0", () => {
  // Captured from 5.x's room controller (adaptivePayload) with these settings: the curve's rise, day, wind-down,
  // a bed time after midnight, the night, and sleep mode at each.
  const before: Array<[string, boolean, number, number]> = [
    ["06:00", false, 5, 455], ["06:45", false, 40, 415], ["07:10", false, 171, 266], ["12:00", false, 229, 200],
    ["22:00", false, 212, 219], ["23:30", false, 63, 389], ["00:20", false, 7, 452], ["02:00", false, 5, 455],
    ["06:45", true, 5, 455], ["12:00", true, 5, 455], ["23:30", true, 5, 455]
  ];
  for (const [time, sleeping, brightness, colorTemp] of before) {
    const {style} = transitionCircadian({sleeping}, {kind: "tick"}, config, at(time));
    assert.deepEqual(lightCommand("ON", style!.values!, style!.transitionSeconds),
      {state: "ON", brightness, color_temp: colorTemp, transition: 45}, `${time} sleeping ${sleeping}`);
  }
});

test("a style lasts three intervals, and only switching circadian on (even when already on) takes back what a person set", () => {
  const tick = transitionCircadian(undefined, {kind: "tick"}, config, at("12:00"));
  assert.equal(tick.style?.until, new Date(at("12:00").getTime() + 180_000).toISOString());
  assert.equal(tick.style?.takeBack, undefined);
  assert.equal(tick.style?.source, "circadian");

  const off = transitionCircadian(tick.state, {kind: "circadian", enabled: false}, config, at("12:01"));
  assert.deepEqual([off.style?.values, off.style?.takeBack, off.stateChanged], [null, undefined, true]);
  // While off, each tick says so again, so a room that missed it stops styling too.
  assert.equal(transitionCircadian(off.state, {kind: "tick"}, config, at("12:02")).style?.values, null);
  // Sleep and times change while off, with nothing to style.
  assert.equal(transitionCircadian(off.state, {kind: "sleep", enabled: true}, config, at("12:03")).style, null);

  const on = transitionCircadian(off.state, {kind: "circadian", enabled: true}, config, at("12:04"));
  assert.equal(on.style?.takeBack, true);
  assert.ok(on.style?.values);
  // Already on, switched on again (a flow bringing lights back into step): it takes back again, as 5.x did.
  const again = transitionCircadian(on.state, {kind: "circadian", enabled: true}, config, at("12:05"));
  assert.deepEqual([again.style?.takeBack, again.stateChanged, again.traces.map(({outcome}) => outcome)], [true, false, ["unchanged"]]);
  // Already off, switched off again: nothing to send.
  assert.equal(transitionCircadian(off.state, {kind: "circadian", enabled: false}, config, at("12:06")).style, null);
});

test("sleep and new times send a style at once; enables take only true or false", () => {
  const sleep = transitionCircadian(undefined, {kind: "sleep", enabled: true}, config, at("12:00"));
  assert.deepEqual([sleep.state.sleeping, Math.round(sleep.style!.values!.brightnessPct)], [true, 2]);
  const times = transitionCircadian(undefined, {kind: "schedule", wakeTime: "11:30"}, config, at("12:00"));
  assert.deepEqual(times.state.schedule, {wakeTime: "11:30", bedTime: "00:30"});
  assert.ok(times.style!.values!.brightnessPct < 90, "still rising after the later wake time");
  assert.deepEqual(transitionCircadian(undefined, {kind: "schedule", wakeTime: "25:00"}, config, at("12:00")).traces.map(({reason}) => reason), ["invalid-times"]);
  for (const kind of ["circadian", "sleep"]) {
    for (const enabled of ["on", "OFF", 1, null]) {
      const refused = transitionCircadian(undefined, {kind, enabled}, config, at("12:00"));
      assert.deepEqual([refused.style, refused.stateChanged, refused.traces.map(({reason}) => reason)], [null, false, ["not-true-or-false"]]);
      assert.deepEqual([refused.state.enabled, refused.state.sleeping], [true, false]);
    }
  }
});

test("a time set at runtime lasts until the setting changes; following a house, the times are the house's", () => {
  const changed = transitionCircadian(undefined, {kind: "schedule", bedTime: "22:00"}, config, at("12:00")).state;
  assert.deepEqual(createCircadianState(config, changed).schedule, {wakeTime: "06:30", bedTime: "22:00"});
  const redeployed = {...config, schedule: resolveSchedule("06:30", "23:00")};
  assert.deepEqual(createCircadianState(redeployed, changed).schedule, {wakeTime: "06:30", bedTime: "23:00"});

  const house = {...config, timesFrom: "house" as const};
  const followed = transitionCircadian(undefined, {kind: "schedule", wakeTime: "08:00", bedTime: "22:30"}, house, at("12:00")).state;
  assert.deepEqual(createCircadianState(house, followed).schedule, {wakeTime: "08:00", bedTime: "22:30"});
  assert.equal(createCircadianState(config, {}).sleeping, false);
  assert.equal(createCircadianState({...config, initialSleep: true}, {}).sleeping, true);
});

const publishing: CircadianPublishingConfig = {
  area: "Living Room", publishState: true, discovery: true, discoveryPrefix: "homeassistant", nodeId: "c1", idScheme: "node", timesFrom: "own"
};

test("its entities keep the room's topics, are named after the node, and come after the old room entries are cleared, in one batch", () => {
  const state = createCircadianState(config, {});
  // Two rooms in the flows with this area, named after their nodes.
  const starting = circadianStartingOutputs(publishing, state, ["r1", "r2"]);
  const clears = starting.filter(({payload}) => payload === "").map(({topic}) => topic);
  const old = roomCircadianDiscoveryTopics(publishing);
  assert.deepEqual(old, [
    "homeassistant/switch/living_room_circadian_lighting/config",
    "homeassistant/switch/living_room_sleep/config",
    "homeassistant/time/living_room_wake_time/config",
    "homeassistant/time/living_room_bed_time/config"
  ]);
  assert.deepEqual(clears, [...old, ...roomCircadianDiscoveryTopics(publishing, "node", "r1"), ...roomCircadianDiscoveryTopics(publishing, "node", "r2")]);
  assert.ok(clears.includes("homeassistant/switch/nrha_r2_circadian_lighting/config"));
  // Every clear comes before anything it publishes.
  assert.equal(starting.findIndex(({payload}) => payload !== ""), clears.length, "the old entries first");
  const own = starting.slice(clears.length).filter(({topic}) => topic.endsWith("/config")).map(({topic, payload}) => [topic, JSON.parse(payload) as Record<string, unknown>] as const);
  assert.deepEqual(own.map(([topic]) => topic), [
    "homeassistant/switch/nrha_c1_circadian_lighting/config",
    "homeassistant/switch/nrha_c1_sleep/config",
    "homeassistant/time/nrha_c1_wake_time/config",
    "homeassistant/time/nrha_c1_bed_time/config"
  ]);
  // The same entity IDs as the room's, once the old entries are gone.
  const entityIds = [["switch", "circadian_lighting"], ["switch", "sleep"], ["time", "wake_time"], ["time", "bed_time"]]
    .map(([component, entity]) => `${component}.${"living_room"}_${entity}`);
  assert.deepEqual(own.map(([, entry]) => entry.default_entity_id), entityIds);
  assert.equal(own[0]![1].command_topic, "home/living_room/circadian/set");
  assert.equal(own[0]![1].availability_topic, "home/living_room/circadian/availability");
  assert.deepEqual(starting.slice(clears.length + 4).map(({topic, payload}) => [topic, payload]), [
    ["home/living_room/circadian/availability", "online"],
    ["home/living_room/circadian/state", "ON"],
    ["home/living_room/sleep/state", "OFF"],
    ["home/living_room/wake-time/state", "06:30:00"],
    ["home/living_room/bed-time/state", "00:30:00"]
  ]);

  // Discovery off: nothing cleared, nothing announced.
  assert.ok(!circadianStartingOutputs({...publishing, discovery: false}, state, ["r1"]).some(({topic}) => topic.endsWith("/config")));
  assert.deepEqual(circadianStartingOutputs({...publishing, publishState: false, discovery: false}, state), []);
});

test("following a house, it has no time entities or time state, and clears its own", () => {
  const house = {...publishing, timesFrom: "house" as const};
  const starting = circadianStartingOutputs(house, createCircadianState({...config, timesFrom: "house"}, {}));
  const cleared = starting.filter(({payload}) => payload === "").map(({topic}) => topic);
  assert.deepEqual(cleared.slice(4), ["homeassistant/time/nrha_c1_wake_time/config", "homeassistant/time/nrha_c1_bed_time/config"]);
  assert.ok(!starting.some(({topic, payload}) => /time/.test(topic) && payload !== ""));
  assert.ok(!circadianRetainedTopics(house).some((topic) => /(wake|bed)-time/.test(topic)));
  assert.deepEqual(circadianStateTopics("den"), ["home/den/circadian/state", "home/den/sleep/state", "home/den/wake-time/state", "home/den/bed-time/state"]);
});

test("Home Assistant's set topics become its events; retained and unreadable ones are ignored", () => {
  const set = (topic: string, payload: unknown, retain = false) => circadianInbound({topic: `home/living_room/${topic}`, payload, retain}, publishing);
  assert.deepEqual(set("circadian/set", "off")?.event, {kind: "circadian", enabled: false});
  assert.deepEqual(set("sleep/set", "ON")?.event, {kind: "sleep", enabled: true});
  assert.deepEqual(set("wake-time/set", "06:15:00")?.event, {kind: "schedule", wakeTime: "06:15"});
  assert.deepEqual(set("sleep/set", "maybe")?.traces.map(({reason}) => reason), ["not-on-or-off"]);
  assert.deepEqual(set("bed-time/set", "late")?.traces.map(({reason}) => reason), ["not-a-time"]);
  assert.deepEqual(set("circadian/set", "ON", true)?.traces.map(({reason}) => reason), ["retained-message"]);
  assert.equal(circadianInbound({topic: "home/living_room/wake-time/set", payload: "06:00"}, {...publishing, timesFrom: "house"}), null);
  assert.equal(circadianInbound({topic: "home/living_room/circadian/set", payload: "ON"}, {...publishing, publishState: false}), null);
  assert.equal(circadianInbound({topic: "elsewhere", payload: "ON"}, publishing), null);
});
