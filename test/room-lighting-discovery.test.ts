"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  circadianCommandTopic,
  circadianStateMessage,
  circadianStateTopic,
  roomLightingDiscovery
} from "../lib/room-lighting-discovery";

test("circadian topics follow the room's area", () => {
  assert.equal(circadianStateTopic("kitchen"), "home/kitchen/circadian/state");
  assert.equal(circadianCommandTopic("kitchen"), "home/kitchen/circadian/set");
  assert.deepEqual(circadianStateMessage("kitchen", false), {topic: "home/kitchen/circadian/state", payload: "OFF", retain: true});
});

test("room discovery announces a circadian switch and then its retained state", () => {
  const [config, state] = roomLightingDiscovery("kitchen", "Kitchen", true);
  assert.equal(config?.topic, "homeassistant/switch/kitchen_circadian_lighting/config");
  assert.equal(config?.retain, true);
  assert.deepEqual(config?.payload, {
    name: "Kitchen Circadian Lighting",
    unique_id: "kitchen_circadian_lighting",
    default_entity_id: "switch." + "kitchen_circadian_lighting",
    icon: "mdi:clock-time-seven-outline",
    command_topic: "home/kitchen/circadian/set",
    state_topic: "home/kitchen/circadian/state",
    payload_on: "ON",
    payload_off: "OFF",
    optimistic: false,
    device: {
      identifiers: ["nodered_kitchen_lighting"],
      name: "Kitchen Lighting Controller",
      manufacturer: "Node-RED",
      model: "Composable circadian lighting"
    }
  });
  assert.deepEqual(state, {topic: "home/kitchen/circadian/state", payload: "ON", retain: true});
});
