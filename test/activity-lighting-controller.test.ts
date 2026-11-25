"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  normaliseActivityLightingConfig,
  normaliseLightingProfiles,
  transitionActivityLighting,
  type ActivityLightingConfig,
  type ActivityLightingEvent,
  type ActivityLightingState
} from "../lib/activity-lighting-controller";
import {scheduledLighting} from "../lib/circadian";
import {resolveSchedule} from "../lib/circadian-schedule";
import {type RoomConfig, type RoomState} from "../lib/room-controller";
import {publishRoom} from "../lib/room-publishing";

const config: ActivityLightingConfig = {
  profiles: {
    off: {targets: [], values: {}},
    tv: {targets: ["wall", "lamp"], values: {brightness: 64, color_temp: 400}},
    projector: {targets: ["wall"], values: {brightness: 10}}
  },
  owner: "lounge-activity",
  confirmationTimeoutMs: 5000,
  maxAttempts: 2
};
const at = (seconds: number): Date =>
  new Date(Date.parse("2026-11-21T16:00:00Z") + seconds * 1000);

function apply(
  state: Partial<ActivityLightingState> | undefined,
  activityLighting: ActivityLightingEvent,
  seconds = 0
) {
  return transitionActivityLighting(state, {activityLighting}, config, at(seconds));
}

function intent(
  state: Partial<ActivityLightingState> | undefined,
  profile = "tv",
  generation = 1,
  seconds = 0
) {
  return apply(state, {
    kind: "intent",
    requestId: `${profile}-${generation}`,
    generation,
    profile
  }, seconds);
}

test("lighting profiles are deployment data with explicit semantic values", () => {
  assert.deepEqual(normaliseLightingProfiles({cinema: {
    targets: ["wall"],
    values: {brightness: 12, effect: "solid"}
  }}), {
    cinema: {targets: ["wall"], values: {brightness: 12, effect: "solid"}}
  });
  assert.throws(
    () => normaliseLightingProfiles({cinema: {targets: ["wall", "wall"], values: {}}}),
    /duplicate targets/
  );
});

test("activity profiles style only active non-manual room lights", () => {
  const result = intent(undefined);
  const command = result.commands[0];
  assert.equal(command?.operation, "apply");
  assert.deepEqual(command?.lighting, {
    kind: "intent",
    targets: ["wall", "lamp"],
    state: "ON",
    values: {brightness: 64, color_temp: 400},
    source: "activity",
    owner: "lounge-activity",
    updateOnOnly: true,
    preserveManual: true
  });
  assert.equal(result.state.phase, "transitioning");
  assert.equal(result.events[0]?.theatre.status, "transitioning");
});

test("matching lights confirm while manual and occupancy-off targets remain preserved", () => {
  let result = intent(undefined);
  result = apply(result.state, {
    kind: "observed",
    generation: 1,
    target: "wall",
    on: true,
    values: {brightness: 64, color_temp: 400},
    observedAt: at(1).toISOString()
  }, 1);
  assert.notEqual(result.state.phase, "ready");

  result = apply(result.state, {
    kind: "observed",
    generation: 1,
    target: "lamp",
    on: true,
    manual: true,
    values: {brightness: 254},
    observedAt: at(1.1).toISOString()
  }, 1.1);
  assert.equal(result.state.phase, "ready");
  assert.deepEqual(result.events[0]?.theatre.details, {
    profile: "tv",
    matched: 1,
    preserved: 1,
    expected: 2,
    metrics: {attempts: 0, retries: 0, fallbackUsed: false}
  });

  result = intent(result.state, "projector", 2, 2);
  result = apply(result.state, {
    kind: "observed",
    generation: 2,
    target: "wall",
    on: false,
    values: {},
    observedAt: at(2.1).toISOString()
  }, 2.1);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.events[0]?.theatre.details.preserved, 1);
});

test("unavailable or unconfirmed room lighting becomes bounded optional failure evidence", () => {
  let result = intent(undefined);
  result = apply(result.state, {
    kind: "observed",
    generation: 1,
    target: "wall",
    on: false,
    available: false,
    observedAt: at(1).toISOString()
  }, 1);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "lighting-unavailable");

  result = intent(result.state, "tv", 2, 2);
  result = apply(result.state, {kind: "tick", generation: 2}, 7);
  assert.equal(result.commands[0]?.attempt, 2);
  result = apply(result.state, {kind: "tick", generation: 2}, 12);
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "confirmation-timeout");
});

