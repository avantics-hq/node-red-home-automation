"use strict";

// A scene, such as "Bath" or "Exercise mode": while it is on, it holds some of
// a room's lights on or off with the values it gives them, and pauses motion
// lighting. When it ends, by request, by its safety timer or by a message the
// flow sends when its own condition is met, it lets them go, and each room
// hands its lights back to what they were (room-holds.ts), or to a scene
// beneath it. The scene speaks the room's owner intents and releases and the
// motion policy's owner pauses, so it reaches its lights only through rooms.

import type {TraceEntry} from "./bounded-trace";
import {jsonSetting, numberSetting} from "./settings";
import {areaId} from "./topic-names";

export interface SceneLight {
  // Its room, by the room controller's Area, and its id in that room's
  // Targets JSON: rooms ignore an intent or release for another area.
  area: string;
  target: string;
  state: "ON" | "OFF";
  brightnessPct?: number;
  colorTempKelvin?: number;
}

export interface SceneConfig {
  // The owner its rooms and motion policies know it by.
  owner: string;
  lights: SceneLight[];
  // How long it stays on unless ended sooner; 0: until ended.
  safetyMs: number;
}

export const DEFAULT_SAFETY_HOURS = 4;
// How often an active scene renews its motion pause and its status: well
// within the motion policy's maximum pause (10 minutes by default).
export const RENEW_MS = 60_000;

export interface SceneState {
  active: boolean;
  // The owner and lights it took when it started, so it releases what it
  // took even if its settings changed since.
  owner: string | null;
  lights: Array<{area: string; target: string}>;
  startedAt: number | null;
  // When the safety timer ends it; null with the timer off.
  endsAt: number | null;
  // How it last ended.
  ended: {by: string; at: number} | null;
}

// What a flow sends it, on msg.scene.
export interface SceneEvent {
  kind?: unknown;
  // On an end: what ended it, shown on its status, such as "trainer off".
  by?: unknown;
}

// Messages for its outputs: owner intents and releases for room controllers,
// owner pauses for motion policies.
export interface SceneLighting {
  lighting: Record<string, unknown>;
}
export interface SceneMotion {
  source: "pause";
  payload: boolean;
  owner: string;
}

