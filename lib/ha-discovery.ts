"use strict";

// What every Home Assistant discovery entry shares: the origin that says
// which software published it, the discovery prefix setting, and the rule
// for an area that names published topics and IDs.

import {readFileSync} from "node:fs";
import {join} from "node:path";
import {textSetting} from "./settings";

// A lowercase identifier: safe in MQTT topics, unique IDs and entity IDs.
export const IDENTIFIER = /^[a-z][a-z0-9_-]*$/;

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
  name: string;
  version: string;
  homepage: string;
};

// Home Assistant's `origin` block, abbreviated `o`, with its `name`,
// `sw` (software version) and `url` (support URL).
export const DISCOVERY_ORIGIN = Object.freeze({
  name: manifest.name,
  sw: manifest.version,
  url: manifest.homepage.split("#")[0]!
});

// The topic prefix Home Assistant listens on for discovery; absent means
// Home Assistant's default.
export function discoveryPrefixSetting(value: unknown): string {
  const prefix = textSetting(value, "discovery prefix", "homeassistant").replace(/^\/+|\/+$/g, "");
  if (!prefix || /[+#]/.test(prefix)) throw new Error("discovery prefix must be a concrete MQTT topic prefix");
  return prefix;
}

// The area of a node that publishes under it. `needed` says whether this
// node's publishing needs one at all.
export function publishingArea(area: string, needed: boolean): string {
  if (!area && needed) throw new Error("area is required");
  if (area && !IDENTIFIER.test(area)) throw new Error("area must be a lowercase identifier");
  return area;
}
