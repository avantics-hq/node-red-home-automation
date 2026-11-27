"use strict";

// A Zigbee2MQTT light (or group) as the room controller's device: the
// room's neutral commands become Zigbee2MQTT's /set payloads, exactly as the
// room sent them before 6.0, and what Zigbee2MQTT publishes becomes neutral
// readings. It also makes the two judgements that depend on Zigbee2MQTT's
// units: telling its own /set echo from someone else's command, and whether
// the light already shows a restyle. No broker connection here: device
// messages arrive from an MQTT in node, and publications leave for an MQTT
// out node.
//
// From Zigbee2MQTT's documentation (MQTT topics and messages, groups, device
// availability):
// - a device publishes its whole state as JSON on <base>/<name>, and takes
//   commands on <base>/<name>/set: state ON, OFF or TOGGLE, brightness
//   1-254, color_temp in mireds, transition in seconds, and others such as
//   effect; <base>/<name>/get with {"state": ""} asks it to report;
// - availability is {"state": "online" | "offline"} on
//   <base>/<name>/availability (or a bare online/offline in older setups);
// - a group takes the same /set commands on <base>/<group>/set, and
//   Zigbee2MQTT publishes the group's state on <base>/<group>, worked out
//   from what it sent and its members' reports rather than read from a
//   device. A group has no availability and doesn't answer /get.

import type {TraceEntry} from "./bounded-trace";
import {ECHO_WINDOW_MS, checkCommandEcho, parsePayload, rememberCommand, type ExpectedCommand} from "./command-echo";
import type {LightCommandMessage, LightField, LightReading} from "./light-contract";
import {textSetting} from "./settings";
import {readLightReport, setsLightValues, zigbeeBrightness, zigbeeColorTemp} from "./z2m-light";

export {ECHO_WINDOW_MS};

export interface Z2mLightConfig {
  // The room's id for this light.
  target: string;
  baseTopic: string;
  friendlyName: string;
  // A Zigbee2MQTT group rather than a device.
  group: boolean;
}

// The light's last report, in Zigbee2MQTT's units.
interface DeviceReport {
  on: boolean;
  brightness: unknown;
  color_temp: unknown;
  observedAt: string;
}

export interface Z2mLightState {
  // The /set payloads it published lately, to know their echoes.
  expected: ExpectedCommand[];
  // The last /set payload it published, and the room's id for it.
  last: {payload: Record<string, unknown>; id: string} | null;
  report: DeviceReport | null;
  // The value fields the light has reported since start.
  fields: LightField[];
  online: boolean | null;
}

export interface Z2mLightMessage {
  topic?: unknown;
  payload?: unknown;
  retain?: unknown;
  light?: unknown;
}

export interface Publication {
  topic: string;
  payload: unknown;
  retain: false;
}

