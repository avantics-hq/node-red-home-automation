"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {evaluateTheatreSlo, type TheatreSloState} from "../lib/theatre-slo";
import {transitionBacklighting, type BacklightingState} from "../lib/backlighting-controller";
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

test("new requests supersede every unfinished activity boundary", () => {
  const preparing = request(undefined, "projector_shield", 1);
  const confirming = target(preparing.state, "display", "ready", 1, 0.1);
  const transitioning = target(preparing.state, "display", "transitioning", 1, 0.1);
  const waiting = confirmCore(request(undefined, "projector_ps5", 1).state, 1);
  const boundaries = [
    ["preparing", preparing.state],
    ["confirming", confirming.state],
    ["transitioning", transitioning.state],
    ["waiting_for_source", waiting.state]
  ] as const;

  for (const [phase, state] of boundaries) {
    assert.equal(state.phase, phase);
    let result = request(state, "tv_shield", 2, 2, `supersede-${phase}`);
    assert.equal(result.events.some((entry) => entry.theatre.kind === "superseded"), true);
    assert.equal(result.commands.length, 5);
    assert.equal(result.state.desired?.activity, "tv_shield");

    result = target(result.state, "display", "ready", 1, 2.1);
    assert.equal(result.state.targets.display, null);
    assert.equal(result.commands.length, 0);
    assert.equal(result.traces.some((entry) => entry.reason === "stale-generation"), true);
  }
});

test("startup from every active phase refreshes observations without replaying intents", () => {
  const preparing = request(undefined, "projector_shield", 1);
  const confirming = target(preparing.state, "display", "ready", 1, 0.1);
  const transitioning = target(preparing.state, "display", "transitioning", 1, 0.1);
  const waiting = confirmCore(request(undefined, "projector_ps5", 1).state, 1);
  const ready = confirmActivity("tv_shield");

  for (const state of [
    preparing.state,
    confirming.state,
    transitioning.state,
    waiting.state,
    ready.state
  ]) {
    const result = apply(state, {kind: "startup"}, 3);
    assert.equal(result.state.phase, "confirming");
    assert.equal(result.state.currentActivity, "unknown");
    assert.equal(result.commands.length, 5);
    assert.equal(result.commands.every((command) => command.kind === "refresh"), true);
    assert.equal(result.traces.some((entry) =>
      entry.event === "startup" && entry.outcome === "refreshing"), true);
  }
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
  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.commands.length, 0);
  assert.equal(result.state.metrics.manualOverrides, 1);
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

test("a stale target while ready is refreshed without leaving ready", () => {
  let result = confirmActivity("projector_shield", 10);
  result = apply(result.state, {kind: "tick", generation: 10}, 12);

  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.currentActivity, "projector_shield");
  assert.deepEqual(result.commands.map((command) => command.target).sort(), [
    "avr", "backlighting", "display", "source"
  ]);
  assert.deepEqual(result.state.degraded.filter(({reason}) => reason === "stale").map(({target}) => target).sort(), [
    "avr", "backlighting", "display", "source"
  ]);

  // Within the retry interval nothing is re-sent.
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

test("startup without persisted intent probes before recovering physical state", () => {
  const result = apply(undefined, {kind: "startup"});
  assert.equal(result.state.phase, "recovering");
  assert.deepEqual(result.commands.map(({target, kind}) => ({target, kind})), [
    {target: "display", kind: "refresh"},
    {target: "avr", kind: "refresh"},
    {target: "source", kind: "refresh"},
    {target: "lighting", kind: "refresh"},
    {target: "backlighting", kind: "refresh"}
  ]);
  assert.equal(result.events.some(({theatre}) => theatre.kind === "recovery_required"), true);
});

test("recovery adopts one clean physical profile without issuing commands", () => {
  const startup = apply(undefined, {kind: "startup"});
  const observedAt = at(1).toISOString();
  const result = apply(startup.state, {
    kind: "recover",
    reason: "startup",
    observations: {
      display: {observedAt, values: {mode: "tv"}},
      avr: {observedAt, values: {power: "on", source: "shield"}},
      source: {observedAt, values: {action: "activate", sourceId: "shield"}},
      backlighting: {observedAt, values: {power: "on"}}
    }
  }, 1);

  assert.equal(result.commands.length, 0);
  assert.equal(result.state.desired?.activity, "tv_shield");
  assert.equal(result.state.currentActivity, "tv_shield");
  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.generation, 1);
  assert.equal(result.state.metrics.recoveriesAdopted, 1);
  assert.equal(result.state.metrics.lastOutcome, "recovery_adopted");
});

test("ambiguous startup recovery leaves the activity unknown and commands nothing", () => {
  const observedAt = at(1).toISOString();
  const result = apply(undefined, {
    kind: "recover",
    reason: "startup",
    observations: {
      display: {observedAt, values: {mode: "tv"}},
      avr: {observedAt, values: {power: "standby"}},
      source: {observedAt, values: {action: "deactivate"}},
      backlighting: {observedAt, values: {power: "on"}}
    }
  }, 1);

  assert.equal(result.state.desired, null);
  assert.equal(result.state.phase, "idle");
  assert.equal(result.state.currentActivity, "unknown");
  assert.deepEqual(result.commands, [], "a running activity is never switched off");
  assert.equal(result.state.metrics.recoveriesUnknown, 1);
  assert.equal(result.state.metrics.lastOutcome, "recovery_unknown");
  assert.equal(result.events.some(({theatre}) => theatre.kind === "recovery_unknown"), true);

  // The next request is handled as usual.
  const next = apply(result.state, {kind: "intent", requestId: "after-recovery", generation: 1, activity: "tv_shield"}, 2);
  assert.equal(next.state.desired?.activity, "tv_shield");
  assert.equal(next.commands.filter(({kind}) => kind === "intent").length, 5);
});

test("ambiguous manual recovery holds ownership without issuing commands", () => {
  let result = confirmActivity("tv_shield", 16);
  result = target(result.state, "avr", "transitioning", 16, 2, {
    classification: "manual_override"
  });
  const observedAt = at(2.1).toISOString();
  result = apply(result.state, {
    kind: "recover",
    reason: "manual_override",
    observations: {
      display: {observedAt, values: {mode: "tv"}},
      avr: {observedAt, values: {power: "on", source: "unknown"}},
      source: {observedAt, values: {action: "deactivate"}},
      backlighting: {observedAt, values: {power: "on"}}
    }
  }, 2.1);

  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.commands.length, 0);
  assert.equal(result.events.some(({theatre}) => theatre.kind === "recovery_ambiguous"), true);
});

