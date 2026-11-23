"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProjectorPower,
  normaliseConfig,
  transitionDisplay,
  type DisplayCommand,
  type DisplayConfig,
  type DisplayDevice,
  type DisplayInputEvent,
  type DisplayMode,
  type DisplayState
} from "../lib/display-mode-controller";

const config: DisplayConfig = {
  screenOpenPosition: 82,
  screenTolerance: 2,
  pollMs: 1000,
  queryTimeoutMs: 1000,
  tvTimeoutMs: 4000,
  screenTimeoutMs: 5000,
  projectorWarmupMs: 4000,
  projectorMinimumWarmupMs: 3000,
  projectorShutdownConfirmMs: 2000,
  projectorCooldownMs: 5000,
  maxAttempts: 2,
  projectorOnWatts: 20,
  projectorOffWatts: 10
};
const at = (seconds: number): Date =>
  new Date(Date.parse("2026-11-21T12:00:00Z") + seconds * 1000);

type ObservedEvent = Extract<DisplayInputEvent, {kind: "observed"}>;
type ObservationValues = Omit<ObservedEvent, "kind" | "device" | "generation" | "source">;
type Observation = [offset: number, device: DisplayDevice, values: ObservationValues];

function apply(state: Partial<DisplayState> | undefined, display: DisplayInputEvent, seconds: number) {
  return transitionDisplay(state, {display}, config, at(seconds));
}

function observe(
  state: Partial<DisplayState> | undefined,
  device: DisplayDevice,
  values: ObservationValues,
  seconds: number,
  generation = 1
) {
  return apply(state, {kind: "observed", device, generation, source: "test", ...values}, seconds);
}

function command(
  result: ReturnType<typeof transitionDisplay>,
  device: DisplayDevice,
  operation: string
): DisplayCommand | undefined {
  return result.commands.find((entry) => entry.device === device && entry.operation === operation);
}

function discover(mode: DisplayMode, generation: number, observations: Observation[], start = 0) {
  let result = apply(undefined, {kind: "intent", requestId: `${mode}-${generation}`, generation, mode}, start);
  assert.deepEqual(result.commands.map((entry) => entry.device).sort(), ["projector", "screen", "tv"]);
  let state = result.state;
  for (const [offset, device, values] of observations) {
    result = observe(state, device, values, start + offset, generation);
    state = result.state;
  }
  return result;
}

test("projector power classification has hysteresis between standby and lamp-on thresholds", () => {
  assert.equal(classifyProjectorPower(2.1, "unknown", config), "standby");
  assert.equal(classifyProjectorPower(50, "standby", config), "on");
  assert.equal(classifyProjectorPower(15, "on", config), "on");
  assert.equal(classifyProjectorPower(15, "standby", config), "standby");
});

test("TV mode discovers state, requests idempotent Bravia power, and waits for confirmation", () => {
  let result = discover("tv", 1, [
    [0.1, "tv", {power: "standby"}],
    [0.2, "screen", {position: 0, state: "closed"}],
    [0.3, "projector", {watts: 2.1}]
  ]);
  assert.deepEqual(command(result, "tv", "set_power"), {
    device: "tv", operation: "set_power", requestId: "tv-1", generation: 1, attempt: 1, power: "on"
  });
  assert.equal(result.state.phase, "transitioning");

  result = observe(result.state, "tv", {power: "on"}, 0.5);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.events.some((entry) => entry.display.kind === "ready"), true);
});

test("projector mode sequences TV standby, screen position, then observed-state-gated lamp power", () => {
  let result = discover("projector", 1, [
    [0.1, "tv", {power: "on"}],
    [0.2, "screen", {position: 0, state: "closed"}],
    [0.3, "projector", {watts: 2.1}]
  ]);
  assert.equal(command(result, "tv", "set_power")?.power, "standby");

  result = observe(result.state, "tv", {power: "standby"}, 0.5);
  assert.equal(command(result, "screen", "set_position")?.position, 82);

  result = observe(result.state, "screen", {position: 82, state: "stopped"}, 1);
  assert.equal(command(result, "projector", "power_toggle")?.reason, "start");

  result = observe(result.state, "projector", {watts: 155}, 2);
  assert.equal(result.state.phase, "transitioning");

  result = apply(result.state, {kind: "tick", generation: 1}, 4);
  assert.ok(command(result, "projector", "query_power"));
  result = observe(result.state, "projector", {watts: 155}, 4.1);
  assert.equal(result.state.phase, "ready");
});

