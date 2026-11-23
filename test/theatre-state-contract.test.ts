"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  normaliseStateContractConfig,
  theatreRetainedTopics,
  theatreStoppingPublications,
  transitionTheatreStateContract,
  type TheatreStateContractConfig,
  type TheatreStateContractState,
  type TheatreStateSnapshot
} from "../lib/theatre-state-contract";

const config: TheatreStateContractConfig = {
  area: "lounge",
  displayName: "Lounge",
  baseTopic: "home/lounge/theatre",
  discoveryPrefix: "homeassistant",
  activities: ["off", "tv_streamer", "projector_streamer"],
  slo: {
    windowSize: 20,
    minimumSamples: 5,
    latencyBudgetMs: 60000,
    successObjectivePct: 95
  }
};
const at = (seconds: number): Date =>
  new Date(Date.parse("2026-11-21T17:00:00Z") + seconds * 1000);

function jsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function snapshot(overrides: Partial<TheatreStateSnapshot> = {}): TheatreStateSnapshot {
  return {
    kind: "state",
    area: "lounge",
    requestId: "request-1",
    generation: 1,
    desiredActivity: "tv_streamer",
    requestedAt: at(0).toISOString(),
    currentActivity: "unknown",
    phase: "transitioning",
    availability: "unknown",
    transitionStartedAt: at(0).toISOString(),
    transitionCompletedAt: null,
    targets: {
      display: {status: "ready", observedAt: at(1).toISOString()},
      avr: {status: "confirming", observedAt: at(1).toISOString()},
      source: null,
      lighting: null,
      backlighting: null
    },
    failure: null,
    degraded: [],
    ...overrides
  };
}

function request(
  state: Partial<TheatreStateContractState> | undefined,
  payload: unknown,
  retain = false,
  seconds = 0
) {
  return transitionTheatreStateContract(state, {
    topic: "home/lounge/theatre/request",
    payload,
    retain
  }, config, at(seconds));
}

test("state-contract configuration owns topics and activity names", () => {
  // Discovery is on unless switched off.
  assert.deepEqual(normaliseStateContractConfig(config), {...config, discovery: true});
  assert.throws(
    () => normaliseStateContractConfig({...config, baseTopic: "home/+/theatre"}),
    /concrete MQTT topic/
  );
  assert.throws(
    () => normaliseStateContractConfig({...config, activities: ["off", "off"]}),
    /unique/
  );
});

test("startup publishes retained Home Assistant discovery for requests and truth", () => {
  const result = transitionTheatreStateContract(undefined, {
    theatreStateContract: {kind: "startup"}
  }, config, at(0));

  assert.equal(result.publications.length, 14);
  assert.equal(result.publications.every(({retain}) => retain), true);
  assert.deepEqual(result.publications.at(-1), {topic: "home/lounge/theatre/availability", payload: "online", retain: true}, "online, after discovery");
  const select = result.publications.find(({topic}) => topic ===
    "homeassistant/select/lounge_theatre_activity/config");
  assert.ok(select);
  const selectConfig = jsonObject(select.payload);
  assert.equal(selectConfig.command_topic, "home/lounge/theatre/request");
  assert.equal(selectConfig.state_topic, "home/lounge/theatre/desired");
  assert.deepEqual(selectConfig.options, config.activities);
  assert.match(String(selectConfig.command_template), /requestId/);
  assert.ok(result.publications.some(({topic}) => topic ===
    "homeassistant/sensor/lounge_theatre_backlighting_health/config"));
  assert.ok(result.publications.some(({topic}) => topic ===
    "homeassistant/sensor/lounge_theatre_transition_metrics/config"));
  assert.ok(result.publications.some(({topic}) => topic ===
    "homeassistant/sensor/lounge_theatre_slo_status/config"));
  assert.ok(result.publications.some(({topic}) => topic ===
    "homeassistant/binary_sensor/lounge_theatre_slo_breach/config"));
});

