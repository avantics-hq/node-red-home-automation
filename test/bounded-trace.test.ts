"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTrace,
  TRACE_SCHEMA,
  type TraceContext,
  type TraceRecord
} from "../lib/bounded-trace";

function memoryContext(): TraceContext {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
    }
  };
}

test("trace records use one schema and remain count bounded", () => {
  const context = memoryContext();
  for (let index = 0; index < 205; index += 1) {
    appendTrace(context, {
      area: "kitchen",
      component: "motion-policy",
      limit: 200
    }, [{event: "motion", outcome: "observed", details: {index}}], new Date(index * 1000));
  }

  const trace = context.get("trace") as TraceRecord[];
  assert.equal(trace.length, 200);
  assert.equal(trace[0]!.sequence, 6);
  const last = trace.at(-1);
  assert.ok(last);
  assert.equal(last.sequence, 205);
  assert.deepEqual(Object.keys(last), [
    "schema", "sequence", "at", "area", "component", "event", "outcome", "reason", "details"
  ]);
  assert.equal(last.schema, TRACE_SCHEMA);
  assert.equal(last.reason, null);
});
