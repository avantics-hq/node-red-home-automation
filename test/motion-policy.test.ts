"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  transitionMotion,
  type LightingIntent,
  type MotionConfig,
  type MotionEffect
} from "../lib/motion-policy";

const config: MotionConfig & {area: string} = {
  area: "kitchen",
  onTargets: ["cooking", "dining"],
  offTargets: ["cooking", "dining", "cabinets"],
  defaultDelaySeconds: 30,
  defaultIlluminanceCutoff: 150,
  switchWindowMs: 500,
  switchFreshnessMs: 60_000
};

function sendEffects(result: ReturnType<typeof transitionMotion>): LightingIntent[] {
  return result.effects
    .filter((effect): effect is Extract<MotionEffect, {kind: "send"}> => effect.kind === "send")
    .map((effect) => effect.message);
}

test("dark enabled motion emits one ON intent", () => {
  let result = transitionMotion(undefined, {source: "illuminance", payload: 12}, config, true, 1000);
  result = transitionMotion(result.state, {source: "occupancy", payload: {occupied: true, trigger: "motion"}}, config, true, 2000);

  assert.deepEqual(sendEffects(result), [{
    lighting: {
      kind: "intent",
      targets: ["cooking", "dining"],
      state: "ON",
      source: "motion"
    }
  }]);
  assert.equal(result.traces.find((entry) => entry.event === "occupancy")?.outcome, "emit-on");
});

test("disabled and bright motion expose distinct suppression reasons", () => {
  const disabled = transitionMotion(
    undefined,
    {source: "occupancy", payload: {occupied: true, trigger: "motion"}},
    config,
    false,
    1000
  );
  assert.equal(sendEffects(disabled).length, 0);
  assert.equal(disabled.traces.find((entry) => entry.event === "occupancy")?.reason, "disabled");

  let bright = transitionMotion(undefined, {source: "illuminance", payload: 151}, config, true, 1000);
  bright = transitionMotion(bright.state, {source: "occupancy", payload: {occupied: true, trigger: "motion"}}, config, true, 2000);
  assert.equal(sendEffects(bright).length, 0);
  assert.equal(bright.traces.find((entry) => entry.event === "occupancy")?.reason, "too-bright");
});

test("only the newest vacancy timer may emit OFF", () => {
  const firstVacancy = transitionMotion(undefined, {source: "occupancy", payload: {occupied: false}}, config, true, 1000);
  const firstSchedule = firstVacancy.effects.find(
    (effect): effect is Extract<MotionEffect, {kind: "schedule-off-timer"}> =>
      effect.kind === "schedule-off-timer"
  );
  const secondVacancy = transitionMotion(firstVacancy.state, {source: "occupancy", payload: {occupied: false}}, config, true, 1001);
  const secondSchedule = secondVacancy.effects.find(
    (effect): effect is Extract<MotionEffect, {kind: "schedule-off-timer"}> =>
      effect.kind === "schedule-off-timer"
  );
  assert.ok(firstSchedule);
  assert.ok(secondSchedule);

  const stale = transitionMotion(secondVacancy.state, {
    source: "off-timer",
    generation: firstSchedule.generation
  }, config, true, 31000);
  assert.equal(sendEffects(stale).length, 0);
  assert.equal(stale.traces[0]?.reason, "stale-generation");

  const current = transitionMotion(stale.state, {
    source: "off-timer",
    generation: secondSchedule.generation
  }, config, true, 31001);
  assert.equal(sendEffects(current).length, 1);
  assert.equal(sendEffects(current)[0]?.lighting.state, "OFF");
});

test("retained switch startup is inert, single edge toggles and double edge is full brightness", () => {
  const retained = transitionMotion(undefined, {
    source: "switch",
    payload: {state: false},
    retain: true
  }, config, true, 1000);
  assert.equal(retained.effects.some((effect) => effect.kind === "schedule-switch-timer"), false);

  const edge = transitionMotion(retained.state, {
    source: "switch",
    payload: {state: true}
  }, config, true, 2000);
  const timer = edge.effects.find(
    (effect): effect is Extract<MotionEffect, {kind: "schedule-switch-timer"}> =>
      effect.kind === "schedule-switch-timer"
  );
  assert.ok(timer);
  const single = transitionMotion(edge.state, {
    source: "switch-timer",
    generation: timer.generation,
    switchAt: timer.switchAt
  }, config, true, 2500);
  assert.equal(sendEffects(single)[0]?.lighting.state, "TOGGLE");

  const first = transitionMotion(single.state, {
    source: "switch",
    payload: {state: false}
  }, config, true, 3000);
  const second = transitionMotion(first.state, {
    source: "switch",
    payload: {state: true}
  }, config, true, 3200);
  assert.deepEqual(sendEffects(second)[0]?.lighting.values, {brightness: 254});
  assert.equal(sendEffects(second)[0]?.lighting.manual, true);
});

