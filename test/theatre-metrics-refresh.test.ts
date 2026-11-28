"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {recordOutcome, recordTargetReport, resetTransitionMetrics} from "../lib/theatre-metrics";
import {planRefreshes} from "../lib/theatre-refresh";
import {createTheatreState, type RefreshPending} from "../lib/theatre-state";
import type {TheatreTarget} from "../lib/theatre-profiles";

test("outcomes count, and only a timed transition updates its durations", () => {
  const {metrics} = createTheatreState({}, {});
  recordOutcome(metrics, "ready", 1200);
  recordOutcome(metrics, "manual_override", null);
  recordOutcome(metrics, "failed", 800);
  assert.deepEqual([metrics.ready, metrics.failed, metrics.lastOutcome], [1, 1, "failed"]);
  assert.deepEqual([metrics.lastTransitionMs, metrics.maxTransitionMs], [800, 1200]);
});

test("a target's report records attempts, fallback use and confirmation time", () => {
  const {metrics} = createTheatreState({}, {});
  const metric = metrics.targets.avr;
  const report = {status: "ready" as const, observedAt: "2026-11-23T18:00:03.000Z", classification: null, failure: null,
    details: {metrics: {attempts: 2, fallbackUsed: true}}};
  recordTargetReport(metric, report, null, Date.parse(report.observedAt), "2026-11-23T18:00:00.000Z", Date.parse("2026-11-23T18:00:05.000Z"));
  assert.deepEqual([metric.attempts, metric.retries, metric.fallbackUses, metric.lastConfirmationMs, metric.observationAgeMs, metric.availability],
    [2, 1, 1, 3000, 2000, "available"]);
  recordTargetReport(metric, {...report, status: "failed"}, report, null, null, 0);
  assert.deepEqual([metric.failures, metric.availability], [1, "unavailable"]);
  resetTransitionMetrics(metrics);
  assert.deepEqual([metric.attempts, metric.fallbackUsed, metric.availability, metric.failures], [0, false, "unknown", 1]);
});

test("a target's confirmation time is set at its first ready report in a transition, and its refreshes leave it", () => {
  const {metrics} = createTheatreState({}, {});
  const metric = metrics.targets.display;
  const started = "2026-11-23T18:00:00.000Z";
  const ready = (seconds: number) => {
    const observedAt = Date.parse(started) + seconds * 1000;
    recordTargetReport(metric, {status: "ready", observedAt: new Date(observedAt).toISOString(), classification: null, failure: null, details: {}},
      null, observedAt, started, observedAt);
  };
  ready(4);
  assert.equal(metric.lastConfirmationMs, 4000);
  // Re-confirmed every minute: still how long it took to confirm.
  for (const seconds of [64, 124, 184]) ready(seconds);
  assert.equal(metric.lastConfirmationMs, 4000);
  // The next transition times it again.
  resetTransitionMetrics(metrics);
  assert.equal(metric.lastConfirmationMs, null);
  const next = "2026-11-23T19:00:00.000Z";
  const observedAt = Date.parse(next) + 7000;
  recordTargetReport(metric, {status: "ready", observedAt: new Date(observedAt).toISOString(), classification: null, failure: null, details: {}},
    null, observedAt, next, observedAt);
  assert.equal(metric.lastConfirmationMs, 7000);
});

test("refreshes are planned per target: send, retry, give up, then re-ask", () => {
  const none = {display: null, avr: null, source: null, lighting: null, backlighting: null} as Record<TheatreTarget, RefreshPending | null>;
  const observed = (target: TheatreTarget) => (target === "avr" ? 0 : null);
  let plan = planRefreshes(none, observed, true, 10000, 5000);
  assert.deepEqual(plan.actions, [{target: "avr", kind: "send"}]);
  assert.deepEqual(planRefreshes(none, observed, false, 10000, 5000).actions, [], "nothing without a request");
  plan = planRefreshes(plan.pending, observed, true, 10000, 10000);
  assert.deepEqual(plan.actions, [{target: "avr", kind: "retry", attempt: 2}]);
  plan = planRefreshes(plan.pending, observed, true, 10000, 15000);
  plan = planRefreshes(plan.pending, observed, true, 10000, 20000);
  assert.deepEqual(plan.actions, [{target: "avr", kind: "give-up"}]);
  assert.equal(plan.pending.avr?.exhausted, true);
  assert.deepEqual(planRefreshes(plan.pending, observed, true, 10000, 25000).actions, []);
  assert.deepEqual(planRefreshes(plan.pending, observed, true, 10000, 30000).actions, [{target: "avr", kind: "re-ask"}]);
  assert.equal(none.avr, null, "the input is not changed");
});
