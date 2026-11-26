"use strict";

// A Zigbee2MQTT cover as the cover controller's device: the controller's
// neutral commands become Zigbee2MQTT's set and get messages, and what the
// device publishes becomes neutral cover readings. No broker connection
// here: device messages arrive from an MQTT in node, and publications leave
// for an MQTT out node.
//
// From Zigbee2MQTT's documentation (MQTT topics and messages, device
// availability, and its cover device pages):
// - a device publishes its whole state as JSON on <base>/<name>, and takes
//   commands on <base>/<name>/set: {"position": 0-100} and {"state": "OPEN"
//   | "CLOSE" | "STOP"}; <base>/<name>/get with {"position": ""} or
//   {"state": ""} asks it to read a value, where the device supports it;
// - position runs 0 (closed) to 100 (open) unless the device's invert_cover
//   option is set; state is OPEN or CLOSE;
// - some covers report motion: motor_state (opening, closing, stopped),
//   moving (UP, DOWN, STOP) or running (true or false); many report none;
//   motor_state also has pause on some motors;
// - availability is {"state": "online" | "offline"} on
//   <base>/<name>/availability, retained.

import type {TraceEntry} from "./bounded-trace";
import type {CoverMotion} from "./cover-controller";
import {isObject, parsedPayload, type MqttPublication} from "./mqtt-message";

export interface Z2mCoverConfig {
  // Zigbee2MQTT's base topic: zigbee2mqtt unless changed in its settings.
  baseTopic: string;
  // The device's friendly name in Zigbee2MQTT.
  friendlyName: string;
}

export interface Z2mCoverState {
  // Whether the device has reported a position: an open, close and stop
  // only cover is asked to read its state instead.
  reportsPosition: boolean;
}

export interface Z2mCoverMessage {
  topic?: unknown;
  payload?: unknown;
  cover_command?: {operation?: unknown; position?: unknown; generation?: unknown};
}

// A reading for the cover controller: a position cover's, or with no
// position, an open, close and stop only cover's end state.
export type Z2mCoverReading =
  | {kind: "observed"; position?: number; state?: "open" | "closed"; motion?: CoverMotion; observedAt: string; battery?: number; charging?: string}
  | {kind: "availability"; online: boolean};

