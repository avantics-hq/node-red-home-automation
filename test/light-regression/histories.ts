"use strict";

import {createHash} from "node:crypto";

// Generated histories for the light-adapter regression proof: the same
// events driven through the room controller as it was before the adapters
// (Zigbee2MQTT targets) and as it is with them, comparing every /set
// publication byte for byte, and the room's decisions. Seeded, so the
// golden fingerprints (test/fixtures/light-regression.json, made by
// scripts/light-regression-golden.mjs from the earlier build) stay valid.
// Events name lights by target id; each runner turns them into its own
// input messages.

export interface RegressionLight {
  id: string;
  // Zigbee2MQTT friendly name, under the base topic "z2m".
  name: string;
  group?: boolean;
  onOffOnly?: boolean;
}

export type RegressionEvent =
  | {at: number; type: "style"; values: {brightnessPct: number; colorTempKelvin: number} | null; transitionSeconds: number; untilSeconds: number; takeBack?: boolean}
  | {at: number; type: "intent"; lighting: Record<string, unknown>}
  | {at: number; type: "release"; owner?: string; targets?: string[]}
  // The light's own report on its state topic, in Zigbee2MQTT's shape.
  | {at: number; type: "report"; target: string; payload: Record<string, unknown>}
  // Someone else's command on its /set topic.
  | {at: number; type: "set"; target: string; payload: Record<string, unknown>; retain?: boolean}
  // The echo of the last /set published for this light: as sent, twice, or cut to a bare state.
  | {at: number; type: "echo"; target: string; mode: "exact" | "twice" | "bare"}
  // The light reports what it was last sent (it obeyed).
  | {at: number; type: "obey"; target: string}
  | {at: number; type: "startup"}
  // Node-RED restarted: with a context store everything is kept, without it nothing.
  | {at: number; type: "restart"; keep: boolean};

export interface RegressionHistory {
  seed: number;
  lights: RegressionLight[];
  events: RegressionEvent[];
}

export const START = Date.parse("2026-06-21T05:00:00Z");

// A small, fixed pseudo-random sequence (mulberry32), so histories never change.
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateHistory(seed: number, length = 60): RegressionHistory {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const lights: RegressionLight[] = [
    {id: "ceiling", name: "test/ceiling"},
    {id: "lamp", name: "test/lamp"},
    {id: "strip", name: "test/strip", group: true},
    {id: "plug", name: "test/plug", onOffOnly: true}
  ];
  const ids = lights.map(({id}) => id);
  const events: RegressionEvent[] = [];
  let at = 0;
  const style = (): RegressionEvent => ({
    at, type: "style",
    values: next() < 0.1 ? null : {brightnessPct: Math.round(next() * 10000) / 100, colorTempKelvin: 2000 + Math.round(next() * 4500)},
    transitionSeconds: pick([30, 45, 60]), untilSeconds: at + 180, ...(next() < 0.1 ? {takeBack: true} : {})
  });
  events.push({at, type: "startup"}, style());
  for (let index = 0; index < length; index += 1) {
    at += pick([0.05, 0.2, 1, 3, 7, 30, 61, 200]);
    const roll = next();
    const target = pick(ids);
    if (roll < 0.14) events.push(style());
    else if (roll < 0.36) {
      const lighting: Record<string, unknown> = {kind: "intent", source: pick(["motion", "wall", "activity", "scene", "dashboard"]),
        state: pick(["ON", "ON", "OFF", "TOGGLE"])};
      if (next() < 0.6) lighting.targets = ids.filter(() => next() < 0.6);
      if (next() < 0.35) {
        const values: Record<string, unknown> = {};
        if (next() < 0.8) values.brightnessPct = pick([0, 5, 25, 39.4, 50, "60", 100]);
        if (next() < 0.5) values.colorTempKelvin = pick([2000, 2500, 2700, 4000, 6500]);
        if (next() < 0.2) values.effect = pick(["blink", "okay"]);
        if (next() < 0.1) values.transition = 3;
        lighting.values = values;
      }
      if (next() < 0.2) lighting.owner = pick(["theatre", "scene"]);
      if (next() < 0.15) lighting.manual = true;
      if (next() < 0.15) lighting.person = true;
      if (next() < 0.1) lighting.preserveManual = true;
      if (next() < 0.1) lighting.updateOnOnly = true;
      if (lighting.source === "motion" && lighting.state === "OFF" && next() < 0.5) {
        lighting.vacantSince = new Date(START + Math.max(0, at - 60) * 1000).toISOString();
      }
      events.push({at, type: "intent", lighting});
    } else if (roll < 0.42) events.push({at, type: "release", ...(next() < 0.5 ? {owner: pick(["theatre", "scene"])} : {}), ...(next() < 0.4 ? {targets: [target]} : {})});
    else if (roll < 0.62) events.push({at, type: "obey", target});
    else if (roll < 0.7) {
      const payload: Record<string, unknown> = {state: pick(["ON", "OFF"])};
      if (next() < 0.5) payload.brightness = pick([1, 64, 128, 200, 254]);
      if (next() < 0.4) payload.color_temp = pick([154, 250, 370, 400, 500]);
      events.push({at, type: "report", target, payload});
    } else if (roll < 0.8) events.push({at, type: "echo", target, mode: pick(["exact", "exact", "twice", "bare"])});
    else if (roll < 0.9) {
      const payload: Record<string, unknown> = {state: pick(["ON", "ON", "OFF", "TOGGLE"])};
      if (next() < 0.4) payload.brightness = pick([10, 120, 254]);
      events.push({at, type: "set", target, payload, ...(next() < 0.05 ? {retain: true} : {})});
    } else if (roll < 0.94) events.push({at, type: "startup"});
    else if (roll < 0.97) events.push({at, type: "restart", keep: next() < 0.6});
    else events.push({at, type: "obey", target});
  }
  return {seed, lights, events};
}

export function generateHistories(count = 400, firstSeed = 1): RegressionHistory[] {
  return Array.from({length: count}, (_, index) => generateHistory(firstSeed + index));
}

// One fingerprint for a list, stable across runs.
export function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}
