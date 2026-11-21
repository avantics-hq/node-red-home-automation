"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  normaliseActivityProfiles,
  transitionTheatre,
  type ActivityProfiles,
  type TargetClassification,
  type TargetFailure,
  type TargetStatus,
  type TheatreConfig,
  type TheatreInputEvent,
  type TheatreState,
  type TheatreTarget
} from "../lib/theatre-activity-controller";

const activityProfiles: ActivityProfiles = normaliseActivityProfiles({
  off: {
    display: {mode: "off"},
    avr: {power: "standby"},
    source: {action: "deactivate", readiness: "optional"},
    lighting: {profile: "off"},
    backlighting: {power: "off"}
  },
  tv_shield: {
    display: {mode: "tv"},
    avr: {power: "on", source: "shield"},
    source: {action: "activate", sourceId: "shield", readiness: "required"},
    lighting: {profile: "tv"},
    backlighting: {power: "on"}
  },
  tv_ps5: {
    display: {mode: "tv"},
    avr: {power: "on", source: "playstation"},
    source: {action: "activate", sourceId: "playstation", readiness: "required"},
    lighting: {profile: "tv"},
    backlighting: {power: "on"}
  },
  projector_shield: {
    display: {mode: "projector"},
    avr: {power: "on", source: "shield"},
    source: {action: "activate", sourceId: "shield", readiness: "required"},
    lighting: {profile: "projector"},
    backlighting: {power: "off"}
  },
  projector_ps5: {
    display: {mode: "projector"},
    avr: {power: "on", source: "playstation"},
    source: {action: "activate", sourceId: "playstation", readiness: "required"},
    lighting: {profile: "projector"},
    backlighting: {power: "off"}
  }
});
const activities = Object.keys(activityProfiles);
const config: TheatreConfig = {area: "lounge", freshnessMs: 10000, activityProfiles};
const at = (seconds: number): Date =>
  new Date(Date.parse("2026-11-21T14:00:00Z") + seconds * 1000);

function apply(
  state: Partial<TheatreState> | undefined,
  theatre: TheatreInputEvent,
  seconds = 0
) {
  return transitionTheatre(state, {theatre}, config, at(seconds));
}

function request(
  state: Partial<TheatreState> | undefined,
  activity: string,
  generation = 1,
  seconds = 0,
  requestId = `${activity}-${generation}`
) {
  return apply(state, {kind: "intent", requestId, generation, activity}, seconds);
}

interface TargetValues {
  classification?: TargetClassification;
  failure?: TargetFailure;
  details?: Record<string, unknown>;
}

function target(
  state: Partial<TheatreState> | undefined,
  name: TheatreTarget,
  status: TargetStatus,
  generation: number,
  seconds: number,
  values: TargetValues = {}
) {
  return apply(state, {
    kind: "target_state",
    target: name,
    status,
    generation,
    observedAt: at(seconds).toISOString(),
    ...values
  }, seconds);
}

function confirmCore(state: Partial<TheatreState>, generation: number, seconds = 1) {
  let result = target(state, "display", "ready", generation, seconds);
  result = target(result.state, "avr", "ready", generation, seconds + 0.1);
  result = target(result.state, "backlighting", "ready", generation, seconds + 0.2);
  return result;
}

function confirmActivity(activity: string, generation = 1) {
  let result = request(undefined, activity, generation);
  result = confirmCore(result.state, generation);
  const profile = activityProfiles[activity];
  assert.ok(profile);
  if (profile.source.readiness === "required") {
    result = target(result.state, "source", "ready", generation, 1.2);
  }
  return result;
}

test("activity and source names are configuration-owned", () => {
  const customProfiles = normaliseActivityProfiles({
    movie_night: {
      display: {mode: "projection"},
      avr: {power: "on", input: "disc"},
      source: {action: "activate", sourceId: "disc_player", readiness: "required"},
      lighting: {profile: "dim"},
      backlighting: {power: "off"}
    }
  });
  const result = transitionTheatre(undefined, {
    theatre: {
      kind: "intent",
      requestId: "movie-night-1",
      generation: 1,
      activity: "movie_night"
    }
  }, {activityProfiles: customProfiles}, at(0));

  assert.equal(result.commands.find(({target}) => target === "source")?.sourceId, "disc_player");
  assert.throws(
    () => normaliseActivityProfiles({
      broken: {...customProfiles.movie_night, source: {action: "activate", sourceId: "disc_player"}}
    }),
    /source readiness/
  );
  assert.throws(
    () => normaliseActivityProfiles({
      broken: {...customProfiles.movie_night, lighting: {profile: "not valid"}}
    }),
    /invalid lighting profile/
  );
  assert.throws(
    () => normaliseActivityProfiles({
      broken: {...customProfiles.movie_night, backlighting: {power: "toggle"}}
    }),
    /invalid backlighting power/
  );
});


