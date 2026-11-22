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
  assert.equal(ownEcho.state.manual.cooking, undefined);

  const external = transitionRoom(ownEcho.state, {
    topic: "home/kitchen/light/group/cooking/set",
    payload: {state: "ON", brightness: 100},
    lighting: {kind: "command-observed", target: "cooking"}
  }, config, new Date(now.getTime() + 200));
  assert.equal(external.state.manual.cooking, true);

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
  assert.equal(initial.state.manual.cooking, true);

  const toggle = transitionRoom(initial.state, {
    lighting: {kind: "intent", targets: ["cooking"], state: "TOGGLE", source: "wall"}
  }, config, new Date(now.getTime() + 100));
  assert.equal(payload(toggle, 0).state, "OFF");
  assert.equal(toggle.state.manual.cooking, false);
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
  assert.equal(result.state.manual.cooking, true);
  assert.equal(result.state.desired.dining, false);

  result.state.manual.cooking = false;
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
  assert.equal(result.state.manual.cooking, false);
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

  assert.equal(result.outputs.length, 1);
  assert.equal(output(result, 0).lighting_command?.target, "dining");
  assert.equal(payload(result, 0).brightness, 40);
  assert.equal(result.state.manual.cooking, undefined);
  assert.equal(result.state.manual.dining, true);
});

test("startup publishes stable discovery and state messages", () => {
  const result = transitionRoom(undefined, {lighting: {kind: "startup"}}, config, now);
  assert.equal(result.outputs.length, 2);
  assert.equal(output(result, 0).topic, "homeassistant/switch/kitchen_circadian_lighting/config");
  assert.equal(output(result, 0).retain, true);
  assert.equal(output(result, 1).topic, "home/kitchen/circadian/state");
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
