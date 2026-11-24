"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  normaliseActivityProfiles,
  transitionTheatre,
  type TheatreConfig,
  type TheatreInputEvent
} from "../lib/theatre-activity-controller";
import {
  normaliseCapabilities,
  readinessEvidence,
  transitionSource,
  type SourceAction,
  type SourceConfig,
  type SourceEvent,
  type SourceObservation,
  type SourceOutputEvent,
  type SourceState
} from "../lib/source-capability-controller";

const config: SourceConfig = {
  sources: {
    streamer: {activation: "command", deactivation: "command", confirmation: "active"},
    player: {activation: "command", deactivation: "command", confirmation: "application"},
    autoplay: {activation: "command", deactivation: "command", confirmation: "playing"},
    console: {activation: "external", deactivation: "unavailable", confirmation: "available"},
    legacy: {activation: "unavailable", deactivation: "unavailable", confirmation: "unavailable"}
  },
  pollMs: 1000,
  confirmationTimeoutMs: 5000,
  maxAttempts: 2
};
const theatreConfig: TheatreConfig = {
  area: "lounge",
  freshnessMs: 10000,
  activityProfiles: normaliseActivityProfiles({
    tv: {display: {mode: "tv"}, avr: {power: "on"}, source: {action: "activate", sourceId: "streamer", readiness: "required"},
      lighting: {profile: "tv"}, backlighting: {power: "on"}}
  })
};
const at = (seconds: number): Date =>
  new Date(Date.parse("2026-11-21T15:00:00Z") + seconds * 1000);

function apply(state: Partial<SourceState> | undefined, sourceCapability: SourceEvent, seconds = 0) {
  return transitionSource(state, {sourceCapability}, config, at(seconds));
}

function intent(
  state: Partial<SourceState> | undefined,
  sourceId: string | null,
  action: SourceAction = "activate",
  generation = 1,
  seconds = 0
) {
  return apply(state, {
    kind: "intent",
    requestId: `${sourceId}-${action}-${generation}`,
    generation,
    sourceId,
    action
  }, seconds);
}

function observed(
  state: Partial<SourceState> | undefined,
  sourceId: string,
  status: "active" | "inactive" | "available" | "unavailable" | "unknown",
  generation: number,
  seconds: number,
  readiness: {application?: string | null; playback?: "playing" | "paused" | "idle" | "buffering" | "stopped" | "unknown"} = {}
) {
  return apply(state, {
    kind: "observed",
    sourceId,
    status,
    generation,
    observedAt: at(seconds).toISOString(),
    ...readiness
  }, seconds);
}

function theatreState(result: ReturnType<typeof transitionSource>): SourceOutputEvent["theatre"] {
  const theatre = result.events.at(-1)?.theatre;
  assert.ok(theatre);
  return theatre;
}

test("capabilities are deployment data and reject incomplete descriptors", () => {
  assert.deepEqual(normaliseCapabilities({disc_player: {
    activation: "command",
    deactivation: "external",
    confirmation: "available"
  }}), {
    disc_player: {activation: "command", deactivation: "external", confirmation: "available"}
  });
  assert.throws(
    () => normaliseCapabilities({disc_player: {activation: "command", deactivation: "external"}}),
    /confirmation capability/
  );
});

test("a controllable source wakes and becomes ready only after observation", () => {
  let result = intent(undefined, "streamer");
  assert.deepEqual(result.commands, [{
    sourceId: "streamer",
    operation: "activate",
    requestId: "streamer-activate-1",
    generation: 1,
    attempt: 1
  }]);
  assert.equal(result.state.phase, "transitioning");
  assert.equal(theatreState(result).status, "transitioning");

  result = apply(result.state, {
    kind: "command_result",
    sourceId: "streamer",
    generation: 1,
    ok: true
  }, 0.1);
  assert.equal(result.state.phase, "confirming");
  assert.notEqual(result.state.phase, "ready");

  result = observed(result.state, "streamer", "active", 1, 0.2);
  assert.equal(result.state.phase, "ready");
  assert.equal(theatreState(result).status, "ready");
});