test("restart observes restored lighting intent without reapplying a profile", () => {
  const active = intent(undefined);
  const result = apply(active.state, {kind: "startup"}, 1);
  assert.deepEqual(result.commands.map(({operation}) => operation), ["observe"]);
  assert.equal(result.commands[0]?.lighting, undefined);
  assert.equal(result.state.phase, "confirming");
});

function releases(result: ReturnType<typeof transitionActivityLighting>) {
  return result.commands.filter((command) => command.operation === "release").map((command) => command.lighting);
}

test("the owner defaults to one name per node, and can't be emptied", () => {
  assert.equal(normaliseActivityLightingConfig({profiles: config.profiles}).owner, "activity");
  assert.throws(() => normaliseActivityLightingConfig({profiles: config.profiles, owner: "  "}), /owner is required/);
  assert.equal(normaliseActivityLightingConfig({profiles: config.profiles, owner: "den"}).owner, "den");
});

test("a new profile releases only the lights it no longer styles", () => {
  let result = intent(undefined, "tv", 1, 0);
  assert.deepEqual(releases(result), []);

  // tv (wall, lamp) -> projector (wall): lamp is released, wall re-overridden.
  result = intent(result.state, "projector", 2, 10);
  assert.deepEqual(result.commands.map((command) => command.operation), ["release", "apply"]);
  assert.deepEqual(releases(result), [{kind: "release", owner: "lounge-activity", targets: ["lamp"], source: "activity"}]);
  assert.equal(result.commands[0]?.profile, "tv");
  assert.deepEqual(result.commands[1]?.lighting?.targets, ["wall"]);
  assert.equal(result.commands[1]?.lighting?.owner, "lounge-activity");

  // projector -> off (no targets): everything is released, nothing applied.
  result = intent(result.state, "off", 3, 20);
  assert.deepEqual(result.commands.map((command) => command.operation), ["release"]);
  assert.deepEqual(releases(result), [{kind: "release", owner: "lounge-activity", targets: ["wall"], source: "activity"}]);

  // The same profile again, a stale or conflicting intent: nothing released.
  result = intent(result.state, "tv", 4, 30);
  const same = intent(result.state, "tv", 5, 40);
  assert.deepEqual(releases(same), []);
  assert.deepEqual(releases(intent(same.state, "off", 4, 50)), []);
  assert.deepEqual(releases(apply(same.state, {kind: "intent", requestId: "other", generation: 5, profile: "off"}, 60)), []);
});

test("activity lighting holds its room lights through refresh and hands them back", () => {
  const roomConfig: RoomConfig = {
    area: "lounge",
    displayName: "Lounge",
    targets: [
      {id: "wall", stateTopic: "lounge/wall", commandTopic: "lounge/wall/set"},
      {id: "lamp", stateTopic: "lounge/lamp", commandTopic: "lounge/lamp/set"}
    ],
    initialTransitionSeconds: 1,
    refreshTransitionSeconds: 45,
    initialSleep: false,
    lighting: scheduledLighting(resolveSchedule(), {
      maxBrightnessPct: 100,
      maxColorTempKelvin: 5500,
      sleepBrightnessPct: 1,
      sleepColorTempKelvin: 1000
    })
  };
  const noon = (seconds: number) => new Date(new Date(2026, 5, 21, 12, 0).getTime() + seconds * 1000);
  let room = publishRoom(undefined, {lighting: {kind: "intent", targets: ["wall", "lamp"], state: "ON", source: "motion"}}, roomConfig, noon(0));
  const feed = (lighting: ReturnType<typeof transitionActivityLighting>, seconds: number) => {
    for (const command of lighting.commands) {
      if (command.lighting) room = publishRoom(room.state as Partial<RoomState>, {lighting: command.lighting}, roomConfig, noon(seconds));
    }
    return room;
  };
  const commanded = (result: typeof room) => result.outputs.filter((entry) => entry.lighting_command)
    .map((entry) => [entry.lighting_command?.target, (entry.payload as Record<string, unknown>).brightness]);

  let activity = intent(undefined, "tv", 1, 0);
  room = feed(activity, 1);
  assert.deepEqual(commanded(room), [["wall", 64], ["lamp", 64]]);
  assert.deepEqual(room.status.control, {wall: "overridden", lamp: "overridden"});
  room = publishRoom(room.state, {lighting: {kind: "refresh"}}, roomConfig, noon(90));
  assert.deepEqual(commanded(room), []);

  // Ending the activity releases both lights and the room controller restyles them.
  activity = intent(activity.state, "off", 2, 100);
  room = feed(activity, 100);
  assert.deepEqual(commanded(room), [["wall", 254], ["lamp", 254]]);
  assert.deepEqual(room.status.control, {wall: "in-control", lamp: "in-control"});
  room = publishRoom(room.state, {lighting: {kind: "refresh"}}, roomConfig, noon(190));
  assert.equal(commanded(room).length, 2);
});

