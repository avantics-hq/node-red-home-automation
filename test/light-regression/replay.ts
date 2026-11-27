"use strict";

// Drives a generated history (histories.ts) through the room controller with
// a Zigbee2MQTT light adapter per light, in the input shapes those nodes
// take, and records the same things scripts/light-regression-golden.mjs
// records for the room before the adapters.
import type {LightReading, LightRoomMessage} from "../../lib/light-contract";
import {publishRoom} from "../../lib/room-publishing";
import type {RoomMessage, RoomState} from "../../lib/room-controller";
import {normaliseZ2mLightConfig, transitionZ2mLight, type Z2mLightState} from "../../lib/z2m-light-adapter";
import {START, type RegressionHistory} from "./histories";

// The traces the comparison includes, as the golden script lists them.
const TRACES = new Set(["mutated-own-command", "restyled-recently", "already-at-level", "not-told-since-start", "person-set-after-vacancy", "held-by",
  "on-off-only", "own-command", "stale-report", "external-off", "external-values", "observed-off", "taken-back"]);

export function replay(history: RegressionHistory, {perturb = false} = {}) {
  const config = {
    area: "test", displayName: "Test", initialTransitionSeconds: 1, publishState: true, discovery: false,
    targets: history.lights.map((light) => ({id: light.id, ...(light.onOffOnly ? {onOffOnly: true} : {})}))
  };
  const adapters = Object.fromEntries(history.lights.map((light) =>
    [light.id, normaliseZ2mLightConfig({target: light.id, baseTopic: "z2m", friendlyName: light.name, group: light.group === true})]));
  let room: RoomState | undefined;
  let lights: Record<string, Partial<Z2mLightState> | undefined> = {};
  const lastSet: Record<string, Record<string, unknown>> = {};
  const sets: Array<[number, string, string]> = [];
  const decisions: unknown[] = [];
  for (const event of history.events) {
    const now = START + event.at * 1000;
    const traces: string[] = [];
    const control: Array<[string, string]> = [];
    // The room's messages, and the adapters' MQTT messages, in arrival order.
    const toRoom: RoomMessage[] = [];
    const toLight: Array<{id: string; msg: Record<string, unknown>}> = [];
    const device = (id: string) => `z2m/${history.lights.find((light) => light.id === id)!.name}`;

    function lightInput(id: string, msg: Record<string, unknown>) {
      const result = transitionZ2mLight(lights[id], msg, adapters[id]!, now);
      lights[id] = result.state;
      for (const publication of result.publications) {
        if (!publication.topic.endsWith("/set")) continue;
        let payload = publication.payload as Record<string, unknown>;
        // The control for the test itself: one conversion off, which must show.
        if (perturb && typeof payload.color_temp === "number") payload = {...payload, color_temp: payload.color_temp + 1};
        sets.push([event.at, publication.topic, JSON.stringify(payload)]);
        lastSet[id] = payload;
      }
      for (const reading of result.readings) toRoom.push({light: reading as LightReading});
    }
    function roomInput(msg: RoomMessage) {
      const result = publishRoom(room, msg, config, now);
      room = result.state;
      for (const output of result.outputs) if (/\/control$/.test(output.topic)) control.push([output.topic, JSON.stringify(output.payload)]);
      for (const entry of result.traces) if (entry.reason && TRACES.has(entry.reason)) traces.push(`${entry.event}:${entry.outcome}:${entry.reason}`);
      // Every adapter gets the room's commands; each acts on its own.
      for (const light of result.commands as LightRoomMessage[]) for (const id of Object.keys(adapters)) lightInput(id, {light});
    }
    function drain() {
      while (toRoom.length || toLight.length) {
        if (toLight.length) {
          const {id, msg} = toLight.shift()!;
          lightInput(id, msg);
        } else {
          roomInput(toRoom.shift()!);
        }
      }
    }

    if (event.type === "style") {
      toRoom.push({lighting: {kind: "style", source: "circadian", values: event.values as never, transitionSeconds: event.transitionSeconds,
        until: new Date(START + event.untilSeconds * 1000).toISOString(), ...(event.takeBack ? {takeBack: true} : {})}});
    } else if (event.type === "intent") {
      toRoom.push({lighting: event.lighting as RoomMessage["lighting"]});
    } else if (event.type === "release") {
      toRoom.push({lighting: {kind: "release", source: "activity", ...(event.owner ? {owner: event.owner} : {}), ...(event.targets ? {targets: event.targets} : {})}});
    } else if (event.type === "report") {
      toLight.push({id: event.target, msg: {topic: device(event.target), payload: event.payload}});
    } else if (event.type === "obey") {
      const last = lastSet[event.target];
      if (last) {
        const payload: Record<string, unknown> = {state: last.state};
        if (last.brightness !== undefined) payload.brightness = last.brightness;
        if (last.color_temp !== undefined) payload.color_temp = last.color_temp;
        toLight.push({id: event.target, msg: {topic: device(event.target), payload}});
      }
    } else if (event.type === "set") {
      toLight.push({id: event.target, msg: {topic: `${device(event.target)}/set`, payload: event.payload, ...(event.retain ? {retain: true} : {})}});
    } else if (event.type === "echo") {
      const last = lastSet[event.target];
      if (last) {
        const payload = event.mode === "bare" ? {state: last.state} : last;
        for (let copy = 0; copy < (event.mode === "twice" ? 2 : 1); copy += 1) {
          toLight.push({id: event.target, msg: {topic: `${device(event.target)}/set`, payload}});
        }
      }
    } else if (event.type === "startup") {
      toRoom.push({lighting: {kind: "startup"}});
    } else if (event.type === "restart" && !event.keep) {
      room = undefined;
      lights = {};
    }
    drain();
    decisions.push([event.at, control, traces.sort(), room ? JSON.stringify(room.control) : null, room ? JSON.stringify(room.personAt) : null]);
  }
  return {sets, decisions};
}