test("an externally controlled observable source waits and recovers", () => {
  let result = intent(undefined, "console");
  assert.equal(result.state.phase, "waiting_for_source");
  assert.equal(result.commands[0]?.operation, "observe");
  assert.equal(theatreState(result).status, "waiting_for_source");

  result = observed(result.state, "console", "inactive", 1, 1);
  assert.equal(result.state.phase, "waiting_for_source");
  result = observed(result.state, "console", "available", 1, 2);
  assert.equal(result.state.phase, "ready");
});

test("application readiness requires fresh active application evidence", () => {
  let result = intent(undefined, "player");
  result = apply(result.state, {
    kind: "command_result",
    sourceId: "player",
    generation: 1,
    ok: true
  }, 0.1);
  result = observed(result.state, "player", "active", 1, 0.2);
  assert.equal(result.state.phase, "waiting_for_source");
  assert.equal(theatreState(result).details.readiness.satisfied, false);

  result = observed(result.state, "player", "active", 1, 0.3, {
    application: "media.app",
    playback: "paused"
  });
  assert.equal(result.state.phase, "ready");
  assert.deepEqual(theatreState(result).details.readiness, {
    required: "application",
    available: true,
    active: true,
    application: "media.app",
    playback: "paused",
    satisfied: true
  });

  const later = apply(result.state, {kind: "tick", generation: 1}, 30);
  assert.equal(theatreState(later).observedAt, at(0.3).toISOString());
});

test("playing readiness does not treat active or paused as playback", () => {
  let result = intent(undefined, "autoplay");
  result = apply(result.state, {
    kind: "command_result",
    sourceId: "autoplay",
    generation: 1,
    ok: true
  }, 0.1);
  result = observed(result.state, "autoplay", "active", 1, 0.2, {
    application: "media.app",
    playback: "paused"
  });
  assert.equal(result.state.phase, "waiting_for_source");

  result = observed(result.state, "autoplay", "active", 1, 0.3, {
    application: "media.app",
    playback: "playing"
  });
  assert.equal(result.state.phase, "ready");
  assert.equal(theatreState(result).details.readiness.playback, "playing");
});

test("an unobservable source reports unavailable instead of invented readiness", () => {
  const result = intent(undefined, "legacy");
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "unavailable");
  assert.equal(result.state.failure?.reason, "unobservable-source");
  assert.equal(theatreState(result).status, "unavailable");
});

test("deactivation with no known active source is explicitly unavailable", () => {
  let result = intent(undefined, null, "deactivate");
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "unavailable");
  assert.equal(result.state.failure?.reason, "unknown-active-source");

  result = apply(result.state, {kind: "startup"}, 1);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.failure?.reason, "unknown-active-source");
});

test("a controllable source stop waits for an inactive observation", () => {
  let result = intent(undefined, "streamer", "deactivate");
  assert.equal(result.commands[0]?.operation, "deactivate");
  assert.equal(result.state.phase, "transitioning");

  result = observed(result.state, "streamer", "inactive", 1, 1);
  assert.equal(result.state.phase, "ready");
  assert.equal(theatreState(result).action, "deactivate");
});

test("unsupported stop is an optional-target degradation, not false success", () => {
  const active = intent(undefined, "console");
  const result = intent(active.state, "console", "deactivate", 2, 1);
  assert.equal(result.state.phase, "unavailable");
  assert.equal(result.state.failure?.reason, "unsupported-deactivation");
});

test("confirmation polling and activation retries are bounded", () => {
  let result = intent(undefined, "streamer");
  result = apply(result.state, {kind: "tick", generation: 1}, 1);
  assert.equal(result.commands[0]?.operation, "observe");
  assert.equal(result.commands[0]?.attempt, 1);

  result = apply(result.state, {kind: "tick", generation: 1}, 5);
  assert.equal(result.commands[0]?.operation, "activate");
  assert.equal(result.commands[0]?.attempt, 2);

  result = apply(result.state, {kind: "tick", generation: 1}, 10);
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "confirmation-timeout");
});