test("metrics retain transition latency, retries, fallback use and target availability", () => {
  let result = request(undefined, "tv_shield", 17);
  result = target(result.state, "display", "transitioning", 17, 1, {
    details: {metrics: {attempts: 2, fallbackUsed: true}}
  });
  result = target(result.state, "display", "ready", 17, 2, {
    details: {metrics: {attempts: 2, fallbackUsed: true}}
  });
  result = target(result.state, "avr", "ready", 17, 2.1);
  result = target(result.state, "backlighting", "ready", 17, 2.2);
  result = target(result.state, "source", "ready", 17, 2.3);

  assert.equal(result.state.metrics.requests, 1);
  assert.equal(result.state.metrics.ready, 1);
  assert.equal(result.state.metrics.lastTransitionMs, 2300);
  assert.equal(result.state.metrics.maxTransitionMs, 2300);
  assert.equal(result.state.metrics.targets.display.retries, 1);
  assert.equal(result.state.metrics.targets.display.fallbackUses, 1);
  assert.equal(result.state.metrics.targets.display.lastConfirmationMs, 2000);
  assert.equal(result.state.metrics.targets.display.availability, "available");
});

function sloSnapshot(state: TheatreState) {
  return {
    generation: state.generation,
    desiredActivity: state.desired?.activity ?? null,
    phase: state.phase,
    transitionStartedAt: state.transitionStartedAt,
    transitionCompletedAt: state.transitionCompletedAt,
    metrics: state.metrics
  };
}

