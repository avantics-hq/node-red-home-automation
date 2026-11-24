"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  transitionCover,
  type CoverConfig,
  type CoverEvent,
  type CoverMotion,
  type CoverState
} from "../lib/cover-controller";

const config: CoverConfig = {
  positionTolerance: 2,
  invert: false,
  travelTimeoutMs: 30000,
  maxAttempts: 2,
  pollMs: 5000,
  settleMs: 5000
};
const at = (seconds: number): Date =>
  new Date(Date.parse("2026-11-21T16:00:00Z") + seconds * 1000);

function apply(
  state: Partial<CoverState> | undefined,
  cover: CoverEvent,
  seconds = 0,
  overrides: Partial<CoverConfig> = {}
) {
  return transitionCover(state, {cover}, {...config, ...overrides}, at(seconds));
}

function setPosition(state: Partial<CoverState> | undefined, position: number, generation = 1, seconds = 0) {
  return apply(state, {kind: "set_position", requestId: `cover-${generation}`, generation, position, source: "schedule"}, seconds);
}

function observe(
  state: Partial<CoverState> | undefined,
  position: number,
  seconds: number,
  motion?: CoverMotion,
  overrides: Partial<CoverConfig> = {}
) {
  const event: CoverEvent = {kind: "observed", position, observedAt: at(seconds).toISOString()};
  if (motion) event.motion = motion;
  return apply(state, event, seconds, overrides);
}

test("cover commands a semantic position and confirms from a fresh settled observation", () => {
  let result = setPosition(undefined, 40);
  assert.deepEqual(result.commands, [{
    operation: "set_position",
    requestId: "cover-1",
    generation: 1,
    position: 40,
    attempt: 1
  }]);
  assert.equal(result.state.phase, "moving");
  assert.equal(result.state.desired?.source, "schedule");

  result = apply(result.state, {kind: "command_result", generation: 1, ok: true}, 0.1);
  assert.notEqual(result.events[0]?.theatre.status, "ready");

  result = observe(result.state, 41, 10, "closing");
  assert.equal(result.state.phase, "moving");

  result = observe(result.state, 41, 12, "stopped");
  assert.equal(result.state.phase, "ready");
  assert.equal(result.events[0]?.theatre.status, "ready");
  assert.equal(result.events[0]?.theatre.target, "cover");
  assert.equal(result.events[0]?.theatre.details.observedPosition, 41);
});

test("open and close map to 100 and 0", () => {
  const opened = apply(undefined, {kind: "open", requestId: "cover-open", generation: 1});
  assert.equal(opened.commands[0]?.position, 100);
  const closed = apply(opened.state, {kind: "close", requestId: "cover-close", generation: 2});
  assert.equal(closed.commands[0]?.position, 0);
  assert.equal(closed.state.desired?.position, 0);
});

test("observations older than the command or out of order cannot confirm", () => {
  let result = setPosition(undefined, 0, 1, 10);

  result = observe(result.state, 0, 5);
  assert.equal(result.state.phase, "moving");
  assert.equal(result.traces.at(-1)?.reason, "stale-observation");

  result = observe(result.state, 50, 20, "closing");
  // A report observed at 15 s that arrives after the 20 s one.
  result = apply(result.state, {kind: "observed", position: 0, observedAt: at(15).toISOString()}, 21);
  assert.equal(result.state.phase, "moving");
  assert.equal(result.state.observed?.position, 50);
  assert.equal(result.traces.at(-1)?.reason, "out-of-order");
});

test("polling, retries and travel time are bounded", () => {
  let result = setPosition(undefined, 100);
  result = apply(result.state, {kind: "tick", generation: 1}, 5);
  assert.deepEqual(result.commands.map(({operation}) => operation), ["observe"]);

  result = apply(result.state, {kind: "tick", generation: 1}, 30);
  assert.equal(result.commands[0]?.operation, "set_position");
  assert.equal(result.commands[0]?.attempt, 2);

  // An observation that predates the retry cannot confirm it.
  result = observe(result.state, 100, 29);
  assert.equal(result.state.phase, "moving");

  result = apply(result.state, {kind: "tick", generation: 1}, 60);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "travel-timeout");
  assert.equal(result.events[0]?.theatre.details.metrics.retries, 1);

  result = apply(result.state, {kind: "tick", generation: 1}, 70);
  assert.equal(result.commands.length, 0);
  result = apply(result.state, {kind: "startup"}, 71);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "failed");
});

test("a failed command result retries once then fails", () => {
  let result = setPosition(undefined, 100);
  result = apply(result.state, {kind: "command_result", generation: 1, ok: false, reason: "publish-failed"}, 1);
  assert.equal(result.commands[0]?.attempt, 2);
  result = apply(result.state, {kind: "command_result", generation: 1, ok: false, reason: "publish-failed"}, 2);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "publish-failed");
});

