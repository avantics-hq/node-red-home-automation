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

test("projector mode starts the lamp first, then opens the screen, and puts the TV in standby last", () => {
  let result = discover("projector", 1, [
    [0.1, "tv", {power: "on"}],
    [0.2, "screen", {position: 0, state: "closed"}],
    [0.3, "projector", {watts: 2.1}]
  ]);
  // The TV keeps the picture while the lamp warms up.
  assert.deepEqual(result.commands.map(({device, operation}) => [device, operation]), [["projector", "power_toggle"]]);
  assert.equal(command(result, "projector", "power_toggle")?.reason, "start");

  result = observe(result.state, "projector", {watts: 155}, 2);
  assert.equal(result.state.phase, "transitioning");
  assert.deepEqual(result.commands, [], "nothing more until the minimum warm-up has passed");

  result = apply(result.state, {kind: "tick", generation: 1}, 4);
  assert.ok(command(result, "projector", "query_power"));
  result = observe(result.state, "projector", {watts: 155}, 4.1);
  assert.equal(command(result, "screen", "set_position")?.position, 82);
  assert.equal(command(result, "tv", "set_power"), undefined, "the TV stays on while the screen moves");

  result = observe(result.state, "screen", {position: 82, state: "stopped"}, 5);
  assert.equal(command(result, "tv", "set_power")?.power, "standby");

  result = observe(result.state, "tv", {power: "standby"}, 5.5);
  assert.equal(result.state.phase, "ready");
});

test("a projector that fails to start fails the display with the TV still on and the screen untouched", () => {
  let result = discover("projector", 1, [
    [0.1, "tv", {power: "on"}],
    [0.2, "screen", {position: 0, state: "closed"}],
    [0.3, "projector", {watts: 2.1}]
  ]);
  const sent = [...result.commands];
  result = observe(result.state, "projector", {watts: 2.1}, 2);
  sent.push(...result.commands);
  result = apply(result.state, {kind: "tick", generation: 1}, 4.3);
  sent.push(...result.commands);
  assert.equal(result.state.phase, "failed");
  assert.deepEqual(result.state.failure && [result.state.failure.device, result.state.failure.operation], ["projector", "projector_start"]);
  assert.deepEqual(sent.filter(({device}) => device !== "projector"), [], "no TV or screen command");
  assert.equal(result.state.observed.tv?.power, "on");
});

test("back to TV mode mid-warm-up: the warming lamp isn't toggled, and the TV never leaves the picture", () => {
  let result = discover("projector", 1, [
    [0.1, "tv", {power: "on"}],
    [0.2, "screen", {position: 0, state: "closed"}],
    [0.3, "projector", {watts: 2.1}]
  ]);
  assert.equal(command(result, "projector", "power_toggle")?.reason, "start");
  result = observe(result.state, "projector", {watts: 155}, 1);

  // A TV request 1 s into the warm-up, read back as the lamp still warming.
  result = apply(result.state, {kind: "intent", requestId: "tv-2", generation: 2, mode: "tv"}, 1.5);
  const sent = [...result.commands];
  for (const [seconds, device, values] of [[1.6, "tv", {power: "on"}], [1.6, "screen", {position: 0, state: "closed"}], [1.6, "projector", {watts: 155}]] as const) {
    result = observe(result.state, device, values, seconds, 2);
    sent.push(...result.commands);
  }
  result = apply(result.state, {kind: "tick", generation: 2}, 2.5);
  sent.push(...result.commands);
  assert.deepEqual(sent.filter(({operation}) => operation === "power_toggle"), [], "no toggle while the lamp warms");
  assert.deepEqual(sent.filter(({device, operation}) => device === "tv" && operation === "set_power"), [], "the TV is never sent to standby");

  // Once the minimum warm-up has passed and the lamp reads on, it is shut down as TV mode does.
  result = apply(result.state, {kind: "tick", generation: 2}, 3.3);
  result = observe(result.state, "projector", {watts: 155}, 3.4, 2);
  assert.equal(command(result, "projector", "power_toggle")?.reason, "shutdown-request");
});

test("a kept projector start that never confirms doesn't fail the newer request: it carries on from a fresh reading", () => {
  // The start toggle is missed (say, an infrared command not received), so the lamp stays in standby.
  let result = discover("projector", 1, [
    [0.1, "tv", {power: "on"}],
    [0.2, "screen", {position: 0, state: "closed"}],
    [0.3, "projector", {watts: 2.1}]
  ]);
  assert.equal(command(result, "projector", "power_toggle")?.reason, "start");
  result = apply(result.state, {kind: "intent", requestId: "tv-2", generation: 2, mode: "tv"}, 1);
  for (const [device, values] of [["tv", {power: "on"}], ["screen", {position: 0, state: "closed"}], ["projector", {watts: 2.1}]] as const) {
    result = observe(result.state, device, values, 1.1, 2);
  }
  assert.equal(result.state.pending?.operation, "projector_start", "kept while it may still be warming");

  // Past the start's deadline: dropped, and the projector asked again under the TV request.
  result = apply(result.state, {kind: "tick", generation: 2}, 4.3);
  assert.notEqual(result.state.phase, "failed");
  assert.deepEqual(result.commands.map(({device, operation, generation}) => [device, operation, generation]), [["projector", "query_power", 2]]);
  assert.ok(result.traces.some(({reason}) => reason === "superseded-operation-unconfirmed"));
  result = observe(result.state, "projector", {watts: 2.1}, 4.4, 2);
  assert.equal(result.state.phase, "ready");
  assert.deepEqual(result.commands.filter(({operation}) => operation === "power_toggle"), []);
});

