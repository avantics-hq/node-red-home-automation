"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {classifyPower} from "../lib/power-reading";

test("a power reading is on, standby, or keeps its last settled state between the bands", () => {
  const bands = {onWatts: 20, offWatts: 10};
  assert.deepEqual([0, 10, 20, 155].map((watts) => classifyPower(watts, "unknown", bands)), ["standby", "standby", "on", "on"]);
  // Between the bands: warming or cooling, so it keeps what it last was.
  assert.deepEqual(["on", "standby", "unknown", "transitioning"].map((previous) => classifyPower(15, previous as never, bands)),
    ["on", "standby", "transitioning", "transitioning"]);
  assert.deepEqual([-1, NaN, Infinity].map((watts) => classifyPower(watts, "on", bands)), ["unknown", "unknown", "unknown"]);
});