test("stop mid-travel confirms on reported stop and keeps the stopped position", () => {
  let result = setPosition(undefined, 100);
  result = observe(result.state, 30, 5, "opening");
  result = apply(result.state, {kind: "stop", requestId: "cover-stop", generation: 2}, 6);
  assert.deepEqual(result.commands, [{operation: "stop", requestId: "cover-stop", generation: 2, attempt: 1}]);
  assert.equal(result.state.phase, "stopping");

  result = observe(result.state, 37, 7, "opening");
  assert.equal(result.state.phase, "stopping");
  result = observe(result.state, 38, 8, "stopped");
  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.desired?.position, 38);
});

test("stop without motion reports confirms once a position holds for the settle interval", () => {
  let result = setPosition(undefined, 0);
  result = apply(result.state, {kind: "stop", requestId: "cover-stop", generation: 2}, 3);
  result = observe(result.state, 60, 4);
  assert.equal(result.state.phase, "stopping");
  result = observe(result.state, 58, 5);
  assert.equal(result.state.phase, "stopping");
  result = observe(result.state, 58, 6);
  assert.equal(result.state.phase, "stopping");
  result = observe(result.state, 58, 10);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.desired?.position, 58);
});

test("manual movement latches ownership without a corrective command; a newer intent resumes", () => {
  let result = setPosition(undefined, 100);
  result = observe(result.state, 100, 20, "stopped");
  assert.equal(result.state.phase, "ready");

  result = observe(result.state, 99, 30);
  assert.equal(result.state.phase, "ready");

  result = observe(result.state, 40, 40, "closing");
  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.commands.length, 0);
  assert.equal(result.events[0]?.theatre.classification, "manual_override");

  result = observe(result.state, 60, 50);
  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.commands.length, 0);

  result = setPosition(result.state, 20, 2, 60);
  assert.equal(result.state.classification, null);
  assert.equal(result.commands[0]?.position, 20);
  result = observe(result.state, 20, 80);
  assert.equal(result.state.phase, "ready");
});

test("newer intents supersede; stale and conflicting generations are inert", () => {
  let result = setPosition(undefined, 100, 3);
  result = setPosition(result.state, 0, 2, 1);
  assert.equal(result.commands.length, 0);
  assert.equal(result.traces.at(-1)?.reason, "stale-generation");

  result = apply(result.state, {kind: "close", requestId: "other", generation: 3}, 2);
  assert.equal(result.commands.length, 0);
  assert.equal(result.traces.at(-1)?.reason, "generation-conflict");

  result = setPosition(result.state, 50, 4, 3);
  assert.equal(result.commands[0]?.position, 50);
  result = apply(result.state, {kind: "tick", generation: 3}, 10);
  assert.equal(result.commands.length, 0);
  result = observe(result.state, 100, 11);
  assert.notEqual(result.state.phase, "ready");
});

test("restart re-observes without replaying a move", () => {
  let result = setPosition(undefined, 70);
  result = apply(result.state, {kind: "startup"}, 5);
  assert.deepEqual(result.commands.map(({operation}) => operation), ["observe"]);
  assert.equal(result.state.phase, "confirming");
  result = observe(result.state, 70, 6);
  assert.equal(result.state.phase, "ready");

  result = apply(result.state, {kind: "refresh"}, 100);
  assert.deepEqual(result.commands.map(({operation}) => operation), ["observe"]);
  result = observe(result.state, 10, 101);
  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.commands.length, 0);
});

test("invert normalises device positions at the boundary", () => {
  const inverted = {invert: true};
  let result = apply(undefined, {kind: "open", requestId: "cover-open", generation: 1}, 0, inverted);
  assert.equal(result.state.desired?.position, 100);
  assert.equal(result.commands[0]?.position, 0);

  result = observe(result.state, 0, 10, "stopped", inverted);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.observed?.position, 100);
  assert.equal(result.events[0]?.theatre.details.observedPosition, 100);
});

test("invalid input is rejected", () => {
  assert.throws(() => setPosition(undefined, 101), /0 to 100/);
  assert.throws(() => apply(undefined, {kind: "open", requestId: "", generation: 1}), /requestId/);
  assert.throws(() => observe(undefined, -1, 1), /0 to 100/);
});