test("retained switch state re-baselines persisted motion policy state", () => {
  const baseline = transitionMotion(undefined, {
    source: "switch",
    payload: {state: false},
    retain: true
  }, config, true, 1000);
  const edge = transitionMotion(baseline.state, {
    source: "switch",
    payload: {state: true}
  }, config, true, 2000);
  const timer = edge.effects.find(
    (effect): effect is Extract<MotionEffect, {kind: "schedule-switch-timer"}> =>
      effect.kind === "schedule-switch-timer"
  );
  assert.ok(timer);

  const replay = transitionMotion(edge.state, {
    source: "switch",
    payload: {state: false},
    retain: true
  }, config, true, 2100);
  assert.equal(sendEffects(replay).length, 0);
  assert.equal(replay.effects.some((effect) => effect.kind === "cancel-switch-timer"), true);

  const stale = transitionMotion(replay.state, {
    source: "switch-timer",
    generation: timer.generation,
    switchAt: timer.switchAt
  }, config, true, 2500);
  assert.equal(sendEffects(stale).length, 0);
});

function scheduled(result: ReturnType<typeof transitionMotion>) {
  return result.effects.find(
    (effect): effect is Extract<MotionEffect, {kind: "schedule-off-timer"}> => effect.kind === "schedule-off-timer"
  );
}

test("a vacancy while motion is disabled schedules no off-timer", () => {
  let area = transitionMotion(undefined, {source: "area-enabled", payload: "off"}, config, true, 1000);
  area = transitionMotion(area.state, {source: "occupancy", payload: {occupied: false}}, config, true, 2000);
  assert.equal(scheduled(area), undefined);
  assert.equal(area.state.offTimerDueAt, null);
  const suppressed = area.traces.find((entry) => entry.event === "occupancy");
  assert.equal(suppressed?.outcome, "suppressed");
  assert.equal(suppressed?.reason, "disabled");

  const global = transitionMotion(undefined, {source: "occupancy", payload: {occupied: false}}, config, false, 2000);
  assert.equal(scheduled(global), undefined);
  assert.equal(global.traces.find((entry) => entry.event === "occupancy")?.reason, "disabled");
});

test("an off-timer that fires after motion is disabled globally emits nothing", () => {
  // Two nodes share the global switch; only node A receives global-enabled.
  const nodeB = transitionMotion(undefined, {source: "occupancy", payload: {occupied: false}}, config, true, 1000);
  const timer = scheduled(nodeB);
  assert.ok(timer);
  const nodeA = transitionMotion(undefined, {source: "global-enabled", payload: "off"}, config, true, 2000);
  assert.equal(nodeA.globalEnabled, false);

  const fired = transitionMotion(nodeB.state, {source: "off-timer", generation: timer.generation}, config, nodeA.globalEnabled, 31_000);
  assert.equal(sendEffects(fired).length, 0);
  assert.equal(fired.state.offTimerDueAt, null);
  const suppressed = fired.traces.find((entry) => entry.event === "off-timer");
  assert.equal(suppressed?.outcome, "suppressed");
  assert.equal(suppressed?.reason, "disabled");
});

test("ON in any case enables motion; other values disable it", () => {
  for (const payload of ["ON", "On", "on", true]) {
    const result = transitionMotion(undefined, {source: "area-enabled", payload}, config, true, 1000);
    assert.equal(result.status.enabled, true, String(payload));
    assert.equal(transitionMotion(undefined, {source: "global-enabled", payload}, config, false, 1000).globalEnabled, true);
  }
  for (const payload of ["OFF", "off", false, "true", 1]) {
    assert.equal(transitionMotion(undefined, {source: "area-enabled", payload}, config, true, 1000).status.enabled, false);
  }
});

test("re-enabling motion switches nothing off; a later vacancy schedules OFF as before", () => {
  let result = transitionMotion(undefined, {source: "area-enabled", payload: "off"}, config, true, 1000);
  result = transitionMotion(result.state, {source: "occupancy", payload: {occupied: false}}, config, true, 2000);
  result = transitionMotion(result.state, {source: "area-enabled", payload: "ON"}, config, true, 3000);
  assert.equal(sendEffects(result).length, 0);
  assert.equal(scheduled(result), undefined);

  result = transitionMotion(result.state, {source: "occupancy", payload: {occupied: false}}, config, true, 4000);
  const timer = scheduled(result);
  assert.equal(timer?.delayMs, 30_000);
  result = transitionMotion(result.state, {source: "off-timer", generation: timer?.generation}, config, true, 34_000);
  assert.deepEqual(sendEffects(result).map((message) => message.lighting.state), ["OFF"]);
});
