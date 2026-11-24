"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {openCloseTargetStates, transitionOpenCloseCover, type OpenCloseEvent, type OpenCloseState} from "../lib/open-close-cover";

const config = {travelMs: 20000, marginMs: 5000, maxAttempts: 2};
const at = (seconds: number): Date => new Date(Date.parse("2026-11-24T08:00:00Z") + seconds * 1000);
const apply = (state: Partial<OpenCloseState> | undefined, event: OpenCloseEvent, seconds: number) =>
  transitionOpenCloseCover(state, event, config, at(seconds));
const request = (state: Partial<OpenCloseState> | undefined, kind: "open" | "close" | "stop", generation: number, seconds: number) =>
  apply(state, {kind, requestId: `r-${generation}`, generation}, seconds);
const report = (state: Partial<OpenCloseState> | undefined, seconds: number, fields: {motion?: "opening" | "closing" | "stopped"; state?: "open" | "closed"}) =>
  apply(state, {kind: "observed", observedAt: at(seconds).toISOString(), ...fields}, seconds);

test("an open that ran for the full travel time and stopped counts as open, judged by travel time", () => {
  let result = request(undefined, "open", 1, 0);
  assert.deepEqual(result.commands.map(({operation}) => operation), ["open"]);
  assert.equal(result.status.moving, true, "moving while unconfirmed");
  result = report(result.state, 1, {motion: "opening"});
  result = report(result.state, 22, {motion: "stopped"});
  assert.deepEqual([result.state.phase, result.state.position, result.state.evidence], ["ready", "open", "travel-time"]);
  assert.match(result.status.text, /open \(by travel time\): ready/);
});

test("a reported end state confirms the move", () => {
  let result = request(undefined, "close", 1, 0);
  result = report(result.state, 1, {motion: "closing"});
  result = report(result.state, 8, {state: "closed"});
  assert.deepEqual([result.state.phase, result.state.position, result.state.evidence], ["ready", "closed", "reported"]);
});

test("stopping short, or moving the other way, is a person's move, not a confirmation", () => {
  let result = request(undefined, "open", 1, 0);
  result = report(result.state, 1, {motion: "opening"});
  result = report(result.state, 6, {motion: "stopped"});
  assert.deepEqual([result.state.phase, result.state.position, result.traces.at(-1)?.reason], ["manual_override", "stopped", "stopped-short"]);
  let other = request(undefined, "open", 1, 0);
  other = report(other.state, 2, {motion: "closing"});
  assert.deepEqual([other.state.phase, other.traces.at(-1)?.reason], ["manual_override", "moved-the-other-way"]);
});

test("a cover that reports nothing is unconfirmed after its retries, not ready and not failed", () => {
  let result = request(undefined, "open", 1, 0);
  result = apply(result.state, {kind: "tick", generation: 1}, 26);
  assert.deepEqual(result.commands.map(({operation, attempt}) => [operation, attempt]), [["open", 2]], "tried again");
  result = apply(result.state, {kind: "tick", generation: 1}, 52);
  assert.deepEqual([result.state.phase, result.state.failure?.reason, result.state.position], ["unconfirmed", "no-reports", "unknown"]);
  const theatre = openCloseTargetStates(result, at(52))[0]?.theatre;
  assert.deepEqual([theatre?.status, (theatre?.failure as {reason?: string} | undefined)?.reason], ["failed", "no-reports"]);
  // One that reports, but never confirms, has failed.
  let reporting = request(undefined, "open", 1, 0);
  reporting = report(reporting.state, 1, {motion: "stopped"});
  reporting = apply(reporting.state, {kind: "tick", generation: 1}, 26);
  reporting = apply(reporting.state, {kind: "tick", generation: 1}, 52);
  assert.deepEqual([reporting.state.phase, reporting.state.failure?.reason], ["failed", "no-confirmation"]);
});

test("already open needs nothing; a move nobody asked for is a person's", () => {
  let result = request(undefined, "open", 1, 0);
  result = report(result.state, 2, {state: "open"});
  const again = request(result.state, "open", 2, 10);
  assert.deepEqual([again.commands, again.state.phase, again.traces.find(({event}) => event === "intent")?.reason], [[], "ready", "already-there"]);
  const moved = report(result.state, 30, {motion: "closing"});
  assert.deepEqual([moved.state.phase, moved.traces.at(-1)?.reason], ["manual_override", "moved-by-someone"]);
  const automatic = apply(moved.state, {kind: "open", requestId: "auto", generation: 3, respectManual: true}, 40);
  assert.deepEqual([automatic.commands, automatic.traces.at(-1)?.reason], [[], "manual-hold"]);
});

test("offline: nothing sent and requests answered unavailable; back online, it is read again", () => {
  let result = request(undefined, "open", 1, 0);
  result = report(result.state, 2, {state: "open"});
  result = apply(result.state, {kind: "availability", online: false}, 5);
  assert.equal(result.state.phase, "unavailable");
  const offline = request(result.state, "close", 2, 6);
  assert.deepEqual(offline.commands, []);
  const answers = openCloseTargetStates(offline, at(6)).map(({theatre}) => [theatre.requestId, theatre.status]);
  assert.deepEqual(answers, [["r-2", "unavailable"], ["r-1", "unavailable"]]);
  const online = apply(offline.state, {kind: "availability", online: true}, 10);
  assert.deepEqual([online.commands.map(({operation}) => operation), online.state.position, online.state.phase], [["observe"], "unknown", "confirming"]);
});

test("a restart reads the cover again rather than trusting what it reported", () => {
  let result = request(undefined, "open", 1, 0);
  result = report(result.state, 2, {state: "open"});
  const restarted = apply(result.state, {kind: "startup"}, 100);
  assert.deepEqual([restarted.commands.map(({operation}) => operation), restarted.state.position], [["observe"], "unknown"]);
});
