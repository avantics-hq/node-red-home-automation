"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  QUERY_COMMAND,
  formatVolumeCommand,
  parseAvrLine,
  transitionAvr,
  type AvrConfig,
  type AvrState
} from "../lib/avr-controller";

const config: AvrConfig = {
  area: "lounge",
  sources: {shield: "SAT/CBL", playstation: "GAME"},
  retryMs: 1000,
  maxAttempts: 3,
  minVolume: 0,
  maxVolume: 60
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

test("formats whole and half-step volume commands", () => {
  assert.equal(formatVolumeCommand(5), "MV05\r");
  assert.equal(formatVolumeCommand(31), "MV31\r");
  assert.equal(formatVolumeCommand(31.5), "MV315\r");
  assert.throws(() => formatVolumeCommand(31.2), /half-step/);
});

test("absolute volume is bounded, commanded and released after fresh confirmation", () => {
  const boundedConfig = {...config, maxVolume: 40};
  let result = transitionAvr(readyState(), {
    avr: {kind: "volume", requestId: "absolute-1", mode: "absolute", value: 50}
  }, boundedConfig, at(1));

  assert.equal(result.commands[0]!.payload, "MV40\r");
  assert.equal(result.commands[0]!.avrCommand.operation, "volume");
  assert.equal(result.state.volumeRequest?.target, 40);
  assert.equal(result.state.volumeMetrics.bounded, 1);

  result = transitionAvr(result.state, {
    avr: {kind: "observed", line: "MV40"}
  }, boundedConfig, at(1.1));
  assert.equal(result.state.volumeRequest, null);
  assert.equal(result.state.volumeMetrics.confirmations, 1);
  assert.equal(result.events.some(({avr}) =>
    avr.kind === "volume_ready" && avr.volume === 40 && avr.bounded === true
  ), true);
});

test("rapid relative volume requests accumulate against the pending target", () => {
  let result = transitionAvr(readyState("PWON\rZMON\rSISAT/CBL\rMV30\r"), {
    avr: {kind: "volume", requestId: "relative-1", mode: "relative", value: 1}
  }, config, at(1));
  assert.equal(result.commands[0]!.payload, "MV31\r");

  result = transitionAvr(result.state, {
    avr: {kind: "volume", requestId: "relative-2", mode: "relative", value: 1}
  }, config, at(1.01));
  assert.equal(result.commands[0]!.payload, "MV32\r");
  assert.equal(result.state.volumeRequest?.requested, 2);

  result = observed(result.state, "MV32", 1.1);
  assert.equal(result.state.volumeRequest, null);
  assert.deepEqual(result.state.volumeMetrics, {
    intents: 2,
    commands: 2,
    bounded: 0,
    confirmations: 1,
    externalChanges: 0,
    failures: 0
  });
});

test("relative volume waits for fresh state and duplicate request IDs remain inert", () => {
  let state = observed(undefined, "PWON\rZMON\rSISAT/CBL\r").state;
  let result = transitionAvr(state, {
    avr: {kind: "volume", requestId: "relative-query", mode: "relative", value: -1}
  }, config, at(1));
  assert.equal(result.commands[0]!.payload, QUERY_COMMAND);
  assert.equal(result.commands[0]!.avrCommand.operation, "volume-query");

  result = observed(result.state, "MV30", 1.1);
  assert.equal(result.commands[0]!.payload, "MV29\r");
  result = observed(result.state, "MV29", 1.2);
  state = result.state;

  result = transitionAvr(state, {
    avr: {kind: "volume", requestId: "relative-query", mode: "relative", value: -1}
  }, config, at(1.3));
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.observed.volume, 29);
  assert.equal(result.traces.some((trace) =>
    trace.event === "volume" && trace.outcome === "duplicate"
  ), true);
});

test("volume does not power on a receiver and external adjustments are preserved", () => {
  let state = observed(undefined, "PWSTANDBY\rZMOFF\rSISAT/CBL\rMV30\r").state;
  let result = transitionAvr(state, {
    avr: {kind: "volume", requestId: "off-volume", mode: "relative", value: 1}
  }, config, at(1));
  assert.equal(result.commands.length, 0);
  assert.equal(result.events.some(({avr}) =>
    avr.kind === "volume_rejected" && avr.reason === "receiver-not-ready"
  ), true);

  state = readyState("PWON\rZMON\rSISAT/CBL\rMV30\r");
  result = transitionAvr(state, {
    avr: {kind: "volume", requestId: "manual-volume", mode: "relative", value: 1}
  }, config, at(2));
  result = observed(result.state, "MV305", 2.1);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.volumeRequest, null);
  assert.equal(result.state.observed.volume, 30.5);
  assert.equal(result.state.volumeMetrics.externalChanges, 1);
  assert.equal(result.events.some(({avr}) => avr.kind === "volume_manual_override"), true);

  result = observed(result.state, "MV29", 3);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.observed.volume, 29);
  assert.equal(result.state.volumeMetrics.externalChanges, 2);
  assert.equal(result.events.some(({avr}) => avr.kind === "volume_external"), true);
});