test("release uses the lights actually applied, even after profiles change on a redeploy", () => {
  const applied = intent(undefined, "tv", 1, 0).state;
  assert.deepEqual(applied.applied, {profile: "tv", targets: ["wall", "lamp"]});

  // Redeploy with tv renamed to cinema: the saved desired profile is gone.
  const renamed = {...config, profiles: {off: config.profiles.off!, cinema: config.profiles.tv!}};
  let result = transitionActivityLighting(applied, {activityLighting: {kind: "intent", requestId: "off-2", generation: 2, profile: "off"}}, renamed, at(10));
  assert.deepEqual(releases(result), [{kind: "release", owner: "lounge-activity", targets: ["wall", "lamp"], source: "activity"}]);
  assert.equal(result.commands[0]?.profile, "tv");

  // Redeploy with tv edited to [wall]: lamp is still released.
  const edited = {...config, profiles: {...config.profiles, tv: {targets: ["wall"], values: {brightness: 64}}}};
  result = transitionActivityLighting(applied, {activityLighting: {kind: "intent", requestId: "off-2", generation: 2, profile: "off"}}, edited, at(10));
  assert.deepEqual(releases(result), [{kind: "release", owner: "lounge-activity", targets: ["wall", "lamp"], source: "activity"}]);

  // State saved before applied existed, with its profile no longer configured:
  // release every light held under this owner.
  const legacy = {...applied, applied: undefined, desired: {...applied.desired!, profile: "retired"}};
  result = transitionActivityLighting(legacy, {activityLighting: {kind: "intent", requestId: "off-2", generation: 2, profile: "off"}}, config, at(10));
  assert.deepEqual(releases(result), [{kind: "release", owner: "lounge-activity", source: "activity"}]);
  assert.equal(result.commands[0]?.profile, "retired");
});

test("a restart's observe has a deadline and ends as a live request would", () => {
  // A tv request was in flight when Node-RED restarted.
  const restored = intent(undefined, "tv", 1, 0).state;
  let result = apply(restored, {kind: "startup"}, 10);
  assert.equal(result.state.phase, "confirming");
  assert.ok(result.state.pending, "the startup observe has a deadline");

  // No light answers: at the deadline the profile is applied again, and
  // after the last attempt the request fails instead of confirming forever.
  const operations: string[] = [];
  for (let seconds = 11; seconds <= 40; seconds += 1) {
    result = apply(result.state, {kind: "tick", generation: 1}, seconds);
    operations.push(...result.commands.map((command) => String(command.operation)));
  }
  assert.ok(operations.includes("apply"));
  assert.equal(result.state.phase, "failed");
  assert.equal(result.state.failure?.reason, "confirmation-timeout");
});

