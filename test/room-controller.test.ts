"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {transitionMotion} from "../lib/motion-policy";
import {transitionSwitchPolicy} from "../lib/switch-policy";
import {scheduledLighting} from "../lib/circadian";
import {DEFAULT_BED_TIME, DEFAULT_WAKE_TIME, resolveSchedule, scheduleLevel} from "../lib/circadian-schedule";
import type {LightLevels} from "../lib/light-styling";
import {
  adaptivePayload,
  type RoomConfig,
  type RoomOutput,
  type RoomState
} from "../lib/room-controller";
import {publishRoom, type RoomPublishingConfig} from "../lib/room-publishing";

const levels: LightLevels = {
  maxBrightnessPct: 100,
  maxColorTempKelvin: 5500,
  sleepBrightnessPct: 1,
  sleepColorTempKelvin: 1000
};
const config: RoomConfig = {
  area: "kitchen",
  displayName: "Kitchen",
  targets: [
    {id: "cooking", stateTopic: "home/kitchen/light/group/cooking", commandTopic: "home/kitchen/light/group/cooking/set"},
    {id: "dining", stateTopic: "home/kitchen/light/group/dining", commandTopic: "home/kitchen/light/group/dining/set"}
  ],
  initialTransitionSeconds: 1,
  refreshTransitionSeconds: 45,
  initialSleep: false,
  lighting: scheduledLighting(resolveSchedule(), levels)
};
// The room on a given wake and bed schedule.
const onSchedule = (wakeTime: string, bedTime: string): RoomConfig =>
  ({...config, lighting: scheduledLighting({wakeTime, bedTime}, levels)});
// Local noon, so the default schedule is in its daytime in any timezone.
const now = new Date(2026, 5, 21, 12, 0);

function output(result: ReturnType<typeof publishRoom>, index: number): RoomOutput {
  const entry = result.outputs[index];
  assert.ok(entry);
  return entry;
}

function payload(result: ReturnType<typeof publishRoom>, index: number): Record<string, unknown> {
  const value = output(result, index).payload;
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("intent emits adaptive commands and records command ownership", () => {
  const result = publishRoom(undefined, {
    lighting: {kind: "intent", targets: ["cooking", "dining"], state: "ON", source: "motion"}
  }, config, now);

  assert.equal(result.outputs.length, 2);
  assert.equal(output(result, 0).topic, "home/kitchen/light/group/cooking/set");
  assert.equal(payload(result, 0).state, "ON");
  assert.equal(payload(result, 0).transition, 1);
  assert.equal(output(result, 0).lighting_command?.source, "motion");
  assert.equal(result.traces[0]?.event, "intent");
  assert.equal(result.traces[0]?.outcome, "commanded");
});

test("own command echo is ignored while external values create a manual override", () => {
  const commanded = publishRoom(undefined, {
    lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}
  }, config, now);
  const ownPayload = output(commanded, 0).payload;
  const ownEcho = publishRoom(commanded.state, {
    topic: "home/kitchen/light/group/cooking/set",
    payload: ownPayload,
    lighting: {kind: "command-observed", target: "cooking"}
  }, config, new Date(now.getTime() + 100));
  assert.equal(ownEcho.state.control.cooking, undefined);

  const external = publishRoom(ownEcho.state, {
    topic: "home/kitchen/light/group/cooking/set",
    payload: {state: "ON", brightness: 100},
    lighting: {kind: "command-observed", target: "cooking"}
  }, config, new Date(now.getTime() + 200));
  assert.equal(external.state.control.cooking?.state, "manual");

  const refresh = publishRoom(external.state, {lighting: {kind: "refresh"}}, config, new Date(now.getTime() + 300));
  assert.equal(refresh.outputs.length, 0);
});

test("OFF clears manual state and TOGGLE resolves from desired state", () => {
  const initial = publishRoom(undefined, {
    lighting: {
      kind: "intent",
      targets: ["cooking"],
      state: "ON",
      source: "wall",
      manual: true,
      values: {brightnessPct: 100}
    }
  }, config, now);
  assert.equal(initial.state.control.cooking?.state, "manual");

  const toggle = publishRoom(initial.state, {
    lighting: {kind: "intent", targets: ["cooking"], state: "TOGGLE", source: "wall"}
  }, config, new Date(now.getTime() + 100));
  assert.equal(payload(toggle, 0).state, "OFF");
  assert.equal(toggle.state.control.cooking, undefined);
});

test("activity styling preserves manual and occupancy power ownership", () => {
  let result = publishRoom(undefined, {
    lighting: {
      kind: "intent",
      targets: ["cooking"],
      state: "ON",
      source: "wall",
      manual: true,
      values: {brightnessPct: 100}
    }
  }, config, now);
  result.state.desired.dining = false;

  result = publishRoom(result.state, {
    lighting: {
      kind: "intent",
      targets: ["cooking", "dining"],
      state: "ON",
      source: "activity",
      values: {brightnessPct: 25},
      updateOnOnly: true,
      preserveManual: true
    }
  }, config, new Date(now.getTime() + 100));
  assert.equal(result.outputs.length, 0);
  assert.equal(result.state.control.cooking?.state, "manual");
  assert.equal(result.state.desired.dining, false);

  delete result.state.control.cooking;
  result = publishRoom(result.state, {
    lighting: {
      kind: "intent",
      targets: ["cooking"],
      state: "ON",
      source: "activity",
      values: {brightnessPct: 25},
      updateOnOnly: true,
      preserveManual: true
    }
  }, config, new Date(now.getTime() + 200));
  assert.equal(payload(result, 0).brightness, 64);
  assert.equal(result.state.control.cooking, undefined);
});

test("off-only intents preserve active lights while applying a bedtime level to inactive targets", () => {
  const state = publishRoom(undefined, {
    lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "wall"}
  }, config, now).state;

  const result = publishRoom(state, {
    lighting: {
      kind: "intent",
      targets: ["cooking", "dining"],
      state: "ON",
      source: "bedtime",
      values: {brightnessPct: 15.7},
      updateOffOnly: true,
      manual: true
    }
  }, config, new Date(now.getTime() + 100));

  assert.equal(result.outputs.length, 2);
  assert.equal(output(result, 0).lighting_command?.target, "dining");
  assert.equal(payload(result, 0).brightness, 40);
  assert.equal(output(result, 1).topic, "home/kitchen/lighting/dining/control");
  assert.equal(result.state.control.cooking, undefined);
  assert.equal(result.state.control.dining?.state, "manual");
});

