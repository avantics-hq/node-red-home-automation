"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {asTargetStatus, isTargetStatus, targetStateEvent} from "../lib/target-state";

test("target statuses are the theatre's, and an owner's other phases map to a fallback", () => {
  for (const status of ["discovering", "transitioning", "confirming", "ready", "waiting_for_source", "failed", "unavailable"]) {
    assert.equal(isTargetStatus(status), true, status);
  }
  assert.equal(isTargetStatus("idle"), false);
  assert.equal(isTargetStatus(undefined), false);
  assert.equal(asTargetStatus("ready", "confirming"), "ready");
  assert.equal(asTargetStatus("idle", "confirming"), "confirming");
});

test("the envelope carries classification and failure only when there are some", () => {
  const base = {target: "cover", requestId: "r1", generation: 2, status: "ready" as const, observedAt: "2026-11-23T18:00:00.000Z", details: {position: 50}};
  assert.deepEqual(targetStateEvent({...base, classification: null, failure: null}), {kind: "target_state", ...base});
  const failure = {operation: "move", reason: "timeout"};
  const failed = targetStateEvent({...base, status: "failed", classification: "manual_override", failure});
  assert.equal(failed.classification, "manual_override");
  assert.deepEqual(failed.failure, failure);
  assert.notEqual(failed.failure, failure, "the failure is copied");
});
