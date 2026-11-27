"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOVED_VOLUME_VALUE,
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
  minVolumeDb: -80,
  maxVolumeDb: -20
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
  assert.equal(parseAvrLine("MV315", config.sources)?.value, -48.5);
  assert.equal(parseAvrLine("MV80", config.sources)?.value, 0);
  assert.equal(parseAvrLine("MVMAX 96", config.sources), null);
});

test("formats whole and half-step volume commands", () => {
  // In dB; the receiver's 80 is 0 dB.
  assert.equal(formatVolumeCommand(-75), "MV05\r");
  assert.equal(formatVolumeCommand(-49), "MV31\r");
  assert.equal(formatVolumeCommand(-48.5), "MV315\r");
  assert.equal(formatVolumeCommand(-80), "MV00\r");
  assert.equal(formatVolumeCommand(18), "MV98\r");
  assert.throws(() => formatVolumeCommand(-48.8), /half-step/);
  assert.throws(() => formatVolumeCommand(-80.5), /half-step/);
  assert.throws(() => formatVolumeCommand(18.5), /half-step/);
});

test("absolute volume is bounded, commanded and released after fresh confirmation", () => {
  const boundedConfig = {...config, maxVolumeDb: -40};
  let result = transitionAvr(readyState(), {
    avr: {kind: "volume", requestId: "absolute-1", mode: "absolute", valueDb: -30}
  }, boundedConfig, at(1));

  assert.equal(result.commands[0]!.payload, "MV40\r");
  assert.equal(result.commands[0]!.avrCommand.operation, "volume");
  assert.equal(result.state.volumeRequest?.target, -40);
  assert.equal(result.state.volumeMetrics.bounded, 1);

  result = transitionAvr(result.state, {
    avr: {kind: "observed", line: "MV40"}
  }, boundedConfig, at(1.1));
  assert.equal(result.state.volumeRequest, null);
  assert.equal(result.state.volumeMetrics.confirmations, 1);
  assert.equal(result.events.some(({avr}) =>
    avr.kind === "volume_ready" && avr.volume === -40 && avr.bounded === true
  ), true);
});

test("rapid relative volume requests accumulate against the pending target", () => {
  let result = transitionAvr(readyState("PWON\rZMON\rSISAT/CBL\rMV30\r"), {
    avr: {kind: "volume", requestId: "relative-1", mode: "relative", valueDb: 1}
  }, config, at(1));
  assert.equal(result.commands[0]!.payload, "MV31\r");

  result = transitionAvr(result.state, {
    avr: {kind: "volume", requestId: "relative-2", mode: "relative", valueDb: 1}
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
    avr: {kind: "volume", requestId: "relative-query", mode: "relative", valueDb: -1}
  }, config, at(1));
  assert.equal(result.commands[0]!.payload, QUERY_COMMAND);
  assert.equal(result.commands[0]!.avrCommand.operation, "volume-query");

  result = observed(result.state, "MV30", 1.1);
  assert.equal(result.commands[0]!.payload, "MV29\r");
  result = observed(result.state, "MV29", 1.2);
  state = result.state;

  result = transitionAvr(state, {
    avr: {kind: "volume", requestId: "relative-query", mode: "relative", valueDb: -1}
  }, config, at(1.3));
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.observed.volume, -51);
  assert.equal(result.traces.some((trace) =>
    trace.event === "volume" && trace.outcome === "duplicate"
  ), true);
});

test("volume does not power on a receiver and external adjustments are preserved", () => {
  let state = observed(undefined, "PWSTANDBY\rZMOFF\rSISAT/CBL\rMV30\r").state;
  let result = transitionAvr(state, {
    avr: {kind: "volume", requestId: "off-volume", mode: "relative", valueDb: 1}
  }, config, at(1));
  assert.equal(result.commands.length, 0);
  assert.equal(result.events.some(({avr}) =>
    avr.kind === "volume_rejected" && avr.reason === "receiver-not-ready"
  ), true);

  state = readyState("PWON\rZMON\rSISAT/CBL\rMV30\r");
  result = transitionAvr(state, {
    avr: {kind: "volume", requestId: "manual-volume", mode: "relative", valueDb: 1}
  }, config, at(2));
  result = observed(result.state, "MV305", 2.1);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.volumeRequest, null);
  assert.equal(result.state.observed.volume, -49.5);
  assert.equal(result.state.volumeMetrics.externalChanges, 1);
  assert.equal(result.events.some(({avr}) => avr.kind === "volume_manual_override"), true);

  result = observed(result.state, "MV29", 3);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.observed.volume, -51);
  assert.equal(result.state.volumeMetrics.externalChanges, 2);
  assert.equal(result.events.some(({avr}) => avr.kind === "volume_external"), true);
});

