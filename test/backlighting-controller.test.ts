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

  // It doesn't match: a manual override, and never commanded.
  let other = apply(undefined, {kind: "refresh", requestId: "activity-8", generation: 8, power: "on"}, 0);
  other = apply(other.state, {kind: "observed", generation: 8, power: "off", observedAt: at(0.5).toISOString()}, 0.5);
  assert.equal(other.state.phase, "manual_override");
  assert.equal(other.events[0]?.theatre.classification, "manual_override");
  assert.equal(other.traces.find(({outcome}) => outcome === "manual_override")?.reason, "adopted-mismatch");
  other = apply(other.state, {kind: "tick", generation: 8}, 10);
  assert.ok(!other.commands.some(({operation}) => operation === "set_power"));
  // A new explicit request is commanded as usual.
  assert.deepEqual(intent(other.state, "on", 9, 11).commands.map(({operation}) => operation), ["set_power"]);

  // A refresh with no values, or for a node whose request is as new, changes nothing.
  assert.equal(apply(undefined, {kind: "refresh"}, 0).state.desired, null);
  const busy = intent(undefined, "off", 3);
  assert.equal(apply(busy.state, {kind: "refresh", requestId: "activity-3", generation: 3, power: "on"}, 1).state.desired?.requestId, "backlighting-3");
  assert.equal(apply(busy.state, {kind: "refresh", requestId: "activity-2", generation: 2, power: "on"}, 1).state.desired?.requestId, "backlighting-3");
  // A newer one is adopted, read-only, as for a node with nothing saved.
  const replaced = apply(busy.state, {kind: "refresh", requestId: "activity-9", generation: 9, power: "on"}, 1);
  assert.equal(replaced.state.desired?.requestId, "activity-9");
  assert.deepEqual(replaced.commands.map(({operation}) => operation), ["observe"]);
});

function readyOn() {
  let result = intent(undefined);
  result = apply(result.state, {kind: "command_result", generation: 1, ok: true}, 0.1);
  result = apply(result.state, {kind: "observed", generation: 1, power: "on", observedAt: at(0.5).toISOString()}, 0.5);
  assert.equal(result.state.phase, "ready");
  return result;
}

test("a refresh of ready backlighting re-reads it without leaving ready; the reading answers", () => {
  let result = apply(readyOn().state, {kind: "refresh", requestId: "backlighting-1", generation: 1, power: "on"}, 30);
  assert.deepEqual(result.commands.map(({operation, generation}) => [operation, generation]), [["observe", 1]]);
  assert.deepEqual(result.events, [], "no target state until the reading answers");
  assert.deepEqual([result.state.phase, result.state.pending, result.state.observed?.power], ["ready", null, "on"]);

  const matching = apply(result.state, {kind: "observed", generation: 1, power: "on", observedAt: at(30.1).toISOString()}, 30.1);
  assert.deepEqual([matching.events[0]?.theatre.status, matching.events[0]?.theatre.observedAt], ["ready", at(30.1).toISOString()]);

  // A different reading classifies as any reading after ready does.
  const differing = apply(result.state, {kind: "observed", generation: 1, power: "off", observedAt: at(30.1).toISOString()}, 30.1);
  assert.equal(differing.state.phase, "manual_override");
  assert.equal(differing.events[0]?.theatre.classification, "manual_override");

  // Unanswered, nothing is left waiting: still ready, and the next refresh does the same.
  const later = apply(result.state, {kind: "tick", generation: 1}, 60);
  assert.deepEqual([later.state.phase, later.state.pending, later.commands], ["ready", null, []]);
  assert.deepEqual(apply(later.state, {kind: "refresh", requestId: "backlighting-1", generation: 1, power: "on"}, 60).commands.map(({operation}) => operation), ["observe"]);
});

test("a refresh of backlighting that isn't ready, and a startup, still re-observe as before", () => {
  const confirming = apply(intent(undefined).state, {kind: "command_result", generation: 1, ok: true}, 0.1);
  const refreshed = apply(confirming.state, {kind: "refresh", requestId: "backlighting-1", generation: 1, power: "on"}, 1);
  assert.deepEqual([refreshed.state.phase, refreshed.state.pending?.operation, refreshed.events[0]?.theatre.status], ["confirming", "observe", "confirming"]);
  const started = apply(readyOn().state, {kind: "startup"}, 30);
  assert.deepEqual([started.state.phase, started.state.pending?.operation, started.state.observed], ["confirming", "observe", null]);
});

test("after carrying on, the command result and reading for the replaced generation still count", () => {
  let result = intent(undefined, "on", 1);
  result = apply(result.state, {kind: "refresh", requestId: "recovery-2", generation: 2, power: "on"}, 0.1);
  assert.deepEqual([result.state.generation, result.state.adoptedGeneration], [2, null], "carried on, not adopted");
  result = apply(result.state, {kind: "command_result", generation: 1, ok: true}, 0.2);
  assert.equal(result.traces.at(-1)?.outcome, "accepted");
  result = apply(result.state, {kind: "observed", generation: 1, power: "on", observedAt: at(0.3).toISOString()}, 0.3);
  assert.equal(result.state.phase, "ready");
  assert.deepEqual([result.events[0]?.theatre.status, result.events[0]?.theatre.generation], ["ready", 2]);
  // After a later request, they're stale.
  result = intent(result.state, "off", 3, 1);
  result = apply(result.state, {kind: "observed", generation: 1, power: "on", observedAt: at(1.1).toISOString()}, 1.1);
  assert.equal(result.traces.at(-1)?.reason, "stale-generation");
});

test("ready is stamped with the reading it rests on: a repeated intent doesn't make it fresh, a new reading does", () => {
  let result = readyOn();
  assert.equal(result.events[0]?.theatre.observedAt, at(0.5).toISOString());
  // The same request again, much later, with nothing new read.
  result = intent(result.state, "on", 1, 30);
  assert.deepEqual([result.events[0]?.theatre.status, result.events[0]?.theatre.observedAt], ["ready", at(0.5).toISOString()]);
  // A new reading moves it on.
  result = apply(result.state, {kind: "observed", generation: 1, power: "on", observedAt: at(31).toISOString()}, 31);
  assert.equal(result.events[0]?.theatre.observedAt, at(31).toISOString());
  // Not ready yet: stamped now, as before.
  const confirming = apply(intent(undefined, "on", 2).state, {kind: "command_result", generation: 2, ok: true}, 5);
  assert.deepEqual([confirming.events[0]?.theatre.status, confirming.events[0]?.theatre.observedAt], ["confirming", at(5).toISOString()]);
});

test("the recovery probe: with no request it reads the backlight and answers with its power", () => {
  let result = apply(undefined, {kind: "refresh", requestId: null, generation: 0});
  assert.deepEqual(result.commands, [{operation: "observe", requestId: null, generation: 0, power: null, attempt: 0}]);
  result = apply(result.state, {kind: "observed", generation: 0, power: "on", observedAt: at(1).toISOString()}, 1);
  assert.deepEqual(result.observations.map(({theatre}) => [theatre.target, theatre.values]), [["backlighting", {power: "on"}]]);
  assert.deepEqual([result.commands, result.events], [[], []]);
});
