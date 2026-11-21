"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  QUERY_COMMAND,
  parseAvrLine,
  transitionAvr,
  type AvrConfig,
  type AvrState
} from "../lib/avr-controller";

const config: AvrConfig = {
  area: "lounge",
  sources: {shield: "SAT/CBL", playstation: "GAME"},
  retryMs: 1000,
  maxAttempts: 3
};
const at = (seconds: number): Date =>
  new Date(Date.parse("2026-11-21T10:00:00Z") + seconds * 1000);

function observed(state: Partial<AvrState> | undefined, line: unknown, seconds = 0) {
  return transitionAvr(state, {avr: {kind: "observed", line}}, config, at(seconds));
}

function readyState(lines = "PWON\rZMON\rSISAT/CBL\rMV31\r"): AvrState {
  return observed(undefined, lines).state;
}

test("parses the Denon state used by the Lounge receiver", () => {
  assert.deepEqual(parseAvrLine("PWON", config.sources), {field: "power", value: "on", line: "PWON"});
  assert.deepEqual(parseAvrLine("PWSTANDBY", config.sources), {field: "power", value: "standby", line: "PWSTANDBY"});
  assert.deepEqual(parseAvrLine("SISAT/CBL", config.sources), {
    field: "source", value: "shield", sourceCode: "SAT/CBL", line: "SISAT/CBL"
  });
  assert.equal(parseAvrLine("MV315", config.sources)?.value, 31.5);
  assert.equal(parseAvrLine("MVMAX 96", config.sources), null);
});

test("startup invalidates stale observations and queries all owned state", () => {
  const saved = readyState();
  const result = transitionAvr(saved, {avr: {kind: "startup"}}, config, at(1));

  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0]!.payload, QUERY_COMMAND);
  assert.deepEqual(result.state.seen, {power: false, mainZone: false, source: false, volume: false});
  assert.equal(result.status.phase, "discovering");
});

test("an already-satisfied intent reports ready without issuing commands", () => {
  const result = transitionAvr(readyState(), {
    avr: {kind: "intent", requestId: "request-1", generation: 1, power: "on", source: "shield"}
  }, config, at(1));

  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.events.some((message) => message.avr.kind === "ready"), true);
});

test("a power-only intent preserves the observed source", () => {
  const state = observed(undefined, "PWON\rZMON\rSIGAME\rMV31\r").state;
  const result = transitionAvr(state, {
    avr: {kind: "intent", requestId: "display-change", generation: 1, power: "on"}
  }, config, at(1));

  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.observed.source, "playstation");
  assert.equal(result.state.desired?.source, null);
});

test("source selection is idempotent and waits for observed confirmation", () => {
  let state = readyState();
  let result = transitionAvr(state, {
    avr: {kind: "intent", requestId: "request-1", generation: 1, power: "on", source: "playstation"}
  }, config, at(1));
  assert.equal(result.commands[0]!.payload, "SIGAME\r");
  state = result.state;

  result = transitionAvr(state, {
    avr: {kind: "intent", requestId: "request-1", generation: 1, power: "on", source: "playstation"}
  }, config, at(1.2));
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "transitioning");

  result = observed(result.state, "SIGAME", 1.3);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "ready");
});

test("power-up is sequenced through power, main zone and source", () => {
  let state = observed(undefined, "PWSTANDBY\rZMOFF\rSIGAME\r").state;
  let result = transitionAvr(state, {
    avr: {kind: "intent", requestId: "request-2", generation: 2, power: "on", source: "shield"}
  }, config, at(1));
  assert.equal(result.commands[0]!.payload, "PWON\r");

  result = observed(result.state, "PWON", 1.2);
  assert.equal(result.commands[0]!.payload, "ZMON\r");

  result = observed(result.state, "ZMON", 1.4);
  assert.equal(result.commands[0]!.payload, "SISAT/CBL\r");

  result = observed(result.state, "SISAT/CBL", 1.6);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.commands.length, 0);
});

test("newer requests supersede pending work and stale generations are rejected", () => {
  let result = transitionAvr(readyState(), {
    avr: {kind: "intent", requestId: "play", generation: 2, power: "on", source: "playstation"}
  }, config, at(1));
  result = transitionAvr(result.state, {
    avr: {kind: "intent", requestId: "off", generation: 3, power: "standby"}
  }, config, at(1.1));
  assert.equal(result.commands[0]!.payload, "PWSTANDBY\r");
  assert.equal(result.events.some((message) => message.avr.kind === "superseded"), true);

  result = transitionAvr(result.state, {
    avr: {kind: "intent", requestId: "old", generation: 2, power: "on", source: "shield"}
  }, config, at(1.2));
  assert.equal(result.commands.length, 0);
  assert.equal(result.events.some((message) => message.avr.reason === "stale-generation"), true);
});

test("a request identity cannot be reused for a different target", () => {
  let result = transitionAvr(readyState(), {
    avr: {kind: "intent", requestId: "request-3", generation: 3, power: "on", source: "shield"}
  }, config, at(1));
  result = transitionAvr(result.state, {
    avr: {kind: "intent", requestId: "request-3", generation: 3, power: "on", source: "playstation"}
  }, config, at(1.1));

  assert.equal(result.commands.length, 0);
  assert.equal(result.state.desired?.source, "shield");
  assert.equal(result.events.some((message) => message.avr.reason === "request-conflict"), true);
});

test("commands retry a bounded number of times and then fail closed", () => {
  let result = transitionAvr(readyState(), {
    avr: {kind: "intent", requestId: "request-4", generation: 4, power: "on", source: "playstation"}
  }, config, at(0));
  assert.equal(result.commands[0]!.avrCommand.attempt, 1);

  result = transitionAvr(result.state, {avr: {kind: "tick"}}, config, at(1));
  assert.equal(result.commands[0]!.avrCommand.attempt, 2);
  result = transitionAvr(result.state, {avr: {kind: "tick"}}, config, at(2));
  assert.equal(result.commands[0]!.avrCommand.attempt, 3);
  result = transitionAvr(result.state, {avr: {kind: "tick"}}, config, at(3));

  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.events.some((message) => message.avr.kind === "failed"), true);

  result = observed(result.state, "Z2ON", 4);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "failed");
});

test("a failed generation remains blocked across startup state recovery", () => {
  let result = transitionAvr(readyState(), {
    avr: {kind: "intent", requestId: "request-6", generation: 6, power: "on", source: "playstation"}
  }, config, at(0));
  result = transitionAvr(result.state, {avr: {kind: "tick"}}, config, at(1));
  result = transitionAvr(result.state, {avr: {kind: "tick"}}, config, at(2));
  result = transitionAvr(result.state, {avr: {kind: "tick"}}, config, at(3));

  result = transitionAvr(result.state, {avr: {kind: "startup"}}, config, at(4));
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0]!.payload, QUERY_COMMAND);
  assert.equal(result.state.pending, null);
  assert.equal(result.state.phase, "failed");

  result = observed(result.state, "PWON\rZMON\rSISAT/CBL\rMV31\r", 4.1);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "failed");
});

test("unknown state is queried before any transition command", () => {
  const result = transitionAvr(undefined, {
    avr: {kind: "intent", requestId: "request-5", generation: 5, power: "on", source: "shield"}
  }, config, at(0));
  assert.equal(result.commands[0]!.payload, QUERY_COMMAND);
  assert.equal(result.state.pending?.operation, "query");
});