test("volume retries are bounded without poisoning an already-ready activity", () => {
  const retryConfig = {...config, maxAttempts: 2};
  let result = transitionAvr(readyState("PWON\rZMON\rSISAT/CBL\rMV30\r"), {
    avr: {kind: "intent", requestId: "activity-1", generation: 1, power: "on", source: "shield"}
  }, retryConfig, at(0));
  result = transitionAvr(result.state, {
    avr: {kind: "volume", requestId: "volume-failure", mode: "absolute", value: 31}
  }, retryConfig, at(0.1));
  result = transitionAvr(result.state, {avr: {kind: "tick"}}, retryConfig, at(1.1));
  assert.equal(result.commands[0]!.avrCommand.attempt, 2);

  result = transitionAvr(result.state, {avr: {kind: "tick"}}, retryConfig, at(2.1));
  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.volumeRequest, null);
  assert.equal(result.state.volumeMetrics.failures, 1);
  assert.equal(result.events.some(({avr}) => avr.kind === "volume_failed"), true);
  assert.equal(result.events.some(({avr}) => avr.kind === "ready"), false);
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

test("unsolicited AVR source changes latch manual ownership without fighting the remote", () => {
  let result = transitionAvr(readyState(), {
    avr: {kind: "intent", requestId: "shield-7", generation: 7, power: "on", source: "shield"}
  }, config, at(1));
  assert.equal(result.state.phase, "ready");

  result = observed(result.state, "SIGAME", 2);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.state.classification, "manual_override");
  assert.equal(result.events.some(({avr}) => avr.kind === "manual_override"), true);

  result = transitionAvr(result.state, {
    avr: {kind: "intent", requestId: "playstation-8", generation: 8, power: "on", source: "playstation"}
  }, config, at(3));
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.classification, null);
});

function volume(state: Partial<AvrState>, requestId: string, mode: "absolute" | "relative", value: number, seconds: number) {
  return transitionAvr(state, {avr: {kind: "volume", requestId, mode, value}}, config, at(seconds));
}

const volumeKinds = (result: ReturnType<typeof transitionAvr>) =>
  result.events.map((message) => message.avr.kind).filter((kind) => String(kind).startsWith("volume"));

test("a volume request is never confirmed by a reading from before the last command", () => {
  // dev-review repro: at 40, absolute 45 sends MV45; absolute 40 must not report ready from the old 40.
  let result = volume(readyState("PWON\rZMON\rSISAT/CBL\rMV40\r"), "abs-45", "absolute", 45, 1);
  assert.equal(result.commands[0]?.payload, "MV45\r");
  result = volume(result.state, "abs-40", "absolute", 40, 1.05);
  assert.deepEqual(volumeKinds(result), []);
  assert.equal(result.commands[0]?.avrCommand.operation, "volume-query");
  // The receiver reports where the first command took it, then the new target.
  result = observed(result.state, "MV45", 1.2);
  assert.equal(result.commands[0]?.payload, "MV40\r");
  result = observed(result.state, "MV40", 1.4);
  assert.deepEqual(volumeKinds(result), ["volume_ready"]);
  assert.equal(result.state.volumeMetrics.externalChanges, 0);

  // Relative +10 then -10 lands back on the stale reading the same way.
  let relative = volume(readyState("PWON\rZMON\rSISAT/CBL\rMV40\r"), "rel-up", "relative", 10, 1);
  assert.equal(relative.commands[0]?.payload, "MV50\r");
  relative = volume(relative.state, "rel-down", "relative", -10, 1.05);
  assert.deepEqual(volumeKinds(relative), []);
  relative = observed(relative.state, "MV50", 1.2);
  assert.equal(relative.commands[0]?.payload, "MV40\r");
});

test("a volume request after a failed activity is sent or rejected, not left waiting", () => {
  let result = transitionAvr(readyState(), {
    avr: {kind: "intent", requestId: "request-4", generation: 4, power: "on", source: "playstation"}
  }, config, at(0));
  for (const seconds of [1, 2, 3]) result = transitionAvr(result.state, {avr: {kind: "tick"}}, config, at(seconds));
  assert.equal(result.state.phase, "failed");

  result = volume(result.state, "after-failure", "absolute", 35, 4);
  assert.equal(result.commands[0]?.payload, "MV35\r");
  assert.equal(result.state.phase, "failed");
  result = observed(result.state, "MV35", 4.2);
  assert.deepEqual(volumeKinds(result), ["volume_ready"]);
  assert.equal(result.state.phase, "failed");

  // With the receiver off, the request is rejected straight away.
  result = observed(result.state, "PWSTANDBY", 5);
  result = volume(result.state, "receiver-off", "absolute", 30, 6);
  assert.equal(result.events.find((message) => message.avr.kind === "volume_rejected")?.avr.reason, "receiver-not-ready");
});

test("a restart reports a pending volume request as failed instead of dropping it", () => {
  let result = volume(readyState("PWON\rZMON\rSISAT/CBL\rMV40\r"), "before-restart", "absolute", 45, 1);
  result = transitionAvr(result.state, {avr: {kind: "startup"}}, config, at(2));
  const failed = result.events.find((message) => message.avr.kind === "volume_failed");
  assert.equal(failed?.avr.requestId, "before-restart");
  assert.equal(failed?.avr.reason, "restart");
  assert.equal(result.state.volumeRequest, null);
  assert.equal(result.state.volumeMetrics.failures, 1);
  assert.equal(result.commands.filter((command) => command.payload.startsWith("MV4")).length, 0);
});
