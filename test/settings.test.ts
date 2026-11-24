"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {normaliseAvrConfig} from "../lib/avr-controller";
import {normaliseConfig as normaliseDisplayConfig} from "../lib/display-mode-controller";
import {booleanSetting, jsonSetting, keptOverride, numberSetting, optionalBooleanSetting, optionalChoiceSetting, textSetting} from "../lib/settings";
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
  assert.deepEqual(normaliseAvrConfig({sources}), {area: "", sources, retryMs: 2000, maxAttempts: 3, minVolume: 0, maxVolume: 60});
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

test("on/off settings: absent takes the default, true and false in either form, anything else is an error", () => {
  assert.equal(booleanSetting(undefined, "initial sleep", false), false);
  assert.equal(booleanSetting(undefined, "initial sleep", true), true);
  assert.equal(booleanSetting(null, "initial sleep", true), true, "null is not set, so the default");
  assert.equal(booleanSetting(true, "initial sleep", false), true);
  assert.equal(booleanSetting("true", "initial sleep", false), true);
  assert.equal(booleanSetting("false", "initial sleep", true), false);
  for (const value of ["", "yes", 1, {}]) {
    assert.throws(() => booleanSetting(value, "initial sleep", false), /^Error: initial sleep must be on or off$/, JSON.stringify(value));
  }
  assert.equal(optionalBooleanSetting(undefined, "discovery"), null);
  assert.equal(optionalBooleanSetting(null, "discovery"), null);
  assert.equal(optionalBooleanSetting("false", "discovery"), false);
  assert.throws(() => optionalBooleanSetting("", "discovery"), /discovery must be on or off/, "an empty string is not \"not set\"");
});

test("text settings: absent takes the default; empty is an error, with or without one", () => {
  assert.equal(textSetting(undefined, "owner", "activity"), "activity");
  assert.equal(textSetting(" den ", "owner", "activity"), "den");
  for (const value of ["", "  ", null, 5]) {
    assert.throws(() => textSetting(value, "owner", "activity"), /^Error: owner is required$/, JSON.stringify(value));
  }
  assert.throws(() => textSetting(undefined, "TV host"), /TV host is required/, "no default: absent is an error too");
});

test("JSON settings: absent takes the default; empty or unparsable is an error", () => {
  assert.deepEqual(jsonSetting(undefined, "targets", ["main"]), ["main"]);
  assert.deepEqual(jsonSetting("[\"lamp\"]", "targets", ["main"]), ["lamp"]);
  for (const value of ["", "  ", null, "[lamp", 7]) {
    assert.throws(() => jsonSetting(value, "targets", ["main"]), /^Error: targets must be valid JSON$/, JSON.stringify(value));
  }
});

test("choice settings: absent or null is not set; one of the choices is kept; anything else is an error naming them", () => {
  const schemes = ["area", "node"] as const;
  assert.equal(optionalChoiceSetting(undefined, "ID scheme", schemes), null);
  assert.equal(optionalChoiceSetting(null, "ID scheme", schemes), null);
  assert.equal(optionalChoiceSetting("node", "ID scheme", schemes), "node");
  for (const value of ["", "Node", 1]) {
    assert.throws(() => optionalChoiceSetting(value, "ID scheme", schemes), /^Error: ID scheme must be area or node$/, JSON.stringify(value));
  }
});

test("a runtime value lasts until the setting it was based on changes", () => {
  assert.equal(keptOverride(300, 120, 120), 300, "same setting: kept");
  assert.equal(keptOverride(300, 120, 600), 600, "setting changed: the setting");
  assert.equal(keptOverride(300, undefined, 120), 120, "saved before the rule: the setting");
  assert.equal(keptOverride(undefined, 120, 120), 120, "nothing saved");
  assert.equal(keptOverride("05:30", "07:00", "07:00"), "05:30");
  assert.equal(keptOverride(530, "07:00", "07:00"), "07:00", "not the setting's kind of value");
});
