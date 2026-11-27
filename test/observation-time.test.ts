"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOCK_SKEW_MS,
  boundObservedAt,
  isFresh,
  isOutOfOrder,
  parseObservedAt
} from "../lib/observation-time";
import {transitionActivityLighting} from "../lib/activity-lighting-controller";
import {transitionBacklighting} from "../lib/backlighting-controller";
import {transitionCover} from "../lib/cover-controller";
import {transitionDisplay} from "../lib/display-mode-controller";
import {transitionSource} from "../lib/source-capability-controller";
import {transitionTheatre} from "../lib/theatre-activity-controller";
import {transitionWallInput, wallInputStatus} from "../lib/wall-input";

const start = Date.parse("2026-11-22T12:00:00Z");
const at = (seconds: number) => new Date(start + seconds * 1000);
const iso = (seconds: number) => at(seconds).toISOString();
// A device clock a day ahead.
const tomorrow = iso(86400);

type Traced = {traces: Array<{event: string; outcome: string; reason: string | null}>};
const skewTraced = (result: Traced) => result.traces.some((entry) => entry.reason === "clock-skew");
const outOfOrder = (result: Traced) => result.traces.some((entry) => entry.reason === "out-of-order");

test("observation times beyond the skew limit count as observed now", () => {
  const now = start;
  assert.equal(parseObservedAt(iso(0)), start);
  assert.equal(parseObservedAt(start), start);
  assert.equal(parseObservedAt("not a time"), null);
  assert.equal(parseObservedAt(-1), null);
  assert.equal(parseObservedAt(undefined), null);

  const reported = new Date(now + CLOCK_SKEW_MS).toISOString();
  assert.deepEqual(boundObservedAt(reported, now + CLOCK_SKEW_MS, now), {ms: now + CLOCK_SKEW_MS, observedAt: reported, skewed: false});
  assert.deepEqual(boundObservedAt("x", now + CLOCK_SKEW_MS + 1, now), {ms: now, observedAt: iso(0), skewed: true});
  assert.deepEqual(boundObservedAt("2026-11-22T11:59:00Z", now - 60000, now), {ms: now - 60000, observedAt: "2026-11-22T11:59:00Z", skewed: false});

  assert.equal(isOutOfOrder(now - 1, iso(0), now), true);
  assert.equal(isOutOfOrder(now, iso(0), now), false);
  assert.equal(isOutOfOrder(now, undefined, now), false);
  // A stored time saved before this rule, a day ahead, no longer blocks.
  assert.equal(isOutOfOrder(now, tomorrow, now), false);

  assert.equal(isFresh(now - 5000, now, 5000), true);
  assert.equal(isFresh(now - 5001, now, 5000), false);
  assert.equal(isFresh(now + CLOCK_SKEW_MS, now, 5000), true);
  assert.equal(isFresh(now + CLOCK_SKEW_MS + 1, now, 5000), false);
  assert.equal(isFresh(null, now, 5000), false);
});

test("source capability: a future report does not lock out later ones", () => {
  const config = {sources: {streamer: {activation: "command", deactivation: "command", confirmation: "active"}}, pollMs: 2000, confirmationTimeoutMs: 15000, maxAttempts: 2} as never;
  const observed = (observedAt: string) => ({sourceCapability: {kind: "observed" as const, sourceId: "streamer", generation: 1, status: "inactive" as const, observedAt}});
  let result = transitionSource(undefined, {sourceCapability: {kind: "intent", requestId: "s1", generation: 1, sourceId: "streamer", action: "activate"}}, config, at(0));
  result = transitionSource(result.state, observed(tomorrow), config, at(1));
  assert.equal(skewTraced(result), true);
  assert.equal(result.state.observed?.observedAt, iso(1));
  result = transitionSource(result.state, observed(iso(5)), config, at(5));
  assert.equal(outOfOrder(result), false);
  assert.equal(result.state.observed?.observedAt, iso(5));
});

