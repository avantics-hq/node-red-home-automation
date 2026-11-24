"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {transitionHouseSchedule} from "../lib/house-schedule";

const setting = {wakeTime: "07:00", bedTime: "23:00"};

test("the house says its times when asked to announce, and whenever they change", () => {
  let result = transitionHouseSchedule(undefined, {kind: "announce"}, setting);
  assert.deepEqual(result.outputs, [{lighting: {kind: "schedule", wakeTime: "07:00", bedTime: "23:00"}}]);
  result = transitionHouseSchedule(result.state, {kind: "schedule", wakeTime: "06:30"}, setting);
  assert.deepEqual(result.outputs, [{lighting: {kind: "schedule", wakeTime: "06:30", bedTime: "23:00"}}]);
  assert.deepEqual(transitionHouseSchedule(result.state, {kind: "schedule", wakeTime: "06:30"}, setting).outputs, [], "no change, nothing to say");
  const invalid = transitionHouseSchedule(result.state, {kind: "schedule", bedTime: "06:30"}, setting);
  assert.deepEqual([invalid.outputs, invalid.traces[0]?.reason], [[], "invalid-times"]);
});

test("a time set at runtime lasts until the house is deployed with a different setting", () => {
  const set = transitionHouseSchedule(undefined, {kind: "schedule", wakeTime: "06:00", bedTime: "22:00"}, setting).state;
  assert.deepEqual(transitionHouseSchedule(set, {kind: "announce"}, setting).state.schedule, {wakeTime: "06:00", bedTime: "22:00"});
  assert.deepEqual(transitionHouseSchedule(set, {kind: "announce"}, {wakeTime: "07:30", bedTime: "23:00"}).state.schedule,
    {wakeTime: "07:30", bedTime: "22:00"}, "only the changed setting replaces its time");
});