test("uses configured activity profiles as semantic target states", () => {
  const expected = {
    off: ["off", "standby", null, "off", "off"],
    tv_shield: ["tv", "on", "shield", "tv", "on"],
    tv_ps5: ["tv", "on", "playstation", "tv", "on"],
    projector_shield: ["projector", "on", "shield", "projector", "off"],
    projector_ps5: ["projector", "on", "playstation", "projector", "off"]
  };

  assert.deepEqual(activities, Object.keys(expected));
  for (const [activity, values] of Object.entries(expected)) {
    const result = request(undefined, activity);
    assert.equal(result.commands.length, 5);
    assert.deepEqual(result.commands.map((command) => command.target), [
      "display", "avr", "source", "lighting", "backlighting"
    ]);
    assert.deepEqual([
      result.commands[0]?.mode,
      result.commands[1]?.power,
      result.commands[2]?.sourceId,
      result.commands[3]?.profile,
      result.commands[4]?.power
    ], values);
    assert.equal(result.commands.every((command) => command.kind === "intent"), true);
    assert.equal(result.commands.every((command) => command.generation === 1), true);
    assert.deepEqual(activityProfiles[activity]?.display, {mode: values[0]});
  }
});

test("every activity becomes ready only from fresh mandatory confirmations", () => {
  for (const activity of activities) {
    const result = confirmActivity(activity);
    assert.equal(result.state.phase, "ready", activity);
    assert.equal(result.state.currentActivity, activity);
    assert.equal(result.events.some((entry) => entry.theatre.kind === "ready"), true);
  }
});

test("source readiness is explicit and PS5 never pretends it was powered on", () => {
  let result = request(undefined, "projector_ps5", 3);
  const sourceCommand = result.commands.find((command) => command.target === "source");
  assert.deepEqual(sourceCommand, {
    target: "source",
    kind: "intent",
    requestId: "projector_ps5-3",
    generation: 3,
    action: "activate",
    sourceId: "playstation",
    readiness: "required"
  });

  result = confirmCore(result.state, 3);
  assert.equal(result.state.phase, "waiting_for_source");
  assert.equal(result.state.currentActivity, "unknown");

  result = target(result.state, "source", "unavailable", 3, 1.2, {
    failure: {reason: "no-supported-control"}
  });
  assert.equal(result.state.phase, "waiting_for_source");
  assert.equal(result.state.failure, null);

  result = target(result.state, "source", "ready", 3, 1.3);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.currentActivity, "projector_ps5");
});

test("new requests supersede unfinished work and stale target state is inert", () => {
  let result = request(undefined, "projector_shield", 1);
  result = target(result.state, "display", "transitioning", 1, 0.1);
  result = request(result.state, "tv_ps5", 2, 0.2);

  assert.equal(result.events.some((entry) => entry.theatre.kind === "superseded"), true);
  assert.equal(result.commands.length, 5);
  assert.equal(result.state.desired?.activity, "tv_ps5");

  result = target(result.state, "display", "ready", 1, 0.3);
  assert.equal(result.state.targets.display, null);
  assert.equal(result.commands.length, 0);
  assert.equal(result.traces.some((entry) => entry.reason === "stale-generation"), true);
});

test("same-generation conflicts are rejected while exact duplicates are idempotent", () => {
  let result = request(undefined, "tv_shield", 4, 0, "request-4");
  result = request(result.state, "tv_shield", 4, 0.1, "request-4");
  assert.equal(result.commands.length, 0);
  assert.equal(result.traces.some((entry) => entry.outcome === "duplicate"), true);

  result = request(result.state, "tv_ps5", 4, 0.2, "request-4");
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.desired?.activity, "tv_shield");
  assert.equal(result.events.some((entry) => entry.theatre.reason === "request-conflict"), true);
});

test("mandatory target failure blocks its generation across refresh and fails closed", () => {
  let result = request(undefined, "tv_shield", 5);
  result = target(result.state, "display", "failed", 5, 1, {
    failure: {operation: "tv_on", reason: "confirmation-timeout", occurredAt: at(1).toISOString()}
  });

  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.blockedGeneration, 5);
  assert.deepEqual(result.state.failure, {
    target: "display",
    operation: "tv_on",
    reason: "confirmation-timeout",
    occurredAt: at(1).toISOString()
  });
  assert.equal(result.commands.length, 0);

  result = target(result.state, "display", "ready", 5, 1.1);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.commands.length, 0);

  result = apply(result.state, {kind: "startup"}, 2);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.commands.length, 5);
  assert.equal(result.commands.every((command) => command.kind === "refresh"), true);
});

