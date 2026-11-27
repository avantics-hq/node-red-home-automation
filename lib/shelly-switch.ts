"use strict";

// A Shelly Gen2+ relay or plug (its Switch component) over its own MQTT
// API, for two consumers: the backlighting controller, which switches it,
// and the display controller, which reads the projector's power from its
// meter. One channel can serve either or both. No broker connection here:
// device messages arrive from an MQTT in node, and publications leave for
// an MQTT out node.
//
// From Shelly's Gen2 API documentation (Switch and Mqtt; see shelly-gen2.ts
// for the topics and notifications shared with the cover adapter):
// - MQTT control commands on <prefix>/command/switch:<id>: "on", "off"
//   and "status_update";
// - the status has output (true when on) and, on devices with power
//   metering, apower: the load's power in watts.

import type {TraceEntry} from "./bounded-trace";
import type {BacklightingPower} from "./backlighting-controller";
import {isObject, type MqttPublication} from "./mqtt-message";
import {readShellyMessage, shellyTopics} from "./shelly-gen2";

export interface ShellySwitchConfig {
  // The device's MQTT topic prefix: its device ID unless one is set on the device.
  topicPrefix: string;
  // The switch's ID on the device: 0, or 1 and up on a device with more.
  channel: number;
}

export interface ShellySwitchState {
  // The device's last full switch status, with each change laid over it.
  status: Record<string, unknown> | null;
  online: boolean;
  // The generation of the backlighting controller's last command: its
  // readings must carry it.
  backlightingGeneration: number | null;
}

export interface ShellySwitchMessage {
  topic?: unknown;
  payload?: unknown;
  backlightingCommand?: {operation?: unknown; power?: unknown; generation?: unknown};
  display_command?: {device?: unknown; operation?: unknown; generation?: unknown};
}

export type BacklightingReading =
  | {kind: "observed"; generation: number; power: BacklightingPower; observedAt: string}
  | {kind: "command_result"; generation: number; ok: false; reason: string};

export type ProjectorReading =
  | {kind: "observed"; device: "projector"; watts: number; source: "switch"; observedAt: string}
  | {kind: "transport_failed"; device: "projector"; operation: string; generation?: number; reason: string};

// Settings may be editor strings. The prefix names the user's own device,
// so it has no default.
export function normaliseShellySwitchConfig(config: {topicPrefix?: unknown; channel?: unknown}): ShellySwitchConfig {
  const topicPrefix = String(config.topicPrefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!topicPrefix) throw new Error("the device's MQTT topic prefix is required");
  if (/[+#]/.test(topicPrefix)) throw new Error("the MQTT topic prefix can't contain + or #");
  const channel = config.channel === undefined || config.channel === "" ? 0 : Number(config.channel);
  if (!Number.isInteger(channel) || channel < 0) throw new Error("the switch ID must be a whole number from 0");
  return {topicPrefix, channel};
}

export function shellySwitchTopics(config: ShellySwitchConfig) {
  return shellyTopics(config.topicPrefix, `switch:${config.channel}`);
}

export function transitionShellySwitch(
  saved: Partial<ShellySwitchState> | undefined,
  msg: ShellySwitchMessage,
  config: ShellySwitchConfig,
  now: Date
) {
  const state: ShellySwitchState = {
    status: isObject(saved?.status) ? {...saved.status} : null,
    online: saved?.online !== false,
    backlightingGeneration: Number.isInteger(saved?.backlightingGeneration) ? saved!.backlightingGeneration! : null
  };
  const topics = shellySwitchTopics(config);
  const publications: MqttPublication[] = [];
  const backlighting: Array<{backlighting: BacklightingReading}> = [];
  const display: Array<{display: ProjectorReading}> = [];
  const traces: TraceEntry[] = [];
  const trace = (event: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) => {
    traces.push({event, outcome, reason, details});
  };
  const send = (payload: string) => publications.push({topic: topics.command, payload});

  // What a status says, to whichever consumer it concerns: the relay's
  // output to the backlighting controller (once it has sent a command, as
  // its readings carry the command's generation), and the meter's power to
  // the display. Stamped when received: the device's clock may be off.
  function read(keys: readonly string[] | null) {
    const status = state.status ?? {};
    const observedAt = now.toISOString();
    if ((keys === null || keys.includes("output")) && typeof status.output === "boolean") {
      if (state.backlightingGeneration !== null) {
        backlighting.push({backlighting: {kind: "observed", generation: state.backlightingGeneration, power: status.output ? "on" : "off", observedAt}});
      }
      trace("status", "output", null, {output: status.output});
    }
    if ((keys === null || keys.includes("apower")) && typeof status.apower === "number" && Number.isFinite(status.apower)) {
      display.push({display: {kind: "observed", device: "projector", watts: Math.max(0, status.apower), source: "switch", observedAt}});
      trace("status", "power", null, {watts: status.apower});
    }
  }

  const backlightingCommand = msg.backlightingCommand;
  const displayCommand = msg.display_command;
  if (isObject(backlightingCommand)) {
    const operation = String(backlightingCommand.operation);
    const generation = Number(backlightingCommand.generation);
    if (!Number.isInteger(generation)) throw new Error("a backlighting command needs its generation");
    state.backlightingGeneration = generation;
    if (!state.online) {
      // An offline device can't take it: say so now rather than at the
      // controller's timeout.
      backlighting.push({backlighting: {kind: "command_result", generation, ok: false, reason: "offline"}});
      trace("command", "refused", "offline", {operation});
    } else if (operation === "set_power" && (backlightingCommand.power === "on" || backlightingCommand.power === "off")) {
      send(backlightingCommand.power);
      trace("command", "sent", null, {operation, power: backlightingCommand.power});
    } else if (operation === "observe") {
      // A fresh reading: the device publishes its full switch status.
      send("status_update");
      trace("command", "sent", null, {operation});
    } else {
      trace("command", "ignored", "unknown-operation", {operation});
    }
  } else if (isObject(displayCommand)) {
    // The display's request for the projector's power (its third output).
    if (displayCommand.device !== "projector" || displayCommand.operation !== "query_power") {
      trace("command", "ignored", "not-a-power-query", {device: String(displayCommand.device), operation: String(displayCommand.operation)});
    } else if (!state.online) {
      const generation = Number(displayCommand.generation);
      display.push({display: {kind: "transport_failed", device: "projector", operation: "query_power",
        ...(Number.isInteger(generation) ? {generation} : {}), reason: "offline"}});
      trace("command", "refused", "offline", {operation: "query_power"});
    } else {
      send("status_update");
      trace("command", "sent", null, {operation: "query_power"});
    }
  } else {
    const message = readShellyMessage(msg, topics, state.status);
    if (message.kind === "status") {
      state.status = message.status;
      read(null);
    } else if (message.kind === "change") {
      state.status = message.status;
      read(Object.keys(message.change));
    } else if (message.kind === "online") {
      state.online = message.online;
      trace("availability", message.online ? "online" : "offline");
      // Back online, it may have changed while it was away.
      if (message.online) {
        send("status_update");
        trace("status", "requested", "online");
      }
    } else {
      trace("message", "ignored", "unrelated-message", {topic: typeof msg.topic === "string" ? msg.topic : null});
    }
  }

  const status = state.status;
  const text = !state.online ? "offline"
    : !status ? "waiting for the device"
      : [typeof status.output === "boolean" ? (status.output ? "on" : "off") : null,
        typeof status.apower === "number" ? `${status.apower} W` : null].filter(Boolean).join(" · ") || "no switch state";
  return {state, publications, backlighting, display, traces, status: {text, online: state.online}};
}
