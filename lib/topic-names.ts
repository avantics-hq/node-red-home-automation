"use strict";

// How areas and names become parts of MQTT topics and IDs. Shared by every
// node that publishes, whether or not Home Assistant reads what it publishes.

// A lowercase identifier: safe in MQTT topics, unique IDs and entity IDs.
export const IDENTIFIER = /^[a-z][a-z0-9_-]*$/;

// The form of an area used in topics, unique IDs, object IDs and device
// identifiers: lowercase, each run of characters other than letters, digits,
// "_" and "-" as one "_", with no "_" or "-" at either end. "Living Room"
// becomes "living_room", and an area that is already an identifier, such as
// "living-room", stays as it is. The area as typed is kept for names shown
// to people.
export function areaId(area: string): string {
  return area.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
}

// The one place a home/<area ID>/... topic is named, for every node that
// publishes under its area (or, for the house schedule, its name): the rest
// of the path follows as given.
export function homeTopic(area: string, ...path: string[]): string {
  return ["home", areaId(area), ...path].join("/");
}

// The area of a node that publishes under it, as typed. `needed` says
// whether this node's publishing needs one at all.
export function publishingArea(area: string, needed: boolean): string {
  if (!area && needed) throw new Error("area is required");
  if (area && !areaId(area)) throw new Error("area must contain a letter or digit");
  return area;
}

// A request ID a caller gives: a letter or digit, then up to 127 more of
// letters, digits and . _ : -. Safe in topics and logs.
export const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
