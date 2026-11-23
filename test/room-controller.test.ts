"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {transitionSwitchPolicy} from "../lib/switch-policy";
import {
  DEFAULT_BED_TIME,
  DEFAULT_WAKE_TIME,
  adaptivePayload,
  scheduleLevel,
  transitionRoom,
  type RoomConfig,
  type RoomOutput
} from "../lib/room-controller";

const config: RoomConfig = {
  area: "kitchen",
  displayName: "Kitchen",
  targets: [
    {id: "cooking", stateTopic: "home/kitchen/light/group/cooking", commandTopic: "home/kitchen/light/group/cooking/set"},
    {id: "dining", stateTopic: "home/kitchen/light/group/dining", commandTopic: "home/kitchen/light/group/dining/set"}
  ],
  maxBrightnessPct: 100,
  maxColorTempKelvin: 5500,
  sleepBrightnessPct: 1,
  sleepColorTempKelvin: 1000,
  initialTransitionSeconds: 1,
  refreshTransitionSeconds: 45,
  initialSleep: false
};
// Local noon, so the default schedule is in its daytime in any timezone.
const now = new Date(2026, 5, 21, 12, 0);

function output(result: ReturnType<typeof transitionRoom>, index: number): RoomOutput {
  const entry = result.outputs[index];
  assert.ok(entry);
  return entry;
}

