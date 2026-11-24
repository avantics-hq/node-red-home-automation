"use strict";

// What a flow sends a cover node, as the cover controller's requests: "open",
// "close" or "stop", a position from 0 (closed) to 100 (open), or the name of
// a preset, in msg.payload; or a full request in msg.cover. The node numbers
// each request.

import type {CoverEvent} from "./cover-controller";
import {jsonSetting} from "./settings";

export type CoverPresets = Record<string, number>;

const PRESET_NAME = /^[a-z][a-z0-9_-]*$/;

// Named positions, such as {"partial": 60}, from the node's setting.
export function coverPresets(value: unknown): CoverPresets {
  const parsed = jsonSetting(value, "presets", {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("presets must be a JSON object");
  const presets: CoverPresets = {};
  for (const [name, position] of Object.entries(parsed)) {
    if (!PRESET_NAME.test(name) || ["open", "close", "stop"].includes(name)) {
      throw new Error(`preset name ${name} must be a lowercase identifier other than open, close and stop`);
    }
    if (typeof position !== "number" || !Number.isFinite(position) || position < 0 || position > 100) {
      throw new Error(`preset ${name} must be a position from 0 to 100`);
    }
    presets[name] = position;
  }
  return presets;
}

export interface CoverRequestInput {
  payload?: unknown;
  // A button's request: if the cover is moving, stop it instead.
  stopIfMoving?: unknown;
  // An automatic target, which waits while a person's move holds the cover.
  respectManual?: unknown;
  source?: unknown;
}

type Intent = Extract<CoverEvent, {requestId: string}>;

// The request a message asks for, given the next generation and a request
// ID; or the reason it asks for nothing usable.
export function coverRequest(
  input: CoverRequestInput,
  presets: CoverPresets,
  ids: {requestId: string; generation: number},
  // Whether the cover is moving now, as the controller judges it.
  moving = false
): {intent: Intent} | {invalid: string} {
  const base = {
    ...ids,
    ...(typeof input.source === "string" && input.source ? {source: input.source} : {}),
    ...(input.respectManual === true ? {respectManual: true} : {})
  };
  const payload = typeof input.payload === "string" ? input.payload.trim().toLowerCase() : input.payload;
  if (input.stopIfMoving === true && moving) return {intent: {...base, kind: "stop"}};
  if (payload === "open" || payload === "close" || payload === "stop") return {intent: {...base, kind: payload}};
  const position = typeof payload === "number" ? payload
    : typeof payload === "string" && /^\d+(\.\d+)?$/.test(payload) ? Number(payload)
    : typeof payload === "string" && Object.hasOwn(presets, payload) ? presets[payload]!
    : null;
  if (position === null) return {invalid: "unknown-request"};
  if (!Number.isFinite(position) || position < 0 || position > 100) return {invalid: "position-out-of-range"};
  return {intent: {...base, kind: "set_position", position}};
}
