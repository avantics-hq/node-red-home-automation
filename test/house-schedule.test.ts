"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {transitionHouseSchedule} from "../lib/house-schedule";

const setting = {wakeTime: "07:00", bedTime: "23:00"};

test("the house changes its times, and says whether they changed", () => {
  let result = transitionHouseSchedule(undefined, {kind: "schedule", wakeTime: "06:30"}, setting);
  assert.deepEqual([result.changed, result.state.schedule], [true, {wakeTime: "06:30", bedTime: "23:00"}]);
  result = transitionHouseSchedule(result.state, {kind: "schedule", wakeTime: "06:30"}, setting);
  assert.equal(result.changed, false, "no change");
  const invalid = transitionHouseSchedule(result.state, {kind: "schedule", bedTime: "06:30"}, setting);
  assert.deepEqual([invalid.changed, invalid.traces[0]?.reason, invalid.state.schedule.bedTime], [false, "invalid-times", "23:00"]);
});

test("a time set at runtime lasts until the house is deployed with a different setting", () => {
  const set = transitionHouseSchedule(undefined, {kind: "schedule", wakeTime: "06:00", bedTime: "22:00"}, setting).state;
  assert.deepEqual(transitionHouseSchedule(set, {kind: "schedule"}, setting).state.schedule, {wakeTime: "06:00", bedTime: "22:00"});
  assert.deepEqual(transitionHouseSchedule(set, {kind: "schedule"}, {wakeTime: "07:30", bedTime: "23:00"}).state.schedule,
    {wakeTime: "07:30", bedTime: "22:00"}, "only the changed setting replaces its time");
});