test("stale and out-of-order observations cannot satisfy a newer request", () => {
  let result = intent(undefined, "streamer", "activate", 1);
  result = intent(result.state, "streamer", "activate", 2, 0.1);
  result = observed(result.state, "streamer", "active", 1, 1);
  assert.notEqual(result.state.phase, "ready");
  assert.equal(result.traces.at(-1)?.reason, "stale-generation");

  result = observed(result.state, "streamer", "inactive", 2, 3);
  result = observed(result.state, "streamer", "active", 2, 2);
  assert.equal(result.state.observed?.status, "inactive");
  assert.equal(result.traces.at(-1)?.reason, "out-of-order");
});

test("startup re-queries restored intent without replaying a command", () => {
  const active = intent(undefined, "streamer");
  const result = apply(active.state, {kind: "startup"}, 1);
  assert.deepEqual(result.commands.map(({operation}) => operation), ["observe"]);
  assert.equal(result.state.phase, "confirming");
  // The re-observation has a deadline, so it cannot wait for good.
  assert.equal(result.state.pending?.operation, "observe");
  assert.equal(result.state.pending?.deadlineAt, at(1).getTime() + config.confirmationTimeoutMs);
});

test("a restart mid-activation ends ready or failed, not waiting for good", () => {
  const active = intent(undefined, "streamer");
  let result = apply(active.state, {kind: "startup"}, 1);
  // The device has not switched yet: waiting, but with a deadline.
  result = apply(result.state, {kind: "observed", sourceId: "streamer", generation: 1, status: "inactive", observedAt: at(1.1).toISOString()}, 1.1);
  assert.equal(result.state.phase, "waiting_for_source");
  assert.ok(result.state.pending);
  for (let seconds = 2; seconds <= 40 && result.state.phase !== "failed"; seconds += 1) {
    result = apply(result.state, {kind: "tick", generation: 1}, seconds);
  }
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "confirmation-timeout");
  assert.equal(result.commands.some((command) => command.operation === "activate"), false);

  // With nothing pending, a tick says so rather than "stale-generation".
  const idle = apply(result.state, {kind: "tick", generation: 1}, 60);
  assert.equal(idle.traces.at(-1)?.reason, "nothing-pending");
});

test("a refresh keeps a settled source ready and stamps it with when the answer arrived", () => {
  let result = intent(undefined, "streamer");
  result = observed(result.state, "streamer", "active", 1, 2);
  assert.equal(theatreState(result).status, "ready");

  // A quiet source: its adapter reports the same reading, still dated 2 s.
  const refresh = apply(result.state, {kind: "refresh"}, 60);
  assert.equal(refresh.commands.length, 1);
  assert.equal(refresh.state.phase, "ready");
  assert.equal(refresh.state.pending, null);
  // Nothing is confirmed until the source answers.
  assert.deepEqual(refresh.events, []);

  const answer = apply(refresh.state, {
    kind: "observed", sourceId: "streamer", status: "active", generation: 1, observedAt: at(2).toISOString()
  }, 61);
  assert.equal(theatreState(answer).status, "ready");
  assert.equal(theatreState(answer).observedAt, at(61).toISOString());

  // An unasked-for report is stamped with its arrival too.
  const later = apply(answer.state, {
    kind: "observed", sourceId: "streamer", status: "active", generation: 1, observedAt: at(62).toISOString()
  }, 90);
  assert.equal(theatreState(later).observedAt, at(90).toISOString());

  // A refresh that is never answered neither fails nor leaves ready.
  let quiet = apply(later.state, {kind: "refresh"}, 120);
  for (let seconds = 121; seconds < 140; seconds += 1) {
    quiet = apply(quiet.state, {kind: "tick", generation: 1}, seconds);
  }
  assert.equal(quiet.state.phase, "ready");
});