export function normaliseZ2mLightConfig(config: {target?: unknown; baseTopic?: unknown; friendlyName?: unknown; group?: unknown}): Z2mLightConfig {
  const target = textSetting(config.target, "target", "");
  const friendlyName = textSetting(config.friendlyName, "friendly name", "");
  const baseTopic = textSetting(config.baseTopic, "base topic", "zigbee2mqtt").replace(/^\/+|\/+$/g, "");
  if (!target) throw new Error("target is required: the room's id for this light");
  if (!friendlyName) throw new Error("friendly name is required");
  if (!baseTopic) throw new Error("base topic is required");
  if (/[+#]/.test(baseTopic + friendlyName)) throw new Error("base topic and friendly name cannot contain + or #");
  return {target, baseTopic, friendlyName, group: config.group === true || config.group === "true"};
}

export function z2mLightTopics(config: Z2mLightConfig) {
  const device = `${config.baseTopic}/${config.friendlyName}`;
  return {device, set: `${device}/set`, get: `${device}/get`, availability: `${device}/availability`};
}

// Where a 5.x room target's topics point, when they are Zigbee2MQTT's own:
// <base>/<name> and <base>/<name>/set. Null for anything else, which is set
// up by hand on the neutral contract.
export function parseZ2mTargetTopics(stateTopic: unknown, commandTopic: unknown): {baseTopic: string; friendlyName: string} | null {
  if (typeof stateTopic !== "string" || typeof commandTopic !== "string") return null;
  if (commandTopic !== `${stateTopic}/set`) return null;
  const slash = stateTopic.indexOf("/");
  if (slash <= 0 || slash === stateTopic.length - 1) return null;
  return {baseTopic: stateTopic.slice(0, slash), friendlyName: stateTopic.slice(slash + 1)};
}

export function createZ2mLightState(saved: Partial<Z2mLightState> = {}): Z2mLightState {
  return {
    expected: Array.isArray(saved.expected) ? saved.expected.map((entry) => ({...entry})) : [],
    last: saved.last && typeof saved.last === "object" ? {payload: {...saved.last.payload}, id: String(saved.last.id)} : null,
    report: saved.report && typeof saved.report === "object" ? {...saved.report} : null,
    fields: Array.isArray(saved.fields) ? saved.fields.filter((field): field is LightField => field === "brightness" || field === "colorTemp") : [],
    online: typeof saved.online === "boolean" ? saved.online : null
  };
}

// A command as Zigbee2MQTT's /set payload, field for field and in the order
// the room built it before 6.0: the state, any other fields the intent gave,
// brightness and colour temperature, then the transition unless an extra
// field already set one.
export function z2mLightPayload(command: LightCommandMessage): Record<string, unknown> {
  if (command.state === "OFF") return {state: "OFF"};
  const payload: Record<string, unknown> = {state: "ON", ...(command.extra ?? {})};
  if (typeof command.brightnessPct === "number") payload.brightness = zigbeeBrightness(command.brightnessPct);
  if (typeof command.colorTempKelvin === "number") payload.color_temp = zigbeeColorTemp(command.colorTempKelvin);
  if (typeof command.transitionSeconds === "number" && !Object.hasOwn(payload, "transition")) payload.transition = command.transitionSeconds;
  return payload;
}

function sameValues(payload: Record<string, unknown>, report: DeviceReport): boolean {
  return (payload.brightness === undefined || Number(report.brightness) === payload.brightness) &&
    (payload.color_temp === undefined || Number(report.color_temp) === payload.color_temp);
}

function reportedFields(payload: Record<string, unknown>): LightField[] {
  const fields: LightField[] = [];
  if (payload.brightness !== undefined && payload.brightness !== null) fields.push("brightness");
  if (payload.color_temp !== undefined && payload.color_temp !== null) fields.push("colorTemp");
  return fields;
}

export function transitionZ2mLight(
  saved: Partial<Z2mLightState> | undefined,
  msg: Z2mLightMessage,
  config: Z2mLightConfig,
  nowValue: Date | string | number = new Date()
) {
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const nowMs = now.getTime();
  const state = createZ2mLightState(saved);
  const topics = z2mLightTopics(config);
  const publications: Publication[] = [];
  const readings: LightReading[] = [];
  const traces: TraceEntry[] = [];
  const trace = (event: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) =>
    traces.push({event, outcome, reason, details});
  const target = config.target;

  const light = msg.light && typeof msg.light === "object" ? msg.light as {kind?: unknown; target?: unknown} : null;
  if (light && (light.kind === "command" || light.kind === "observe")) {
    // The room's messages for every light arrive here; only this one's count.
    if (light.target !== target) return {state, publications, readings, traces, ignored: true};
    if (light.kind === "observe") {
      if (config.group) {
        // A group can't be asked: Zigbee2MQTT sends its state as it changes.
        trace("observe", "ignored", "group-has-no-get");
      } else {
        publications.push({topic: topics.get, payload: {state: ""}, retain: false});
        trace("observe", "sent");
      }
    } else {
      const command = light as unknown as LightCommandMessage;
      const payload = z2mLightPayload(command);
      if (command.restyle === true && state.report?.on === true && payload.state === "ON" && sameValues(payload, state.report)) {
        // Already there: nothing to send, as the room skipped it before 6.0.
        readings.push({kind: "skipped", target, id: String(command.id), observedAt: state.report.observedAt});
        trace("command", "skipped", "already-at-level", {id: command.id});
      } else {
        state.expected = rememberCommand(state.expected, payload, nowMs);
        state.last = {payload, id: String(command.id)};
        publications.push({topic: topics.set, payload, retain: false});
        if (command.restyle === true) readings.push({kind: "sent", target, id: String(command.id)});
        trace("command", "sent", null, {id: command.id, source: command.source, state: payload.state});
      }
    }
    return {state, publications, readings, traces, ignored: false};
  }

  const topic = typeof msg.topic === "string" ? msg.topic : "";
  const parsed = parsePayload(msg.payload);
  if (topic === topics.device) {
    const payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    const report = payload ? readLightReport(payload) : null;
    if (!payload || !report) {
      trace("report", "ignored", "no-state");
    } else {
      state.report = {...report, observedAt: now.toISOString()};
      for (const field of reportedFields(payload)) if (!state.fields.includes(field)) state.fields.push(field);
      readings.push(observedReading(state.report));
      trace("report", "read", null, {on: report.on});
    }
  } else if (topic === topics.set) {
    const payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    if (msg.retain === true) {
      trace("set", "ignored", "retained-message");
    } else if (payload) {
      const echo = checkCommandEcho(state.expected, payload, nowMs);
      state.expected = echo.queue;
      const requested = String(payload.state ?? "").toUpperCase();
      if (echo.changed) {
        readings.push({kind: "echo-changed", target, id: state.last?.id ?? null, state: requested});
        trace("set", "own", "mutated-own-command", {state: requested});
      } else if (echo.own) {
        trace("set", "own", "echo");
      } else {
        readings.push({kind: "external", target, state: requested, setsValues: setsLightValues(payload), observedAt: now.toISOString()});
        trace("set", "external", null, {state: requested});
      }
    }
  } else if (topic === topics.availability && !config.group) {
    const value = parsed && typeof parsed === "object" ? (parsed as {state?: unknown}).state : parsed;
    const online = String(value).toLowerCase() === "online";
    if (String(value).toLowerCase() === "online" || String(value).toLowerCase() === "offline") {
      state.online = online;
      readings.push({kind: "availability", target, online});
      trace("availability", online ? "online" : "offline");
    }
  } else if (topic !== "") {
    trace("message", "ignored", "other-topic", {topic});
  }
  return {state, publications, readings, traces, ignored: false};

  function observedReading(report: DeviceReport): LightReading {
    const brightness = Number(report.brightness);
    const colorTemp = Number(report.color_temp);
    const last = state.last?.payload;
    const showsLast = last !== undefined && report.on === (last.state === "ON") && (last.state === "OFF" || sameValues(last, report));
    return {
      kind: "observed",
      target,
      on: report.on,
      ...(report.brightness !== null && Number.isFinite(brightness) ? {brightnessPct: brightness * 100 / 254} : {}),
      ...(report.color_temp !== null && Number.isFinite(colorTemp) && colorTemp > 0 ? {colorTempKelvin: 1_000_000 / colorTemp} : {}),
      fields: [...state.fields],
      showsLast,
      observedAt: report.observedAt
    };
  }
}
