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

test("light values: the new field wins whatever the order, numeric strings count, and unusable ones never reach the light", () => {
  // U1: both forms given; the result doesn't depend on key order.
  const forward = lightValues({brightness: 10, brightnessPct: 50, color_temp: 200, colorTempKelvin: 2500});
  const backward = lightValues({colorTempKelvin: 2500, color_temp: 200, brightnessPct: 50, brightness: 10});
  assert.deepEqual(forward.values, {brightness: 127, color_temp: 400});
  assert.deepEqual(backward.values, forward.values);
  assert.deepEqual([forward.superseded.sort(), forward.legacy], [["brightness", "color_temp"], false]);
  // U2: a finite numeric string is a number.
  assert.deepEqual(lightValues({brightnessPct: "50", colorTempKelvin: " 2500 "}).values, {brightness: 127, color_temp: 400});
  // Anything else unusable is left out, reported, and never passed on under the new names.
  for (const bad of [{brightnessPct: null}, {brightnessPct: NaN}, {brightnessPct: "bright"}, {colorTempKelvin: 0}, {colorTempKelvin: -2700}, {colorTempKelvin: "warm"}]) {
    const result = lightValues({...bad, effect: "candle"});
    assert.deepEqual(result.values, {effect: "candle"}, JSON.stringify(bad));
    assert.deepEqual(result.invalid, Object.keys(bad));
  }
  // An unusable new value with an old one alongside: the old one is used, as in 5.x.
  assert.deepEqual(lightValues({brightnessPct: null, brightness: 64}).values, {brightness: 64});
});

test("mireds round half up exactly, without float noise", () => {
  // From the circadian curve (sleep 1000 K, day 2800 K, level 0.805): exactly
  // 482.5 mireds, but 1e6 / kelvin comes out as 482.4999999999999, which a
  // plain Math.round takes down to 482.
  assert.equal(1_000_000 / 2072.5388601036275, 482.4999999999999);
  assert.equal(zigbeeColorTemp(2072.5388601036275), 483);
  assert.equal(zigbeeColorTemp(2500), 400);
});
