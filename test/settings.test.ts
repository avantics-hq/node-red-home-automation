"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {normaliseAvrConfig} from "../lib/avr-controller";
import {normaliseConfig as normaliseDisplayConfig} from "../lib/display-mode-controller";
import {finiteOr} from "../lib/settings";
import {normaliseConfig as normaliseSourceConfig} from "../lib/source-capability-controller";

test("finiteOr reads editor strings and falls back on anything unusable", () => {
  assert.equal(finiteOr("12", 5), 12);
  assert.equal(finiteOr("abc", 5), 5);
  assert.equal(finiteOr(undefined, 5), 5);
  // A blank (cleared) editor field takes the default, not 0; a typed 0 stays 0.
  assert.equal(finiteOr("", 5), 5);
  assert.equal(finiteOr("  ", 5), 5);
  assert.equal(finiteOr(null, 5), 5);
  assert.equal(finiteOr("0", 5), 0);
});

test("the receiver's settings are read from editor strings with its deployed defaults", () => {
  const sources = {shield: "SAT/CBL"};
  assert.deepEqual(normaliseAvrConfig({sources}), {area: "room", sources, retryMs: 2000, maxAttempts: 3, minVolume: 0, maxVolume: 60});
  assert.deepEqual(normaliseAvrConfig({area: "area-a", sources, retryMs: "100", maxAttempts: "2.7", minVolume: "10", maxVolume: "40.5"}),
    {area: "area-a", sources, retryMs: 250, maxAttempts: 2, minVolume: 10, maxVolume: 40.5});
  // A blank retry, attempt count or volume bound takes its default.
  assert.equal(normaliseAvrConfig({sources, retryMs: "", maxAttempts: ""}).retryMs, 2000);
  assert.equal(normaliseAvrConfig({sources, retryMs: "", maxAttempts: ""}).maxAttempts, 3);
  assert.equal(normaliseAvrConfig({sources, minVolume: "", maxVolume: ""}).maxVolume, 60);
  assert.throws(() => normaliseAvrConfig({sources, minVolume: "50", maxVolume: "40"}), /volume bounds/);
});

test("display and source settings are read from editor strings", () => {
  const display = normaliseDisplayConfig({pollMs: "100", tvTimeoutMs: "45000", projectorPowerFallback: true});
  assert.equal(display.pollMs, 250);
  assert.equal(display.tvTimeoutMs, 45000);
  assert.equal(display.screenOpenPosition, 82);
  assert.equal(display.projectorPowerFallback, true);
  const source = normaliseSourceConfig({
    sources: {streamer: {activation: "command", deactivation: "command", confirmation: "active"}},
    pollMs: "500", confirmationTimeoutMs: "", maxAttempts: "abc"
  });
  assert.deepEqual([source.pollMs, source.confirmationTimeoutMs, source.maxAttempts], [500, 15000, 2]);
});