test("startup publishes stable discovery and state messages", () => {
  const result = publishRoom(undefined, {lighting: {kind: "startup"}}, config, now);
  assert.deepEqual(result.outputs.slice(0, 6).map(({topic}) => topic), [
    "homeassistant/switch/kitchen_circadian_lighting/config",
    "homeassistant/switch/kitchen_sleep/config",
    "homeassistant/time/kitchen_wake_time/config",
    "homeassistant/time/kitchen_bed_time/config",
    "homeassistant/sensor/kitchen_cooking_control/config",
    "homeassistant/sensor/kitchen_dining_control/config"
  ]);
  assert.ok(result.outputs.slice(0, 6).every(({retain}) => retain));
  assert.deepEqual(result.outputs.slice(6, 11), [
    {topic: "home/kitchen/lighting/availability", payload: "online", retain: true},
    {topic: "home/kitchen/circadian/state", payload: "ON", retain: true},
    {topic: "home/kitchen/sleep/state", payload: "OFF", retain: true},
    {topic: "home/kitchen/wake-time/state", payload: "07:00:00", retain: true},
    {topic: "home/kitchen/bed-time/state", payload: "23:00:00", retain: true}
  ]);
  assert.deepEqual(result.outputs.slice(11), [
    {topic: "home/kitchen/lighting/cooking/control", payload: {state: "in-control", owner: null}, retain: true},
    {topic: "home/kitchen/lighting/dining/control", payload: {state: "in-control", owner: null}, retain: true}
  ]);
});

const later = (ms: number): Date => new Date(now.getTime() + ms);

function observeState(state: Parameters<typeof publishRoom>[0], on: boolean, ms: number) {
  return publishRoom(state, {
    topic: "home/kitchen/light/group/cooking",
    payload: {state: on ? "ON" : "OFF", brightness: on ? 254 : null},
    lighting: {kind: "observed"}
  }, config, later(ms));
}

test("a light switched off at the bulb is not switched back on by the periodic refresh", () => {
  let result = publishRoom(undefined, {
    lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}
  }, config, now);
  result = observeState(result.state, true, 200);
  result = observeState(result.state, false, 60000);
  assert.equal(result.state.desired.cooking, false);
  result = publishRoom(result.state, {lighting: {kind: "refresh"}}, config, later(90000));
  assert.equal(result.outputs.length, 0);
});

test("a light switched on at the bulb is switched off by the next toggle", () => {
  let result = observeState(undefined, false, 0);
  result = publishRoom(result.state, {
    lighting: {kind: "intent", targets: ["cooking"], state: "OFF", source: "wall"}
  }, config, later(100));
  result = observeState(result.state, false, 300);
  result = observeState(result.state, true, 60000);
  assert.equal(result.state.desired.cooking, true);
  result = publishRoom(result.state, {
    lighting: {kind: "intent", targets: ["cooking"], state: "TOGGLE", source: "wall"}
  }, config, later(61000));
  assert.equal(payload(result, 0).state, "OFF");
});

test("a stale state report does not undo the controller's own command in flight", () => {
  let result = observeState(undefined, false, 0);
  result = publishRoom(result.state, {
    lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}
  }, config, later(1000));
  const ownPayload = output(result, 0).payload;
  // The command topic echo arrives before the bulb's stale report.
  result = publishRoom(result.state, {
    topic: "home/kitchen/light/group/cooking/set",
    payload: ownPayload,
    lighting: {kind: "command-observed", target: "cooking"}
  }, config, later(1050));
  result = observeState(result.state, false, 1100);
  assert.equal(result.state.desired.cooking, true);
  assert.equal(result.traces.at(-1)?.reason, "stale-report");

  result = observeState(result.state, true, 1400);
  assert.equal(result.state.desired.cooking, true);
  // Once confirmed, a later OFF is a real external change.
  result = observeState(result.state, false, 2000);
  assert.equal(result.state.desired.cooking, false);
});

test("an own command echo seen twice in the echo window is ours; after it, someone else's", () => {
  let result = publishRoom(undefined, {
    lighting: {kind: "intent", targets: ["cooking"], state: "OFF", source: "wall"}
  }, config, now);
  const echo = {topic: "home/kitchen/light/group/cooking/set", payload: {state: "OFF"}, lighting: {kind: "command-observed", target: "cooking"}};
  result = publishRoom(result.state, echo, config, later(100));
  assert.equal(result.traces.length, 0);
  result = publishRoom(result.state, echo, config, later(200));
  assert.equal(result.traces.length, 0, "a repeat of our own echo");
  result = publishRoom(result.state, echo, config, later(6000));
  assert.equal(result.traces.at(-1)?.event, "external-command");
});

test("restored state with expected entries from before in-flight tracking adopts observations", () => {
  const saved = {
    desired: {cooking: true},
    expected: {cooking: [{fingerprint: "{\"state\":\"ON\"}", expires: later(5000).getTime()}]}
  };
  let result = observeState(saved, false, 1000);
  assert.equal(result.state.desired.cooking, false);
  result = publishRoom(result.state, {lighting: {kind: "refresh"}}, config, later(90000));
  assert.equal(result.outputs.length, 0);
});

test("the reducer does not mutate the saved state it is given", () => {
  let result = observeState(undefined, false, 0);
  result = publishRoom(result.state, {
    lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}
  }, config, later(1000));
  const ownPayload = output(result, 0).payload;
  const beforeEcho = structuredClone(result.state);
  const echoed = publishRoom(result.state, {
    topic: "home/kitchen/light/group/cooking/set",
    payload: ownPayload,
    lighting: {kind: "command-observed", target: "cooking"}
  }, config, later(1050));
  assert.deepEqual(result.state, beforeEcho);

  const beforeReport = structuredClone(echoed.state);
  observeState(echoed.state, true, 1400);
  assert.deepEqual(echoed.state, beforeReport);
});

const later2 = (ms: number): Date => new Date(now.getTime() + ms);

function controlOutputs(result: ReturnType<typeof publishRoom>) {
  return result.outputs.filter((entry) => entry.topic.endsWith("/control")).map((entry) => [entry.topic, entry.payload]);
}

function ownedActivity(state: Parameters<typeof publishRoom>[0], ms: number) {
  return publishRoom(state, {
    lighting: {
      kind: "intent",
      targets: ["cooking"],
      state: "ON",
      source: "activity",
      owner: "theatre",
      values: {brightnessPct: 25, colorTempKelvin: 2500},
      preserveManual: true
    }
  }, config, later2(ms));
}

test("an overridden light keeps its owner's style through the periodic refresh", () => {
  // dev-review repro: activity {brightness 64, color_temp 400} became circadian {254, 439}.
  let result = publishRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, now);
  result = ownedActivity(result.state, 1000);
  assert.equal(payload(result, 0).brightness, 64);
  assert.deepEqual(result.state.control.cooking, {state: "overridden", owner: "theatre"});
  assert.equal(result.status.control.cooking, "overridden");
  assert.equal(result.status.overriddenCount, 1);
  assert.deepEqual(controlOutputs(result), [["home/kitchen/lighting/cooking/control", {state: "overridden", owner: "theatre"}]]);
  assert.equal(result.traces.some((entry) => entry.event === "control" && entry.reason === "owner-intent"), true);

  result = publishRoom(result.state, {lighting: {kind: "refresh"}}, config, later2(90000));
  assert.equal(result.outputs.length, 0);
  // A later owner-less ON (motion) is ignored for the held light.
  result = publishRoom(result.state, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, later2(91000));
  assert.equal(result.outputs.length, 0);
  assert.equal(result.status.control.cooking, "overridden");
});