test("volume retries are bounded without poisoning an already-ready activity", () => {
  const retryConfig = {...config, maxAttempts: 2};
  let result = transitionAvr(readyState("PWON\rZMON\rSISAT/CBL\rMV30\r"), {
    avr: {kind: "intent", requestId: "activity-1", generation: 1, power: "on", source: "shield"}
  }, retryConfig, at(0));
  result = transitionAvr(result.state, {
    avr: {kind: "volume", requestId: "volume-failure", mode: "absolute", valueDb: -49}
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
  return transitionAvr(state, {avr: {kind: "volume", requestId, mode, valueDb: value}}, config, at(seconds));
}

const volumeKinds = (result: ReturnType<typeof transitionAvr>) =>
  result.events.map((message) => message.avr.kind).filter((kind) => String(kind).startsWith("volume"));

test("a volume request is never confirmed by a reading from before the last command", () => {
  // dev-review repro: at 40, absolute 45 sends MV45; absolute 40 must not report ready from the old 40.
  let result = volume(readyState("PWON\rZMON\rSISAT/CBL\rMV40\r"), "abs-45", "absolute", -35, 1);
  assert.equal(result.commands[0]?.payload, "MV45\r");
  result = volume(result.state, "abs-40", "absolute", -40, 1.05);
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

  result = volume(result.state, "after-failure", "absolute", -45, 4);
  assert.equal(result.commands[0]?.payload, "MV35\r");
  assert.equal(result.state.phase, "failed");
  result = observed(result.state, "MV35", 4.2);
  assert.deepEqual(volumeKinds(result), ["volume_ready"]);
  assert.equal(result.state.phase, "failed");

  // With the receiver off, the request is rejected straight away.
  result = observed(result.state, "PWSTANDBY", 5);
  result = volume(result.state, "receiver-off", "absolute", -50, 6);
  assert.equal(result.events.find((message) => message.avr.kind === "volume_rejected")?.avr.reason, "receiver-not-ready");
});

test("a restart reports a pending volume request as failed instead of dropping it", () => {
  let result = volume(readyState("PWON\rZMON\rSISAT/CBL\rMV40\r"), "before-restart", "absolute", -35, 1);
  result = transitionAvr(result.state, {avr: {kind: "startup"}}, config, at(2));
  const failed = result.events.find((message) => message.avr.kind === "volume_failed");
  assert.deepEqual(failed?.avr, {
    kind: "volume_failed", area: "lounge", requestId: "before-restart", reason: "restart", operation: null, attempts: null
  });
  assert.equal(result.traces.some((entry) => entry.event === "volume" && entry.outcome === "failed" && entry.reason === "restart"), true);
  assert.equal(result.state.volumeRequest, null);
  assert.equal(result.state.volumeMetrics.failures, 1);
  assert.equal(result.commands.filter((command) => command.payload.startsWith("MV4")).length, 0);
});

test("a refresh re-reads the receiver without failing or resetting work in flight", () => {
  // Lead repro: a theatre refresh 0.2 s after a volume command failed it as a restart.
  let result = volume(readyState("PWON\rZMON\rSISAT/CBL\rMV31\r"), "v1", "absolute", -40, 1);
  assert.equal(result.commands[0]?.payload, "MV40\r");
  result = transitionAvr(result.state, {avr: {kind: "refresh"}}, config, at(1.2));
  assert.deepEqual(result.commands.map((command) => command.payload), [QUERY_COMMAND]);
  assert.deepEqual(volumeKinds(result), []);
  assert.equal(result.state.volumeRequest?.requestId, "v1");
  assert.equal(result.state.pending?.operation, "volume");
  result = observed(result.state, "MV40", 1.4);
  assert.deepEqual(volumeKinds(result), ["volume_ready"]);

  // A source change in flight is not reset either.
  let source = transitionAvr(readyState(), {
    avr: {kind: "intent", requestId: "source-1", generation: 1, power: "on", source: "playstation"}
  }, config, at(2));
  const phase = source.state.phase;
  source = transitionAvr(source.state, {avr: {kind: "refresh"}}, config, at(2.2));
  assert.equal(source.state.pending?.operation, "source");
  assert.equal(source.state.phase, phase);
  source = observed(source.state, "SIGAME", 2.4);
  assert.equal(source.state.phase, "ready");
});

test("every failed volume request is reported in one shape", () => {
  let result = volume(readyState("PWON\rZMON\rSISAT/CBL\rMV31\r"), "unanswered", "absolute", -40, 1);
  for (const seconds of [2.1, 3.2, 4.3]) result = transitionAvr(result.state, {avr: {kind: "tick"}}, config, at(seconds));
  const failed = result.events.find((message) => message.avr.kind === "volume_failed");
  assert.deepEqual(failed?.avr, {
    kind: "volume_failed", area: "lounge", requestId: "unanswered", reason: "attempts-exhausted", operation: "volume", attempts: 3
  });
  assert.equal(result.traces.some((entry) => entry.event === "volume" && entry.outcome === "failed" && entry.reason === "attempts-exhausted"), true);
});

const intent = (state: Partial<AvrState> | undefined, seconds: number) => transitionAvr(state, {
  avr: {kind: "intent", requestId: "tv-1", generation: 1, power: "on", source: "shield"}
}, config, at(seconds));

test("a confirmed request reports ready target state for the theatre activity controller", () => {
  const result = intent(readyState(), 5);
  assert.deepEqual(result.targetStates.map((entry) => entry.theatre.status), ["ready"]);
  const theatre = result.targetStates[0]!.theatre;
  assert.equal(theatre.target, "avr");
  assert.equal(theatre.requestId, "tv-1");
  assert.equal(theatre.generation, 1);
  // Confirmed by the readings taken at 0 s, not by the intent at 5 s.
  assert.equal(theatre.observedAt, at(0).toISOString());
  assert.deepEqual(theatre.details.recovery, {power: "on", source: "shield"});
});

test("a refresh is answered with target state stamped by the receiver's new readings", () => {
  const settled = intent(readyState(), 5).state;
  const refresh = transitionAvr(settled, {avr: {kind: "refresh"}}, config, at(60));
  assert.equal(refresh.commands[0]!.payload, QUERY_COMMAND);
  // Nothing new is confirmed until the receiver answers.
  assert.deepEqual(refresh.targetStates, []);

  let state = refresh.state;
  const answers = ["PWON", "ZMON", "SISAT/CBL"].map((line, index) => {
    const result = observed(state, line, 61 + index);
    state = result.state;
    return result.targetStates.map((entry) => entry.theatre);
  });
  // Each answer re-sends ready, stamped with the oldest field it relies on:
  // only the last answer makes the whole request fresh.
  assert.deepEqual(answers.map((entries) => entries.map((entry) => entry.status)), [["ready"], ["ready"], ["ready"]]);
  assert.equal(answers[0]![0]!.observedAt, at(0).toISOString());
  assert.equal(answers[2]![0]!.observedAt, at(61).toISOString());
  // A volume reading confirms nothing the request needs.
  assert.deepEqual(observed(state, "MV31", 70).targetStates, []);
});

test("target state reports a manual override and a failed request honestly", () => {
  const settled = intent(readyState(), 5).state;
  const override = observed(settled, "SIGAME", 10).targetStates.map((entry) => entry.theatre);
  assert.equal(override.at(-1)!.status, "transitioning");
  assert.equal(override.at(-1)!.classification, "manual_override");

  let result = transitionAvr(observed(undefined, "PWSTANDBY\rZMOFF\rSIGAME\r").state, {
    avr: {kind: "intent", requestId: "tv-2", generation: 2, power: "on", source: "shield"}
  }, config, at(1));
  for (let tick = 2; result.state.phase !== "failed" && tick < 20; tick += 2) {
    result = transitionAvr(result.state, {avr: {kind: "tick"}}, config, at(tick));
  }
  const failed = result.targetStates.at(-1)!.theatre;
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure?.reason, "attempts-exhausted");
  assert.equal(failed.failure?.operation, "power-on");
});

test("a new request for a ready receiver is carried out, not mistaken for a manual change", () => {
  const settled = intent(readyState(), 5).state;
  const off = transitionAvr(settled, {
    avr: {kind: "intent", requestId: "off-2", generation: 2, power: "standby"}
  }, config, at(10));
  assert.equal(off.state.classification, null);
  assert.deepEqual(off.commands.map((command) => command.payload), ["PWSTANDBY\r"]);
  assert.equal(off.targetStates.at(-1)!.theatre.status, "transitioning");
});

test("a receiver node with nothing saved adopts a refresh's wanted state and queries, sending nothing when it matches", () => {
  const apply = (state: Partial<AvrState> | undefined, avr: Parameters<typeof transitionAvr>[1]["avr"], seconds = 0) =>
    transitionAvr(state, {avr}, config, at(seconds));
  let result = apply(undefined, {kind: "refresh", requestId: "activity-5", generation: 5, power: "on", source: "shield"});
  assert.deepEqual([result.state.desired?.power, result.state.desired?.source], ["on", "shield"]);
  assert.deepEqual(result.commands.map(({avrCommand}) => avrCommand.operation), ["query"], "a query, never the change itself");
  result = transitionAvr(result.state, {avr: {kind: "observed", line: "PWON\rZMON\rSISAT/CBL\rMV31\r"}}, config, at(0.5));
  assert.ok(!result.commands.some(({avrCommand}) => avrCommand.operation !== "query"), JSON.stringify(result.commands));
  assert.equal(result.targetStates.at(-1)?.theatre.status, "ready");
  assert.equal(result.targetStates.at(-1)?.theatre.requestId, "activity-5");
  // An unknown source is not adopted.
  assert.equal(apply(undefined, {kind: "refresh", requestId: "activity-6", generation: 6, power: "on", source: "vcr"}).state.desired, null);
});

test("an adopted request the receiver doesn't match is a manual override: no power or source command", () => {
  let result = transitionAvr(undefined, {avr: {kind: "refresh", requestId: "activity-8", generation: 8, power: "on", source: "shield"}}, config, at(0));
  const sent = [...result.commands];
  // The receiver is in standby.
  result = transitionAvr(result.state, {avr: {kind: "observed", line: "PWSTANDBY\rZMOFF\rSIGAME\rMV20\r"}}, config, at(0.5));
  sent.push(...result.commands);
  for (const seconds of [2, 4, 8]) {
    result = transitionAvr(result.state, {avr: {kind: "tick"}}, config, at(seconds));
    sent.push(...result.commands);
  }
  assert.deepEqual([...new Set(sent.map(({avrCommand}) => avrCommand.operation))], ["query"], "no PW or SI");
  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.state.classification, "manual_override");
});

test("a volume request in the receiver's own 0-98 (removed in 6.0) is rejected, never sent", () => {
  for (const mode of ["absolute", "relative"] as const) {
    const result = transitionAvr(readyState(), {avr: {kind: "volume", requestId: `old-${mode}`, mode, value: 40}}, config, at(1));
    assert.deepEqual(result.commands, [], mode);
    assert.ok(result.events.some(({avr}) => avr.kind === "volume_rejected" && avr.reason === REMOVED_VOLUME_VALUE), mode);
    assert.equal(result.state.volumeRequest, null);
  }
  // With valueDb as well, valueDb is the request.
  const both = transitionAvr(readyState(), {avr: {kind: "volume", requestId: "both", mode: "absolute", valueDb: -45, value: 40}}, config, at(1));
  assert.equal(both.commands[0]?.payload, "MV35\r");
});

test("a receiver state saved before 5.0 has its volumes read as the receiver's units, once", () => {
  // From a context store across the upgrade: a reading of MV31 and an
  // absolute request for MV40 in flight.
  const saved = {...readyState(), volumeUnits: undefined, volumeRequest: {requestId: "old", mode: "absolute", requested: 40, target: 40, bounded: false}} as unknown as AvrState;
  saved.observed.volume = 31;
  const result = transitionAvr(saved, {avr: {kind: "tick"}}, config, at(1));
  assert.equal(result.state.observed.volume, -49);
  assert.deepEqual([result.state.volumeRequest?.requested, result.state.volumeRequest?.target], [-40, -40]);
  assert.equal(result.state.volumeUnits, "dB");
  assert.ok(result.commands.every(({payload}) => payload !== "MV90\r"));
  // Saved again, it is already dB.
  const again = transitionAvr(result.state, {avr: {kind: "tick"}}, config, at(1.1));
  assert.equal(again.state.observed.volume, -49);
  // A relative request's change is the same in both units.
  const relative = transitionAvr({...saved, volumeRequest: {requestId: "rel", mode: "relative", requested: 2, target: 33, bounded: false}} as unknown as AvrState,
    {avr: {kind: "tick"}}, config, at(1));
  assert.deepEqual([relative.state.volumeRequest?.requested, relative.state.volumeRequest?.target], [2, -47]);
});

test("a volume request's valueDb may be a numeric string", () => {
  let result = transitionAvr(readyState(), {avr: {kind: "volume", requestId: "text", mode: "absolute", valueDb: " -45 "}}, config, at(1));
  assert.equal(result.commands[0]?.payload, "MV35\r");
  result = transitionAvr(readyState(), {avr: {kind: "volume", requestId: "loud", mode: "absolute", valueDb: "loud"}}, config, at(1));
  assert.deepEqual(result.commands, []);
  assert.ok(result.events.some(({avr}) => avr.kind === "volume_rejected" && avr.reason === "invalid-volume-value"));
});