test("a settled activity stays ready through refresh cycles without false transitions", () => {
  // dev-review repro: everything ready at about 1 s, then ticks past several
  // freshness windows (10 s here) with owners answering each refresh.
  let result = confirmActivity("tv_shield", 1);
  const firstTransitionMs = result.state.metrics.lastTransitionMs;
  assert.equal(result.state.metrics.ready, 1);
  let slo: TheatreSloState | undefined;
  for (let seconds = 5; seconds <= 200; seconds += 5) {
    result = apply(result.state, {kind: "tick", generation: 1}, seconds);
    for (const command of result.commands) {
      result = target(result.state, command.target as TheatreTarget, "ready", 1, seconds + 0.1);
    }
    assert.equal(result.state.phase, "ready", `phase at ${seconds} s`);
    const assessment = evaluateTheatreSlo(slo, sloSnapshot(result.state), {}, at(seconds + 0.1));
    slo = assessment.state;
    assert.notEqual(assessment.assessment.status, "breached", `SLO at ${seconds} s: ${assessment.assessment.reason}`);
  }
  assert.equal(result.state.metrics.ready, 1);
  assert.equal(result.state.metrics.lastTransitionMs, firstTransitionMs);
  assert.equal(result.state.metrics.requests, 1);
});

test("an unanswered refresh is retried a bounded number of times, then reported", () => {
  let result = confirmActivity("tv_shield", 1);
  const sent: number[] = [];
  const reported: number[] = [];
  for (const seconds of [7, 12, 17, 22, 27, 32]) {
    result = apply(result.state, {kind: "tick", generation: 1}, seconds);
    sent.push(result.commands.length);
    reported.push(result.traces.filter((entry) => entry.event === "refresh" && entry.outcome === "no-response").length);
  }
  // First refresh, two retries, then each target is reported once and asked
  // again a freshness window later.
  assert.deepEqual(sent, [4, 4, 4, 0, 0, 4]);
  assert.deepEqual(reported, [0, 0, 0, 4, 0, 0]);
  assert.equal(result.state.phase, "ready");
  assert.deepEqual(Object.fromEntries(result.state.degraded.map(({target: name, reason}) => [name, reason])), {
    lighting: "unconfirmed", display: "no-response", avr: "no-response", backlighting: "no-response", source: "no-response"
  });
  assert.equal(result.state.metrics.targets.avr.availability, "unavailable");
  const assessment = evaluateTheatreSlo(undefined, sloSnapshot(result.state), {}, at(32));
  assert.notEqual(assessment.assessment.reason, "transition_timeout");

  // A late answer restores it.
  result = target(result.state, "avr", "ready", 1, 33);
  assert.equal(result.state.degraded.some(({target: name}) => name === "avr"), false);
});

test("a refresh lost after a restart ends as unavailable, not stuck confirming", () => {
  let result = confirmActivity("tv_shield", 1);
  result = apply(result.state, {kind: "startup"}, 50);
  assert.equal(result.state.phase, "confirming");
  for (const seconds of [55, 60, 65]) result = apply(result.state, {kind: "tick", generation: 1}, seconds);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "no-response");
  result = apply(result.state, {kind: "tick", generation: 1}, 3650);
  assert.equal(result.state.phase, "failed");
});

test("recovery with no observations times out to an unknown activity, commanding nothing", () => {
  let result = apply(undefined, {kind: "startup"}, 0);
  assert.equal(result.state.phase, "recovering");
  const kinds: string[] = [];
  for (const seconds of [5, 10, 15]) {
    result = apply(result.state, {kind: "tick", generation: 0}, seconds);
    kinds.push(...result.commands.map((command) => command.kind));
  }
  assert.equal(result.state.desired, null);
  assert.equal(result.state.currentActivity, "unknown");
  assert.equal(result.traces.some((entry) => entry.event === "recovery" && entry.outcome === "timed-out"), true);
  assert.equal(result.events.some(({theatre}) => theatre.kind === "recovery_unknown"), true);
  assert.equal(kinds.filter((kind) => kind === "intent").length, 0, "no Off activity");
  // Idle: no more ticks are needed and none probe again.
  assert.equal(result.state.phase, "idle");
  assert.deepEqual(apply(result.state, {kind: "tick", generation: 0}, 20).commands, []);
});