// Settings may be editor strings. The friendly name is the user's own
// device's, so it has no default.
export function normaliseZ2mCoverConfig(config: {baseTopic?: unknown; friendlyName?: unknown}): Z2mCoverConfig {
  const baseTopic = String(config.baseTopic ?? "").trim().replace(/^\/+|\/+$/g, "") || "zigbee2mqtt";
  const friendlyName = String(config.friendlyName ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!friendlyName) throw new Error("the device's friendly name is required");
  if (/[+#]/.test(baseTopic) || /[+#]/.test(friendlyName)) throw new Error("the base topic and friendly name can't contain + or #");
  return {baseTopic, friendlyName};
}

export function z2mCoverTopics(config: Z2mCoverConfig) {
  const device = `${config.baseTopic}/${config.friendlyName}`;
  return {device, set: `${device}/set`, get: `${device}/get`, availability: `${device}/availability`};
}

// "pause": stopped part-way, as some motors report it.
const MOTOR_STATES: Record<string, CoverMotion> = {opening: "opening", closing: "closing", stopped: "stopped", pause: "stopped"};
const MOVING: Record<string, CoverMotion> = {UP: "opening", DOWN: "closing", STOP: "stopped"};
const COMMAND_STATES: Record<string, string> = {open: "OPEN", close: "CLOSE", stop: "STOP"};

// The motion a state report gives, if any: running alone says the motor is
// moving but not which way, so only its false (stopped) counts.
function motionOf(report: Record<string, unknown>): CoverMotion | undefined {
  if (typeof report.motor_state === "string" && MOTOR_STATES[report.motor_state]) return MOTOR_STATES[report.motor_state];
  if (typeof report.moving === "string" && MOVING[report.moving]) return MOVING[report.moving];
  if (report.running === false) return "stopped";
  return undefined;
}

export function transitionZ2mCover(
  saved: Partial<Z2mCoverState> | undefined,
  msg: Z2mCoverMessage,
  config: Z2mCoverConfig,
  now: Date
) {
  const state: Z2mCoverState = {reportsPosition: saved?.reportsPosition !== false};
  const topics = z2mCoverTopics(config);
  const publications: MqttPublication[] = [];
  const readings: Array<{cover: Z2mCoverReading}> = [];
  const traces: TraceEntry[] = [];
  const trace = (event: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) => {
    traces.push({event, outcome, reason, details});
  };
  const publish = (topic: string, payload: Record<string, unknown>) => publications.push({topic, payload: JSON.stringify(payload)});

  const command = msg.cover_command;
  if (isObject(command)) {
    const operation = String(command.operation);
    if (operation === "set_position") {
      const position = Number(command.position);
      if (!Number.isFinite(position)) throw new Error("set_position needs a position");
      publish(topics.set, {position: Math.round(Math.max(0, Math.min(100, position)))});
      trace("command", "sent", null, {operation, position});
    } else if (Object.hasOwn(COMMAND_STATES, operation)) {
      publish(topics.set, {state: COMMAND_STATES[operation]});
      trace("command", "sent", null, {operation});
    } else if (operation === "observe") {
      // A fresh read, not the last report: its position, or for a cover with
      // none, its state. The device answers on its state topic.
      publish(topics.get, state.reportsPosition ? {position: ""} : {state: ""});
      trace("command", "sent", null, {operation, read: state.reportsPosition ? "position" : "state"});
    } else {
      trace("command", "ignored", "unknown-operation", {operation});
    }
  } else if (msg.topic === topics.device) {
    const report = parsedPayload(msg.payload);
    if (!isObject(report)) throw new Error(`${topics.device} must carry the device's state object`);
    const position = typeof report.position === "number" && Number.isFinite(report.position) && report.position >= 0 && report.position <= 100
      ? report.position : undefined;
    const motion = motionOf(report);
    // With a position, an end state only at the ends: Zigbee2MQTT's OPEN
    // can mean no more than "not closed". Without one, its OPEN or CLOSE,
    // but only once the motor reports it has stopped: the state can change
    // as soon as a move is asked for, before the cover gets there.
    const end = position !== undefined
      ? (position === 100 ? "open" : position === 0 ? "closed" : undefined)
      : motion !== "stopped" ? undefined
        : report.state === "OPEN" ? "open" : report.state === "CLOSE" ? "closed" : undefined;
    if (position === undefined && motion === undefined && end === undefined) {
      trace("report", "ignored", "no-cover-state");
    } else {
      state.reportsPosition = position !== undefined;
      readings.push({cover: {
        kind: "observed",
        ...(position !== undefined ? {position} : {}),
        ...(end ? {state: end} : {}),
        ...(motion ? {motion} : {}),
        // When received, never a time the device gives: its clock may be off.
        observedAt: now.toISOString(),
        ...(typeof report.battery === "number" ? {battery: report.battery} : {}),
        // A string, or a binary's true or false: passed on as text.
        ...(typeof report.charging_status === "string" || typeof report.charging_status === "boolean"
          ? {charging: String(report.charging_status)} : {})
      }});
      trace("report", "read", null, {position: position ?? null, motion: motion ?? null, state: end ?? null});
    }
  } else if (msg.topic === topics.availability) {
    // {"state": "online"}, or the plain "online" of older setups.
    const received = parsedPayload(msg.payload);
    const value = isObject(received) ? received.state : received;
    if (value !== "online" && value !== "offline") throw new Error(`${topics.availability} must say online or offline`);
    readings.push({cover: {kind: "availability", online: value === "online"}});
    trace("availability", value);
  } else {
    trace("message", "ignored", "unrelated-message", {topic: typeof msg.topic === "string" ? msg.topic : null});
  }

  return {state, publications, readings, traces};
}
