"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  TOGGLE_COOLDOWN,
  TOGGLE_SHUTDOWN_CONFIRM,
  TOGGLE_START,
  beginShutdownConfirm,
  cooldownPending,
  holdForWarmup,
  needsShutdownConfirm,
  shutdownRequestPending,
  togglePowerSatisfied
} from "../lib/toggle-power";

const timing = {pollMs: 250, queryTimeoutMs: 1000, warmupMs: 1500, minimumWarmupMs: 1000, shutdownConfirmMs: 2000, cooldownMs: 1500};

test("a toggle-power sequence: each step's end, the warm-up hold, and the shutdown's confirming toggle", () => {
  assert.deepEqual(["on", "standby", "transitioning"].map((power) => togglePowerSatisfied(TOGGLE_START, power as never)), [true, false, false]);
  assert.equal(togglePowerSatisfied(TOGGLE_COOLDOWN, "standby"), true);
  assert.equal(togglePowerSatisfied("tv_on", "on"), undefined, "not a toggle-power step");
  // On before the minimum warm-up: look again then, not yet done.
  const start = {operation: TOGGLE_START, readyAt: 1000, deadlineAt: 1500};
  assert.deepEqual([holdForWarmup(start, "on", 400), holdForWarmup(start, "on", 1000), holdForWarmup(start, "standby", 400)], [1000, null, null]);
  // Shutdown: read the meter after shutdownConfirmMs; still on wants the confirming toggle, then the cool-down.
  const pending = shutdownRequestPending("projector", {operation: "power_toggle"}, 0, timing);
  assert.deepEqual([pending.nextAt, pending.deadlineAt], [2000, 3000]);
  beginShutdownConfirm(pending, 2000, timing);
  assert.deepEqual([pending.operation, pending.nextAt, pending.deadlineAt], [TOGGLE_SHUTDOWN_CONFIRM, 3000, 3000]);
  assert.deepEqual([needsShutdownConfirm(pending, "on"), needsShutdownConfirm(pending, "standby")], [true, false]);
  assert.deepEqual(cooldownPending("projector", "toggle", 3000, timing).deadlineAt, 4500);
});