test("non-retained requests allocate generations and exact duplicates are idempotent", () => {
  let result = request(undefined, {
    requestId: "ha-request-1",
    activity: "tv_streamer"
  });
  assert.equal(result.requests[0]?.theatre.generation, 1);
  assert.equal(result.requests[0]?.theatre.requestedAt, at(0).toISOString());
  assert.equal(result.publications.length, 4);
  const requestTopics = Object.fromEntries(
    result.publications.map(({topic, payload}) => [topic, payload])
  );
  assert.equal(requestTopics["home/lounge/theatre/phase"], "requested");
  assert.equal(requestTopics["home/lounge/theatre/failure"], "null");
  assert.equal(requestTopics["home/lounge/theatre/readiness"], "unknown");
  assert.equal(
    jsonObject(requestTopics["home/lounge/theatre/desired"]!).requestId,
    "ha-request-1"
  );

  result = request(result.state, {
    requestId: "ha-request-1",
    activity: "tv_streamer"
  }, false, 1);
  assert.equal(result.requests[0]?.theatre.generation, 1);
  assert.equal(result.traces.at(-1)?.outcome, "duplicate");
  assert.equal(result.publications.length, 4);

  assert.throws(() => request(result.state, {
    requestId: "ha-request-1",
    activity: "off"
  }, false, 2), /cannot be reused/);

  result = request(result.state, {
    requestId: "ha-request-2",
    activity: "off",
    requestedAt: at(3).toISOString()
  }, false, 3);
  assert.equal(result.requests[0]?.theatre.generation, 2);
});

test("retained requests are inert and unknown activities fail closed", () => {
  const retained = request(undefined, {
    requestId: "stale-retained",
    activity: "off"
  }, true);
  assert.equal(retained.requests.length, 0);
  assert.equal(retained.state.generation, 0);
  assert.equal(retained.traces.at(-1)?.reason, "retained-request");

  assert.throws(() => request(undefined, {
    requestId: "bad-activity",
    activity: "movie"
  }), /unknown theatre activity/);
});

test("controller snapshots publish retained desired, current, phase, failure and target health", () => {
  const result = transitionTheatreStateContract(undefined, {
    theatre: snapshot()
  }, config, at(2));

  assert.equal(result.publications.length, 14);
  assert.equal(result.publications.every(({retain}) => retain), true);
  const byTopic = Object.fromEntries(result.publications.map(({topic, payload}) => [topic, payload]));
  assert.deepEqual(JSON.parse(byTopic["home/lounge/theatre/desired"]!), {
    requestId: "request-1",
    generation: 1,
    activity: "tv_streamer",
    requestedAt: at(0).toISOString()
  });
  assert.equal(byTopic["home/lounge/theatre/current"], "unknown");
  assert.equal(byTopic["home/lounge/theatre/phase"], "transitioning");
  assert.equal(byTopic["home/lounge/theatre/failure"], "null");
  assert.equal(byTopic["home/lounge/theatre/readiness"], "unknown");
  assert.equal(jsonObject(byTopic["home/lounge/theatre/health/display"]!).status, "ready");
  assert.equal(jsonObject(byTopic["home/lounge/theatre/health/source"]!).status, "unknown");
  assert.equal(jsonObject(byTopic["home/lounge/theatre/metrics"]!).lastTransitionMs, null);
  assert.equal(jsonObject(byTopic["home/lounge/theatre/slo"]!).status, "learning");
  assert.equal(byTopic["home/lounge/theatre/slo/breach"], "OFF");

  for (const exposedPhase of ["waiting_for_source", "ready", "failed"]) {
    const phaseResult = transitionTheatreStateContract(undefined, {
      theatre: snapshot({phase: exposedPhase})
    }, config, at(2));
    const phasePublication = phaseResult.publications.find(
      ({topic}) => topic === "home/lounge/theatre/phase"
    );
    assert.equal(phasePublication?.payload, exposedPhase);
  }

  assert.throws(() => transitionTheatreStateContract(undefined, {
    theatre: {...snapshot(), targets: null}
  }, config, at(2)), /targets must be an object/);
});