function payload(result: ReturnType<typeof transitionRoom>, index: number): Record<string, unknown> {
  const value = output(result, index).payload;
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("intent emits adaptive commands and records command ownership", () => {
  const result = transitionRoom(undefined, {
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
  const commanded = transitionRoom(undefined, {
    lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}
  }, config, now);
  const ownPayload = output(commanded, 0).payload;
  const ownEcho = transitionRoom(commanded.state, {
    topic: "home/kitchen/light/group/cooking/set",
    payload: ownPayload,
    lighting: {kind: "command-observed", target: "cooking"}
  }, config, new Date(now.getTime() + 100));
  assert.equal(ownEcho.state.control.cooking, undefined);

  const external = transitionRoom(ownEcho.state, {
    topic: "home/kitchen/light/group/cooking/set",
    payload: {state: "ON", brightness: 100},
    lighting: {kind: "command-observed", target: "cooking"}
  }, config, new Date(now.getTime() + 200));
  assert.equal(external.state.control.cooking?.state, "manual");

  const refresh = transitionRoom(external.state, {lighting: {kind: "refresh"}}, config, new Date(now.getTime() + 300));
  assert.equal(refresh.outputs.length, 0);
});

test("OFF clears manual state and TOGGLE resolves from desired state", () => {
  const initial = transitionRoom(undefined, {
    lighting: {
      kind: "intent",
      targets: ["cooking"],
      state: "ON",
      source: "wall",
      manual: true,
      values: {brightness: 254}
    }
  }, config, now);
  assert.equal(initial.state.control.cooking?.state, "manual");

  const toggle = transitionRoom(initial.state, {
    lighting: {kind: "intent", targets: ["cooking"], state: "TOGGLE", source: "wall"}
  }, config, new Date(now.getTime() + 100));
  assert.equal(payload(toggle, 0).state, "OFF");
  assert.equal(toggle.state.control.cooking, undefined);
});

test("activity styling preserves manual and occupancy power ownership", () => {
  let result = transitionRoom(undefined, {
    lighting: {
      kind: "intent",
      targets: ["cooking"],
      state: "ON",
      source: "wall",
      manual: true,
      values: {brightness: 254}
    }
  }, config, now);
  result.state.desired.dining = false;

  result = transitionRoom(result.state, {
    lighting: {
      kind: "intent",
      targets: ["cooking", "dining"],
      state: "ON",
      source: "activity",
      values: {brightness: 64},
      updateOnOnly: true,
      preserveManual: true
    }
  }, config, new Date(now.getTime() + 100));
  assert.equal(result.outputs.length, 0);
  assert.equal(result.state.control.cooking?.state, "manual");
  assert.equal(result.state.desired.dining, false);

  delete result.state.control.cooking;
  result = transitionRoom(result.state, {
    lighting: {
      kind: "intent",
      targets: ["cooking"],
      state: "ON",
      source: "activity",
      values: {brightness: 64},
      updateOnOnly: true,
      preserveManual: true
    }
  }, config, new Date(now.getTime() + 200));
  assert.equal(payload(result, 0).brightness, 64);
  assert.equal(result.state.control.cooking, undefined);
});

test("off-only intents preserve active lights while applying a bedtime level to inactive targets", () => {
  const state = transitionRoom(undefined, {
    lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "wall"}
  }, config, now).state;

  const result = transitionRoom(state, {
    lighting: {
      kind: "intent",
      targets: ["cooking", "dining"],
      state: "ON",
      source: "bedtime",
      values: {brightness: 40},
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
  const result = transitionRoom(undefined, {lighting: {kind: "startup"}}, config, now);
  assert.equal(result.outputs.length, 4);
  assert.equal(output(result, 0).topic, "homeassistant/switch/kitchen_circadian_lighting/config");
  assert.equal(output(result, 0).retain, true);
  assert.equal(output(result, 1).topic, "home/kitchen/circadian/state");
  assert.deepEqual(result.outputs.slice(2), [
    {topic: "home/kitchen/lighting/cooking/control", payload: {state: "in-control", owner: null}, retain: true},
    {topic: "home/kitchen/lighting/dining/control", payload: {state: "in-control", owner: null}, retain: true}
  ]);
});

const later = (ms: number): Date => new Date(now.getTime() + ms);

function observeState(state: Parameters<typeof transitionRoom>[0], on: boolean, ms: number) {
  return transitionRoom(state, {
    topic: "home/kitchen/light/group/cooking",
    payload: {state: on ? "ON" : "OFF", brightness: on ? 254 : null},
    lighting: {kind: "observed"}
  }, config, later(ms));
}

test("a light switched off at the bulb is not switched back on by the periodic refresh", () => {
  let result = transitionRoom(undefined, {
    lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}
  }, config, now);
  result = observeState(result.state, true, 200);
  result = observeState(result.state, false, 60000);
  assert.equal(result.state.desired.cooking, false);
  result = transitionRoom(result.state, {lighting: {kind: "refresh"}}, config, later(90000));
  assert.equal(result.outputs.length, 0);
});

test("a light switched on at the bulb is switched off by the next toggle", () => {
  let result = observeState(undefined, false, 0);
  result = transitionRoom(result.state, {
    lighting: {kind: "intent", targets: ["cooking"], state: "OFF", source: "wall"}
  }, config, later(100));
  result = observeState(result.state, false, 300);
  result = observeState(result.state, true, 60000);
  assert.equal(result.state.desired.cooking, true);
  result = transitionRoom(result.state, {
    lighting: {kind: "intent", targets: ["cooking"], state: "TOGGLE", source: "wall"}
  }, config, later(61000));
  assert.equal(payload(result, 0).state, "OFF");
});

test("a stale state report does not undo the controller's own command in flight", () => {
  let result = observeState(undefined, false, 0);
  result = transitionRoom(result.state, {
    lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}
  }, config, later(1000));
  const ownPayload = output(result, 0).payload;
  // The command topic echo arrives before the bulb's stale report.
  result = transitionRoom(result.state, {
    topic: "home/kitchen/light/group/cooking/set",
    payload: ownPayload,
    lighting: {kind: "command-observed", target: "cooking"}
  }, config, later(1050));
  result = observeState(result.state, false, 1100);
  assert.equal(result.state.desired.cooking, true);
  assert.equal(result.traces.at(-1)?.reason, "own-command-in-flight");

  result = observeState(result.state, true, 1400);
  assert.equal(result.state.desired.cooking, true);
  // Once confirmed, a later OFF is a real external change.
  result = observeState(result.state, false, 2000);
  assert.equal(result.state.desired.cooking, false);
});

test("an own command echo still marks only one matching external command as own", () => {
  let result = transitionRoom(undefined, {
    lighting: {kind: "intent", targets: ["cooking"], state: "OFF", source: "wall"}
  }, config, now);
  const echo = {topic: "home/kitchen/light/group/cooking/set", payload: {state: "OFF"}, lighting: {kind: "command-observed", target: "cooking"}};
  result = transitionRoom(result.state, echo, config, later(100));
  assert.equal(result.traces.length, 0);
  result = transitionRoom(result.state, echo, config, later(200));
  assert.equal(result.traces.at(-1)?.event, "external-command");
});

test("restored state with expected entries from before in-flight tracking adopts observations", () => {
  const saved = {
    desired: {cooking: true},
    expected: {cooking: [{fingerprint: "{\"state\":\"ON\"}", expires: later(5000).getTime()}]}
  };
  let result = observeState(saved, false, 1000);
  assert.equal(result.state.desired.cooking, false);
  result = transitionRoom(result.state, {lighting: {kind: "refresh"}}, config, later(90000));
  assert.equal(result.outputs.length, 0);
});

test("the reducer does not mutate the saved state it is given", () => {
  let result = observeState(undefined, false, 0);
  result = transitionRoom(result.state, {
    lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}
  }, config, later(1000));
  const ownPayload = output(result, 0).payload;
  const beforeEcho = structuredClone(result.state);
  const echoed = transitionRoom(result.state, {
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

function controlOutputs(result: ReturnType<typeof transitionRoom>) {
  return result.outputs.filter((entry) => entry.topic.endsWith("/control")).map((entry) => [entry.topic, entry.payload]);
}

function ownedActivity(state: Parameters<typeof transitionRoom>[0], ms: number) {
  return transitionRoom(state, {
    lighting: {
      kind: "intent",
      targets: ["cooking"],
      state: "ON",
      source: "activity",
      owner: "theatre",
      values: {brightness: 64, color_temp: 400},
      preserveManual: true
    }
  }, config, later2(ms));
}

test("an overridden light keeps its owner's style through the periodic refresh", () => {
  // dev-review repro: activity {brightness 64, color_temp 400} became circadian {254, 439}.
  let result = transitionRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, now);
  result = ownedActivity(result.state, 1000);
  assert.equal(payload(result, 0).brightness, 64);
  assert.deepEqual(result.state.control.cooking, {state: "overridden", owner: "theatre"});
  assert.equal(result.status.control.cooking, "overridden");
  assert.equal(result.status.overriddenCount, 1);
  assert.deepEqual(controlOutputs(result), [["home/kitchen/lighting/cooking/control", {state: "overridden", owner: "theatre"}]]);
  assert.equal(result.traces.some((entry) => entry.event === "control" && entry.reason === "owner-intent"), true);

  result = transitionRoom(result.state, {lighting: {kind: "refresh"}}, config, later2(90000));
  assert.equal(result.outputs.length, 0);
  // A later owner-less ON (motion) is ignored for the held light.
  result = transitionRoom(result.state, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, later2(91000));
  assert.equal(result.outputs.length, 0);
  assert.equal(result.status.control.cooking, "overridden");
});

test("releasing an overridden light restyles it and refresh resumes", () => {
  let result = transitionRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, now);
  result = ownedActivity(result.state, 1000);
  // Another owner's release does not touch it.
  result = transitionRoom(result.state, {lighting: {kind: "release", owner: "scene"}}, config, later2(2000));
  assert.equal(result.outputs.length, 0);
  assert.equal(result.status.control.cooking, "overridden");

  result = transitionRoom(result.state, {lighting: {kind: "release", targets: ["cooking"], owner: "theatre"}}, config, later2(3000));
  assert.equal(result.status.control.cooking, "in-control");
  assert.equal(result.outputs[0]?.lighting_command?.source, "release");
  assert.equal(payload(result, 0).brightness, 254);
  assert.equal(payload(result, 0).transition, 45);
  assert.deepEqual(controlOutputs(result), [["home/kitchen/lighting/cooking/control", {state: "in-control", owner: null}]]);

  result = transitionRoom(result.state, {lighting: {kind: "refresh"}}, config, later2(90000));
  assert.equal(result.outputs.length, 1);
  assert.equal(payload(result, 0).brightness, 254);
});

test("only the owner switching a held light off returns it to the room controller", () => {
  let result = transitionRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, now);
  result = ownedActivity(result.state, 1000);
  result = transitionRoom(result.state, {lighting: {kind: "intent", targets: ["cooking"], state: "OFF", source: "activity", owner: "theatre"}}, config, later2(2000));
  assert.equal(payload(result, 0).state, "OFF");
  assert.equal(result.status.control.cooking, "in-control");
  assert.equal(result.traces.some((entry) => entry.event === "control" && entry.reason === "off"), true);

  result = transitionRoom(result.state, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, later2(60000));
  assert.equal(payload(result, 0).brightness, 254);
});

test("a person's change on an overridden light makes it manual; enabling circadian keeps other owners", () => {
  let result = ownedActivity(undefined, 0);
  result = transitionRoom(result.state, {
    lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "wall", manual: true, values: {brightness: 254}}
  }, config, later2(1000));
  assert.equal(result.status.control.cooking, "manual");
  // An owner intent with preserveManual leaves a person's light alone.
  result = ownedActivity(result.state, 2000);
  assert.equal(result.outputs.length, 0);
  assert.equal(result.status.control.cooking, "manual");

  result = ownedActivity(undefined, 2000);
  result = transitionRoom(result.state, {
    lighting: {kind: "intent", targets: ["dining"], state: "ON", source: "wall", manual: true, values: {brightness: 100}}
  }, config, later2(3000));
  result = transitionRoom(result.state, {lighting: {kind: "circadian", enabled: true}}, config, later2(4000));
  assert.equal(result.status.control.cooking, "overridden");
  assert.equal(result.status.control.dining, "in-control");
});

test("state saved before control states existed loads as manual or in-control", () => {
  const saved = {desired: {cooking: true, dining: true}, manual: {cooking: true, dining: false}};
  const result = transitionRoom(saved as Parameters<typeof transitionRoom>[0], {lighting: {kind: "refresh"}}, config, now);
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
  let result = transitionRoom(undefined, {lighting: {kind: "intent", targets: ["lamp", "wall"], state: "ON", source: "motion"}}, heldConfig, now);
  result = transitionRoom(result.state, {
    lighting: {kind: "intent", targets: ["lamp"], state: "ON", source: "activity", owner: "film", values: {brightness: 30}}
  }, heldConfig, later2(1000));
  assert.equal(result.status.control.lamp, "overridden");
  return result;
}

function heldIntent(state: Parameters<typeof transitionRoom>[0], lighting: Record<string, unknown>, ms = 2000) {
  return transitionRoom(state, {lighting: {kind: "intent", targets: ["lamp"], ...lighting}}, heldConfig, later2(ms));
}

function ignoredHeld(result: ReturnType<typeof transitionRoom>) {
  return result.traces.filter((entry) => entry.reason === "held-by").map((entry) => [entry.details.target, entry.details.owner]);
}

test("a held light ignores owner-less automation", () => {
  const held = heldLamp();
  for (const lighting of [
    {state: "ON", source: "motion"},
    {state: "OFF", source: "motion"},
    {state: "TOGGLE", source: "schedule"},
    {state: "ON", source: "bedtime", values: {brightness: 40}},
    {state: "ON", source: "activity", values: {brightness: 80}, updateOnOnly: true},
    {state: "ON", source: "bedtime", values: {brightness: 5}, updateOffOnly: true}
  ]) {
    const result = heldIntent(held.state, lighting);
    assert.equal(result.outputs.length, 0, JSON.stringify(lighting));
    assert.deepEqual(result.state.control.lamp, {state: "overridden", owner: "film"});
    assert.deepEqual(ignoredHeld(result), [["lamp", "film"]]);
  }
});

test("a held light follows its owner, a newer owner, a person and a release", () => {
  const held = heldLamp();
  let result = heldIntent(held.state, {state: "ON", source: "activity", owner: "film", values: {brightness: 20}});
  assert.equal(payload(result, 0).brightness, 20);

  result = heldIntent(held.state, {state: "ON", source: "scene", owner: "reading", values: {brightness: 90}});
  assert.equal(payload(result, 0).brightness, 90);
  assert.deepEqual(result.state.control.lamp, {state: "overridden", owner: "reading"});

  result = heldIntent(held.state, {state: "ON", source: "wall", manual: true, values: {brightness: 254}});
  assert.equal(payload(result, 0).brightness, 254);
  assert.equal(result.status.control.lamp, "manual");

  result = transitionRoom(held.state, {lighting: {kind: "release", owner: "film"}}, heldConfig, later2(2000));
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
  const result = transitionRoom(held.state, sent.message, heldConfig, later2(2000));
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
  let result = transitionRoom(held.state, {topic: "home/kitchen/light/lamp", payload: {state: "ON", brightness: 30}, lighting: {kind: "observed"}}, heldConfig, later2(1200));
  result = transitionRoom(result.state, {topic: "home/kitchen/light/lamp", payload: {state: "OFF"}, lighting: {kind: "observed"}}, heldConfig, later2(60000));
  assert.equal(result.outputs.filter((entry) => entry.lighting_command).length, 0);
  assert.equal(result.status.control.lamp, "in-control");
  assert.equal(result.state.desired.lamp, false);
});

test("a mixed intent changes only the lights that are not held", () => {
  const held = heldLamp();
  const result = transitionRoom(held.state, {lighting: {kind: "intent", targets: ["lamp", "wall"], state: "OFF", source: "motion"}}, heldConfig, later2(2000));
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

  const scheduled = {...config, wakeTime: "07:00", bedTime: "23:00"};
  const day = adaptivePayload("ON", false, false, clock(13), scheduled);
  assert.equal(day.brightness, 254);
  assert.equal(day.color_temp, Math.round(1_000_000 / scheduled.maxColorTempKelvin));
  const night = adaptivePayload("ON", false, false, clock(3), scheduled);
  assert.equal(night.brightness, Math.round(scheduled.sleepBrightnessPct * 254 / 100) || 1);
  assert.equal(night.color_temp, Math.round(1_000_000 / scheduled.sleepColorTempKelvin));
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
  const scheduled = {...config, wakeTime: "07:00", bedTime: "23:00"};
  let result = transitionRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, scheduled, clock(21, 30));
  assert.equal(payload(result, 0).brightness, 128);
  result = transitionRoom(result.state, {lighting: {kind: "refresh"}}, scheduled, clock(23, 30));
  assert.equal(payload(result, 0).brightness, Math.round(scheduled.sleepBrightnessPct * 254 / 100) || 1);
});

test("without wake and bed times the default schedule applies", () => {
  for (const [hours, minutes] of [[3, 0], [7, 30], [13, 0], [21, 30], [23, 30]] as const) {
    const at = clock(hours, minutes);
    assert.deepEqual(
      adaptivePayload("ON", false, false, at, config),
      adaptivePayload("ON", false, false, at, {...config, wakeTime: DEFAULT_WAKE_TIME, bedTime: DEFAULT_BED_TIME}),
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
  const scheduled = {...config, wakeTime: "07:00", bedTime: "23:00"};
  const sleepMired = 1_000_000 / scheduled.sleepColorTempKelvin;
  const dayMired = 1_000_000 / scheduled.maxColorTempKelvin;
  // Half-way through the rise, the colour is half-way in mireds.
  assert.equal(adaptivePayload("ON", false, false, clock(7, 30), scheduled).color_temp, Math.round((sleepMired + dayMired) / 2));
});

test("a refresh skips lights already at their level and re-sends to one that is not", () => {
  const scheduled = {...config, wakeTime: "07:00", bedTime: "23:00"};
  const report = (state: Parameters<typeof transitionRoom>[0], level: Record<string, unknown>, at: Date) =>
    transitionRoom(state, {topic: "home/kitchen/light/group/cooking", payload: {state: "ON", ...level}, lighting: {kind: "observed"}}, scheduled, at);
  let result = transitionRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, scheduled, clock(13));
  const sent = payload(result, 0);
  result = report(result.state, {brightness: sent.brightness, color_temp: sent.color_temp}, clock(13, 0));

  // Flat daytime: the bulb already reports the level, so nothing is sent.
  const flat = transitionRoom(result.state, {lighting: {kind: "refresh"}}, scheduled, clock(14));
  assert.equal(flat.outputs.filter((entry) => entry.lighting_command).length, 0);
  assert.equal(flat.traces.some((entry) => entry.reason === "already-at-level"), true);

  // A bulb that missed a command reports something else and gets it again.
  const missed = report(result.state, {brightness: 120, color_temp: sent.color_temp}, clock(14));
  const resent = transitionRoom(missed.state, {lighting: {kind: "refresh"}}, scheduled, clock(14, 1));
  assert.equal(resent.outputs.filter((entry) => entry.lighting_command).length, 1);

  // During the wind-down the level moves, so the refresh sends.
  const ramp = transitionRoom(result.state, {lighting: {kind: "refresh"}}, scheduled, clock(21, 30));
  assert.equal(ramp.outputs.filter((entry) => entry.lighting_command).length, 1);
  assert.notEqual(payload(ramp, 0).brightness, sent.brightness);
});
