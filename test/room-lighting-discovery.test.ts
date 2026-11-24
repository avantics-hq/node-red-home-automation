"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {
  circadianCommandTopic,
  circadianStateMessage,
  circadianStateTopic,
  roomDiscovery,
  roomLightingDiscovery,
  scheduleStateMessages,
  sleepStateMessage
} from "../lib/room-lighting-discovery";

const {version} = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as {version: string};

test("circadian topics follow the room's area", () => {
  assert.equal(circadianStateTopic("kitchen"), "home/kitchen/circadian/state");
  assert.equal(circadianCommandTopic("kitchen"), "home/kitchen/circadian/set");
  assert.deepEqual(circadianStateMessage("kitchen", false), {topic: "home/kitchen/circadian/state", payload: "OFF", retain: true});
});

test("room discovery announces a circadian switch and then its retained state", () => {
  const [config, state] = roomLightingDiscovery({area: "kitchen", displayName: "Kitchen", discoveryPrefix: "homeassistant"}, true);
  assert.equal(config?.topic, "homeassistant/switch/kitchen_circadian_lighting/config");
  assert.equal(config?.retain, true);
  assert.deepEqual(config?.payload, {
    name: "Kitchen Circadian Lighting",
    unique_id: "kitchen_circadian_lighting",
    default_entity_id: "switch." + "kitchen_circadian_lighting",
    icon: "mdi:clock-time-seven-outline",
    command_topic: "home/kitchen/circadian/set",
    state_topic: "home/kitchen/circadian/state",
    availability_topic: "home/kitchen/lighting/availability",
    payload_on: "ON",
    payload_off: "OFF",
    optimistic: false,
    device: {
      identifiers: ["nodered_kitchen_lighting"],
      name: "Kitchen Lighting Controller",
      manufacturer: "Node-RED",
      model: "Composable circadian lighting"
    },
    origin: {name: "@avantics/node-red-home-automation", sw: version, url: "https://github.com/avantics-hq/node-red-home-automation"}
  });
  assert.deepEqual(state, {topic: "home/kitchen/circadian/state", payload: "ON", retain: true});
});

test("room discovery uses the configured discovery prefix", () => {
  const [config] = roomLightingDiscovery({area: "kitchen", displayName: "Kitchen", discoveryPrefix: "ha/discovery"}, false);
  assert.equal(config?.topic, "ha/discovery/switch/kitchen_circadian_lighting/config");
});

test("the room's Home Assistant entities: sleep, wake and bed times, and each light's control state", () => {
  const entries = roomDiscovery({area: "kitchen", displayName: "Kitchen", discoveryPrefix: "homeassistant"}, ["cooking"]);
  const byTopic = Object.fromEntries(entries.map(({topic, payload}) => [topic, payload as Record<string, unknown>]));
  const sleep = byTopic["homeassistant/switch/kitchen_sleep/config"]!;
  assert.equal(sleep.name, "Kitchen Sleep");
  assert.equal(sleep.command_topic, "home/kitchen/sleep/set");
  assert.equal(sleep.state_topic, "home/kitchen/sleep/state");
  const wake = byTopic["homeassistant/time/kitchen_wake_time/config"]!;
  assert.deepEqual([wake.command_topic, wake.state_topic, wake.entity_category],
    ["home/kitchen/wake-time/set", "home/kitchen/wake-time/state", "config"]);
  assert.equal(byTopic["homeassistant/time/kitchen_bed_time/config"]!.state_topic, "home/kitchen/bed-time/state");
  const control = byTopic["homeassistant/sensor/kitchen_cooking_control/config"]!;
  assert.deepEqual([control.state_topic, control.json_attributes_topic, control.value_template, control.entity_category],
    ["home/kitchen/lighting/cooking/control", "home/kitchen/lighting/cooking/control", "{{ value_json.state }}", "diagnostic"]);
  for (const payload of Object.values(byTopic)) {
    assert.deepEqual((payload.device as {identifiers: string[]}).identifiers, ["nodered_kitchen_lighting"], "one device");
    assert.equal(payload.availability_topic, "home/kitchen/lighting/availability");
  }
  assert.deepEqual(scheduleStateMessages("kitchen", {wakeTime: "06:15", bedTime: "22:45"}).map(({payload}) => payload), ["06:15:00", "22:45:00"]);
  assert.deepEqual(sleepStateMessage("kitchen", true), {topic: "home/kitchen/sleep/state", payload: "ON", retain: true});
});
