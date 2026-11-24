"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  coverDiscovery,
  coverInbound,
  coverRetainedTopics,
  coverStartingOutputs,
  coverStateOutputs,
  type CoverPublishingConfig
} from "../lib/cover-publishing";

const config: CoverPublishingConfig = {
  area: "Bedroom", name: "Left", positions: true, publishState: true, discovery: true,
  discoveryPrefix: "homeassistant", nodeId: "cover1", idScheme: "node"
};

test("a position cover's entity: open, close, stop and set position, on its own topics", () => {
  const [entry] = coverDiscovery(config);
  assert.equal(entry!.topic, "homeassistant/cover/nrha_cover1_cover_left/config");
  const payload = JSON.parse(entry!.payload) as Record<string, unknown>;
  assert.deepEqual([payload.command_topic, payload.state_topic, payload.position_topic, payload.set_position_topic, payload.availability_topic], [
    "home/bedroom/cover/left/set", "home/bedroom/cover/left/state", "home/bedroom/cover/left/position",
    "home/bedroom/cover/left/position/set", "home/bedroom/cover/left/availability"
  ]);
  assert.deepEqual([payload.payload_open, payload.payload_close, payload.payload_stop, payload.position_open, payload.position_closed],
    ["OPEN", "CLOSE", "STOP", 100, 0]);
  // Open, close and stop only: no position.
  const openClose = JSON.parse(coverDiscovery({...config, positions: false})[0]!.payload) as Record<string, unknown>;
  assert.equal(openClose.position_topic, undefined);
  assert.equal(openClose.set_position_topic, undefined);
  // Two covers in one room, under the area scheme, don't share IDs.
  const left = coverDiscovery({...config, idScheme: "area"})[0]!.topic;
  const right = coverDiscovery({...config, idScheme: "area", name: "Right"})[0]!.topic;
  assert.notEqual(left, right);
});

test("its state and position once it has reported, and its retained topics", () => {
  assert.deepEqual(coverStateOutputs(config, null), [], "nothing before a report");
  assert.deepEqual(coverStateOutputs(config, {state: "opening", position: 42.4}).map(({topic, payload}) => [topic, payload]),
    [["home/bedroom/cover/left/state", "opening"], ["home/bedroom/cover/left/position", "42"]]);
  assert.deepEqual(coverStateOutputs({...config, positions: false}, {state: "stopped", position: null}).map(({payload}) => payload), ["stopped"]);
  assert.deepEqual(coverStateOutputs({...config, publishState: false}, {state: "open", position: 100}), [], "off unless switched on");
  assert.deepEqual(coverStartingOutputs(config, {state: "closed", position: 0}).map(({topic}) => topic), [
    "homeassistant/cover/nrha_cover1_cover_left/config", "home/bedroom/cover/left/availability",
    "home/bedroom/cover/left/state", "home/bedroom/cover/left/position"
  ]);
  assert.ok(coverRetainedTopics(config).includes("home/bedroom/cover/left/position"));
  assert.ok(!coverRetainedTopics({...config, positions: false}).includes("home/bedroom/cover/left/position"));
});

test("Home Assistant's commands come back as the cover's own requests", () => {
  const at = (topic: string, payload: unknown, retain = false) => coverInbound({topic, payload, retain}, config);
  assert.deepEqual(at("home/bedroom/cover/left/set", "OPEN")?.request, "open");
  assert.deepEqual(at("home/bedroom/cover/left/set", "stop")?.request, "stop");
  assert.deepEqual(at("home/bedroom/cover/left/position/set", "40")?.request, 40);
  assert.equal(at("home/bedroom/cover/left/set", "TOGGLE")?.traces[0]?.reason, "not-open-close-or-stop");
  assert.equal(at("home/bedroom/cover/left/position/set", "140")?.traces[0]?.reason, "not-a-position");
  assert.equal(at("home/bedroom/cover/left/set", "OPEN", true)?.traces[0]?.reason, "retained-message");
  assert.equal(at("elsewhere/left/set", "OPEN"), null, "other topics pass through");
  assert.equal(coverInbound({topic: "home/bedroom/cover/left/position/set", payload: "40"}, {...config, positions: false}), null,
    "no positions on an open/close cover");
  assert.equal(coverInbound({topic: "home/bedroom/cover/left/set", payload: "OPEN"}, {...config, publishState: false}), null);
});