test("stale controller snapshots cannot overwrite a newer requested generation", () => {
  const requested = request(undefined, {
    requestId: "new-request",
    activity: "projector_streamer"
  });
  const result = transitionTheatreStateContract(requested.state, {
    theatre: snapshot({generation: 0, requestId: null, desiredActivity: null})
  }, config, at(1));

  assert.equal(result.publications.length, 0);
  assert.equal(result.state.lastRequest?.requestId, "new-request");
  assert.equal(result.traces.at(-1)?.reason, "stale-generation");
});

test("a contract area that isn't an identifier names topics and IDs by its ID", () => {
  const living = normaliseStateContractConfig({...config, area: "Living Room", displayName: "", baseTopic: ""});
  assert.equal(living.area, "Living Room");
  assert.equal(living.displayName, "Living Room");
  assert.equal(living.baseTopic, "home/living_room/theatre");
  const topics = transitionTheatreStateContract(undefined, {theatreStateContract: {kind: "startup"}}, living, at(0)).publications.map(({topic}) => topic);
  assert.ok(topics.includes("homeassistant/select/living_room_theatre_activity/config"), topics.join());
  assert.ok(topics.every((topic) => !/[A-Z ]/.test(topic)), topics.join());
});

test("discovery is a setting: on publishes it, off clears it, unset means on", () => {
  const startup = (settings: Partial<TheatreStateContractConfig>) =>
    transitionTheatreStateContract(undefined, {theatreStateContract: {kind: "startup"}}, {...config, ...settings}, at(0)).publications;
  const online = {topic: "home/lounge/theatre/availability", payload: "online", retain: true};
  const discovery = (publications: ReturnType<typeof startup>) => publications.filter(({topic}) => topic !== online.topic);
  assert.deepEqual(startup({}).at(-1), online, "the contract publishes its state, so its availability, either way");
  assert.deepEqual(startup({discovery: false}).at(-1), online);
  const on = discovery(startup({}));
  assert.equal(on.length, 13);
  assert.ok(on.every(({payload}) => payload.startsWith("{")));
  const off = discovery(startup({discovery: false}));
  assert.deepEqual(off.map(({topic}) => topic), on.map(({topic}) => topic), "the same discovery topics");
  assert.ok(off.every(({payload, retain}) => payload === "" && retain), "each cleared with an empty retained message");
  // With no area there are no entities to clear.
  assert.deepEqual(discovery(startup({discovery: false, area: ""})), []);
});

test("the area is needed for discovery or the default base topic, and optional otherwise", () => {
  const noArea = {...config, area: "", displayName: ""};
  assert.throws(() => normaliseStateContractConfig(noArea), /area is required/, "discovery unset means on");
  assert.throws(() => normaliseStateContractConfig({...noArea, discovery: true}), /area is required/);
  assert.throws(() => normaliseStateContractConfig({...noArea, discovery: false, baseTopic: ""}), /area is required/);
  const topicOnly = normaliseStateContractConfig({...noArea, discovery: false, baseTopic: "media/theatre"});
  assert.equal(topicOnly.area, "");
  assert.equal(topicOnly.baseTopic, "media/theatre");
});

test("the retained topic list covers everything the contract publishes", () => {
  const listed = new Set(theatreRetainedTopics(config));
  const startup = transitionTheatreStateContract(undefined, {theatreStateContract: {kind: "startup"}}, config, at(0));
  const requested = request(startup.state, {requestId: "request-1", activity: "tv_streamer"});
  const published = [...startup.publications, ...requested.publications, ...theatreStoppingPublications(config)].map(({topic}) => topic);
  for (const topic of published) assert.ok(listed.has(topic), topic);
  for (const target of ["display", "avr", "source", "lighting", "backlighting"]) {
    assert.ok(listed.has(`home/lounge/theatre/health/${target}`), target);
  }
  assert.ok(listed.has("home/lounge/theatre/transition"));
});