test("releasing an overridden light restyles it and refresh resumes", () => {
  let result = publishRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, now);
  result = ownedActivity(result.state, 1000);
  // Another owner's release does not touch it.
  result = publishRoom(result.state, {lighting: {kind: "release", owner: "scene"}}, config, later2(2000));
  assert.equal(result.outputs.length, 0);
  assert.equal(result.status.control.cooking, "overridden");

  result = publishRoom(result.state, {lighting: {kind: "release", targets: ["cooking"], owner: "theatre"}}, config, later2(3000));
  assert.equal(result.status.control.cooking, "in-control");
  assert.equal(result.outputs[0]?.lighting_command?.source, "release");
  assert.equal(payload(result, 0).brightness, 254);
  assert.equal(payload(result, 0).transition, 45);
  assert.deepEqual(controlOutputs(result), [["home/kitchen/lighting/cooking/control", {state: "in-control", owner: null}]]);

  result = publishRoom(result.state, {lighting: {kind: "refresh"}}, config, later2(90000));
  assert.equal(result.outputs.length, 1);
  assert.equal(payload(result, 0).brightness, 254);
});

test("only the owner switching a held light off returns it to the room controller", () => {
  let result = publishRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, now);
  result = ownedActivity(result.state, 1000);
  result = publishRoom(result.state, {lighting: {kind: "intent", targets: ["cooking"], state: "OFF", source: "activity", owner: "theatre"}}, config, later2(2000));
  assert.equal(payload(result, 0).state, "OFF");
  assert.equal(result.status.control.cooking, "in-control");
  assert.equal(result.traces.some((entry) => entry.event === "control" && entry.reason === "off"), true);

  result = publishRoom(result.state, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, later2(60000));
  assert.equal(payload(result, 0).brightness, 254);
});

test("a person's change on an overridden light makes it manual; enabling circadian keeps other owners", () => {
  let result = ownedActivity(undefined, 0);
  result = publishRoom(result.state, {
    lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "wall", manual: true, values: {brightnessPct: 100}}
  }, config, later2(1000));
  assert.equal(result.status.control.cooking, "manual");
  // An owner intent with preserveManual leaves a person's light alone.
  result = ownedActivity(result.state, 2000);
  assert.equal(result.outputs.length, 0);
  assert.equal(result.status.control.cooking, "manual");

  result = ownedActivity(undefined, 2000);
  result = publishRoom(result.state, {
    lighting: {kind: "intent", targets: ["dining"], state: "ON", source: "wall", manual: true, values: {brightnessPct: 39.4}}
  }, config, later2(3000));
  result = publishRoom(result.state, {lighting: {kind: "circadian", enabled: true}}, config, later2(4000));
  assert.equal(result.status.control.cooking, "overridden");
  assert.equal(result.status.control.dining, "in-control");
});

test("state saved before control states existed loads as manual or in-control", () => {
  const saved = {desired: {cooking: true, dining: true}, manual: {cooking: true, dining: false}};
  const result = publishRoom(saved as Parameters<typeof publishRoom>[0], {lighting: {kind: "refresh"}}, config, now);
  assert.deepEqual(result.status.control, {cooking: "manual", dining: "in-control"});
  assert.deepEqual(result.outputs.map((entry) => entry.lighting_command?.target), ["dining"]);
  assert.equal(Object.hasOwn(result.state, "manual"), false);
});

// The held-light rule: lamp held by "film".
const heldConfig: RoomConfig = {...config, targets: [
  {id: "lamp", stateTopic: "home/kitchen/light/lamp", commandTopic: "home/kitchen/light/lamp/set"},
  {id: "wall", stateTopic: "home/kitchen/light/wall", commandTopic: "home/kitchen/light/wall/set"}
]};

function heldLamp() {
  let result = publishRoom(undefined, {lighting: {kind: "intent", targets: ["lamp", "wall"], state: "ON", source: "motion"}}, heldConfig, now);
  result = publishRoom(result.state, {
    lighting: {kind: "intent", targets: ["lamp"], state: "ON", source: "activity", owner: "film", values: {brightnessPct: 12}}
  }, heldConfig, later2(1000));
  assert.equal(result.status.control.lamp, "overridden");
  return result;
}

function heldIntent(state: Parameters<typeof publishRoom>[0], lighting: Record<string, unknown>, ms = 2000) {
  return publishRoom(state, {lighting: {kind: "intent", targets: ["lamp"], ...lighting}}, heldConfig, later2(ms));
}

function ignoredHeld(result: ReturnType<typeof publishRoom>) {
  return result.traces.filter((entry) => entry.reason === "held-by").map((entry) => [entry.details.target, entry.details.owner]);
}

test("a held light ignores owner-less automation", () => {
  const held = heldLamp();
  for (const lighting of [
    {state: "ON", source: "motion"},
    {state: "OFF", source: "motion"},
    {state: "TOGGLE", source: "schedule"},
    {state: "ON", source: "bedtime", values: {brightnessPct: 15.7}},
    {state: "ON", source: "activity", values: {brightnessPct: 31.5}, updateOnOnly: true},
    {state: "ON", source: "bedtime", values: {brightnessPct: 2}, updateOffOnly: true}
  ]) {
    const result = heldIntent(held.state, lighting);
    assert.equal(result.outputs.length, 0, JSON.stringify(lighting));
    assert.deepEqual(result.state.control.lamp, {state: "overridden", owner: "film"});
    assert.deepEqual(ignoredHeld(result), [["lamp", "film"]]);
  }
});

test("a held light follows its owner, a newer owner, a person and a release", () => {
  const held = heldLamp();
  let result = heldIntent(held.state, {state: "ON", source: "activity", owner: "film", values: {brightnessPct: 8}});
  assert.equal(payload(result, 0).brightness, 20);

  result = heldIntent(held.state, {state: "ON", source: "scene", owner: "reading", values: {brightnessPct: 35.4}});
  assert.equal(payload(result, 0).brightness, 90);
  assert.deepEqual(result.state.control.lamp, {state: "overridden", owner: "reading"});

  result = heldIntent(held.state, {state: "ON", source: "wall", manual: true, values: {brightnessPct: 100}});
  assert.equal(payload(result, 0).brightness, 254);
  assert.equal(result.status.control.lamp, "manual");

  result = publishRoom(held.state, {lighting: {kind: "release", owner: "film"}}, heldConfig, later2(2000));
  assert.equal(result.status.control.lamp, "in-control");
  assert.equal(output(result, 0).lighting_command?.target, "lamp");
  assert.equal(payload(result, 0).brightness, 254);
});

