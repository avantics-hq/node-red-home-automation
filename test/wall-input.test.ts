"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  isWallInputSource,
  normaliseWallInputConfig,
  transitionWallInput,
  wallGestureIntent,
  wallInputFor,
  type WallInputConfig,
  type WallInputEffect
} from "../lib/wall-input";

const config: WallInputConfig = {
  switchWindowMs: 500,
  switchFreshnessMs: 60_000
};

function scheduled(result: ReturnType<typeof transitionWallInput>) {
  return result.effects.find(
    (effect): effect is Extract<WallInputEffect, {kind: "schedule-switch-timer"}> =>
      effect.kind === "schedule-switch-timer"
  );
}

test("startup preserves a persisted baseline but exposes it as unconfirmed until a live observation", () => {
  const startup = transitionWallInput({
    baselineKnown: true,
    value: false,
    observedAt: 500,
    sessionObserved: true,
    available: true
  }, {kind: "startup"}, config, 1000);

  assert.equal(startup.gesture, null);
  assert.equal(startup.status.phase, "stale");
  assert.equal(startup.status.reason, "startup-unconfirmed");

  const refresh = transitionWallInput(startup.state, {
    kind: "observation",
    payload: {state: false}
  }, config, 1100);
  assert.equal(refresh.gesture, null);
  assert.equal(refresh.status.phase, "fresh");
  assert.equal(refresh.status.observedAt, 1100);

  const edge = transitionWallInput(refresh.state, {
    kind: "observation",
    payload: {state: true}
  }, config, 1200);
  assert.ok(scheduled(edge));
});

test("a first live edge remains actionable when no persisted or retained baseline exists", () => {
  const first = transitionWallInput(undefined, {
    kind: "observation",
    payload: {state: true}
  }, config, 1000);
  const timer = scheduled(first);
  assert.ok(timer);
  assert.equal(first.status.phase, "fresh");

  const elapsed = transitionWallInput(first.state, {
    kind: "timer",
    generation: timer.generation,
    edgeAt: timer.switchAt
  }, config, 1500);
  assert.equal(elapsed.gesture, "single");
});

test("retained state cancels a pending gesture and is stale without an observation timestamp", () => {
  const baseline = transitionWallInput(undefined, {
    kind: "observation",
    payload: {state: false},
    baseline: true
  }, config, 1000);
  const edge = transitionWallInput(baseline.state, {
    kind: "observation",
    payload: {state: true}
  }, config, 1100);
  assert.ok(scheduled(edge));

  const replay = transitionWallInput(edge.state, {
    kind: "observation",
    payload: {state: false},
    retain: true
  }, config, 1200);
  assert.equal(replay.gesture, null);
  assert.equal(replay.effects.some((effect) => effect.kind === "cancel-switch-timer"), true);
  assert.equal(replay.status.phase, "stale");
  assert.equal(replay.status.reason, "timestamp-unknown");
});

test("reported unavailability invalidates the baseline and recovery re-baselines without a gesture", () => {
  const baseline = transitionWallInput(undefined, {
    kind: "observation",
    payload: {state: false},
    baseline: true
  }, config, 1000);
  const unavailable = transitionWallInput(baseline.state, {
    kind: "availability",
    payload: "offline"
  }, config, 1100);
  assert.equal(unavailable.status.phase, "unavailable");
  assert.equal(unavailable.state.baselineKnown, false);

  const recovered = transitionWallInput(unavailable.state, {
    kind: "observation",
    payload: {state: true}
  }, config, 1200);
  assert.equal(recovered.gesture, null);
  assert.equal(scheduled(recovered), undefined);
  assert.equal(recovered.status.phase, "fresh");
});

test("wall-input sources map to their events", () => {
  assert.equal(isWallInputSource("switch"), true);
  assert.equal(isWallInputSource("switch-action"), false);
  assert.deepEqual(wallInputFor("switch-startup", {}), {kind: "startup"});
  assert.deepEqual(wallInputFor("switch", {payload: true, retain: false, baseline: true, observedAt: "t"}),
    {kind: "observation", payload: true, retain: false, baseline: true, observedAt: "t"});
  assert.deepEqual(wallInputFor("switch-availability", {payload: "online"}), {kind: "availability", payload: "online"});
  assert.deepEqual(wallInputFor("switch-timer", {generation: 3, switchAt: 10}), {kind: "timer", generation: 3, edgeAt: 10});
});

test("a single press toggles, a double press turns fully on as manual", () => {
  assert.deepEqual(wallGestureIntent(["main"], "single"), {
    lighting: {kind: "intent", targets: ["main"], state: "TOGGLE", source: "wall", person: true}
  });
  assert.deepEqual(wallGestureIntent(["main"], "double"), {
    lighting: {kind: "intent", targets: ["main"], state: "ON", source: "wall", person: true, manual: true, values: {brightness: 254}}
  });
});

test("a cancel ends a gesture in progress", () => {
  let result = transitionWallInput(undefined, {kind: "observation", payload: {state: false}, baseline: true}, config, 0);
  result = transitionWallInput(result.state, {kind: "observation", payload: {state: true}}, config, 1000);
  assert.ok(result.state.timerDueAt);
  const cancelled = transitionWallInput(result.state, {kind: "cancel", reason: "explicit-action"}, config, 1100);
  assert.equal(cancelled.state.timerDueAt, null);
  assert.equal(cancelled.state.edgeAt, 0);
  assert.equal(cancelled.state.generation, result.state.generation + 1);
  assert.deepEqual(cancelled.effects, [{kind: "cancel-switch-timer"}]);
  assert.deepEqual(cancelled.traces.map((entry) => entry.reason), ["explicit-action"]);
});

test("wall-input settings default and require a positive freshness", () => {
  assert.deepEqual(normaliseWallInputConfig({}), {switchWindowMs: 500, switchFreshnessMs: 3600000});
  assert.deepEqual(normaliseWallInputConfig({switchWindowMs: "300", switchFreshnessSeconds: "60"}), {switchWindowMs: 300, switchFreshnessMs: 60000});
  assert.throws(() => normaliseWallInputConfig({switchFreshnessSeconds: 0}), /positive/);
});
