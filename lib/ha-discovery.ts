"use strict";

// What every Home Assistant discovery entry shares: the origin that says
// which software published it, the discovery prefix setting, and the
// availability payloads.

import {textSetting} from "./settings";

// The package's own manifest, loaded as a module from the package root (two
// levels above dist/lib), so no file is read here. A JSON import would make
// the compiler copy package.json into dist/, which isn't published.
const manifest = require("../../package.json") as {name: string; version: string; homepage: string};

// Home Assistant's `origin` block, abbreviated `o`, with its `name`,
// `sw` (software version) and `url` (support URL).
export const DISCOVERY_ORIGIN = Object.freeze({
  name: manifest.name,
  sw: manifest.version,
  url: manifest.homepage.split("#")[0]!
});

// Home Assistant's default discovery prefix.
export const DEFAULT_DISCOVERY_PREFIX = "homeassistant";

// The topic prefix Home Assistant listens on for discovery; absent means
// Home Assistant's default.
export function discoveryPrefixSetting(value: unknown): string {
  const prefix = textSetting(value, "discovery prefix", DEFAULT_DISCOVERY_PREFIX).replace(/^\/+|\/+$/g, "");
  if (!prefix || /[+#]/.test(prefix)) throw new Error("discovery prefix must be a concrete MQTT topic prefix");
  return prefix;
}

// A publishing node's availability, retained on its availability topic:
// online when it starts, offline when it stops. These are Home Assistant's
// default availability payloads, so entities need only the topic.
export const ONLINE = "online";
export const OFFLINE = "offline";
