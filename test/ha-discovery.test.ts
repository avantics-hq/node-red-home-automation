"use strict";

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {DISCOVERY_ORIGIN, discoveryPrefixSetting} from "../lib/ha-discovery";
import {areaId, publishingArea} from "../lib/topic-names";
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

test("an area's ID: lowercase, other characters as one _, none at the ends", () => {
  const cases: Array<[string, string]> = [
    ["Living Room", "living_room"],
    ["Hall 2", "hall_2"],
    ["  Den / Theatre!  ", "den_theatre"],
    ["hall+#", "hall"],
    ["1st-floor", "1st-floor"],
    ["-Den-", "den"],
    ["!!!", ""],
    ["--", ""]
  ];
  for (const [area, id] of cases) assert.equal(areaId(area), id, area);
});

test("an area that is already an identifier is its own ID, so its topics and IDs don't change", () => {
  for (const area of ["living-room", "den_2", "kitchen"]) assert.equal(areaId(area), area);
});

test("a publishing area is kept as typed, needed only when asked, and needs a letter or digit", () => {
  assert.equal(publishingArea("Living Room", true), "Living Room");
  assert.equal(publishingArea("", false), "");
  assert.throws(() => publishingArea("", true), /^Error: area is required$/);
  assert.throws(() => publishingArea("!!!", false), /^Error: area must contain a letter or digit$/);
});
