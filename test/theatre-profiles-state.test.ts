"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {OPTIONAL_TARGETS, REQUIRED_TARGETS, TARGETS, matchesExpected, normaliseActivityProfiles} from "../lib/theatre-profiles";
import {createTheatreState, theatreSnapshot} from "../lib/theatre-state";

const profiles = normaliseActivityProfiles({
  tv: {display: {mode: "tv"}, avr: {power: "on"}, source: {action: "activate", sourceId: "streamer", readiness: "required"},
    lighting: {profile: "tv"}, backlighting: {power: "on"}}
});

test("profiles cover every target, and matching compares only what a profile expects", () => {
  assert.deepEqual([...TARGETS].sort(), [...REQUIRED_TARGETS, ...OPTIONAL_TARGETS, "source"].sort());
  assert.equal(matchesExpected({power: "on"}, {power: "on", source: "shield"}), true);
  assert.equal(matchesExpected({power: "on"}, {power: "standby"}), false);
  assert.equal(matchesExpected({mode: {screen: "down"}}, {mode: {screen: "down", lamp: "on"}}), true);
  assert.throws(() => normaliseActivityProfiles({tv: {display: {mode: "tv"}}}), /must define avr/);
});

test("restored state keeps only what the configured profiles allow, and the snapshot carries it", () => {
  const state = createTheatreState({
    desired: {requestId: "r1", generation: 3, activity: "tv", requestedAt: "2026-11-23T18:00:00.000Z"},
    currentActivity: "movie", generation: 3, phase: "ready", availability: "available"
  }, profiles);
  assert.equal(state.desired?.activity, "tv");
  assert.equal(state.currentActivity, "unknown", "an unknown activity is not restored");
  const snapshot = theatreSnapshot(state, "lounge");
  assert.equal(snapshot.kind, "state");
  assert.equal(snapshot.requestId, "r1");
  assert.equal(snapshot.desiredActivity, "tv");
  assert.deepEqual(Object.keys(snapshot.targets).sort(), [...TARGETS].sort());
  assert.equal(snapshot.metrics.requests, 0);
});