test("a cover stopped short after moving latches manual ownership and is not retried", () => {
  let result = observe(undefined, 100, 0, "stopped");
  result = setPosition(result.state, 0, 1, 1);
  assert.equal(result.events[0]?.theatre.status, "transitioning");

  result = observe(result.state, 80, 5, "closing");
  result = observe(result.state, 60, 10, "stopped");
  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.state.pending, null);
  assert.equal(result.traces.at(-1)?.reason, "stopped-short");
  assert.equal(result.events[0]?.theatre.status, "transitioning");

  result = apply(result.state, {kind: "tick", generation: 1}, 40);
  assert.equal(result.commands.length, 0);

  result = setPosition(result.state, 0, 2, 50);
  assert.equal(result.commands[0]?.position, 0);
  assert.equal(result.state.classification, null);
});

test("a cover without motion reports that stops short is also not retried", () => {
  let result = observe(undefined, 100, 0);
  result = setPosition(result.state, 0, 1, 1);
  result = observe(result.state, 70, 5);
  result = observe(result.state, 60, 10);
  assert.equal(result.state.phase, "moving");
  result = observe(result.state, 60, 15);
  assert.equal(result.state.phase, "manual_override");
  result = apply(result.state, {kind: "tick", generation: 1}, 40);
  assert.equal(result.commands.length, 0);
});

test("a cover that never moved is retried as a lost command", () => {
  let result = observe(undefined, 100, 0, "stopped");
  result = setPosition(result.state, 0, 1, 1);
  result = observe(result.state, 100, 5, "stopped");
  result = observe(result.state, 100, 10, "stopped");
  assert.equal(result.state.phase, "moving");
  result = apply(result.state, {kind: "tick", generation: 1}, 31);
  assert.equal(result.commands[0]?.operation, "set_position");
  assert.equal(result.commands[0]?.attempt, 2);
});

test("target_state status only uses theatre target statuses", () => {
  const allowed = new Set(["discovering", "transitioning", "confirming", "ready", "waiting_for_source", "failed", "unavailable"]);
  let result = setPosition(undefined, 50);
  const statuses = [result.events[0]?.theatre.status];
  result = apply(result.state, {kind: "stop", requestId: "cover-stop", generation: 2}, 1);
  statuses.push(result.events[0]?.theatre.status);
  result = apply(result.state, {kind: "startup"}, 2);
  statuses.push(result.events[0]?.theatre.status);
  result = observe(result.state, 50, 3, "stopped");
  statuses.push(result.events[0]?.theatre.status);
  assert.deepEqual(statuses, ["transitioning", "transitioning", "confirming", "ready"]);
  for (const status of statuses) assert.ok(allowed.has(status!));
});

test("a duplicate report mid-travel without motion does not latch manual ownership", () => {
  // dev-review repro: two equal readings 0.2 s apart while still travelling.
  let result = observe(undefined, 0, 0);
  result = setPosition(result.state, 100, 1, 0.01);
  result = observe(result.state, 30, 5);
  assert.equal(result.traces.at(-1)?.reason, "position-mismatch");
  result = observe(result.state, 30, 5.2);
  assert.equal(result.state.phase, "moving");
  result = observe(result.state, 70, 10);
  result = observe(result.state, 100, 15);
  assert.equal(result.state.phase, "ready");
});

test("a fresh observation at the target returns a manual cover to ready", () => {
  let result = observe(undefined, 0, 0);
  result = setPosition(result.state, 100, 1, 1);
  result = observe(result.state, 30, 5);
  result = observe(result.state, 30, 10);
  assert.equal(result.state.phase, "manual_override");
  result = observe(result.state, 70, 12, "opening");
  assert.equal(result.state.phase, "manual_override");
  result = observe(result.state, 100, 15);
  assert.equal(result.state.phase, "manual_override");
  result = observe(result.state, 100, 20);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.classification, null);
  assert.equal(result.commands.length, 0);

  let reported = observe(undefined, 0, 0);
  reported = setPosition(reported.state, 100, 1, 1);
  reported = observe(reported.state, 30, 5, "stopped");
  assert.equal(reported.state.phase, "manual_override");
  reported = observe(reported.state, 100, 12, "stopped");
  assert.equal(reported.state.phase, "ready");
});

test("a hand move passing through the target does not report ready", () => {
  // dev-review repro: no motion reports, settleMs 5000.
  let result = setPosition(undefined, 50);
  result = observe(result.state, 50, 20);
  assert.equal(result.state.phase, "ready");
  result = observe(result.state, 80, 30);
  assert.equal(result.state.phase, "manual_override");
  result = observe(result.state, 51, 31);
  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.events[0]?.theatre.status, "transitioning");
  result = observe(result.state, 51, 33);
  assert.equal(result.state.phase, "manual_override");
  result = observe(result.state, 20, 34);
  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.commands.length, 0);
  result = observe(result.state, 50, 40);
  result = observe(result.state, 50, 45);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.commands.length, 0);
});

