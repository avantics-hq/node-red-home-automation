"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
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
  latitude: 51.5074,
  longitude: -0.1278,
  minBrightnessPct: 1,
  maxBrightnessPct: 100,
  minColorTempKelvin: 2000,
  maxColorTempKelvin: 5500,
  sleepBrightnessPct: 1,
  sleepColorTempKelvin: 1000,
  initialTransitionSeconds: 1,
  refreshTransitionSeconds: 45,
  initialSleep: false
};
const now = new Date("2026-06-21T12:00:00Z");

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
  // A later non-owner ON (motion) neither restyles nor takes the light back.
  result = transitionRoom(result.state, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, later2(91000));
  assert.deepEqual(payload(result, 0), {state: "ON"});
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

test("switching off an overridden light returns it to the room controller", () => {
  let result = transitionRoom(undefined, {lighting: {kind: "intent", targets: ["cooking"], state: "ON", source: "motion"}}, config, now);
  result = ownedActivity(result.state, 1000);
  result = transitionRoom(result.state, {lighting: {kind: "intent", targets: ["cooking"], state: "OFF", source: "motion"}}, config, later2(2000));
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
