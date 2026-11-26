"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  transitionSwitchPolicy,
  type SwitchPolicyConfig,
  type SwitchPolicyEffect
} from "../lib/switch-policy";

const config: SwitchPolicyConfig = {
  targets: ["main"],
  switchWindowMs: 500,
  switchFreshnessMs: 60_000
};

function messages(result: ReturnType<typeof transitionSwitchPolicy>) {
  return result.effects
    .filter((effect): effect is Extract<SwitchPolicyEffect, {kind: "send"}> => effect.kind === "send")
    .map((effect) => effect.message);
}

test("retained raw state is a baseline and a single edge toggles after the window", () => {
  const retained = transitionSwitchPolicy(undefined, {
    source: "switch",
    payload: {state: false},
    retain: true
  }, config, 1000);
  assert.equal(messages(retained).length, 0);

  const edge = transitionSwitchPolicy(retained.state, {
    source: "switch",
    payload: {state: true}
  }, config, 2000);
  const timer = edge.effects.find(
    (effect): effect is Extract<SwitchPolicyEffect, {kind: "schedule-switch-timer"}> =>
      effect.kind === "schedule-switch-timer"
  );
  assert.ok(timer);

  const elapsed = transitionSwitchPolicy(edge.state, {
    source: "switch-timer",
    generation: timer.generation,
    switchAt: timer.switchAt
  }, config, 2500);
  assert.equal(messages(elapsed)[0]?.lighting.state, "TOGGLE");
});

test("retained state re-baselines a known switch without replaying an edge", () => {
  const baseline = transitionSwitchPolicy(undefined, {
    source: "switch",
    payload: {state: false},
    retain: true
  }, config, 1000);
  const edge = transitionSwitchPolicy(baseline.state, {
    source: "switch",
    payload: {state: true}
  }, config, 2000);
  const timer = edge.effects.find(
    (effect): effect is Extract<SwitchPolicyEffect, {kind: "schedule-switch-timer"}> =>
      effect.kind === "schedule-switch-timer"
  );
  assert.ok(timer);

  const replay = transitionSwitchPolicy(edge.state, {
    source: "switch",
    payload: {state: false},
    retain: true
  }, config, 2100);
  assert.equal(messages(replay).length, 0);
  assert.equal(replay.effects.some((effect) => effect.kind === "cancel-switch-timer"), true);

  const stale = transitionSwitchPolicy(replay.state, {
    source: "switch-timer",
    generation: timer.generation,
    switchAt: timer.switchAt
  }, config, 2500);
  assert.equal(messages(stale).length, 0);

  const duplicate = transitionSwitchPolicy(stale.state, {
    source: "switch",
    payload: {state: false}
  }, config, 3000);
  assert.equal(duplicate.effects.some((effect) => effect.kind === "schedule-switch-timer"), false);
  assert.equal(duplicate.traces.at(-1)?.reason, "unchanged");
});

test("a second raw edge in the window cancels the toggle and requests full brightness", () => {
  const baseline = transitionSwitchPolicy(undefined, {
    source: "switch",
    payload: {state: false},
    retain: true
  }, config, 1000);
  const first = transitionSwitchPolicy(baseline.state, {
    source: "switch",
    payload: {state: true}
  }, config, 2000);
  const second = transitionSwitchPolicy(first.state, {
    source: "switch",
    payload: {state: false}
  }, config, 2200);

  assert.equal(second.effects.some((effect) => effect.kind === "cancel-switch-timer"), true);
  assert.deepEqual(messages(second)[0]?.lighting.values, {brightnessPct: 100});
  assert.equal(messages(second)[0]?.lighting.manual, true);
});

test("pre-classified actions are immediate and retained actions are inert", () => {
  const retained = transitionSwitchPolicy(undefined, {
    source: "switch-action",
    payload: {action: "double"},
    retain: true
  }, config, 1000);
  assert.equal(messages(retained).length, 0);

  const single = transitionSwitchPolicy(retained.state, {
    source: "switch-action",
    payload: {action: "single"}
  }, config, 2000);
  assert.equal(messages(single)[0]?.lighting.state, "TOGGLE");

  const double = transitionSwitchPolicy(single.state, {
    source: "switch-action",
    payload: {action: "double"}
  }, config, 3000);
  assert.equal(messages(double)[0]?.lighting.state, "ON");
  assert.deepEqual(messages(double)[0]?.lighting.values, {brightnessPct: 100});
  assert.equal(messages(double)[0]?.lighting.manual, true);
});