test("a wall-switch press reaches a held light like any person", () => {
  // dev-review repro: a single press is an owner-less TOGGLE marked person: true.
  const held = heldLamp();
  const press = transitionSwitchPolicy(undefined, {source: "switch", payload: {state: true}}, {targets: ["lamp", "wall"], switchWindowMs: 500, switchFreshnessMs: 60000}, 0);
  const single = transitionSwitchPolicy(press.state, {source: "switch-timer", generation: press.state.wallInput.generation, switchAt: press.state.wallInput.edgeAt}, {targets: ["lamp", "wall"], switchWindowMs: 500, switchFreshnessMs: 60000}, 600);
  const sent = single.effects.find((effect) => effect.kind === "send");
  assert.ok(sent && sent.kind === "send");
  assert.equal(sent.message.lighting.person, true);
  const result = publishRoom(held.state, sent.message, heldConfig, later2(2000));
  assert.deepEqual(result.outputs.filter((entry) => entry.lighting_command).map((entry) => [entry.lighting_command?.target, (entry.payload as Record<string, unknown>).state]), [["lamp", "OFF"], ["wall", "OFF"]]);
  assert.equal(result.status.control.lamp, "in-control");
  assert.deepEqual(ignoredHeld(result), []);

  // The source alone is not a person.
  const unmarked = heldIntent(held.state, {state: "TOGGLE", source: "wall"});
  assert.deepEqual(ignoredHeld(unmarked), [["lamp", "film"]]);
});

test("switching a held light off at the bulb still frees it", () => {
  const held = heldLamp();
  // Confirm the owner's ON first, so the OFF report is a real external change.
  let result = publishRoom(held.state, {topic: "home/kitchen/light/lamp", payload: {state: "ON", brightness: 30}, lighting: {kind: "observed"}}, heldConfig, later2(1200));
  result = publishRoom(result.state, {topic: "home/kitchen/light/lamp", payload: {state: "OFF"}, lighting: {kind: "observed"}}, heldConfig, later2(60000));
  assert.equal(result.outputs.filter((entry) => entry.lighting_command).length, 0);
  assert.equal(result.status.control.lamp, "in-control");
  assert.equal(result.state.desired.lamp, false);
});

test("a mixed intent changes only the lights that are not held", () => {
  const held = heldLamp();
  const result = publishRoom(held.state, {lighting: {kind: "intent", targets: ["lamp", "wall"], state: "OFF", source: "motion"}}, heldConfig, later2(2000));
  assert.deepEqual(result.outputs.filter((entry) => entry.lighting_command).map((entry) => entry.lighting_command?.target), ["wall"]);
  assert.deepEqual(ignoredHeld(result), [["lamp", "film"]]);
  assert.equal(result.status.control.lamp, "overridden");
  assert.equal(result.state.desired.wall, false);
});

// Local wall-clock times, so the tests hold in any timezone.
const clock = (hours: number, minutes = 0) => new Date(2026, 10, 23, hours, minutes);

test("a wake and bed schedule shapes the circadian day", () => {
  const level = (hours: number, minutes = 0) => scheduleLevel(clock(hours, minutes), "07:00", "23:00");
  assert.equal(level(6, 59), 0);
  assert.equal(level(7), 0);
  assert.equal(level(7, 30), 0.5);
  assert.equal(level(8), 1);
  assert.equal(level(13), 1);
  assert.equal(level(20), 1);
  assert.equal(level(21, 30), 0.5);
  assert.equal(level(23), 0);
  assert.equal(level(3), 0);
  // Never a step: neighbouring minutes stay close all day.
  let previous = level(0);
  for (let minute = 1; minute < 24 * 60; minute += 1) {
    const current = level(Math.floor(minute / 60), minute % 60);
    assert.ok(Math.abs(current - previous) <= 0.03, `${minute} min`);
    previous = current;
  }

  const scheduled = onSchedule("07:00", "23:00");
  const day = adaptivePayload("ON", false, false, clock(13), scheduled);
  assert.equal(day.brightness, 254);
  assert.equal(day.color_temp, Math.round(1_000_000 / levels.maxColorTempKelvin));
  const night = adaptivePayload("ON", false, false, clock(3), scheduled);
  assert.equal(night.brightness, Math.round(levels.sleepBrightnessPct * 254 / 100) || 1);
  assert.equal(night.color_temp, Math.round(1_000_000 / levels.sleepColorTempKelvin));
  // Sleep mode still overrides the schedule.
  assert.deepEqual(adaptivePayload("ON", false, true, clock(13), scheduled), night);
});

test("schedules may cross midnight or run through the night", () => {
  // Bed after midnight.
  assert.equal(scheduleLevel(clock(12), "09:00", "01:00"), 1);
  assert.ok(scheduleLevel(clock(0), "09:00", "01:00") > 0);
  assert.ok(scheduleLevel(clock(0), "09:00", "01:00") < 1);
  assert.equal(scheduleLevel(clock(2), "09:00", "01:00"), 0);
  // Awake through the night, asleep in the morning.
  assert.equal(scheduleLevel(clock(23), "15:00", "07:00"), 1);
  assert.equal(scheduleLevel(clock(10), "15:00", "07:00"), 0);
  // A short day shortens the rise and wind-down in proportion.
  assert.equal(scheduleLevel(clock(7, 30), "07:00", "09:00"), 1);
  assert.ok(scheduleLevel(clock(7, 15), "07:00", "09:00") > 0.4);
  assert.throws(() => scheduleLevel(clock(7), "07:00", "07:00"), /different/);
});

test("the room controller styles lights from the schedule", () => {
  const scheduled = onSchedule("07:00", "23:00");
  let result = publishRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, scheduled, clock(21, 30));
  assert.equal(payload(result, 0).brightness, 128);
  result = publishRoom(result.state, {lighting: {kind: "refresh"}}, scheduled, clock(23, 30));
  assert.equal(payload(result, 0).brightness, Math.round(levels.sleepBrightnessPct * 254 / 100) || 1);
});

test("without wake and bed times the default schedule applies", () => {
  for (const [hours, minutes] of [[3, 0], [7, 30], [13, 0], [21, 30], [23, 30]] as const) {
    const at = clock(hours, minutes);
    assert.deepEqual(
      adaptivePayload("ON", false, false, at, config),
      adaptivePayload("ON", false, false, at, onSchedule(DEFAULT_WAKE_TIME, DEFAULT_BED_TIME)),
      `${hours}:${minutes}`
    );
  }
  assert.equal(DEFAULT_WAKE_TIME, "07:00");
  assert.equal(DEFAULT_BED_TIME, "23:00");
  assert.equal(adaptivePayload("ON", false, false, clock(13), config).brightness, 254);
});

test("the room controller has no sun dependency left", () => {
  const {readFileSync} = require("node:fs") as typeof import("node:fs");
  const {resolve} = require("node:path") as typeof import("node:path");
  const source = readFileSync(resolve(__dirname, "../../lib/room-controller.ts"), "utf8");
  assert.equal(/suncalc|SunCalc|sunPosition|latitude|longitude/.test(source), false);
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));
  assert.equal(JSON.stringify(manifest).includes("suncalc"), false);
});

