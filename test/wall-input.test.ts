"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  transitionWallInput,
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

test("a deployment without persisted state establishes an inert first baseline", () => {
  const first = transitionWallInput(undefined, {
    kind: "observation",
    payload: {state: true}
  }, config, 1000);
  assert.equal(first.gesture, null);
  assert.equal(scheduled(first), undefined);
  assert.equal(first.status.phase, "fresh");

  const edge = transitionWallInput(first.state, {
    kind: "observation",
    payload: {state: false}
  }, config, 1100);
  assert.ok(scheduled(edge));
});

test("retained state cancels a pending gesture and is stale without an observation timestamp", () => {
  const baseline = transitionWallInput(undefined, {
    kind: "observation",
    payload: {state: false}
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
    payload: {state: false}
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