test("activity lighting: a future report does not lock out later ones", () => {
  const config = {profiles: {tv: {targets: ["wall"], values: {brightnessPct: 25}}}, confirmationTimeoutMs: 15000, maxAttempts: 2};
  const observed = (observedAt: string) => ({activityLighting: {kind: "observed" as const, generation: 1, target: "wall", on: true, values: {brightness: 10}, observedAt}});
  let result = transitionActivityLighting(undefined, {activityLighting: {kind: "intent", requestId: "a1", generation: 1, profile: "tv"}}, config, at(0));
  result = transitionActivityLighting(result.state, observed(tomorrow), config, at(1));
  assert.equal(skewTraced(result), true);
  assert.equal(result.state.observed.wall?.observedAt, iso(1));
  result = transitionActivityLighting(result.state, observed(iso(5)), config, at(5));
  assert.equal(outOfOrder(result), false);
  assert.equal(result.state.observed.wall?.observedAt, iso(5));
});

test("backlighting: a future report does not lock out later ones", () => {
  const config = {pollMs: 2000, confirmationTimeoutMs: 15000, maxAttempts: 2};
  const observed = (power: "on" | "off", observedAt: string) => ({backlighting: {kind: "observed" as const, generation: 1, power, observedAt}});
  let result = transitionBacklighting(undefined, {backlighting: {kind: "intent", requestId: "b1", generation: 1, power: "on"}}, config, at(0));
  result = transitionBacklighting(result.state, observed("off", tomorrow), config, at(1));
  assert.equal(skewTraced(result), true);
  assert.equal(result.state.observed?.observedAt, iso(1));
  result = transitionBacklighting(result.state, observed("on", iso(5)), config, at(5));
  assert.equal(outOfOrder(result), false);
  assert.equal(result.state.phase, "ready");
});

test("cover: a future report does not lock out later ones", () => {
  const config = {positionTolerance: 2, invert: false, travelTimeoutMs: 30000, maxAttempts: 2, pollMs: 5000, settleMs: 5000};
  const observed = (position: number, observedAt: string) => ({cover: {kind: "observed" as const, position, motion: "stopped" as const, observedAt}});
  let result = transitionCover(undefined, {cover: {kind: "set_position", requestId: "c1", generation: 1, position: 50}}, config, at(0));
  result = transitionCover(result.state, observed(20, tomorrow), config, at(1));
  assert.equal(skewTraced(result), true);
  assert.equal(result.state.observed?.observedAt, iso(1));
  result = transitionCover(result.state, observed(50, iso(5)), config, at(5));
  assert.equal(outOfOrder(result), false);
  assert.equal(result.state.observed?.position, 50);
});

test("theatre activity: a future target state does not lock out later ones", () => {
  const profile = {
    display: {mode: "tv"},
    avr: {power: "on", source: "streamer"},
    source: {action: "activate", sourceId: "streamer", readiness: "required"},
    lighting: {profile: "tv"},
    backlighting: {power: "on"}
  };
  const config = {area: "room", freshnessMs: 30000, activityProfiles: {tv: profile}};
  const targetState = (status: string, observedAt: string) => ({theatre: {kind: "target_state" as const, target: "avr" as const, generation: 1, status, observedAt}});
  let result = transitionTheatre(undefined, {theatre: {kind: "intent", requestId: "t1", generation: 1, activity: "tv"}}, config as never, at(0));
  result = transitionTheatre(result.state, targetState("transitioning", tomorrow) as never, config as never, at(1));
  assert.equal(skewTraced(result), true);
  assert.equal(result.state.targets.avr?.observedAt, iso(1));
  result = transitionTheatre(result.state, targetState("ready", iso(5)) as never, config as never, at(5));
  assert.equal(outOfOrder(result), false);
  assert.equal(result.state.targets.avr?.status, "ready");
});

test("wall input: a future time no longer reads as fresh forever", () => {
  const config = {switchWindowMs: 500, switchFreshnessMs: 60000};
  const result = transitionWallInput(undefined, {kind: "observation", payload: {state: true}, observedAt: tomorrow}, config, start + 1000);
  assert.equal(skewTraced(result), true);
  assert.equal(result.state.observedAt, start + 1000);
  // Two minutes later the input is stale, not "age 0".
  const status = wallInputStatus(result.state, config.switchFreshnessMs, start + 121000);
  assert.equal(status.ageMs, 120000);
  assert.equal(status.phase, "stale");
});

test("display mode: a future time is stored as receipt time", () => {
  const result = transitionDisplay(undefined, {display: {kind: "observed", device: "tv", power: "on", observedAt: tomorrow}}, {}, at(1));
  assert.equal(skewTraced(result), true);
  assert.equal(result.state.observed.tv?.observedAt, iso(1));
});
