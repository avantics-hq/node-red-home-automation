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

test("startup publishes stable discovery and state messages", () => {
  const result = transitionRoom(undefined, {lighting: {kind: "startup"}}, config, now);
  assert.equal(result.outputs.length, 2);
  assert.equal(output(result, 0).topic, "homeassistant/switch/kitchen_circadian_lighting/config");
  assert.equal(output(result, 0).retain, true);
  assert.equal(output(result, 1).topic, "home/kitchen/circadian/state");
});