test("restart mid-travel that finds the cover stopped off target latches manual, not a timeout", () => {
  let result = observe(undefined, 0, 0);
  result = setPosition(result.state, 100, 1, 1);
  result = apply(result.state, {kind: "startup"}, 3);
  assert.deepEqual(result.commands.map(({operation}) => operation), ["observe"]);
  result = observe(result.state, 40, 4);
  assert.equal(result.state.phase, "confirming");
  result = observe(result.state, 40, 9);
  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.traces.at(-1)?.reason, "stopped-while-offline");
  result = apply(result.state, {kind: "tick", generation: 1}, 40);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.failure, null);

  let reported = setPosition(undefined, 100, 1, 1);
  reported = apply(reported.state, {kind: "startup"}, 3);
  reported = observe(reported.state, 40, 4, "stopped");
  assert.equal(reported.state.phase, "manual_override");
});

test("a target the cover is already at, and still, is confirmed without a command", () => {
  let result = observe(undefined, 60, 0, "stopped");
  result = setPosition(result.state, 61, 1, 1);
  assert.deepEqual(result.commands, []);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.traces.find(({event}) => event === "intent")?.reason, "already-there");
  // Moving, or not yet seen since the last start: it is commanded.
  const moving = observe(undefined, 60, 0, "opening");
  assert.equal(setPosition(moving.state, 60, 1, 1).commands.length, 1);
  assert.equal(setPosition(undefined, 60).commands.length, 1);
});

test("an automatic target waits while a person's move holds the cover; a plain request takes it back", () => {
  let result = setPosition(undefined, 40);
  result = observe(result.state, 40, 6, "stopped");
  assert.equal(result.state.phase, "ready");
  result = observe(result.state, 80, 60, "stopped");
  assert.equal(result.state.phase, "manual_override");
  const automatic = apply(result.state, {kind: "set_position", requestId: "weather-1", generation: 2, position: 20, respectManual: true}, 70);
  assert.deepEqual(automatic.commands, []);
  assert.equal(automatic.state.phase, "manual_override");
  assert.equal(automatic.traces.at(-1)?.reason, "manual-hold");
  const button = apply(automatic.state, {kind: "close", requestId: "button-1", generation: 2}, 80);
  assert.equal(button.commands[0]?.position, 0);
});

test("battery and charging are kept as reported facts, and moving follows the cover's motion", () => {
  let result = apply(undefined, {kind: "observed", position: 50, motion: "opening", observedAt: at(0).toISOString(), battery: 87, charging: "false"});
  assert.deepEqual([result.state.observed?.battery, result.state.observed?.charging, result.status.moving], [87, "false", true]);
  result = observe(result.state, 70, 5, "stopped");
  assert.deepEqual([result.state.observed?.battery, result.status.moving], [87, false], "a report without battery keeps the last");
  // Without motion reports, moving while a move is unconfirmed.
  const commanded = setPosition(undefined, 30);
  assert.equal(commanded.status.moving, true);
});

test("cover settings are read with the shared readers", () => {
  assert.throws(() => transitionCover(undefined, {cover: {kind: "startup"}}, {travelTimeoutMs: ""} as never, at(0)), /travel timeout must be a number/);
  assert.throws(() => transitionCover(undefined, {cover: {kind: "startup"}}, {positionTolerance: -1}, at(0)), /position tolerance must not be negative/);
  assert.throws(() => transitionCover(undefined, {cover: {kind: "startup"}}, {invert: "maybe"} as never, at(0)), /invert must be on or off/);
});

test("an offline cover is sent nothing and answers requests as unavailable; back online it is read again", () => {
  let result = setPosition(undefined, 40);
  result = observe(result.state, 40, 6, "stopped");
  assert.equal(result.state.phase, "ready");
  result = apply(result.state, {kind: "availability", online: false}, 10);
  assert.deepEqual([result.state.phase, result.state.available, result.commands], ["unavailable", false, []]);
  assert.equal(result.events[0]?.theatre.status, "unavailable");
  const request = setPosition(result.state, 80, 2, 20);
  assert.deepEqual(request.commands, []);
  const answer = request.events.find(({theatre}) => theatre.requestId === "cover-2")?.theatre;
  assert.deepEqual([answer?.status, answer?.failure?.reason], ["unavailable", "unavailable"]);
  assert.equal(request.state.desired?.requestId, "cover-1", "the earlier request is kept");
  // Back online: it reads the cover before trusting anything.
  const online = apply(request.state, {kind: "availability", online: true}, 30);
  assert.deepEqual(online.commands.map(({operation}) => operation), ["observe"]);
  assert.equal(online.state.phase, "confirming");
  assert.equal(observe(online.state, 40, 31, "stopped").state.phase, "ready");
});
