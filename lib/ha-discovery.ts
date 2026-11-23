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

// The form of an area used in topics, unique IDs, object IDs and device
// identifiers: lowercase, each run of characters other than letters, digits,
// "_" and "-" as one "_", with no "_" or "-" at either end. "Living Room"
// becomes "living_room", and an area that is already an identifier, such as
// "living-room", stays as it is. The area as typed is kept for names shown
// to people.
export function areaId(area: string): string {
  return area.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
}

// The area of a node that publishes under it, as typed. `needed` says
// whether this node's publishing needs one at all.
export function publishingArea(area: string, needed: boolean): string {
  if (!area && needed) throw new Error("area is required");
  if (area && !areaId(area)) throw new Error("area must contain a letter or digit");
  return area;
}

// A publishing node's availability, retained on its availability topic:
// online when it starts, offline when it stops. These are Home Assistant's
// default availability payloads, so entities need only the topic.
export const ONLINE = "online";
export const OFFLINE = "offline";
