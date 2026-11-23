"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {lightCommand, readLightReport, setsLightValues} from "../lib/z2m-light";

test("a state report needs an ON or OFF state", () => {
  assert.deepEqual(readLightReport({state: "on", brightness: 120, color_temp: 300}), {on: true, brightness: 120, color_temp: 300});
  assert.deepEqual(readLightReport({state: "OFF"}), {on: false, brightness: null, color_temp: null});
  assert.equal(readLightReport({brightness: 120}), null);
  assert.equal(readLightReport({state: "TOGGLE"}), null);
});

test("a light command fades a style in, and OFF stands alone", () => {
  assert.deepEqual(lightCommand("ON", {brightness: 200, color_temp: 250}, 60), {state: "ON", brightness: 200, color_temp: 250, transition: 60});
  assert.deepEqual(lightCommand("OFF", {brightness: 200, color_temp: 250}, 60), {state: "OFF"});
});

test("value fields mark a command that sets a light's values", () => {
  assert.equal(setsLightValues({state: "ON", brightness: 10}), true);
  assert.equal(setsLightValues({state: "ON", color_temp_kelvin: 2700}), true);
  assert.equal(setsLightValues({state: "ON"}), false);
  assert.equal(setsLightValues({state: "ON", transition: 2}), false);
});
