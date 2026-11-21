"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProjectorPower,
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
