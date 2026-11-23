"use strict";

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {DISCOVERY_ORIGIN, discoveryPrefixSetting, publishingArea} from "../lib/ha-discovery";
import {theatreDiscovery} from "../lib/theatre-ha-discovery";

test("the discovery origin names this package, its version and its home", () => {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as {name: string; version: string};
  assert.deepEqual(DISCOVERY_ORIGIN, {
    name: manifest.name,
    sw: manifest.version,
    url: "https://github.com/avantics-hq/node-red-home-automation"
  });
});

test("every theatre discovery entry carries the origin", () => {
  const entries = theatreDiscovery({area: "den", displayName: "Den", baseTopic: "home/den/theatre", discoveryPrefix: "homeassistant", activities: ["off", "tv"]});
  assert.ok(entries.length > 1);
  for (const entry of entries) assert.deepEqual(entry.payload.origin, DISCOVERY_ORIGIN, entry.topic);
});

test("the discovery prefix: absent is Home Assistant's default, and it must be a concrete topic prefix", () => {
  assert.equal(discoveryPrefixSetting(undefined), "homeassistant");
  assert.equal(discoveryPrefixSetting(" /ha/discovery/ "), "ha/discovery");
  assert.throws(() => discoveryPrefixSetting(""), /^Error: discovery prefix is required$/);
  for (const value of ["/", "ha/+", "#"]) {
    assert.throws(() => discoveryPrefixSetting(value), /^Error: discovery prefix must be a concrete MQTT topic prefix$/, value);
  }
});

test("a publishing area is a lowercase identifier, and needed only when asked", () => {
  assert.equal(publishingArea("living_room", true), "living_room");
  assert.equal(publishingArea("", false), "");
  assert.throws(() => publishingArea("", true), /^Error: area is required$/);
  for (const area of ["Living Room", "hall+", "1st-floor", "den/theatre"]) {
    assert.throws(() => publishingArea(area, false), /^Error: area must be a lowercase identifier$/, area);
  }
});