test("TV mode confirms the projector shutdown prompt before cool-down and only then raises the screen", () => {
  let result = discover("tv", 2, [
    [0.1, "tv", {power: "standby"}],
    [0.2, "screen", {position: 82, state: "stopped"}],
    [0.3, "projector", {watts: 155}]
  ]);
  assert.equal(command(result, "tv", "set_power")?.power, "on");

  result = observe(result.state, "tv", {power: "on"}, 0.5, 2);
  assert.equal(command(result, "projector", "power_toggle")?.reason, "shutdown-request");

  result = apply(result.state, {kind: "tick", generation: 2}, 2.5);
  assert.ok(command(result, "projector", "query_power"));
  assert.equal(result.state.pending?.operation, "projector_shutdown_confirm");

  result = observe(result.state, "projector", {watts: 155}, 2.6, 2);
  assert.equal(command(result, "projector", "power_toggle")?.reason, "shutdown-confirm");
  assert.equal(result.state.pending?.operation, "projector_cooldown");

  result = observe(result.state, "projector", {watts: 2.1}, 4, 2);
  assert.equal(command(result, "screen", "set_position")?.position, 0);

  result = observe(result.state, "screen", {position: 0, state: "closed"}, 5, 2);
  assert.equal(result.state.phase, "ready");
});

test("a newer display request supersedes pending work and stale observations cannot command equipment", () => {
  let result = discover("projector", 1, [
    [0.1, "tv", {power: "standby"}],
    [0.2, "screen", {position: 0, state: "closed"}],
    [0.3, "projector", {watts: 2.1}]
  ]);
  result = apply(result.state, {kind: "intent", requestId: "tv-2", generation: 2, mode: "tv"}, 1);
  assert.equal(result.events.some((entry) => entry.display.kind === "superseded"), true);
  assert.deepEqual(result.commands.map((entry) => entry.operation).sort(), ["query_position", "query_power", "query_power"]);

  result = observe(result.state, "screen", {position: 82, state: "stopped"}, 1.1, 1);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.seen.screen, false);
});

test("projector start confirmation times out without issuing a second blind power toggle", () => {
  let result = discover("projector", 1, [
    [0.1, "tv", {power: "standby"}],
    [0.2, "screen", {position: 82, state: "stopped"}],
    [0.3, "projector", {watts: 2.1}]
  ]);
  assert.equal(command(result, "projector", "power_toggle")?.reason, "start");

  result = apply(result.state, {kind: "tick", generation: 1}, 4.3);
  assert.equal(result.commands.filter((entry) => entry.operation === "power_toggle").length, 0);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "confirmation-timeout");
});

test("startup re-queries all devices and preserves a failed generation as blocked", () => {
  let result = discover("projector", 1, [
    [0.1, "tv", {power: "standby"}],
    [0.2, "screen", {position: 82, state: "stopped"}],
    [0.3, "projector", {watts: 2.1}]
  ]);
  result = apply(result.state, {kind: "tick", generation: 1}, 4.3);
  result = apply(result.state, {kind: "startup"}, 5);
  assert.equal(result.commands.length, 3);
  assert.equal(result.state.blockedGeneration, 1);
});

test("unsolicited display changes latch manual ownership without corrective commands", () => {
  let result = discover("tv", 7, [
    [0.1, "tv", {power: "on"}],
    [0.2, "screen", {position: 0, state: "closed"}],
    [0.3, "projector", {watts: 2.1}]
  ]);
  assert.equal(result.state.phase, "ready");

  result = observe(result.state, "tv", {power: "standby"}, 1, 7);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.state.classification, "manual_override");
  assert.equal(result.events.some(({display}) => display.kind === "manual_override"), true);

  result = apply(result.state, {
    kind: "intent",
    requestId: "off-8",
    generation: 8,
    mode: "off"
  }, 2);
  assert.equal(result.state.classification, null);
  assert.deepEqual(result.commands.map(({operation}) => operation).sort(), [
    "query_position",
    "query_power",
    "query_power"
  ]);
});