test("a source whose clock runs behind is stamped with when its report arrived", () => {
  // The adapter's clock is 5 s behind: every report is dated 5 s early.
  let result = intent(undefined, "streamer", "activate", 1, 0);
  result = apply(result.state, {
    kind: "observed", sourceId: "streamer", status: "active", generation: 1, observedAt: at(3 - 5).toISOString()
  }, 3);
  assert.equal(theatreState(result).status, "ready");
  assert.equal(theatreState(result).observedAt, at(3).toISOString());

  // The theatre activity controller sees an up-to-date report, not one older
  // than the intent it answers.
  const theatre = transitionTheatre(undefined, {
    theatre: {kind: "intent", requestId: "tv-1", generation: 1, activity: "tv"}
  }, theatreConfig, at(0));
  const answered = transitionTheatre(theatre.state, {theatre: {...theatreState(result), kind: "target_state"} as TheatreInputEvent},
    theatreConfig, at(3));
  assert.equal(answered.state.targets.source?.status, "ready");
});

test("each kind of confirmation needs its own evidence", () => {
  const seen = (status: "active" | "available" | "inactive", extra: {application?: string | null; playback?: "playing" | "paused"} = {}): SourceObservation =>
    ({sourceId: "streamer", status, observedAt: at(0).toISOString(), application: extra.application ?? null, playback: extra.playback ?? "unknown"});
  const ready = (required: Parameters<typeof readinessEvidence>[1], observation: SourceObservation | null) =>
    readinessEvidence(observation, required).satisfied;

  assert.equal(ready("available", seen("available")), true);
  assert.equal(ready("available", seen("inactive")), false);
  assert.equal(ready("active", seen("available")), false);
  assert.equal(ready("active", seen("active")), true);
  assert.equal(ready("application", seen("active")), false);
  assert.equal(ready("application", seen("active", {application: "player"})), true);
  assert.equal(ready("playing", seen("active", {playback: "paused"})), false);
  assert.equal(ready("playing", seen("active", {playback: "playing"})), true);
  assert.equal(ready("unavailable", seen("active", {playback: "playing"})), false);
  assert.equal(ready("active", null), false);
  assert.deepEqual(readinessEvidence(seen("active", {application: "player"}), "application"), {
    required: "application", available: true, active: true, application: "player", playback: "unknown", satisfied: true
  });
});

test("a source node with nothing saved adopts a refresh's wanted source and observes, never activating it", () => {
  let result = apply(undefined, {kind: "refresh", requestId: "activity-3", generation: 3, sourceId: "streamer", action: "activate"});
  assert.equal(result.state.desired?.sourceId, "streamer");
  assert.deepEqual(result.commands.map(({operation}) => operation), ["observe"]);
  result = observed(result.state, "streamer", "active", 3, 0.5);
  assert.deepEqual(result.commands, []);
  assert.equal(theatreState(result).status, "ready");
  assert.equal(theatreState(result).requestId, "activity-3");
  // Not running: it is never activated, and doesn't report ready.
  let other = apply(undefined, {kind: "refresh", requestId: "activity-4", generation: 4, sourceId: "streamer", action: "activate"});
  const sent = [...other.commands];
  other = observed(other.state, "streamer", "inactive", 4, 0.5);
  sent.push(...other.commands);
  for (const seconds of [2, 4, 6]) {
    other = apply(other.state, {kind: "tick", generation: 4}, seconds);
    sent.push(...other.commands);
  }
  assert.ok(!sent.some(({operation}) => operation === "activate"), JSON.stringify(sent));
  assert.notEqual(theatreState(other).status, "ready");
});

test("an adopted request the source doesn't match is a manual override, and it is never activated", () => {
  let result = apply(undefined, {kind: "refresh", requestId: "activity-5", generation: 5, sourceId: "streamer", action: "activate"});
  result = observed(result.state, "streamer", "inactive", 5, 0.5);
  assert.equal(result.state.phase, "manual_override");
  assert.equal(theatreState(result).classification, "manual_override");
  assert.ok(!result.commands.some(({operation}) => operation === "activate"));
});
