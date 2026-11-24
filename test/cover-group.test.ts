"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {coverGroupMembers, transitionCoverGroup, type CoverGroupState} from "../lib/cover-group";

const members = ["left", "right"];
const now = new Date("2026-11-24T08:00:00Z");
const run = (state: Partial<CoverGroupState> | undefined, event: Parameters<typeof transitionCoverGroup>[1]) =>
  transitionCoverGroup(state, event, members, now);

test("a group sends each member the request under its own ID, and is ready only when all confirm", () => {
  let result = run(undefined, {kind: "request", payload: "open", stopIfMoving: true});
  assert.deepEqual(result.commands.map(({topic, payload, stopIfMoving}) => [topic, payload, stopIfMoving]), [["left", "open", true], ["right", "open", true]]);
  const [left, right] = result.commands.map(({coverRequestId}) => coverRequestId);
  assert.equal(result.events[0]?.theatre.status, "transitioning");
  result = run(result.state, {kind: "member", requestId: left!, status: "ready"});
  assert.deepEqual([result.events[0]?.theatre.status, result.status.text], ["transitioning", "1/2 confirmed"]);
  result = run(result.state, {kind: "member", requestId: right!, status: "ready"});
  assert.equal(result.events[0]?.theatre.status, "ready");
});

test("when only one confirms, the group says which, rather than claiming the move", () => {
  let result = run(undefined, {kind: "request", payload: 60});
  const [left, right] = result.commands.map(({coverRequestId}) => coverRequestId);
  result = run(result.state, {kind: "member", requestId: left!, status: "ready"});
  result = run(result.state, {kind: "member", requestId: right!, status: "transitioning", classification: "manual_override"});
  const theatre = result.events[0]?.theatre;
  assert.equal(theatre?.status, "failed");
  assert.deepEqual(theatre?.failure, {reason: "partial", confirmed: ["left"]});
  assert.deepEqual((theatre?.details as {members: Record<string, {status: string}>}).members.right?.status, "manual_override");
  // A result for an earlier request changes nothing.
  assert.deepEqual(run(result.state, {kind: "member", requestId: "group-old:left", status: "ready"}).events, []);
  // None confirmed.
  let none = run(undefined, {kind: "request", payload: "close"});
  for (const command of none.commands) none = run(none.state, {kind: "member", requestId: command.coverRequestId, status: "unavailable", reason: "unavailable"});
  assert.deepEqual(none.events[0]?.theatre.failure, {reason: "none-confirmed", confirmed: []});
});

test("members are at least two unique lowercase names", () => {
  assert.deepEqual(coverGroupMembers("[\"left\",\"right\"]"), ["left", "right"]);
  assert.throws(() => coverGroupMembers("[\"left\"]"), /at least two/);
  assert.throws(() => coverGroupMembers("[\"left\",\"left\"]"), /unique/);
  assert.throws(() => coverGroupMembers("[\"Left\",\"right\"]"), /lowercase/);
});

test("a member that never answers doesn't hang the group: at the deadline it is no-answer", () => {
  let result = transitionCoverGroup(undefined, {kind: "request", payload: "partial"}, members, now, 120);
  const [left] = result.commands.map(({coverRequestId}) => coverRequestId);
  result = transitionCoverGroup(result.state, {kind: "member", requestId: left!, status: "ready"}, members, new Date(now.getTime() + 1000), 120);
  assert.equal(result.events[0]?.theatre.status, "transitioning");
  const late = transitionCoverGroup(result.state, {kind: "tick"}, members, new Date(now.getTime() + 121_000), 120);
  const theatre = late.events[0]?.theatre;
  assert.deepEqual([theatre?.status, theatre?.failure], ["failed", {reason: "partial", confirmed: ["left"]}]);
  assert.deepEqual((theatre?.details as {members: Record<string, {status: string; reason: string}>}).members.right, {status: "failed", reason: "no-answer"});
  assert.equal(late.state.request?.settled, true);
});

test("a new request first gives the open one its final answer, superseded; its late results are ignored", () => {
  let result = run(undefined, {kind: "request", payload: "open"});
  const first = result.state.request!.requestId;
  const oldRight = result.commands[1]!.coverRequestId;
  result = run(result.state, {kind: "request", payload: "close"});
  assert.deepEqual(result.events.map(({theatre}) => [theatre.requestId, theatre.status, (theatre.failure as {reason?: string} | undefined)?.reason ?? null]),
    [[first, "failed", "superseded"], [result.state.request!.requestId, "transitioning", null]]);
  assert.deepEqual(result.commands.map(({payload}) => payload), ["close", "close"]);
  const stale = run(result.state, {kind: "member", requestId: oldRight, status: "ready"});
  assert.deepEqual([stale.events, stale.traces.at(-1)?.reason], [[], "other-request"]);
});
