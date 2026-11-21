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
  switchWindowMs: 500
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