test("the transition's timing and degraded targets reach Home Assistant as the Phase sensor's attributes", () => {
  const started = at(0).toISOString();
  const completed = at(9).toISOString();
  const result = transitionTheatreStateContract(undefined, {
    theatre: snapshot({
      phase: "ready",
      transitionStartedAt: started,
      transitionCompletedAt: completed,
      degraded: [{target: "source", reason: "unconfirmed"}]
    })
  }, config, at(10));
  const transition = result.publications.find(({topic}) => topic === "home/lounge/theatre/transition");
  assert.deepEqual(transition && JSON.parse(transition.payload), {
    startedAt: started,
    completedAt: completed,
    degraded: [{target: "source", reason: "unconfirmed"}]
  });
  assert.equal(transition?.retain, true);
  // A snapshot from a controller without these fields publishes empty details.
  const older = transitionTheatreStateContract(undefined, {
    theatre: {...snapshot(), transitionStartedAt: undefined, transitionCompletedAt: undefined, degraded: undefined}
  } as never, config, at(10)).publications.find(({topic}) => topic === "home/lounge/theatre/transition");
  assert.deepEqual(older && JSON.parse(older.payload), {startedAt: null, completedAt: null, degraded: []});

  const startup = transitionTheatreStateContract(undefined, {theatreStateContract: {kind: "startup"}}, config, at(0)).publications;
  const phase = startup.find(({topic}) => topic.includes("_theatre_phase/config"));
  assert.equal(phase && JSON.parse(phase.payload).json_attributes_topic, "home/lounge/theatre/transition");
});

test("a node-named contract needs no area: entity IDs and the suggested area come from the display name", () => {
  const base = {...config, nodeId: "c7", idScheme: "node" as const, area: "", displayName: "Media Room", baseTopic: "media/theatre"};
  const normalised = normaliseStateContractConfig(base);
  assert.equal(normalised.area, "");
  const startup = transitionTheatreStateContract(undefined, {theatreStateContract: {kind: "startup"}}, normalised, at(0)).publications;
  const select = startup.find(({topic}) => topic === "homeassistant/select/nrha_c7_theatre_activity/config");
  const payload = JSON.parse(select!.payload) as {default_entity_id: string; device: {suggested_area?: string}};
  assert.equal(payload.default_entity_id, ["select", "media_room_theatre_activity"].join("."));
  assert.equal(payload.device.suggested_area, "Media Room");
  // With an area, the area names them.
  const withArea = transitionTheatreStateContract(undefined, {theatreStateContract: {kind: "startup"}},
    normaliseStateContractConfig({...base, area: "Lounge"}), at(0)).publications;
  const areaPayload = JSON.parse(withArea.find(({topic}) => topic.includes("_theatre_activity/config"))!.payload) as {default_entity_id: string; device: {suggested_area?: string}};
  assert.deepEqual([areaPayload.default_entity_id, areaPayload.device.suggested_area], [["select", "lounge_theatre_activity"].join("."), "Lounge"]);

  // Still needed for the default base topic, and for an area-named contract's entities.
  assert.throws(() => normaliseStateContractConfig({...base, baseTopic: ""}), /area is required/);
  assert.throws(() => normaliseStateContractConfig({...base, idScheme: undefined}), /area is required/);
  assert.throws(() => normaliseStateContractConfig({...base, displayName: ""}), /displayName is required/);
  // An area-named contract's entries are as before: no suggested area.
  const legacy = transitionTheatreStateContract(undefined, {theatreStateContract: {kind: "startup"}}, config, at(0)).publications;
  assert.ok(legacy.filter(({topic}) => topic.endsWith("/config")).every(({payload}) => !("suggested_area" in (JSON.parse(payload) as {device: object}).device)));
});
