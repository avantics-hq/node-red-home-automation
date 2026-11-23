"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {TARGETS} from "../lib/theatre-activity-controller";
import {theatreDiscovery, theatreTopic} from "../lib/theatre-ha-discovery";

const config = {area: "lounge", displayName: "Lounge", baseTopic: "home/lounge/theatre", discoveryPrefix: "homeassistant", activities: ["off", "tv"]};

test("theatre topics are named in one place", () => {
  assert.equal(theatreTopic("home/lounge/theatre", "request"), "home/lounge/theatre/request");
  assert.equal(theatreTopic("home/lounge/theatre", "slo/breach"), "home/lounge/theatre/slo/breach");
  assert.equal(theatreTopic("home/lounge/theatre", "health/avr"), "home/lounge/theatre/health/avr");
});

test("theatre discovery describes every published topic under the discovery prefix", () => {
  const entries = theatreDiscovery(config);
  assert.equal(entries.length, 8 + TARGETS.length);
  for (const {topic} of entries) assert.match(topic, /^homeassistant\/(select|sensor|binary_sensor)\/lounge_theatre_[a-z_]+\/config$/);

  const requested = entries[0]!.payload;
  assert.equal(requested.command_topic, theatreTopic(config.baseTopic, "request"));
  assert.equal(requested.state_topic, theatreTopic(config.baseTopic, "desired"));
  assert.deepEqual(requested.options, ["off", "tv"]);

  const stateTopics = entries.slice(1).map(({payload}) => payload.state_topic);
  assert.deepEqual(stateTopics, [
    ...(["current", "phase", "availability", "failure", "metrics", "slo", "slo/breach"] as const)
      .map((name) => theatreTopic(config.baseTopic, name)),
    ...TARGETS.map((target) => theatreTopic(config.baseTopic, `health/${target}`))
  ]);
});