export function normaliseSceneConfig(raw: {owner: string; lights?: unknown; safetyHours?: unknown}): SceneConfig {
  const parsed = jsonSetting(raw.lights, "lights", []);
  if (!Array.isArray(parsed)) throw new Error("lights must be a JSON array");
  const seen = new Set<string>();
  const lights = parsed.map((entry, index): SceneLight => {
    const at = `light ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${at} must be an object`);
    const light = entry as Record<string, unknown>;
    const target = typeof light.target === "string" ? light.target.trim() : "";
    if (!target) throw new Error(`${at} needs a target: the light's id in its room controller`);
    const area = typeof light.area === "string" ? light.area.trim() : "";
    if (!areaId(area)) throw new Error(`${at} (${target}) needs an area: its room controller's Area`);
    const key = areaId(area) + "/" + target;
    if (seen.has(key)) throw new Error(`${at}: ${target} in ${area} is listed twice`);
    seen.add(key);
    const state = String(light.state ?? "").toUpperCase();
    if (state !== "ON" && state !== "OFF") throw new Error(`${at} (${target}): state must be ON or OFF`);
    const scene: SceneLight = {area, target, state};
    for (const key of ["brightnessPct", "colorTempKelvin"] as const) {
      if (light[key] === undefined) continue;
      const value = light[key];
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${at} (${target}): ${key} must be a number`);
      if (key === "brightnessPct" && (value < 0 || value > 100)) throw new Error(`${at} (${target}): brightnessPct must be 0-100`);
      if (key === "colorTempKelvin" && value <= 0) throw new Error(`${at} (${target}): colorTempKelvin must be above 0`);
      if (state === "OFF") throw new Error(`${at} (${target}): an OFF light takes no ${key}`);
      scene[key] = value;
    }
    for (const key of Object.keys(light)) {
      if (!["area", "target", "state", "brightnessPct", "colorTempKelvin"].includes(key)) throw new Error(`${at} (${target}): unknown field ${key}`);
    }
    return scene;
  });
  const hours = numberSetting(raw.safetyHours, "safety timer", DEFAULT_SAFETY_HOURS);
  if (hours < 0) throw new Error("safety timer must be 0 (off) or more hours");
  return {owner: raw.owner, lights, safetyMs: Math.round(hours * 3_600_000)};
}

export function createSceneState(saved: Partial<SceneState> = {}): SceneState {
  const active = saved.active === true && typeof saved.owner === "string";
  return {
    active,
    owner: active ? saved.owner! : null,
    lights: active && Array.isArray(saved.lights)
      ? saved.lights.filter((light) => typeof light?.area === "string" && typeof light.target === "string").map(({area, target}) => ({area, target}))
      : [],
    startedAt: active && Number.isFinite(saved.startedAt) ? saved.startedAt! : null,
    endsAt: active && Number.isFinite(saved.endsAt) ? saved.endsAt! : null,
    ended: saved.ended && typeof saved.ended.by === "string" && Number.isFinite(saved.ended.at) ? {...saved.ended} : null
  };
}

// How a span of time reads on the status: "3h 59m", "12m", "under 1m".
function span(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under 1m";
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function transitionScene(
  saved: Partial<SceneState> | undefined,
  msg: {scene?: SceneEvent},
  config: SceneConfig,
  nowValue: Date | string | number = new Date()
) {
  const now = (nowValue instanceof Date ? nowValue : new Date(nowValue)).getTime();
  const state = createSceneState(saved);
  const lighting: SceneLighting[] = [];
  const motion: SceneMotion[] = [];
  const traces: TraceEntry[] = [];
  const trace = (event: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) =>
    traces.push({event, outcome, reason, details});
  const event = msg.scene && typeof msg.scene === "object" ? msg.scene : {};
  const kind = String(event.kind ?? "");
  const pause = (on: boolean) => motion.push({source: "pause", payload: on, owner: state.owner!});

  function end(by: string) {
    const owner = state.owner!;
    // One release per room, for the lights it took there.
    const rooms = new Map<string, string[]>();
    for (const {area, target} of state.lights) rooms.set(area, [...(rooms.get(area) ?? []), target]);
    for (const [area, targets] of rooms) lighting.push({lighting: {kind: "release", area, owner, targets, source: "scene"}});
    pause(false);
    trace("scene", "ended", null, {by, owner});
    Object.assign(state, {active: false, owner: null, lights: [], startedAt: null, endsAt: null, ended: {by, at: now}});
  }

  if (kind === "start") {
    if (state.active) {
      // On again: a fresh safety timer; its lights are left as they are, so
      // a person's change during the scene stands.
      state.endsAt = config.safetyMs > 0 ? now + config.safetyMs : null;
      pause(true);
      trace("scene", "renewed", null, {owner: state.owner});
    } else {
      Object.assign(state, {
        active: true,
        owner: config.owner,
        lights: config.lights.map(({area, target}) => ({area, target})),
        startedAt: now,
        endsAt: config.safetyMs > 0 ? now + config.safetyMs : null
      });
      for (const light of config.lights) {
        const values = {
          ...(light.brightnessPct !== undefined ? {brightnessPct: light.brightnessPct} : {}),
          ...(light.colorTempKelvin !== undefined ? {colorTempKelvin: light.colorTempKelvin} : {})
        };
        lighting.push({lighting: {kind: "intent", area: light.area, targets: [light.target], state: light.state, owner: config.owner, source: "scene",
          ...(Object.keys(values).length ? {values} : {})}});
      }
      pause(true);
      trace("scene", "started", null, {owner: config.owner, lights: state.lights});
    }
  } else if (kind === "end") {
    if (state.active) end(typeof event.by === "string" && event.by.trim() ? event.by.trim() : "request");
    else trace("scene", "ignored", "not-active");
  } else if (kind === "tick" || kind === "startup") {
    // Its timer, or the flows starting again (a redeploy or restart with a
    // context store): end it if its time is up, otherwise renew its pause.
    // Its lights are not asked again: the rooms still hold them.
    if (state.active && state.endsAt !== null && state.endsAt <= now) end("timer");
    else if (state.active) pause(true);
  } else {
    trace("input", "ignored", "not-a-scene-message");
  }

  return {
    state,
    lighting,
    motion,
    traces,
    status: state.active
      ? {fill: "green", shape: "dot", text: "on" + (state.endsAt !== null ? ` · ${span(state.endsAt - now)} left` : "")}
      : {fill: "grey", shape: state.ended ? "dot" : "ring", text: state.ended ? `off · ended by ${state.ended.by}` : "off"}
  };
}

// When it next needs a tick: its next renewal, or its safety timer's end if
// sooner. Null when off.
export function sceneTickAt(state: SceneState, now: number): number | null {
  if (!state.active) return null;
  const renew = now + RENEW_MS;
  return state.endsAt !== null ? Math.min(renew, state.endsAt) : renew;
}