test("colour moves evenly in mireds with no kelvin rounding", () => {
  const scheduled = onSchedule("07:00", "23:00");
  const sleepMired = 1_000_000 / levels.sleepColorTempKelvin;
  const dayMired = 1_000_000 / levels.maxColorTempKelvin;
  // Half-way through the rise, the colour is half-way in mireds.
  assert.equal(adaptivePayload("ON", false, false, clock(7, 30), scheduled).color_temp, Math.round((sleepMired + dayMired) / 2));
});

test("a refresh skips lights already at their level and re-sends to one that is not", () => {
  const scheduled = onSchedule("07:00", "23:00");
  const report = (state: Parameters<typeof publishRoom>[0], level: Record<string, unknown>, at: Date) =>
    publishRoom(state, {topic: "home/kitchen/light/group/cooking", payload: {state: "ON", ...level}, lighting: {kind: "observed"}}, scheduled, at);
  let result = publishRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, scheduled, clock(13));
  const sent = payload(result, 0);
  result = report(result.state, {brightness: sent.brightness, color_temp: sent.color_temp}, clock(13, 0));

  // Flat daytime: the bulb already reports the level, so nothing is sent.
  const flat = publishRoom(result.state, {lighting: {kind: "refresh"}}, scheduled, clock(14));
  assert.equal(flat.outputs.filter((entry) => entry.lighting_command).length, 0);
  assert.equal(flat.traces.some((entry) => entry.reason === "already-at-level"), true);

  // A bulb that missed a command reports something else and gets it again.
  const missed = report(result.state, {brightness: 120, color_temp: sent.color_temp}, clock(14));
  const resent = publishRoom(missed.state, {lighting: {kind: "refresh"}}, scheduled, clock(14, 1));
  assert.equal(resent.outputs.filter((entry) => entry.lighting_command).length, 1);

  // During the wind-down the level moves, so the refresh sends.
  const ramp = publishRoom(result.state, {lighting: {kind: "refresh"}}, scheduled, clock(21, 30));
  assert.equal(ramp.outputs.filter((entry) => entry.lighting_command).length, 1);
  assert.notEqual(payload(ramp, 0).brightness, sent.brightness);
});

test("motion does not switch off a light a person set after the room went vacant", () => {
  // The old scenario, end to end: the light is on, the room goes vacant, a
  // person double-presses the wall switch, then the vacancy timer fires.
  const motionConfig = {onTargets: ["cooking"], offTargets: ["cooking"], defaultDelaySeconds: 30, defaultIlluminanceCutoff: 150};
  const switchConfig = {targets: ["cooking"], switchWindowMs: 500, switchFreshnessMs: 60000};
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const motionAt = (seconds: number) => at(seconds).getTime();
  const intents = (effects: Array<{kind: string; message?: {lighting: Record<string, unknown>}}>) =>
    effects.filter((effect) => effect.kind === "send").map((effect) => effect.message!.lighting);
  const room = (state: RoomState | undefined, lighting: Record<string, unknown>, seconds: number) =>
    publishRoom(state, {lighting}, config, at(seconds));
  const sentOff = (result: ReturnType<typeof publishRoom>) =>
    result.outputs.some((entry) => entry.lighting_command && (entry.payload as {state?: string}).state === "OFF");

  let roomResult = room(undefined, {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}, 0);
  let motion = transitionMotion(undefined, {source: "occupancy", payload: {occupied: false}}, motionConfig, true, motionAt(10));
  const edge = transitionSwitchPolicy(undefined, {source: "switch", payload: {state: true}}, switchConfig, motionAt(20));
  const double = transitionSwitchPolicy(edge.state, {source: "switch", payload: {state: false}}, switchConfig, motionAt(20.2));
  for (const lighting of intents(double.effects as never)) roomResult = room(roomResult.state as RoomState, lighting, 20.2);
  motion = transitionMotion(motion.state, {source: "off-timer", generation: motion.state.offTimerGeneration}, motionConfig, true, motionAt(40));
  const off = intents(motion.effects as never)[0]!;
  assert.equal(off.vacantSince, at(10).toISOString());
  const afterVacancy = room(roomResult.state as RoomState, off, 40);
  assert.equal(sentOff(afterVacancy), false, "the person's light stays on");
  assert.equal(afterVacancy.traces.some((entry) => entry.reason === "person-set-after-vacancy"), true);
  assert.equal(afterVacancy.state.desired.cooking, true);

  // A person's change before the room went vacant is not protected: the
  // vacancy that follows switches the light off, as before.
  const earlier = room(roomResult.state as RoomState, {...off, vacantSince: at(30).toISOString()}, 60);
  assert.equal(sentOff(earlier), true);
  // Nor is a light nobody touched.
  const untouched = room(undefined, {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}, 0);
  assert.equal(sentOff(room(untouched.state, off, 40)), true);
});

test("someone else's command counts as a person's change for the vacancy rule", () => {
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  let result = publishRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, at(0));
  result = publishRoom(result.state, {topic: "home/kitchen/light/group/cooking/set", payload: {state: "ON", brightness: 40}, lighting: {kind: "command-observed"}}, config, at(20));
  const off = publishRoom(result.state, {lighting: {kind: "intent", targets: ["cooking"], state: "OFF", source: "motion", vacantSince: at(10).toISOString()}}, config, at(40));
  assert.equal(off.outputs.some((entry) => entry.lighting_command), false);
});

test("state reports are traced as confirming our command, stale, or someone else's change", () => {
  const report = (state: RoomState, on: boolean, ms: number) =>
    publishRoom(state, {topic: "home/kitchen/light/group/cooking", payload: {state: on ? "ON" : "OFF"}, lighting: {kind: "observed"}}, config, new Date(now.getTime() + ms));
  const traced = (result: ReturnType<typeof publishRoom>) =>
    result.traces.filter((entry) => entry.event === "state-observed" && entry.outcome !== "changed").map((entry) => [entry.outcome, entry.reason]);
  const sent = publishRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, now);

  const stale = report(sent.state as RoomState, false, 100);
  assert.deepEqual(traced(stale), [["ignored", "stale-report"]]);
  assert.equal(stale.state.desired.cooking, true, "a stale report doesn't change the intended state");

  const confirmed = report(sent.state as RoomState, true, 100);
  assert.deepEqual(traced(confirmed), [["confirmed", "own-command"]]);
  assert.equal(confirmed.state.desired.cooking, true);

  const external = report(confirmed.state as RoomState, false, 200);
  assert.deepEqual(traced(external), []);
  assert.equal(external.state.desired.cooking, false, "someone else's change becomes the intended state");
});