// Answers every projector power query instantly (a zero-latency relay) and
// ticks every 100 ms, counting projector queries and power toggles.
function runProjector(
  result: ReturnType<typeof transitionDisplay>,
  from: number,
  to: number,
  watts: (seconds: number) => number,
  generation = 1
) {
  let queries = 0;
  let toggles = 0;
  let steps = 0;
  const count = (entry: ReturnType<typeof transitionDisplay>) => {
    queries += entry.commands.filter((item) => item.device === "projector" && item.operation === "query_power").length;
    toggles += entry.commands.filter((item) => item.operation === "power_toggle").length;
  };
  for (let tick = from; tick < to; tick = Math.round((tick + 0.1) * 10) / 10) {
    result = apply(result.state, {kind: "tick", generation}, tick);
    count(result);
    while (result.commands.some((item) => item.device === "projector" && item.operation === "query_power")) {
      assert.ok(++steps < 2000, "projector queries keep answering each other");
      result = observe(result.state, "projector", {watts: watts(tick)}, tick, generation);
      count(result);
    }
  }
  return {result, queries, toggles};
}

test("a projector reading between the power thresholds re-polls at pollMs, not in a loop", () => {
  // dev-review repro: 869 queries in 1 s at 15 W.
  const start = discover("projector", 1, [
    [0.1, "tv", {power: "standby"}],
    [0.2, "screen", {position: 82, state: "stopped"}],
    [0.3, "projector", {watts: 15}]
  ]);
  assert.equal(start.state.pending?.operation, "projector_settle");
  const {queries, toggles, result} = runProjector(start, 0.4, 3.4, () => 15);
  assert.ok(queries <= 3, `${queries} queries in 3 s at pollMs 1 s`);
  assert.equal(toggles, 0);
  assert.equal(result.state.phase, "transitioning");
});

test("an in-band projector that settles on becomes ready without a toggle", () => {
  const start = discover("projector", 1, [
    [0.1, "tv", {power: "standby"}],
    [0.2, "screen", {position: 82, state: "stopped"}],
    [0.3, "projector", {watts: 15}]
  ]);
  const {result, toggles} = runProjector(start, 0.4, 3.4, (seconds) => (seconds < 1.5 ? 15 : 155));
  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.pending, null);
  assert.equal(toggles, 0);
});

test("an in-band projector that settles in standby follows the standby path", () => {
  // Off mode: a cooling projector that reaches standby needs nothing more.
  const start = discover("off", 1, [
    [0.1, "tv", {power: "standby"}],
    [0.2, "screen", {position: 0, state: "closed"}],
    [0.3, "projector", {watts: 15}]
  ]);
  assert.equal(start.state.pending?.operation, "projector_settle");
  const {result, toggles} = runProjector(start, 0.4, 3.4, (seconds) => (seconds < 1.5 ? 15 : 2));
  assert.equal(result.state.phase, "ready");
  assert.equal(toggles, 0);
});

test("a projector stuck between the power thresholds fails at the deadline", () => {
  const start = discover("projector", 1, [
    [0.1, "tv", {power: "standby"}],
    [0.2, "screen", {position: 82, state: "stopped"}],
    [0.3, "projector", {watts: 15}]
  ]);
  // Deadline: the longer of warm-up (4 s) and cool-down (5 s) after the reading.
  const {result, queries, toggles} = runProjector(start, 0.4, 6, () => 15);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "projector-power-unsettled");
  assert.equal(result.state.failure?.operation, "projector_settle");
  assert.ok(queries <= 6, `${queries} queries before the deadline`);
  assert.equal(toggles, 0);
});

test("an older display reading cannot override a newer one", () => {
  // Overlapping polls: a TV standby report taken before the latest "on" arrives late.
  let result = discover("tv", 1, [
    [0.1, "tv", {power: "on", observedAt: at(0.1).toISOString()}],
    [0.2, "screen", {position: 0, state: "closed", observedAt: at(0.2).toISOString()}],
    [0.3, "projector", {watts: 2.1, observedAt: at(0.3).toISOString()}]
  ]);
  assert.equal(result.state.phase, "ready");
  result = observe(result.state, "tv", {power: "standby", observedAt: at(0.05).toISOString()}, 2);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.observed.tv?.power, "on");
  assert.equal(result.traces.at(-1)?.reason, "out-of-order");
});

