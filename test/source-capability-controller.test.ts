"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  normaliseCapabilities,
  transitionSource,
  type SourceAction,
  type SourceConfig,
  type SourceEvent,
  type SourceOutputEvent,
  type SourceState
} from "../lib/source-capability-controller";

const config: SourceConfig = {
  sources: {
    streamer: {activation: "command", deactivation: "command", confirmation: "active"},
    console: {activation: "external", deactivation: "unavailable", confirmation: "available"},
    legacy: {activation: "unavailable", deactivation: "unavailable", confirmation: "unavailable"}
  },
  pollMs: 1000,
  confirmationTimeoutMs: 5000,
  maxAttempts: 2
};
const at = (seconds: number): Date =>
  new Date(Date.parse("2026-11-21T15:00:00Z") + seconds * 1000);

function apply(state: Partial<SourceState> | undefined, sourceCapability: SourceEvent, seconds = 0) {
  return transitionSource(state, {sourceCapability}, config, at(seconds));
}

function intent(
  state: Partial<SourceState> | undefined,
  sourceId: string | null,
  action: SourceAction = "activate",
  generation = 1,
  seconds = 0
) {
  return apply(state, {
    kind: "intent",
    requestId: `${sourceId}-${action}-${generation}`,
    generation,
    sourceId,
    action
  }, seconds);
}

function observed(
  state: Partial<SourceState> | undefined,
  sourceId: string,
  status: "active" | "inactive" | "available" | "unavailable" | "unknown",
  generation: number,
  seconds: number
) {
  return apply(state, {
    kind: "observed",
    sourceId,
    status,
    generation,
    observedAt: at(seconds).toISOString()
  }, seconds);
}

function theatreState(result: ReturnType<typeof transitionSource>): SourceOutputEvent["theatre"] {
  const theatre = result.events.at(-1)?.theatre;
  assert.ok(theatre);
  return theatre;
}

test("capabilities are deployment data and reject incomplete descriptors", () => {
  assert.deepEqual(normaliseCapabilities({disc_player: {
    activation: "command",
    deactivation: "external",
    confirmation: "available"
  }}), {
    disc_player: {activation: "command", deactivation: "external", confirmation: "available"}
  });
  assert.throws(
    () => normaliseCapabilities({disc_player: {activation: "command", deactivation: "external"}}),
    /confirmation capability/
  );
});

test("a controllable source wakes and becomes ready only after observation", () => {
  let result = intent(undefined, "streamer");
  assert.deepEqual(result.commands, [{
    sourceId: "streamer",
    operation: "activate",
    requestId: "streamer-activate-1",
    generation: 1,
    attempt: 1
  }]);
  assert.equal(result.state.phase, "transitioning");
  assert.equal(theatreState(result).status, "transitioning");

  result = apply(result.state, {
    kind: "command_result",
    sourceId: "streamer",
    generation: 1,
    ok: true
  }, 0.1);
  assert.equal(result.state.phase, "confirming");
  assert.notEqual(result.state.phase, "ready");

  result = observed(result.state, "streamer", "active", 1, 0.2);
  assert.equal(result.state.phase, "ready");
  assert.equal(theatreState(result).status, "ready");
});

test("an externally controlled observable source waits and recovers", () => {
  let result = intent(undefined, "console");
  assert.equal(result.state.phase, "waiting_for_source");
  assert.equal(result.commands[0]?.operation, "observe");
  assert.equal(theatreState(result).status, "waiting_for_source");

  result = observed(result.state, "console", "inactive", 1, 1);
  assert.equal(result.state.phase, "waiting_for_source");
  result = observed(result.state, "console", "available", 1, 2);
  assert.equal(result.state.phase, "ready");
});

test("an unobservable source reports unavailable instead of invented readiness", () => {
  const result = intent(undefined, "legacy");
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "unavailable");
  assert.equal(result.state.failure?.reason, "unobservable-source");
  assert.equal(theatreState(result).status, "unavailable");
});

test("deactivation with no known active source is explicitly unavailable", () => {
  let result = intent(undefined, null, "deactivate");
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "unavailable");
  assert.equal(result.state.failure?.reason, "unknown-active-source");

  result = apply(result.state, {kind: "startup"}, 1);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.failure?.reason, "unknown-active-source");
});

test("a controllable source stop waits for an inactive observation", () => {
  let result = intent(undefined, "streamer", "deactivate");
  assert.equal(result.commands[0]?.operation, "deactivate");
  assert.equal(result.state.phase, "transitioning");

  result = observed(result.state, "streamer", "inactive", 1, 1);
  assert.equal(result.state.phase, "ready");
  assert.equal(theatreState(result).action, "deactivate");
});

test("unsupported stop is an optional-target degradation, not false success", () => {
  const active = intent(undefined, "console");
  const result = intent(active.state, "console", "deactivate", 2, 1);
  assert.equal(result.state.phase, "unavailable");
  assert.equal(result.state.failure?.reason, "unsupported-deactivation");
});

test("confirmation polling and activation retries are bounded", () => {
  let result = intent(undefined, "streamer");
  result = apply(result.state, {kind: "tick", generation: 1}, 1);
  assert.equal(result.commands[0]?.operation, "observe");
  assert.equal(result.commands[0]?.attempt, 1);

  result = apply(result.state, {kind: "tick", generation: 1}, 5);
  assert.equal(result.commands[0]?.operation, "activate");
  assert.equal(result.commands[0]?.attempt, 2);

  result = apply(result.state, {kind: "tick", generation: 1}, 10);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "confirmation-timeout");
});

test("stale and out-of-order observations cannot satisfy a newer request", () => {
  let result = intent(undefined, "streamer", "activate", 1);
  result = intent(result.state, "streamer", "activate", 2, 0.1);
  result = observed(result.state, "streamer", "active", 1, 1);
  assert.notEqual(result.state.phase, "ready");
  assert.equal(result.traces.at(-1)?.reason, "stale-generation");

  result = observed(result.state, "streamer", "inactive", 2, 3);
  result = observed(result.state, "streamer", "active", 2, 2);
  assert.equal(result.state.observed?.status, "inactive");
  assert.equal(result.traces.at(-1)?.reason, "out-of-order");
});

test("startup re-queries restored intent without replaying a command", () => {
  const active = intent(undefined, "streamer");
  const result = apply(active.state, {kind: "startup"}, 1);
  assert.deepEqual(result.commands.map(({operation}) => operation), ["observe"]);
  assert.equal(result.state.phase, "confirming");
  assert.equal(result.state.pending, null);
});