test("a confirmed OFF leaves control as the OFF intent set it", () => {
  // A person set values, so the light is manual; our OFF intent returns it to
  // in-control. The confirming report changes nothing more.
  let result = publishRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "wall", manual: true, values: {brightnessPct: 31.5}}}, config, now);
  assert.equal(result.state.control.cooking?.state, "manual");
  result = publishRoom(result.state, {lighting: {kind: "intent", targets: ["cooking"], state: "OFF", source: "wall"}}, config, new Date(now.getTime() + 100));
  assert.equal(result.state.control.cooking, undefined);
  const controlBefore = JSON.stringify(result.state.control);
  const confirmed = publishRoom(result.state, {topic: "home/kitchen/light/group/cooking", payload: {state: "OFF"}, lighting: {kind: "observed"}}, config, new Date(now.getTime() + 200));
  assert.equal(confirmed.traces.some((entry) => entry.outcome === "confirmed" && entry.reason === "own-command"), true);
  assert.equal(JSON.stringify(confirmed.state.control), controlBefore);
  assert.equal(confirmed.outputs.some((entry) => entry.topic.endsWith("/control")), false, "no control change is published");
});

test("publish settings: state and discovery each switch on and off, and unset means on", () => {
  const startupTopics = (settings: Partial<RoomConfig & RoomPublishingConfig>) =>
    publishRoom(undefined, {lighting: {kind: "startup"}}, {...config, ...settings}, now).outputs.map(({topic, payload}) => [topic, payload]);
  const discoveryTopic = "homeassistant/switch/kitchen_circadian_lighting/config";
  const controlTopic = "home/kitchen/lighting/cooking/control";

  // Unset (a saved flow from before the settings): both on, as before.
  const legacy = startupTopics({});
  assert.ok(legacy.some(([topic, payload]) => topic === discoveryTopic && typeof payload === "object"));
  assert.ok(legacy.some(([topic]) => topic === controlTopic));
  assert.ok(legacy.some(([topic]) => topic === "home/kitchen/circadian/state"));

  // State on, discovery off: the state is published, and the switch is
  // removed from Home Assistant with an empty retained entry.
  const stateOnly = startupTopics({publishState: true, discovery: false});
  assert.ok(stateOnly.some(([topic]) => topic === controlTopic));
  assert.deepEqual(stateOnly.filter(([topic]) => topic === discoveryTopic), [[discoveryTopic, ""]]);

  // Discovery needs the state: with state off, nothing named after the area
  // is published, and the discovery entry is cleared.
  const off = startupTopics({publishState: false, discovery: true});
  assert.deepEqual(off.map(([, payload]) => payload), ["", "", "", "", "", ""], "every entry cleared");
  assert.deepEqual(off[0], [discoveryTopic, ""]);
  assert.deepEqual(startupTopics({publishState: false, discovery: false}), off);

  // Circadian changes publish their state only with state on.
  const circadian = (settings: Partial<RoomConfig & RoomPublishingConfig>) =>
    publishRoom(undefined, {lighting: {kind: "circadian", enabled: false}}, {...config, ...settings}, now).outputs.map(({topic}) => topic);
  assert.deepEqual(circadian({publishState: true}), ["home/kitchen/circadian/state"]);
  assert.deepEqual(circadian({publishState: false}), []);
});

test("the circadian set topic switches circadian lighting on and off", () => {
  const set = (state: RoomState | undefined, payload: unknown, extra: Record<string, unknown> = {}, settings: Partial<RoomConfig & RoomPublishingConfig> = {}) =>
    publishRoom(state, {topic: "home/kitchen/circadian/set", payload, ...extra}, {...config, ...settings}, now);
  const lit = publishRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, now).state as RoomState;

  const off = set(lit, "OFF");
  assert.equal(off.state.circadianEnabled, false);
  assert.deepEqual(off.outputs.map(({topic, payload}) => [topic, payload]), [["home/kitchen/circadian/state", "OFF"]]);
  const on = set(off.state as RoomState, " on ");
  assert.equal(on.state.circadianEnabled, true, "case and spaces don't matter");
  // A flow may tag MQTT messages as observed; the set topic still counts.
  assert.equal(set(lit, "off", {lighting: {kind: "command-observed"}}).state.circadianEnabled, false);

  for (const [label, result] of [
    ["junk", set(lit, "maybe")],
    ["a retained message", set(lit, "OFF", {retain: true})],
    ["no area", set(lit, "OFF", {}, {area: ""})],
    ["publishing off", set(lit, "OFF", {}, {publishState: false})]
  ] as const) {
    assert.equal(result.state.circadianEnabled, true, label);
    assert.deepEqual(result.outputs, [], label);
  }
  assert.deepEqual(set(lit, "maybe").traces.map(({event, outcome, reason}) => [event, outcome, reason]), [["circadian-set", "ignored", "not-on-or-off"]]);
  assert.deepEqual(set(lit, "OFF", {retain: true}).traces.map(({reason}) => reason), ["retained-message"]);
});

test("an area that isn't an identifier publishes under its ID, and keeps its name for people", () => {
  const living = {...config, area: "Living Room", displayName: "Living Room"};
  const startup = publishRoom(undefined, {lighting: {kind: "startup"}}, living, now);
  assert.deepEqual(startup.outputs.map(({topic}) => topic), [
    "homeassistant/switch/living_room_circadian_lighting/config",
    "homeassistant/switch/living_room_sleep/config",
    "homeassistant/time/living_room_wake_time/config",
    "homeassistant/time/living_room_bed_time/config",
    "homeassistant/sensor/living_room_cooking_control/config",
    "homeassistant/sensor/living_room_dining_control/config",
    "home/living_room/lighting/availability",
    "home/living_room/circadian/state",
    "home/living_room/sleep/state",
    "home/living_room/wake-time/state",
    "home/living_room/bed-time/state",
    "home/living_room/lighting/cooking/control",
    "home/living_room/lighting/dining/control"
  ]);
  const entry = startup.outputs[0]!.payload as Record<string, unknown>;
  assert.equal(entry.unique_id, "living_room_circadian_lighting");
  assert.equal(entry.default_entity_id, ["switch", "living_room_circadian_lighting"].join("."));
  assert.equal(entry.name, "Living Room Circadian Lighting");
  assert.deepEqual((entry.device as {identifiers: string[]}).identifiers, ["nodered_living_room_lighting"]);
  // The set topic is matched under the ID too.
  const off = publishRoom(startup.state, {topic: "home/living_room/circadian/set", payload: "OFF"}, living, now);
  assert.equal(off.state.circadianEnabled, false);
});