test("a node with nothing saved adopts a refresh's wanted profile and observes, sending no apply when the lights match", () => {
  let result = apply(undefined, {kind: "refresh", requestId: "activity-2", generation: 2, profile: "tv"});
  assert.equal(result.state.desired?.profile, "tv");
  assert.deepEqual(result.commands.map(({operation}) => operation), ["observe"]);
  assert.equal(result.state.applied?.targets, null, "which lights it held is unknown");
  for (const [target, seconds] of [["wall", 1], ["lamp", 1.1]] as const) {
    result = apply(result.state, {kind: "observed", generation: 2, target, on: true, values: {brightness: 64, color_temp: 400},
      observedAt: at(seconds).toISOString()}, seconds);
    assert.ok(!result.commands.some(({operation}) => operation === "apply"));
  }
  assert.equal(result.state.phase, "ready");
  assert.equal(result.events[0]?.theatre.requestId, "activity-2");

  // The next activity releases every light held under this owner, as it can't know which.
  const next = apply(result.state, {kind: "intent", requestId: "projector-3", generation: 3, profile: "projector"}, 2);
  const release = next.commands.find(({operation}) => operation === "release");
  assert.ok(release, JSON.stringify(next.commands));
});

test("an adopted request the lights don't match is a manual override: nothing applied", () => {
  let result = apply(undefined, {kind: "refresh", requestId: "activity-9", generation: 9, profile: "tv"});
  const sent = [...result.commands];
  result = apply(result.state, {kind: "observed", generation: 9, target: "wall", on: true, values: {brightness: 200, color_temp: 250},
    observedAt: at(1).toISOString()}, 1);
  sent.push(...result.commands);
  for (const seconds of [3, 6, 12]) {
    result = apply(result.state, {kind: "tick", generation: 9}, seconds);
    sent.push(...result.commands);
  }
  assert.deepEqual([...new Set(sent.map(({operation}) => operation))], ["observe"], "no apply");
  assert.equal(result.state.phase, "manual_override");
  assert.equal(result.events.at(-1)?.theatre.classification, "manual_override");
});

function readyTv() {
  let result = intent(undefined);
  for (const [seconds, target] of [[1, "wall"], [1.1, "lamp"]] as const) {
    result = apply(result.state, {kind: "observed", generation: 1, target, on: true, values: {brightness: 64, color_temp: 400}, observedAt: at(seconds).toISOString()}, seconds);
  }
  assert.equal(result.state.phase, "ready");
  return result;
}

test("a refresh of ready room lighting re-reads it without leaving ready; the readings answer", () => {
  let result = apply(readyTv().state, {kind: "refresh", requestId: "tv-1", generation: 1, profile: "tv"}, 30);
  assert.deepEqual(result.commands.map(({operation, generation}) => [operation, generation]), [["observe", 1]]);
  assert.deepEqual(result.events, [], "no target state until a reading answers");
  assert.deepEqual([result.state.phase, result.state.pending, Object.keys(result.state.observed).sort()], ["ready", null, ["lamp", "wall"]]);

  const matching = apply(result.state, {kind: "observed", generation: 1, target: "wall", on: true, values: {brightness: 64, color_temp: 400}, observedAt: at(30.1).toISOString()}, 30.1);
  assert.equal(matching.events[0]?.theatre.status, "ready");

  // A light restyled by someone else classifies as any reading after ready does.
  const differing = apply(result.state, {kind: "observed", generation: 1, target: "wall", on: true, values: {brightness: 200}, observedAt: at(30.1).toISOString()}, 30.1);
  assert.equal(differing.state.phase, readyAfter(readyTv().state, {brightness: 200}).state.phase);

  // Unanswered, nothing is left waiting.
  const later = apply(result.state, {kind: "tick", generation: 1}, 60);
  assert.deepEqual([later.state.phase, later.state.pending, later.commands], ["ready", null, []]);
});

// The same different reading reaching ready lighting with no refresh before it.
function readyAfter(state: ActivityLightingState, values: Record<string, unknown>) {
  return apply(state, {kind: "observed", generation: 1, target: "wall", on: true, values, observedAt: at(30.1).toISOString()}, 30.1);
}

test("a refresh of room lighting that isn't ready, and a startup, still re-observe as before", () => {
  const transitioning = intent(undefined);
  const refreshed = apply(transitioning.state, {kind: "refresh", requestId: "tv-1", generation: 1, profile: "tv"}, 1);
  assert.deepEqual([refreshed.state.phase, refreshed.state.observed, refreshed.events[0]?.theatre.status], ["confirming", {}, "confirming"]);
  const started = apply(readyTv().state, {kind: "startup"}, 30);
  assert.deepEqual([started.state.phase, started.state.observed, started.state.pending?.attempt], ["confirming", {}, 0]);
});
