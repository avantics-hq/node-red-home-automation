"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {staleRetainedTopics} from "../lib/retained-topics";

test("with no record, nothing is known to clear, and what the node publishes is recorded", () => {
  assert.deepEqual(staleRetainedTopics(undefined, ["new/a", "kept/b"]), {clears: [], record: ["new/a", "kept/b"]});
});

test("with a record, only recorded topics the node no longer publishes are cleared", () => {
  const {clears, record} = staleRetainedTopics(["home/hall/x", "home/hall/y", "same", "same"], ["home/den/x", "same"]);
  assert.deepEqual(clears, [
    {topic: "home/hall/x", payload: "", retain: true},
    {topic: "home/hall/y", payload: "", retain: true}
  ]);
  assert.deepEqual(record, ["home/den/x", "same"]);
  assert.deepEqual(staleRetainedTopics(record, record).clears, [], "nothing changed, nothing cleared");
});
