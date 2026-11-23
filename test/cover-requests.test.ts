"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {coverPresets, coverRequest} from "../lib/cover-requests";

const ids = {requestId: "r-1", generation: 4};

test("simple requests become cover requests", () => {
  const presets = coverPresets("{\"partial\":60}");
  assert.deepEqual(coverRequest({payload: "OPEN"}, presets, ids), {intent: {...ids, kind: "open"}});
  assert.deepEqual(coverRequest({payload: "stop"}, presets, ids), {intent: {...ids, kind: "stop"}});
  assert.deepEqual(coverRequest({payload: 40}, presets, ids), {intent: {...ids, kind: "set_position", position: 40}});
  assert.deepEqual(coverRequest({payload: "40"}, presets, ids), {intent: {...ids, kind: "set_position", position: 40}});
  assert.deepEqual(coverRequest({payload: "partial"}, presets, ids), {intent: {...ids, kind: "set_position", position: 60}});
  assert.deepEqual(coverRequest({payload: 40, respectManual: true, source: "weather"}, presets, ids),
    {intent: {...ids, kind: "set_position", position: 40, respectManual: true, source: "weather"}});
  assert.deepEqual(coverRequest({payload: "half"}, presets, ids), {invalid: "unknown-request"});
  assert.deepEqual(coverRequest({payload: 140}, presets, ids), {invalid: "position-out-of-range"});
});

test("presets are named positions, checked at deploy", () => {
  assert.deepEqual(coverPresets(undefined), {});
  assert.deepEqual(coverPresets("{\"partial\":60,\"night\":0}"), {partial: 60, night: 0});
  assert.throws(() => coverPresets(""), /presets must be valid JSON/);
  assert.throws(() => coverPresets("[60]"), /presets must be a JSON object/);
  assert.throws(() => coverPresets("{\"open\":50}"), /preset name open/);
  assert.throws(() => coverPresets("{\"partial\":160}"), /preset partial must be a position from 0 to 100/);
});
