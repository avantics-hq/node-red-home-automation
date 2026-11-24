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

test("a clear that may not reach the broker keeps the topic in the record, to clear it again", () => {
  const first = staleRetainedTopics(["old", "same"], ["same", "new"], true);
  assert.deepEqual(first.clears.map(({topic}) => topic), ["old"]);
  assert.deepEqual(first.record, ["same", "new", "old"]);
  const second = staleRetainedTopics(first.record, ["same", "new"]);
  assert.deepEqual(second.clears.map(({topic}) => topic), ["old"]);
  assert.deepEqual(second.record, ["same", "new"]);
  assert.deepEqual(staleRetainedTopics(["old"], ["old"], true).record, ["old"], "a topic in use again is no longer stale");
});
