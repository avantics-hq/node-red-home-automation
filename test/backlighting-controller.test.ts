"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  transitionBacklighting,
  type BacklightingConfig,
  type BacklightingEvent,
  type BacklightingState
} from "../lib/backlighting-controller";

const config: BacklightingConfig = {
  pollMs: 1000,
  confirmationTimeoutMs: 5000,
  maxAttempts: 2
};
const at = (seconds: number): Date =>
  new Date(Date.parse("2026-11-21T16:00:00Z") + seconds * 1000);

function apply(
  state: Partial<BacklightingState> | undefined,
  backlighting: BacklightingEvent,
  seconds = 0
) {
  return transitionBacklighting(state, {backlighting}, config, at(seconds));
}

function intent(
  state: Partial<BacklightingState> | undefined,
  power: "on" | "off" = "on",
  generation = 1,
  seconds = 0
) {
  return apply(state, {
    kind: "intent",
    requestId: `backlighting-${generation}`,
    generation,
    power
  }, seconds);
}

test("backlighting commands semantic power but waits for observed confirmation", () => {
  let result = intent(undefined);
  assert.deepEqual(result.commands, [{
    operation: "set_power",
    requestId: "backlighting-1",
    generation: 1,
    power: "on",
    attempt: 1
  }]);
  assert.equal(result.state.phase, "transitioning");

  result = apply(result.state, {kind: "command_result", generation: 1, ok: true}, 0.1);
  assert.equal(result.state.phase, "confirming");
  assert.notEqual(result.events[0]?.theatre.status, "ready");

  result = apply(result.state, {
    kind: "observed",
    generation: 1,
    power: "on",
    observedAt: at(0.2).toISOString()
  }, 0.2);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.events[0]?.theatre.status, "ready");
});

test("mismatched, stale and out-of-order observations cannot confirm power", () => {
  let result = intent(undefined, "off", 3);
  result = apply(result.state, {
    kind: "observed",
    generation: 3,
    power: "on",
    observedAt: at(1).toISOString()
  }, 1);
  assert.equal(result.state.phase, "confirming");

  result = apply(result.state, {
    kind: "observed",
    generation: 2,
    power: "off",
    observedAt: at(2).toISOString()
  }, 2);
  assert.notEqual(result.state.phase, "ready");
  assert.equal(result.traces.at(-1)?.reason, "stale-generation");

  result = apply(result.state, {
    kind: "observed",
    generation: 3,
    power: "off",
    observedAt: at(0.5).toISOString()
  }, 2.1);
  assert.equal(result.state.observed?.power, "on");
  assert.equal(result.traces.at(-1)?.reason, "out-of-order");
});

test("backlighting polling and retries are bounded", () => {
  let result = intent(undefined);
  result = apply(result.state, {kind: "tick", generation: 1}, 1);
  assert.equal(result.commands[0]?.operation, "observe");

  result = apply(result.state, {kind: "tick", generation: 1}, 5);
  assert.equal(result.commands[0]?.operation, "set_power");
  assert.equal(result.commands[0]?.attempt, 2);

  result = apply(result.state, {kind: "tick", generation: 1}, 10);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "confirmation-timeout");
});

test("restart queries restored power without replaying a set command", () => {
  const active = intent(undefined);
  const result = apply(active.state, {kind: "startup"}, 1);
  assert.deepEqual(result.commands.map(({operation}) => operation), ["observe"]);
  assert.equal(result.state.phase, "confirming");
  assert.equal(result.state.pending?.operation, "observe");
});

test("new generation supersedes failed backlighting and can recover", () => {
  let result = intent(undefined);
  result = apply(result.state, {kind: "tick", generation: 1}, 5);
  result = apply(result.state, {kind: "tick", generation: 1}, 10);
  assert.equal(result.state.blockedGeneration, 1);

  result = intent(result.state, "off", 2, 11);
  assert.equal(result.state.blockedGeneration, null);
  result = apply(result.state, {
    kind: "observed",
    generation: 2,
    power: "off",
    observedAt: at(12).toISOString()
  }, 12);
  assert.equal(result.state.phase, "ready");
});

test("a node with nothing saved adopts a refresh's wanted power and observes, never commanding it", () => {
  // Started with nothing saved (no context store), mid-activity: the theatre
  // activity controller's refresh carries the activity's wanted values.
  let result = apply(undefined, {kind: "refresh", requestId: "activity-7", generation: 7, power: "on"}, 0);
  assert.equal(result.state.desired?.requestId, "activity-7");
  assert.deepEqual(result.commands.map(({operation}) => operation), ["observe"], "observes; never sets power");
  assert.equal(result.events[0]?.theatre.requestId, "activity-7");
  assert.equal(result.events[0]?.theatre.generation, 7);

  // The device already matches: ready, with nothing sent.
  result = apply(result.state, {kind: "observed", generation: 7, power: "on", observedAt: at(0.5).toISOString()}, 0.5);
  assert.equal(result.events[0]?.theatre.status, "ready");
  assert.deepEqual(result.commands, []);

  // It doesn't match: confirming, never commanded, then failed at the deadline.
  let other = apply(undefined, {kind: "refresh", requestId: "activity-8", generation: 8, power: "on"}, 0);
  other = apply(other.state, {kind: "observed", generation: 8, power: "off", observedAt: at(0.5).toISOString()}, 0.5);
  assert.notEqual(other.events[0]?.theatre.status, "ready");
  other = apply(other.state, {kind: "tick", generation: 8}, 10);
  assert.ok(!other.commands.some(({operation}) => operation === "set_power"));
  assert.equal(other.events[0]?.theatre.status, "failed");

  // A refresh with no values, or for a node that has a request, changes nothing.
  assert.equal(apply(undefined, {kind: "refresh"}, 0).state.desired, null);
  const busy = intent(undefined, "off", 3);
  assert.equal(apply(busy.state, {kind: "refresh", requestId: "activity-9", generation: 9, power: "on"}, 1).state.desired?.requestId, "backlighting-3");
});