test("wake and bed times from Home Assistant change the schedule, restyle lit lights and are published back", () => {
  // 06:30 local: before the default 07:00 wake, so the room is still at night level.
  const early = new Date(2026, 5, 21, 6, 30);
  const lit = publishRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, early);
  const nightBrightness = (lit.outputs.find(({lighting_command}) => lighting_command)!.payload as {brightness: number}).brightness;

  const changed = publishRoom(lit.state, {topic: "home/kitchen/wake-time/set", payload: "05:30:00"}, config, early);
  assert.deepEqual(changed.state.schedule, {wakeTime: "05:30", bedTime: "23:00"});
  assert.deepEqual(changed.outputs.slice(0, 2), [
    {topic: "home/kitchen/wake-time/state", payload: "05:30:00", retain: true},
    {topic: "home/kitchen/bed-time/state", payload: "23:00:00", retain: true}
  ]);
  const restyled = changed.outputs.find(({lighting_command}) => lighting_command?.target === "cooking");
  assert.ok(restyled, "the lit light is restyled for the new schedule");
  assert.ok((restyled.payload as {brightness: number}).brightness > nightBrightness, "an hour after the new wake time, brighter");
  assert.deepEqual(changed.traces.find(({event}) => event === "schedule"), {
    event: "schedule", outcome: "changed", reason: null, details: {wakeTime: "05:30", bedTime: "23:00"}
  });

  // "HH:MM" works too; junk, a retained message and equal times change nothing.
  assert.deepEqual(publishRoom(lit.state, {topic: "home/kitchen/bed-time/set", payload: "22:15"}, config, early).state.schedule,
    {wakeTime: "07:00", bedTime: "22:15"});
  for (const [msg, reason] of [
    [{topic: "home/kitchen/wake-time/set", payload: "25:00"}, "not-a-time"],
    [{topic: "home/kitchen/wake-time/set", payload: "06:00:00", retain: true}, "retained-message"]
  ] as const) {
    const ignored = publishRoom(lit.state, msg, config, early);
    assert.deepEqual(ignored.state.schedule, {wakeTime: "07:00", bedTime: "23:00"}, reason);
    assert.equal(ignored.traces[0]?.reason, reason);
  }
  const same = publishRoom(lit.state, {topic: "home/kitchen/wake-time/set", payload: "23:00:00"}, config, early);
  assert.equal(same.traces.find(({event}) => event === "schedule")?.reason, "invalid-times");
  assert.deepEqual(same.state.schedule, {wakeTime: "07:00", bedTime: "23:00"});
});

test("a time set at runtime lasts until a redeploy changes that setting", () => {
  const withSchedule = (wakeTime: string, bedTime: string): RoomConfig =>
    ({...onSchedule(wakeTime, bedTime), schedule: {wakeTime, bedTime}});
  const set = publishRoom(undefined, {lighting: {kind: "schedule", wakeTime: "05:30", bedTime: "22:00"}}, withSchedule("07:00", "23:00"), now).state;
  // A redeploy with the same settings keeps both.
  assert.deepEqual(publishRoom(set, {lighting: {kind: "refresh"}}, withSchedule("07:00", "23:00"), now).state.schedule,
    {wakeTime: "05:30", bedTime: "22:00"});
  // A changed wake setting replaces only the wake time.
  assert.deepEqual(publishRoom(set, {lighting: {kind: "refresh"}}, withSchedule("06:00", "23:00"), now).state.schedule,
    {wakeTime: "06:00", bedTime: "22:00"});
  // State saved before times could change takes the settings.
  const {schedule: _schedule, scheduleSetting: _setting, ...older} = set;
  assert.deepEqual(publishRoom(older, {lighting: {kind: "refresh"}}, withSchedule("07:00", "23:00"), now).state.schedule,
    {wakeTime: "07:00", bedTime: "23:00"});
});

test("sleep from Home Assistant switches sleep and is published back", () => {
  const lit = publishRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, now);
  const asleep = publishRoom(lit.state, {topic: "home/kitchen/sleep/set", payload: "on"}, config, now);
  assert.equal(asleep.state.sleeping, true);
  assert.deepEqual(asleep.outputs[0], {topic: "home/kitchen/sleep/state", payload: "ON", retain: true});
  assert.ok(asleep.outputs.some(({lighting_command}) => lighting_command?.target === "cooking"), "restyled for sleep");
  const junk = publishRoom(lit.state, {topic: "home/kitchen/sleep/set", payload: "maybe"}, config, now);
  assert.equal(junk.state.sleeping, false);
  assert.deepEqual(junk.traces[0], {event: "sleep-set", outcome: "ignored", reason: "not-on-or-off", details: {payload: "maybe"}});
  assert.deepEqual(publishRoom(lit.state, {topic: "home/kitchen/sleep/set", payload: "ON"}, {...config, publishState: false}, now).state.sleeping,
    false, "not publishing: the set topic isn't read");
});

test("a room that starts with nothing saved leaves its lights alone until it is told about them", () => {
  const later = (ms: number) => new Date(now.getTime() + ms);
  const observe = (target: string, state: Partial<RoomState> | undefined, at: Date) => publishRoom(state, {
    topic: `home/kitchen/light/group/${target}`,
    payload: {state: "ON", brightness: 30, color_temp: 400},
    lighting: {kind: "observed"}
  }, config, at);
  // Nothing saved, as after a redeploy or restart without a context store:
  // both lights are on, perhaps held by an activity or set by a person.
  let result = observe("cooking", undefined, now);
  assert.deepEqual(result.state.untold, ["cooking", "dining"]);
  result = observe("dining", result.state, later(10));
  const commandsFor = (outputs: RoomOutput[]) => outputs.filter((output) => output.lighting_command).map((output) => output.lighting_command!.target);
  result = publishRoom(result.state, {lighting: {kind: "refresh"}}, config, later(90000));
  assert.deepEqual(commandsFor(result.outputs), [], "no restyle of lights it wasn't told about");
  assert.equal(result.traces.at(-1)?.reason, "not-told-since-start");
  // A sleep or schedule change restyles only lights it has been told about.
  result = publishRoom(result.state, {lighting: {kind: "schedule", wakeTime: "06:00"}}, config, later(91000));
  assert.deepEqual(commandsFor(result.outputs), []);

  // An intent naming one light tells it about that light only.
  result = publishRoom(result.state, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, later(92000));
  assert.deepEqual(result.state.untold, ["dining"]);
  result = publishRoom(result.state, {lighting: {kind: "refresh"}}, config, later(200000));
  assert.ok(!commandsFor(result.outputs).includes("dining"));

  // Switching circadian lighting on takes every light back.
  result = publishRoom(result.state, {lighting: {kind: "circadian", enabled: true}}, config, later(201000));
  assert.deepEqual(result.state.untold, []);
  assert.ok(commandsFor(result.outputs).includes("dining"));
});

test("an external bare ON tells a room that started with nothing saved about that light", () => {
  const later = (ms: number) => new Date(now.getTime() + ms);
  let result = publishRoom(undefined, {topic: "home/kitchen/light/group/cooking", payload: {state: "ON", brightness: 30, color_temp: 400}, lighting: {kind: "observed"}}, config, now);
  result = publishRoom(result.state, {topic: "home/kitchen/light/group/cooking/set", payload: {state: "ON"}, lighting: {kind: "command-observed", target: "cooking"}}, config, later(1000));
  assert.deepEqual(result.outputs.filter((output) => output.lighting_command).map((output) => output.lighting_command!.source), ["external-bare-on"]);
  assert.deepEqual(result.state.untold, ["dining"]);
  result = publishRoom(result.state, {lighting: {kind: "refresh"}}, config, later(200000));
  assert.deepEqual(result.outputs.filter((output) => output.lighting_command).map((output) => output.lighting_command!.target), ["cooking"],
    "kept in step by the refresh from then on");
});