test("a request is never lost to a generation the controller used for recovery", () => {
  // dev-review repro: recovery bumps the controller to generation 1 while the
  // contract, not yet told, numbers the user's request 1 as well. Adopting
  // the one matching activity takes a generation.
  let result = apply(undefined, {kind: "startup"}, 0);
  const observedAt = at(1).toISOString();
  result = apply(result.state, {kind: "recover", reason: "startup", observations: {
    display: {observedAt, values: {mode: "tv"}},
    avr: {observedAt, values: {power: "on", source: "shield"}},
    source: {observedAt, values: {action: "activate", sourceId: "shield"}},
    backlighting: {observedAt, values: {power: "on"}}
  }}, 1);
  assert.equal(result.state.desired?.activity, "tv_shield");
  assert.equal(result.state.generation, 1);

  result = request(result.state, "tv_shield", 1, 2, "user-request-1");
  assert.equal(result.events.some(({theatre}) => theatre.kind === "rejected"), false);
  assert.equal(result.state.desired?.requestId, "user-request-1");
  assert.equal(result.state.generation, 2);
  assert.equal(result.traces.some((entry) => entry.outcome === "reassigned"), true);
  assert.equal(result.commands.every((command) => command.generation === 2), true);

  // Back-to-back requests before any snapshot syncs the contract: it proposes
  // 2 for the next one, which is now taken too, and must not be lost.
  const quick = request(result.state, "off", 2, 2.1, "user-request-quick");
  assert.equal(quick.events.some(({theatre}) => theatre.kind === "rejected"), false);
  assert.equal(quick.state.desired?.requestId, "user-request-quick");
  assert.equal(quick.state.generation, 3);

  // The contract learns 2 from the snapshot and proposes 3 next: used as given.
  result = request(result.state, "off", 3, 3, "user-request-2");
  assert.equal(result.state.generation, 3);
  // A request the controller already moved past is still rejected.
  result = request(result.state, "tv_shield", 2, 4, "late-request");
  assert.equal(result.events.find(({theatre}) => theatre.kind === "rejected")?.theatre.reason, "stale-generation");
  // And a different request reusing the current generation still conflicts.
  result = request(result.state, "tv_shield", 3, 5, "other-request");
  assert.equal(result.events.find(({theatre}) => theatre.kind === "rejected")?.theatre.reason, "generation-conflict");
});

test("transition time covers only the transition, not later overrides or failures", () => {
  const settled = confirmActivity("tv_shield", 1);
  const transitionMs = settled.state.metrics.lastTransitionMs;
  assert.equal(transitionMs, 1200);

  // A person takes over the receiver an hour later.
  const manual = target(settled.state, "avr", "transitioning", 1, 3600, {classification: "manual_override"});
  assert.equal(manual.state.phase, "manual_override");
  assert.equal(manual.state.metrics.lastTransitionMs, transitionMs);
  assert.equal(manual.state.metrics.maxTransitionMs, transitionMs);

  // A target fails an hour later: the activity fails, but the transition
  // it completed is not retimed.
  const failed = target(settled.state, "display", "failed", 1, 3600, {
    failure: {operation: "query", reason: "timeout", occurredAt: at(3600).toISOString()}
  });
  assert.equal(failed.state.phase, "failed");
  assert.equal(failed.state.metrics.lastTransitionMs, transitionMs);
  assert.equal(failed.state.transitionCompletedAt, settled.state.transitionCompletedAt);
});

test("a target that stopped answering is still refreshed on later cycles", () => {
  let result = confirmActivity("tv_shield", 1);
  const asked: number[] = [];
  for (let seconds = 5; seconds <= 120; seconds += 5) {
    result = apply(result.state, {kind: "tick", generation: 1}, seconds);
    // Everyone answers except the receiver.
    for (const command of result.commands) {
      if (command.target === "avr") asked.push(seconds);
      else result = target(result.state, command.target as TheatreTarget, "ready", 1, seconds + 0.1);
    }
  }
  // Long after it was reported, the receiver is still asked, once per
  // freshness window, and still shown as not responding.
  assert.ok(asked.some((seconds) => seconds > 60), JSON.stringify(asked));
  assert.ok(asked.filter((seconds) => seconds > 60).length <= 6, JSON.stringify(asked));
  assert.deepEqual(result.state.degraded.filter(({target: name}) => name === "avr"), [{target: "avr", reason: "no-response"}]);

  // When it answers again, it is no longer reported.
  result = target(result.state, "avr", "ready", 1, 121);
  assert.equal(result.state.degraded.some(({target: name}) => name === "avr"), false);
});