test("a newer request clears a blocked generation and can recover", () => {
  let result = request(undefined, "projector_shield", 6);
  result = target(result.state, "avr", "unavailable", 6, 0.5, {
    failure: {reason: "connection-refused"}
  });
  assert.equal(result.state.phase, "failed");

  result = request(result.state, "off", 7, 1);
  assert.equal(result.state.failure, null);
  assert.equal(result.state.blockedGeneration, null);
  result = confirmCore(result.state, 7, 1.1);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.currentActivity, "off");
});

test("optional lighting failures are visible degradation but do not lie about core readiness", () => {
  let result = request(undefined, "tv_shield", 8);
  result = target(result.state, "lighting", "failed", 8, 0.5, {
    failure: {reason: "zigbee-unavailable"}
  });
  result = target(result.state, "backlighting", "ready", 8, 0.6);
  result = confirmCore(result.state, 8, 0.7);
  result = target(result.state, "source", "ready", 8, 0.9);

  assert.equal(result.state.phase, "ready");
  assert.deepEqual(result.state.degraded, [{target: "lighting", reason: "zigbee-unavailable"}]);
  assert.equal(result.state.availability, "degraded");
  assert.equal(result.state.transitionStartedAt, at(0).toISOString());
  assert.equal(result.state.transitionCompletedAt, at(0.9).toISOString());
  const eventDegraded = result.events[0]?.theatre.degraded as
    | Array<{target: TheatreTarget; reason: string}>
    | undefined;
  assert.equal(eventDegraded?.[0]?.target, "lighting");
});

test("backlighting confirmation is mandatory and failure blocks the generation", () => {
  let result = request(undefined, "tv_shield", 14);
  result = target(result.state, "display", "ready", 14, 0.2);
  result = target(result.state, "avr", "ready", 14, 0.3);
  result = target(result.state, "source", "ready", 14, 0.4);
  assert.equal(result.state.phase, "confirming");
  assert.equal(result.state.currentActivity, "unknown");

  result = target(result.state, "backlighting", "failed", 14, 0.5, {
    failure: {operation: "set_power", reason: "confirmation-timeout"}
  });
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.target, "backlighting");
  assert.equal(result.state.blockedGeneration, 14);
});

test("fresh target drift removes ready state without creating a new activity", () => {
  let result = confirmActivity("tv_shield", 9);
  result = target(result.state, "display", "transitioning", 9, 2, {
    details: {reason: "physical-remote-drift"}
  });

  assert.equal(result.state.phase, "transitioning");
  assert.equal(result.state.currentActivity, "unknown");
  assert.equal(result.state.desired?.activity, "tv_shield");
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.targets.display?.classification, "drift");
  assert.equal(result.events.some((entry) => entry.theatre.kind === "drift"), true);
  assert.equal(result.state.availability, "degraded");
});

test("explicit manual override classification remains evidence, not a new request", () => {
  let result = confirmActivity("projector_shield", 12);
  result = target(result.state, "display", "transitioning", 12, 2, {
    classification: "manual_override",
    details: {reason: "physical-remote"}
  });

  assert.equal(result.state.targets.display?.classification, "manual_override");
  assert.equal(result.events.some((entry) => entry.theatre.kind === "manual_override"), true);
  assert.equal(result.state.desired?.activity, "projector_shield");
  assert.equal(result.state.generation, 12);
});

test("adapter failure after ready is failure evidence, not physical drift", () => {
  let result = confirmActivity("tv_shield", 13);
  result = target(result.state, "display", "failed", 13, 2, {
    failure: {reason: "transport-timeout"}
  });

  assert.equal(result.state.phase, "failed");
  assert.equal(result.events.some((entry) => entry.theatre.kind === "failed"), true);
  assert.equal(result.events.some((entry) => entry.theatre.kind === "drift"), false);
  assert.equal(result.state.targets.display?.classification, null);
});

test("stale observations trigger one refresh and cannot preserve ready", () => {
  let result = confirmActivity("projector_shield", 10);
  result = apply(result.state, {kind: "tick", generation: 10}, 12);

  assert.equal(result.state.phase, "confirming");
  assert.equal(result.state.currentActivity, "unknown");
  assert.deepEqual(result.commands.map((command) => command.target).sort(), [
    "avr", "backlighting", "display", "source"
  ]);

  result = apply(result.state, {kind: "tick", generation: 10}, 13);
  assert.equal(result.commands.length, 0);
});

test("older same-generation observations cannot overwrite newer target state", () => {
  let result = request(undefined, "off", 11);
  result = target(result.state, "display", "ready", 11, 2);
  result = target(result.state, "display", "failed", 11, 1, {
    failure: {reason: "late-failure"}
  });

  assert.equal(result.state.targets.display?.status, "ready");
  assert.equal(result.state.phase, "confirming");
  assert.equal(result.traces.some((entry) => entry.reason === "out-of-order"), true);
});
