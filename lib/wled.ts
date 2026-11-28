"use strict";

// A WLED light strip as the backlighting controller's device: the
// controller's set_power becomes WLED's ON or OFF, and what WLED publishes
// becomes the controller's readings. No broker connection here: device
// messages arrive from the node's broker subscription (or an MQTT in node),
// and publications leave for the broker (or an MQTT out node).
//
// From WLED's documentation (interfaces, MQTT):
// - it subscribes to its device topic, taking "ON", "OFF", "T" (toggle) or
//   a brightness 0-255;
// - on every light change it publishes the brightness, 0-255, on
//   <device>/g (and the colour on /c and the XML API response on /v);
// - it says nothing of who made a change.
// Seen on a WLED device, not in its documentation: <device>/status carries
// "online" or "offline", retained (its last will), and /g, /c and /v aren't
// retained.

import type {TraceEntry} from "./bounded-trace";
import {isObject, type MqttPublication} from "./mqtt-message";

export interface WledConfig {
  // WLED's device topic, as set in its Sync settings (WLED's own default is
  // wled/<MAC address>).
  deviceTopic: string;
}

export type WledPower = "on" | "off";

export interface WledState {
  // The power WLED last reported, and when that report arrived.
  power: WledPower | null;
  observedAt: string | null;
  // From <device>/status: null until it reports.
  online: boolean | null;
  // The generation of the backlighting controller's command in hand, which
  // its readings answer.
  generation: number | null;
}

export interface WledMessage {
  topic?: unknown;
  payload?: unknown;
  backlightingCommand?: {operation?: unknown; generation?: unknown; power?: unknown};
}

// For the backlighting controller, as msg.backlighting.
export type WledReading =
  | {kind: "observed"; generation: number; power: WledPower; observedAt: string}
  | {kind: "command_result"; generation: number; ok: boolean; reason?: string};

export function normaliseWledConfig(config: {deviceTopic?: unknown}): WledConfig {
  const deviceTopic = String(config.deviceTopic ?? "").trim().replace(/^\/+|\/+$/g, "");
  // The user's own device's: no default.
  if (!deviceTopic) throw new Error("WLED's device topic is required");
  if (/[+#]/.test(deviceTopic)) throw new Error("the device topic can't contain + or #");
  return {deviceTopic};
}

export function wledTopics(config: WledConfig) {
  const device = config.deviceTopic;
  return {device, brightness: `${device}/g`, status: `${device}/status`};
}

function text(payload: unknown): string {
  if (Buffer.isBuffer(payload)) return payload.toString("utf8").trim();
  return String(payload ?? "").trim();
}

export function transitionWled(
  saved: Partial<WledState> | undefined,
  msg: WledMessage,
  config: WledConfig,
  now: Date
) {
  const state: WledState = {
    power: saved?.power === "on" || saved?.power === "off" ? saved.power : null,
    observedAt: typeof saved?.observedAt === "string" ? saved.observedAt : null,
    online: typeof saved?.online === "boolean" ? saved.online : null,
    generation: Number.isInteger(saved?.generation) ? saved!.generation! : null
  };
  const topics = wledTopics(config);
  const publications: MqttPublication[] = [];
  const readings: Array<{backlighting: WledReading}> = [];
  const traces: TraceEntry[] = [];
  const trace = (event: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) => {
    traces.push({event, outcome, reason, details});
  };
  // What it knows, as a reading for the command in hand.
  const reading = () => {
    if (state.generation === null || state.power === null) return;
    readings.push({backlighting: {kind: "observed", generation: state.generation, power: state.power, observedAt: now.toISOString()}});
  };

  const command = msg.backlightingCommand;
  if (isObject(command)) {
    const operation = String(command.operation);
    const generation = Number(command.generation);
    if (!Number.isInteger(generation) || generation < 0) throw new Error("a backlighting command needs its generation");
    state.generation = generation;
    if (operation === "set_power") {
      if (command.power !== "on" && command.power !== "off") throw new Error("set_power needs power on or off");
      if (state.online === false) {
        // It would be lost: WLED isn't connected to the broker.
        readings.push({backlighting: {kind: "command_result", generation, ok: false, reason: "unavailable"}});
        trace("command", "refused", "offline", {power: command.power});
      } else {
        publications.push({topic: topics.device, payload: command.power === "on" ? "ON" : "OFF"});
        readings.push({backlighting: {kind: "command_result", generation, ok: true}});
        trace("command", "sent", null, {power: command.power});
      }
    } else if (operation === "observe") {
      // WLED publishes every change while it is connected, so the last
      // report is what it shows now; with none since the node started, or
      // with WLED offline, there is nothing to say yet.
      if (state.online !== false && state.power !== null) {
        reading();
        trace("command", "observed", null, {power: state.power});
      } else {
        trace("command", "unanswered", state.online === false ? "offline" : "no-report");
      }
    } else {
      trace("command", "ignored", "unknown-operation", {operation});
    }
  } else if (msg.topic === topics.brightness) {
    const brightness = Number(text(msg.payload));
    if (!Number.isFinite(brightness) || brightness < 0) throw new Error(`${topics.brightness} must carry a brightness 0-255`);
    // Off is brightness 0.
    state.power = brightness > 0 ? "on" : "off";
    state.observedAt = now.toISOString();
    state.online = true;
    reading();
    trace("report", "read", null, {brightness, power: state.power});
  } else if (msg.topic === topics.status) {
    const status = text(msg.payload).toLowerCase();
    if (status !== "online" && status !== "offline") throw new Error(`${topics.status} must be online or offline`);
    state.online = status === "online";
    trace("availability", status);
  } else {
    trace("message", "ignored", "other-topic", {topic: typeof msg.topic === "string" ? msg.topic : null});
  }
  return {state, publications, readings, traces};
}