test("a refresh carries the activity's wanted values, so a target node with nothing saved can adopt them", () => {
  let result = confirmActivity("tv_shield", 21);
  // Past freshness, the controller refreshes its targets.
  result = apply(result.state, {kind: "tick", generation: 21}, 15);
  const refreshes = Object.fromEntries(result.commands.filter(({kind}) => kind === "refresh").map((command) => [command.target, command]));
  // Each target refreshed carries its part of the profile, as its intent did.
  const wanted: Record<string, Record<string, unknown>> = {
    display: {mode: "tv"}, avr: {power: "on", source: "shield"}, source: {action: "activate", sourceId: "shield"},
    lighting: {profile: "tv"}, backlighting: {power: "on"}
  };
  assert.ok(Object.keys(refreshes).length >= 3, Object.keys(refreshes).join());
  for (const [target, command] of Object.entries(refreshes)) {
    for (const [key, value] of Object.entries(wanted[target]!)) assert.equal((command as Record<string, unknown>)[key], value, `${target}.${key}`);
  }
  assert.equal(refreshes.display?.requestId, result.state.desired?.requestId);
  // A probe with nothing desired carries none.
  const probe = apply(undefined, {kind: "startup"}, 0).commands.find(({target}) => target === "display");
  assert.equal(probe?.mode, undefined);
});

test("off and ready: a backlighting refresh round trip through its own controller is no drift and no phase change", () => {
  let theatre = confirmActivity("off", 1);
  assert.equal(theatre.state.phase, "ready");
  const backlightingConfig = {pollMs: 1000, confirmationTimeoutMs: 5000, maxAttempts: 2};
  const backlighting = (state: Partial<BacklightingState> | undefined, event: Record<string, unknown>, seconds: number) =>
    transitionBacklighting(state, {backlighting: event as never}, backlightingConfig, at(seconds));
  // The backlighting node, settled off under the same request.
  let lights = backlighting(undefined, {kind: "intent", requestId: "off-1", generation: 1, power: "off", requestedAt: at(0).toISOString()}, 0);
  lights = backlighting(lights.state, {kind: "command_result", generation: 1, ok: true}, 0.1);
  lights = backlighting(lights.state, {kind: "observed", generation: 1, power: "off", observedAt: at(0.5).toISOString()}, 0.5);
  assert.equal(lights.state.phase, "ready");

  const driftBefore = theatre.state.metrics.driftEvents;
  for (let seconds = 15; seconds <= 75; seconds += 15) {
    theatre = apply(theatre.state, {kind: "tick", generation: 1}, seconds);
    for (const command of theatre.commands) {
      if (command.target !== "backlighting") {
        theatre = target(theatre.state, command.target as TheatreTarget, "ready", 1, seconds + 0.1);
        continue;
      }
      // The refresh reaches the backlighting node; whatever it reports goes back, then its reading.
      lights = backlighting(lights.state, {...command}, seconds);
      const answers = [...lights.events];
      if (lights.commands.some(({operation}) => operation === "observe")) {
        lights = backlighting(lights.state, {kind: "observed", generation: 1, power: "off", observedAt: at(seconds + 0.04).toISOString()}, seconds + 0.04);
        answers.push(...lights.events);
      }
      for (const {theatre: event} of answers) {
        theatre = apply(theatre.state, event as unknown as TheatreInputEvent, seconds + 0.05);
        assert.equal(theatre.state.phase, "ready", `phase at ${seconds} s`);
        assert.equal(theatre.state.targets.backlighting?.status, "ready", `backlighting at ${seconds} s`);
      }
    }
    assert.equal(theatre.state.phase, "ready", `phase at ${seconds} s`);
  }
  assert.equal(theatre.state.metrics.driftEvents, driftBefore, "no drift events");
});
