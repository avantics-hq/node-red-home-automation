"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {normaliseAvrConfig} from "../lib/avr-controller";
import {normaliseConfig as normaliseDisplayConfig} from "../lib/display-mode-controller";
import {numberSetting} from "../lib/settings";
import {normaliseConfig as normaliseSourceConfig} from "../lib/source-capability-controller";

test("a number setting is a number, or its default only when absent from an older saved flow", () => {
  assert.equal(numberSetting("12", "max attempts", 5), 12);
  assert.equal(numberSetting(7, "max attempts", 5), 7);
  assert.equal(numberSetting("0", "max attempts", 5), 0, "a typed 0 is kept");
  assert.equal(numberSetting(undefined, "max attempts", 5), 5, "absent: the default");
  for (const value of ["", "  ", null, "abc", true, {}]) {
    assert.throws(() => numberSetting(value, "max attempts", 5), /^Error: max attempts must be a number$/, JSON.stringify(value));
  }
});

test("the receiver's settings are read from editor strings with its deployed defaults", () => {
  const sources = {shield: "SAT/CBL"};
  assert.deepEqual(normaliseAvrConfig({sources}), {area: "room", sources, retryMs: 2000, maxAttempts: 3, minVolume: 0, maxVolume: 60});
  assert.deepEqual(normaliseAvrConfig({area: "area-a", sources, retryMs: "100", maxAttempts: "2.7", minVolume: "10", maxVolume: "40.5"}),
    {area: "area-a", sources, retryMs: 250, maxAttempts: 2, minVolume: 10, maxVolume: 40.5});
  // An emptied or non-numeric field is an error naming the setting.
  assert.throws(() => normaliseAvrConfig({sources, retryMs: ""}), /retry interval must be a number/);
  assert.throws(() => normaliseAvrConfig({sources, maxAttempts: "abc"}), /max attempts must be a number/);
  assert.throws(() => normaliseAvrConfig({sources, maxVolume: ""}), /maximum volume must be a number/);
  // A typed 0 is kept, then raised to the minimum.
  assert.equal(normaliseAvrConfig({sources, retryMs: "0"}).retryMs, 250);
  assert.throws(() => normaliseAvrConfig({sources, minVolume: "50", maxVolume: "40"}), /volume bounds/);
});

test("display and source settings are read from editor strings", () => {
  const display = normaliseDisplayConfig({pollMs: "100", tvTimeoutMs: "45000", projectorPowerFallback: true});
  assert.equal(display.pollMs, 250);
  assert.equal(display.tvTimeoutMs, 45000);
  assert.equal(display.screenOpenPosition, 82);
  assert.equal(display.projectorPowerFallback, true);
  const sources = {streamer: {activation: "command", deactivation: "command", confirmation: "active"}};
  const source = normaliseSourceConfig({sources, pollMs: "500"});
  assert.deepEqual([source.pollMs, source.confirmationTimeoutMs, source.maxAttempts], [500, 15000, 2]);
  assert.throws(() => normaliseSourceConfig({sources, confirmationTimeoutMs: ""}), /confirmation timeout must be a number/);
  assert.throws(() => normaliseDisplayConfig({tvTimeoutMs: "soon"}), /TV timeout must be a number/);
});
