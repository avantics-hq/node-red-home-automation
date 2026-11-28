"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateTheatreSlo,
  type TheatreSloConfig,
  type TheatreSloSnapshot,
  type TheatreSloState
} from "../lib/theatre-slo";

const config: TheatreSloConfig = {
  windowSize: 5,
  minimumSamples: 5,
  latencyBudgetMs: 10000,
  successObjectivePct: 90
};
const start = Date.parse("2026-11-21T20:00:00Z");

function snapshot(
  generation: number,
  phase: string,
  transitionMs: number,
  activity = "tv_streamer"
): TheatreSloSnapshot {
  return {
    generation,
    desiredActivity: activity,
    phase,
    transitionStartedAt: new Date(start + generation * 60000).toISOString(),
    transitionCompletedAt: new Date(start + generation * 60000 + transitionMs).toISOString(),
    metrics: {lastTransitionMs: transitionMs}
  };
}

function evaluate(
  state: Partial<TheatreSloState> | undefined,
  value: TheatreSloSnapshot,
  suppliedConfig: TheatreSloConfig = config,
  now = value.transitionCompletedAt || new Date(start).toISOString()
) {
  return evaluateTheatreSlo(state, value, suppliedConfig, now);
}

test("rolling successful transitions establish latency percentiles and a healthy objective", () => {
  let state: TheatreSloState | undefined;
  let result;
  for (const [index, duration] of [1000, 2000, 3000, 4000, 5000].entries()) {
    result = evaluate(state, snapshot(index + 1, "ready", duration));
    state = result.state;
  }

  assert.ok(result);
  assert.equal(result.assessment.status, "healthy");
  assert.equal(result.assessment.successRatePct, 100);
  assert.equal(result.assessment.p50TransitionMs, 3000);
  assert.equal(result.assessment.p95TransitionMs, 5000);
  assert.equal(result.assessment.sampleCount, 5);
});

test("a consumed error budget is visible before it becomes a breach", () => {
  let state: TheatreSloState | undefined;
  let result;
  for (let generation = 1; generation <= 20; generation += 1) {
    result = evaluate(
      state,
      snapshot(generation, generation === 20 ? "failed" : "ready", 1000),
      {...config, windowSize: 20, minimumSamples: 5, successObjectivePct: 95}
    );
    state = result.state;
  }

  assert.ok(result);
  assert.equal(result.assessment.successRatePct, 95);
  assert.equal(result.assessment.status, "breached");
  assert.equal(result.assessment.reason, "transition_failed");

  const recovered = evaluate(
    result.state,
    snapshot(21, "ready", 1000),
    {...config, windowSize: 20, minimumSamples: 5, successObjectivePct: 95}
  );
  assert.equal(recovered.assessment.successRatePct, 95);
  assert.equal(recovered.assessment.status, "at_risk");
  assert.equal(recovered.assessment.reason, "error_budget_consumed");
});

test("a later failure replaces the same generation instead of double-counting it", () => {
  const ready = evaluate(undefined, snapshot(3, "ready", 1200));
  const failed = evaluate(ready.state, snapshot(3, "failed", 1800));

  assert.equal(failed.state.samples.length, 1);
  assert.equal(failed.state.samples[0]?.outcome, "failed");
  assert.equal(failed.assessment.status, "breached");
  assert.equal(failed.assessment.reason, "transition_failed");
});

test("an over-budget active transition breaches while expected source waiting does not", () => {
  const active = snapshot(1, "transitioning", 0);
  active.transitionCompletedAt = null;
  active.metrics = {};
  const afterBudget = new Date(Date.parse(active.transitionStartedAt!) + 10001).toISOString();
  const timedOut = evaluate(undefined, active, config, afterBudget);
  assert.equal(timedOut.assessment.status, "breached");
  assert.equal(timedOut.assessment.reason, "transition_timeout");

  const waiting = evaluate(undefined, {...active, phase: "waiting_for_source"}, config, afterBudget);
  assert.equal(waiting.assessment.status, "learning");
  assert.equal(waiting.assessment.reason, "minimum_samples");
});

test("an untimed transition is no latency sample, not 0 ms, and stays untimed across a restart", () => {
  // No metric: the latency comes from the transition's own times.
  let result = evaluate(undefined, {...snapshot(1, "ready", 4000), metrics: {lastTransitionMs: null}});
  assert.equal(result.state.samples[0]?.transitionMs, 4000);
  // Neither a metric nor a completed time: no latency, not 0 ms.
  result = evaluate(result.state, {...snapshot(2, "ready", 0), transitionCompletedAt: null, metrics: {lastTransitionMs: null}},
    config, new Date(start + 3 * 60000).toISOString());
  assert.equal(result.state.samples[1]?.transitionMs, null);
  assert.deepEqual([result.assessment.p50TransitionMs, result.assessment.p95TransitionMs], [4000, 4000]);
  // Saved and read back (a restart): still untimed, still out of the percentiles.
  const restored = evaluate(JSON.parse(JSON.stringify(result.state)) as TheatreSloState, snapshot(3, "ready", 6000));
  assert.deepEqual(restored.state.samples.map(({transitionMs}) => transitionMs), [4000, null, 6000]);
  assert.deepEqual([restored.assessment.p50TransitionMs, restored.assessment.p95TransitionMs], [4000, 6000]);
});