test("unusable timing settings fall back to their defaults, keeping valid zeros", () => {
  const normalised = transitionDisplay(undefined, {display: {kind: "startup"}}, {pollMs: "soon" as never, screenTolerance: 0, projectorMinimumWarmupMs: 0}, at(0));
  assert.equal(normalised.state.pending, null);
  const config = normaliseConfig({pollMs: "soon" as never, queryTimeoutMs: Number.NaN, screenTolerance: 0, projectorMinimumWarmupMs: 0});
  assert.equal(config.pollMs, 2000);
  assert.equal(config.queryTimeoutMs, 5000);
  assert.equal(config.screenTolerance, 0);
  assert.equal(config.projectorMinimumWarmupMs, 0);
});

const targetStatus = (result: ReturnType<typeof transitionDisplay>) =>
  result.targetStates.map(({theatre}) => theatre.status);

test("the display reports target state for the theatre activity controller", () => {
  let result = apply(undefined, {kind: "intent", requestId: "tv-1", generation: 1, mode: "tv"}, 0);
  assert.deepEqual(result.targetStates.map(({theatre}) => [theatre.kind, theatre.target, theatre.requestId, theatre.generation, theatre.status]), [
    ["target_state", "display", "tv-1", 1, "discovering"]
  ]);
  result = discover("tv", 1, [
    [0.1, "tv", {power: "on"}],
    [0.2, "screen", {position: 0, state: "closed"}],
    [0.3, "projector", {watts: 2.1}]
  ]);
  assert.equal(result.state.phase, "ready");
  assert.deepEqual(targetStatus(result), ["ready"]);
  // Stamped with the oldest of the readings that confirm it.
  assert.equal(result.targetStates[0]?.theatre.observedAt, at(0.1).toISOString());

  // A tick while settled claims nothing new.
  assert.deepEqual(targetStatus(apply(result.state, {kind: "tick", generation: 1}, 30)), []);

  // An unsolicited change is reported as manual override, not ready.
  const manual = observe(result.state, "tv", {power: "standby"}, 31);
  assert.equal(manual.targetStates[0]?.theatre.status, "transitioning");
  assert.equal(manual.targetStates[0]?.theatre.classification, "manual_override");
});

test("a display refresh is answered from fresh readings", () => {
  let result = discover("tv", 1, [
    [0.1, "tv", {power: "on"}],
    [0.2, "screen", {position: 0, state: "closed"}],
    [0.3, "projector", {watts: 2.1}]
  ]);
  result = apply(result.state, {kind: "refresh"}, 40);
  assert.deepEqual(result.commands.map(({device, operation}) => [device, operation]), [
    ["tv", "query_power"], ["screen", "query_position"], ["projector", "query_power"]
  ]);
  // No ready claim until a reading arrives.
  assert.deepEqual(targetStatus(result), []);
  assert.equal(result.state.phase, "ready");
  // Each reading re-sends ready, stamped with the oldest device reading the
  // mode relies on: one answered device does not make the display fresh.
  result = observe(result.state, "tv", {power: "on"}, 40.2);
  assert.deepEqual(targetStatus(result), ["ready"]);
  assert.equal(result.targetStates[0]?.theatre.observedAt, at(0.2).toISOString());
  result = observe(result.state, "screen", {position: 0, state: "closed"}, 40.3);
  assert.equal(result.targetStates[0]?.theatre.observedAt, at(0.3).toISOString());
  result = observe(result.state, "projector", {watts: 2.1}, 40.4);
  assert.equal(result.targetStates[0]?.theatre.observedAt, at(40.2).toISOString());

  // A failed refresh query does not fail a settled display.
  const failed = apply(result.state, {kind: "transport_failed", device: "screen", operation: "query_position", generation: 1, reason: "timeout"}, 41);
  assert.equal(failed.state.phase, "ready");

  // Before it is settled, a refresh reports where it is.
  const early = apply(undefined, {kind: "intent", requestId: "tv-2", generation: 2, mode: "tv"}, 50);
  assert.deepEqual(targetStatus(apply(early.state, {kind: "refresh"}, 51)), ["discovering"]);
});
