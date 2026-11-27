"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {roomAvailabilityTopic, roomControlTopic, roomDiscovery} from "../lib/room-lighting-discovery";

const {version} = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as {version: string};

test("room topics follow the room's area", () => {
  assert.equal(roomAvailabilityTopic("Living Room"), "home/living_room/lighting/availability");
  assert.equal(roomControlTopic("kitchen", "cooking"), "home/kitchen/lighting/cooking/control");
});

test("the room's Home Assistant entities are each light's control state, on one device", () => {
  const [control, ...others] = roomDiscovery({area: "kitchen", displayName: "Kitchen", discoveryPrefix: "homeassistant"}, ["cooking", "dining"]);
  assert.equal(others.length, 1);
  assert.equal(control?.topic, "homeassistant/sensor/kitchen_cooking_control/config");
  assert.equal(control?.retain, true);
  assert.deepEqual(control?.payload, {
    name: "Kitchen cooking control",
    unique_id: "kitchen_cooking_control",
    default_entity_id: "sensor." + "kitchen_cooking_control",
    icon: "mdi:account-lock-outline",
    state_topic: "home/kitchen/lighting/cooking/control",
    value_template: "{{ value_json.state }}",
    json_attributes_topic: "home/kitchen/lighting/cooking/control",
    json_attributes_template: "{{ {'owner': value_json.owner, 'available': value_json.available} | tojson }}",
    entity_category: "diagnostic",
    availability_topic: "home/kitchen/lighting/availability",
    device: {
      identifiers: ["nodered_kitchen_lighting"],
      name: "Kitchen Lighting Controller",
      manufacturer: "Node-RED",
      model: "Room lighting controller"
    },
    origin: {name: "@avantics/node-red-home-automation", sw: version, url: "https://github.com/avantics-hq/node-red-home-automation"}
  });
  assert.equal(roomDiscovery({area: "kitchen", displayName: "Kitchen", discoveryPrefix: "ha/discovery"}, ["cooking"])[0]?.topic,
    "ha/discovery/sensor/kitchen_cooking_control/config");
});
