"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  normaliseStateContractConfig,
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
  assert.deepEqual(normaliseStateContractConfig(config), config);
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

  assert.equal(result.publications.length, 13);
  assert.equal(result.publications.every(({retain}) => retain), true);
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
  assert.equal(requestTopics["home/lounge/theatre/availability"], "unknown");
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

  assert.equal(result.publications.length, 13);
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
  assert.equal(byTopic["home/lounge/theatre/availability"], "unknown");
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
