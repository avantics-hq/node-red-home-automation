"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {lightCommand, lightValues, readLightReport, setsLightValues, zigbeeColorTemp} from "../lib/z2m-light";

test("a state report needs an ON or OFF state", () => {
  assert.deepEqual(readLightReport({state: "on", brightness: 120, color_temp: 300}), {on: true, brightness: 120, color_temp: 300});
  assert.deepEqual(readLightReport({state: "OFF"}), {on: false, brightness: null, color_temp: null});
  assert.equal(readLightReport({brightness: 120}), null);
  assert.equal(readLightReport({state: "TOGGLE"}), null);
});

test("a light command fades a style in, and OFF stands alone", () => {
  assert.deepEqual(lightCommand("ON", {brightnessPct: 200 * 100 / 254, colorTempKelvin: 4000}, 60), {state: "ON", brightness: 200, color_temp: 250, transition: 60});
  assert.deepEqual(lightCommand("OFF", {brightnessPct: 50, colorTempKelvin: 4000}, 60), {state: "OFF"});
});

test("value fields mark a command that sets a light's values", () => {
  assert.equal(setsLightValues({state: "ON", brightness: 10}), true);
  assert.equal(setsLightValues({state: "ON", color_temp_kelvin: 2700}), true);
  assert.equal(setsLightValues({state: "ON"}), false);
  assert.equal(setsLightValues({state: "ON", transition: 2}), false);
});

test("light values: numeric strings count, unusable ones never reach the light, and Zigbee2MQTT's own units are removed", () => {
  // A finite numeric string is a number.
  assert.deepEqual(lightValues({brightnessPct: "50", colorTempKelvin: " 2500 "}).values, {brightness: 127, color_temp: 400});
  // Anything unusable is left out, reported, and never passed on.
  for (const bad of [{brightnessPct: null}, {brightnessPct: NaN}, {brightnessPct: "bright"}, {colorTempKelvin: 0}, {colorTempKelvin: -2700}, {colorTempKelvin: "warm"}]) {
    const result = lightValues({...bad, effect: "candle"});
    assert.deepEqual(result.values, {effect: "candle"}, JSON.stringify(bad));
    assert.deepEqual(result.invalid, Object.keys(bad));
  }
  // brightness and color_temp (removed in 6.0) are left out and reported, alone or beside the new fields,
  // in whatever order; the new fields still apply.
  const old = lightValues({brightness: 64, color_temp: 400, effect: "candle"});
  assert.deepEqual([old.values, old.removed], [{effect: "candle"}, ["brightness", "color_temp"]]);
  const both = lightValues({color_temp: 200, colorTempKelvin: 2500, brightness: 10, brightnessPct: 50});
  assert.deepEqual([both.values, both.removed.sort()], [{brightness: 127, color_temp: 400}, ["brightness", "color_temp"]]);
});

test("mireds round half up exactly, without float noise", () => {
  // From the circadian curve (sleep 1000 K, day 2800 K, level 0.805): exactly
  // 482.5 mireds, but 1e6 / kelvin comes out as 482.4999999999999, which a
  // plain Math.round takes down to 482.
  assert.equal(1_000_000 / 2072.5388601036275, 482.4999999999999);
  assert.equal(zigbeeColorTemp(2072.5388601036275), 483);
  assert.equal(zigbeeColorTemp(2500), 400);
});