test("back to TV mode while the screen opens: the TV stays on, the lamp is shut down and the screen closes", () => {
  let result = discover("projector", 1, [
    [0.1, "tv", {power: "on"}],
    [0.2, "screen", {position: 0, state: "closed"}],
    [0.3, "projector", {watts: 155}]
  ]);
  assert.equal(command(result, "screen", "set_position")?.position, 82);

  result = apply(result.state, {kind: "intent", requestId: "tv-2", generation: 2, mode: "tv"}, 1);
  const sent = [...result.commands];
  for (const [device, values] of [["tv", {power: "on"}], ["screen", {position: 40, state: "opening"}], ["projector", {watts: 155}]] as const) {
    result = observe(result.state, device, values, 1.1, 2);
    sent.push(...result.commands);
  }
  assert.deepEqual(sent.filter(({device, operation}) => device === "tv" && operation === "set_power"), []);
  assert.equal(command(result, "projector", "power_toggle")?.reason, "shutdown-request");

  result = apply(result.state, {kind: "tick", generation: 2}, 3.1);
  assert.ok(command(result, "projector", "query_power"));
  result = observe(result.state, "projector", {watts: 155}, 3.2, 2);
  assert.equal(command(result, "projector", "power_toggle")?.reason, "shutdown-confirm");
  result = observe(result.state, "projector", {watts: 2.1}, 5, 2);
  assert.equal(command(result, "screen", "set_position")?.position, 0);
  result = observe(result.state, "screen", {position: 0, state: "closed"}, 6, 2);
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

test("unusable timing settings are an error naming the setting; valid zeros are kept", () => {
  assert.throws(() => transitionDisplay(undefined, {display: {kind: "startup"}}, {pollMs: "soon" as never}, at(0)), /poll interval must be a number/);
  assert.throws(() => normaliseConfig({queryTimeoutMs: Number.NaN}), /query timeout must be a number/);
  const config = normaliseConfig({screenTolerance: 0, projectorMinimumWarmupMs: 0});
  assert.equal(config.pollMs, 2000, "absent: the default");
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

test("a retry after a transport failure gets its own full deadline", () => {
  // The TV is off; tv mode sends set_power, which has 4 s to confirm.
  let result = discover("tv", 1, [
    [0.1, "tv", {power: "standby"}],
    [0.2, "screen", {position: 0, state: "closed"}],
    [0.3, "projector", {watts: 2.1}]
  ]);
  assert.equal(result.state.pending?.device, "tv");
  const operation = result.state.pending!.command.operation;
  // The command's transport fails just before its deadline.
  result = apply(result.state, {kind: "transport_failed", device: "tv", operation, generation: 1, reason: "timeout"}, 3.9);
  assert.equal(result.state.pending?.attempt, 2);
  assert.equal(result.state.pending?.deadlineAt, at(3.9).getTime() + config.tvTimeoutMs);
  // So the retry is not given up on a tenth of a second later.
  result = apply(result.state, {kind: "tick", generation: 1}, 4.5);
  assert.notEqual(result.state.phase, "failed");
});

test("a display with nothing saved adopts a refresh's wanted mode and rediscovers, sending nothing when it matches", () => {
  let result = apply(undefined, {kind: "refresh", requestId: "activity-4", generation: 4, mode: "projector"}, 0);
  assert.equal(result.state.desired?.mode, "projector");
  assert.deepEqual(result.commands.map(({operation}) => operation).sort(), ["query_position", "query_power", "query_power"],
    "discovery queries only");
  // The projector is already running, the screen down and the TV in standby.
  result = observe(result.state, "tv", {power: "standby"}, 0.1, 4);
  result = observe(result.state, "screen", {position: 82, state: "stopped"}, 0.2, 4);
  result = observe(result.state, "projector", {watts: 155}, 0.3, 4);
  assert.ok(!result.commands.some(({operation}) => operation === "set_power" || operation === "toggle_power" || operation.startsWith("move")),
    JSON.stringify(result.commands));
  assert.equal(result.state.phase, "ready");
  assert.equal(result.targetStates.at(-1)?.theatre.requestId, "activity-4");
});

test("an adopted request the display doesn't match is a manual override: no toggle, no screen move", () => {
  let result = apply(undefined, {kind: "refresh", requestId: "activity-6", generation: 6, mode: "projector"}, 0);
  const sent = [...result.commands];
  // Someone is watching TV: TV on, screen up, projector off.
  for (const [seconds, device, values] of [[0.1, "tv", {power: "on"}], [0.2, "screen", {position: 0, state: "closed"}], [0.3, "projector", {watts: 2}]] as const) {
    result = observe(result.state, device, values, seconds, 6);
    sent.push(...result.commands);
  }
  for (const seconds of [2, 5, 10]) {
    result = apply(result.state, {kind: "tick", generation: 6}, seconds);
    sent.push(...result.commands);
  }
  assert.deepEqual([...new Set(sent.map(({operation}) => operation))].sort(), ["query_position", "query_power"], "reads only");
  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.targetStates.at(-1)?.theatre.classification ?? result.state.classification, "manual_override");
  // A new explicit request is carried out as usual.
  const next = apply(result.state, {kind: "intent", requestId: "projector-7", generation: 7, mode: "projector"}, 11);
  assert.equal(next.state.desired?.requestId, "projector-7");
});

test("pushed projector power states alone, with every query left unanswered, take the display into and out of projector mode", () => {
  // The projector as an adapter sees it: standby until toggled on, then
  // transitioning for 1.5 s; when on, the first toggle is the shutdown
  // prompt and the second starts a 2 s cool-down.
  const projector = {power: "standby" as "on" | "standby" | "transitioning", until: 0, next: "standby" as "on" | "standby", prompted: false};
  const devices = {tv: "on" as "on" | "standby", screen: 0};
  let queries = 0;
  let state: Partial<DisplayState> | undefined;
  let result: ReturnType<typeof transitionDisplay>;
  // Carries out each command, as the transports and the infrared blaster
  // would, and feeds back what the TV and screen then report, until the
  // node has nothing more to send. Projector queries go unanswered.
  const answer = (now: number, generation: number): void => {
    const follow: Array<[DisplayDevice, ObservationValues]> = [];
    for (const entry of result.commands) {
      if (entry.device === "projector" && entry.operation === "query_power") queries += 1;
      else if (entry.device === "projector" && entry.operation === "power_toggle") {
        if (projector.power === "standby") Object.assign(projector, {power: "transitioning", until: now + 1.5, next: "on"});
        else if (!projector.prompted) projector.prompted = true;
        else Object.assign(projector, {power: "transitioning", until: now + 2, next: "standby", prompted: false});
      } else if (entry.device === "tv") {
        if (entry.operation === "set_power") devices.tv = entry.power as "on" | "standby";
        follow.push(["tv", {power: devices.tv}]);
      } else if (entry.device === "screen") {
        if (entry.operation === "set_position") devices.screen = Number(entry.position);
        follow.push(["screen", {position: devices.screen, state: "stopped"}]);
      }
    }
    for (const [device, values] of follow) {
      result = observe(result.state, device, values, now, generation);
      state = result.state;
      answer(now, generation);
    }
  };
  const run = (mode: DisplayMode, generation: number, from: number) => {
    result = apply(state, {kind: "intent", requestId: `${mode}-${generation}`, generation, mode}, from);
    state = result.state;
    answer(from, generation);
    for (let tenth = 1; tenth <= 200 && result.state.phase !== "ready"; tenth += 1) {
      const now = from + tenth / 10;
      if (projector.power === "transitioning" && now >= projector.until) projector.power = projector.next;
      // Reports once a second, unasked.
      if (tenth % 10 === 0) {
        result = observe(state, "projector", {power: projector.power}, now, generation);
      } else {
        result = apply(state, {kind: "tick", generation}, now);
      }
      state = result.state;
      answer(now, generation);
      assert.notEqual(result.state.phase, "failed", `${mode} at ${now}: ${JSON.stringify(result.state.failure)}`);
    }
    return result.state.phase;
  };
  assert.equal(run("projector", 1, 0), "ready");
  assert.equal(projector.power, "on");
  assert.equal(run("tv", 2, 30), "ready");
  assert.equal(projector.power, "standby");
  assert.ok(queries > 0, "the node did ask; nothing answered");
});

test("a projector reading may give its power state instead of watts", () => {
  const reading = (values: ObservationValues, previous?: ObservationValues) => {
    let state: Partial<DisplayState> | undefined;
    if (previous) state = observe(undefined, "projector", previous, 0).state;
    return observe(state, "projector", values, 1).state.observed?.projector;
  };
  assert.deepEqual([reading({power: "on"})?.power, reading({power: "on"})?.watts], ["on", null]);
  assert.equal(reading({power: "standby"})?.power, "standby");
  // Transitioning reads as watts between the thresholds do: the last settled state, if any.
  assert.equal(reading({power: "transitioning"})?.power, "transitioning");
  assert.equal(reading({power: "transitioning"}, {power: "on"})?.power, "on");
  assert.equal(reading({power: "transitioning"}, {watts: 2})?.power, "standby");
  // Both: the state wins, and the watts are kept.
  assert.deepEqual([reading({power: "standby", watts: 155})?.power, reading({power: "standby", watts: 155})?.watts], ["standby", 155]);
  assert.throws(() => reading({power: "warming"}), /on, standby or transitioning/);
  assert.throws(() => reading({}), /invalid projector power observation/);
});
