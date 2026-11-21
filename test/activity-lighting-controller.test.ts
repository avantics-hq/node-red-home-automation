"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  normaliseLightingProfiles,
  transitionActivityLighting,
  type ActivityLightingConfig,
  type ActivityLightingEvent,
  type ActivityLightingState
} from "../lib/activity-lighting-controller";

const config: ActivityLightingConfig = {
  profiles: {
    off: {targets: [], values: {}},
    tv: {targets: ["wall", "lamp"], values: {brightness: 64, color_temp: 400}},
    projector: {targets: ["wall"], values: {brightness: 10}}
  },
  confirmationTimeoutMs: 5000,
  maxAttempts: 2
};
const at = (seconds: number): Date =>
  new Date(Date.parse("2026-11-21T16:00:00Z") + seconds * 1000);

function apply(
  state: Partial<ActivityLightingState> | undefined,
  activityLighting: ActivityLightingEvent,
  seconds = 0
) {
  return transitionActivityLighting(state, {activityLighting}, config, at(seconds));
}

function intent(
  state: Partial<ActivityLightingState> | undefined,
  profile = "tv",
  generation = 1,
  seconds = 0
) {
  return apply(state, {
    kind: "intent",
    requestId: `${profile}-${generation}`,
    generation,
    profile
  }, seconds);
}

test("lighting profiles are deployment data with explicit semantic values", () => {
  assert.deepEqual(normaliseLightingProfiles({cinema: {
    targets: ["wall"],
    values: {brightness: 12, effect: "solid"}
  }}), {
    cinema: {targets: ["wall"], values: {brightness: 12, effect: "solid"}}
  });
  assert.throws(
    () => normaliseLightingProfiles({cinema: {targets: ["wall", "wall"], values: {}}}),
    /duplicate targets/
  );
});

test("activity profiles style only active non-manual room lights", () => {
  const result = intent(undefined);
  const command = result.commands[0];
  assert.equal(command?.operation, "apply");
  assert.deepEqual(command?.lighting, {
    kind: "intent",
    targets: ["wall", "lamp"],
    state: "ON",
    values: {brightness: 64, color_temp: 400},
    source: "activity",
    updateOnOnly: true,
    preserveManual: true
  });
  assert.equal(result.state.phase, "transitioning");
  assert.equal(result.events[0]?.theatre.status, "transitioning");
});

test("matching lights confirm while manual and occupancy-off targets remain preserved", () => {
  let result = intent(undefined);
  result = apply(result.state, {
    kind: "observed",
    generation: 1,
    target: "wall",
    on: true,
    values: {brightness: 64, color_temp: 400},
    observedAt: at(1).toISOString()
  }, 1);
  assert.notEqual(result.state.phase, "ready");

  result = apply(result.state, {
    kind: "observed",
    generation: 1,
    target: "lamp",
    on: true,
    manual: true,
    values: {brightness: 254},
    observedAt: at(1.1).toISOString()
  }, 1.1);
  assert.equal(result.state.phase, "ready");
  assert.deepEqual(result.events[0]?.theatre.details, {
    profile: "tv",
    matched: 1,
    preserved: 1,
    expected: 2
  });

  result = intent(result.state, "projector", 2, 2);
  result = apply(result.state, {
    kind: "observed",
    generation: 2,
    target: "wall",
    on: false,
    values: {},
    observedAt: at(2.1).toISOString()
  }, 2.1);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.events[0]?.theatre.details.preserved, 1);
});

test("unavailable or unconfirmed room lighting becomes bounded optional failure evidence", () => {
  let result = intent(undefined);
  result = apply(result.state, {
    kind: "observed",
    generation: 1,
    target: "wall",
    on: false,
    available: false,
    observedAt: at(1).toISOString()
  }, 1);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "lighting-unavailable");

  result = intent(result.state, "tv", 2, 2);
  result = apply(result.state, {kind: "tick", generation: 2}, 7);
  assert.equal(result.commands[0]?.attempt, 2);
  result = apply(result.state, {kind: "tick", generation: 2}, 12);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "confirmation-timeout");
});

test("restart observes restored lighting intent without reapplying a profile", () => {
  const active = intent(undefined);
  const result = apply(active.state, {kind: "startup"}, 1);
  assert.deepEqual(result.commands.map(({operation}) => operation), ["observe"]);
  assert.equal(result.commands[0]?.lighting, undefined);
  assert.equal(result.state.phase, "confirming");
});