test("a room with saved state restyles as before", () => {
  const saved = publishRoom({}, {topic: "home/kitchen/light/group/cooking", payload: {state: "ON", brightness: 30, color_temp: 400}, lighting: {kind: "observed"}}, config, now);
  assert.deepEqual(saved.state.untold, []);
  const refresh = publishRoom(saved.state, {lighting: {kind: "refresh"}}, config, new Date(now.getTime() + 90000));
  assert.deepEqual(refresh.outputs.filter((output) => output.lighting_command).map((output) => output.lighting_command!.target), ["cooking"]);
});

// The real-install loop: a function between the controller and MQTT out
// cuts every command to {"state":"ON"}, and the command observer feeds that
// back. Each command the room sends comes back changed, up to `rounds` times.
function loopThroughRewriter(start: ReturnType<typeof publishRoom>, rounds: number, copies = 1) {
  let result = start;
  let commands = 0;
  let pending = result.outputs.filter((output) => output.lighting_command);
  let at = now.getTime() + 100;
  for (let round = 0; round < rounds && pending.length; round += 1) {
    commands += pending.length;
    const next: RoomOutput[] = [];
    for (const output of pending) {
      for (let copy = 0; copy < copies; copy += 1) {
        at += 10;
        result = publishRoom(result.state, {
          topic: output.topic,
          payload: JSON.stringify({state: "ON"}),
          lighting: {kind: "command-observed", target: output.lighting_command!.target}
        }, config, new Date(at));
        next.push(...result.outputs.filter((entry) => entry.lighting_command));
      }
    }
    pending = next;
  }
  return {result, commands, correctives: commands - start.outputs.filter((output) => output.lighting_command).length};
}

test("a command rewritten on its way to MQTT never makes the room answer itself", () => {
  const styled = publishRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, now);
  assert.equal(styled.outputs.filter((output) => output.lighting_command).length, 1);
  const looped = loopThroughRewriter(styled, 50);
  assert.equal(looped.correctives, 0, "the rewritten echo is ours, so nothing more is sent");
  assert.equal(looped.result.traces.find(({reason}) => reason === "mutated-own-command")?.outcome, "ignored");

  // Each rewritten command delivered twice (two subscriptions, or a QoS
  // redelivery): the second copy looks like someone else's, but the room
  // restyles each light at most once per echo window.
  const doubled = loopThroughRewriter(styled, 50, 2);
  assert.ok(doubled.correctives <= 1, `${doubled.correctives} restyles`);
});

test("someone else's bare ON is still restyled, once per echo window", () => {
  const external = (at: number) => publishRoom(undefined, {topic: "home/kitchen/light/group/cooking/set", payload: {state: "ON"},
    lighting: {kind: "command-observed", target: "cooking"}}, config, new Date(now.getTime() + at));
  const first = external(0);
  assert.deepEqual(first.outputs.filter((output) => output.lighting_command).map((output) => output.lighting_command!.source), ["external-bare-on"]);
  // Another bare ON in the window, not ours: the room has just restyled it.
  const again = publishRoom(first.state, {topic: "home/kitchen/light/group/cooking/set", payload: {state: "ON"}, retain: false,
    lighting: {kind: "command-observed", target: "cooking"}}, config, new Date(now.getTime() + 6000));
  assert.deepEqual(again.outputs.filter((output) => output.lighting_command).map((output) => output.lighting_command!.source), ["external-bare-on"],
    "after the window, restyled again");
});

test("echo orderings never turn our own command into a manual light", () => {
  const send = () => publishRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, now);
  const seen = (state: RoomState, payload: unknown, ms: number) => publishRoom(state, {
    topic: "home/kitchen/light/group/cooking/set", payload, lighting: {kind: "command-observed", target: "cooking"}
  }, config, later(ms));
  const ours = (result: ReturnType<typeof publishRoom>) => result.outputs.find((output) => output.lighting_command)!.payload;
  const control = (result: ReturnType<typeof publishRoom>) => result.status.control.cooking;

  // A person's bare ON between our styled ON and its echo, then our echo.
  let result = send();
  const styled = ours(result);
  result = seen(result.state, {state: "ON"}, 50);
  result = seen(result.state, styled, 100);
  assert.equal(control(result), "in-control", "a race with a person's bare ON");
  assert.deepEqual(result.outputs.filter((output) => output.lighting_command), []);

  // Our exact echo delivered twice.
  result = send();
  result = seen(result.state, styled, 50);
  result = seen(result.state, styled, 100);
  assert.equal(control(result), "in-control", "our echo twice");

  // The light confirms first, then a bare ON, then our echo.
  result = send();
  result = publishRoom(result.state, {topic: "home/kitchen/light/group/cooking", payload: {state: "ON", brightness: 200},
    lighting: {kind: "observed"}}, config, later(30));
  assert.equal(result.state.expected.cooking?.[0]?.on, undefined, "confirmed");
  result = seen(result.state, {state: "ON"}, 50);
  result = seen(result.state, styled, 100);
  assert.equal(control(result), "in-control", "echo after its state report, with a bare ON between");
});

test("the circadian and sleep switches take only true or false from a flow: \"on\" and the like are refused and change nothing", () => {
  const start = publishRoom(undefined, {lighting: {kind: "sleep", enabled: true}}, config, new Date("2026-06-21T12:00:00Z"));
  for (const kind of ["circadian", "sleep"]) {
    for (const enabled of ["on", "ON", "off", "true", 1, null, undefined]) {
      const result = publishRoom(start.state, {lighting: {kind, enabled: enabled as unknown as boolean /* as a flow may send */}}, config, new Date("2026-06-21T12:01:00Z"));
      assert.deepEqual([result.state.circadianEnabled, result.state.sleeping], [true, true], `${kind} ${String(enabled)}`);
      assert.deepEqual(result.traces.map(({event, outcome, reason}) => [event, outcome, reason]), [[kind, "ignored", "not-true-or-false"]]);
      // No light is commanded; only the unchanged state may be published again.
      assert.deepEqual(result.outputs.filter(({lighting_command}) => lighting_command), []);
      assert.ok(result.outputs.every(({payload}) => payload === "ON"), JSON.stringify(result.outputs));
    }
  }
  // Home Assistant's ON and OFF still arrive, as true and false, through the set topics.
  const fromHa = publishRoom(start.state, {topic: "home/kitchen/sleep/set", payload: "OFF"}, config, new Date("2026-06-21T12:02:00Z"));
  assert.equal(fromHa.state.sleeping, false);
});
