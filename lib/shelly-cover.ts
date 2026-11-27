"use strict";

// A Shelly Gen2+ device in cover mode, over its own MQTT API, as the cover
// controller's device: the controller's neutral commands become the
// device's MQTT control commands, and what the device publishes becomes
// neutral cover readings. No broker connection here: device messages arrive
// from an MQTT in node, and publications leave for an MQTT out node.
//
// From Shelly's Gen2 API documentation (Mqtt, Cover and Notifications):
// - commands are text on <prefix>/command/cover:<id>: "pos,<0-100>",
//   "stop", and "status_update", which makes the device publish its full
//   cover status on <prefix>/status/cover:<id>;
// - status changes arrive as NotifyStatus frames on <prefix>/events/rpc,
//   holding only what changed, to be laid over the last full status;
// - <prefix>/online is true once connected, and false (the broker's last
//   will) when it drops;
// - current_pos runs 0 (closed) to 100 (open), as the controller's does. It
//   is absent while the cover isn't calibrated (pos_control false) and null
//   when its position is unknown.

import type {TraceEntry} from "./bounded-trace";
import type {CoverCommand, CoverEvent, CoverMotion} from "./cover-controller";
import {isObject, type MqttPublication} from "./mqtt-message";
import {readShellyMessage, shellyTopics} from "./shelly-gen2";

export type {MqttPublication} from "./mqtt-message";

export interface ShellyCoverConfig {
  // The device's MQTT topic prefix: its device ID unless one is set on the device.
  topicPrefix: string;
  // The cover's ID on the device: 0, or 1 on a device with two covers.
  channel: number;
}

export interface ShellyCoverState {
  // The device's last full cover status, with each change laid over it.
  status: Record<string, unknown> | null;
  // Whether a full status underlies it: a change alone can't say a cover
  // isn't calibrated, only that a key didn't change.
  complete: boolean;
  // The controller's last command, so a cover that can't report a position
  // fails it rather than leaving it to time out.
  command: {operation: string; generation: number} | null;
}

export interface ShellyCoverMessage {
  topic?: unknown;
  payload?: unknown;
  cover_command?: CoverCommand;
}

// Settings may be editor strings. The prefix names the user's own device,
// so it has no default.
export function normaliseShellyCoverConfig(config: {topicPrefix?: unknown; channel?: unknown}): ShellyCoverConfig {
  const topicPrefix = String(config.topicPrefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!topicPrefix) throw new Error("the device's MQTT topic prefix is required");
  if (/[+#]/.test(topicPrefix)) throw new Error("the MQTT topic prefix can't contain + or #");
  const channel = config.channel === undefined || config.channel === "" ? 0 : Number(config.channel);
  if (!Number.isInteger(channel) || channel < 0) throw new Error("the cover ID must be a whole number from 0");
  return {topicPrefix, channel};
}

export function shellyCoverTopics(config: ShellyCoverConfig) {
  return shellyTopics(config.topicPrefix, `cover:${config.channel}`);
}

const MOTIONS: Record<string, CoverMotion> = {
  opening: "opening",
  closing: "closing",
  open: "stopped",
  closed: "stopped",
  stopped: "stopped"
};

export function transitionShellyCover(
  saved: Partial<ShellyCoverState> | undefined,
  msg: ShellyCoverMessage,
  config: ShellyCoverConfig,
  now: Date
) {
  const state: ShellyCoverState = {
    status: isObject(saved?.status) ? {...saved.status} : null,
    complete: saved?.complete === true && isObject(saved?.status),
    command: saved?.command && Number.isInteger(saved.command.generation) ? {...saved.command} : null
  };
  const topics = shellyCoverTopics(config);
  const publications: MqttPublication[] = [];
  const readings: Array<{cover: CoverEvent}> = [];
  const traces: TraceEntry[] = [];
  const trace = (event: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) => {
    traces.push({event, outcome, reason, details});
  };

  // Asks the device for its full cover status.
  function requestStatus(reason: string) {
    publications.push({topic: topics.command, payload: "status_update"});
    trace("status", "requested", reason);
  }

  // What the status says: a position reading, or why there is none.
  function read(observedAt: string, reply: boolean) {
    const status = state.status ?? {};
    if (status.state === "calibrating") {
      trace("status", "ignored", "calibrating");
      return;
    }
    if (status.pos_control !== false && !Object.hasOwn(status, "current_pos") && !state.complete) {
      // Only changes so far, none of them the position: ask for the rest.
      return requestStatus("no-full-status");
    }
    const reason = status.pos_control === false || !Object.hasOwn(status, "current_pos") ? "not-calibrated"
      : typeof status.current_pos !== "number" || !Number.isFinite(status.current_pos) ? "position-unknown"
        : null;
    if (reason) {
      // Never a made-up position: the command in hand fails with the reason,
      // which the controller retries and then reports.
      trace("status", "no-position", reason);
      if (state.command) {
        readings.push({cover: {kind: "command_result", generation: state.command.generation, ok: false, reason}});
        state.command = null;
      }
      return;
    }
    const motion = typeof status.state === "string" ? MOTIONS[status.state] : undefined;
    readings.push({cover: {
      kind: "observed",
      position: Math.max(0, Math.min(100, status.current_pos as number)),
      ...(motion ? {motion} : {}),
      observedAt
    }});
    trace("status", reply ? "read" : "changed", null, {position: status.current_pos, state: status.state ?? null});
  }

  const command = msg.cover_command;
  if (isObject(command)) {
    const operation = String(command.operation);
    const generation = Number(command.generation);
    if (operation === "set_position") {
      const position = Number(command.position);
      if (!Number.isFinite(position)) throw new Error("set_position needs a position");
      state.command = {operation, generation};
      if (state.status && (state.status.pos_control === false || (state.complete && !Object.hasOwn(state.status, "current_pos")))) {
        // The device refuses a position on an uncalibrated cover, so say so
        // now rather than send it.
        readings.push({cover: {kind: "command_result", generation, ok: false, reason: "not-calibrated"}});
        state.command = null;
        trace("command", "refused", "not-calibrated", {position});
      } else {
        publications.push({topic: topics.command, payload: `pos,${Math.round(Math.max(0, Math.min(100, position)))}`});
        trace("command", "sent", null, {operation, position});
      }
    } else if (operation === "stop" || operation === "observe") {
      state.command = {operation, generation};
      // observe asks for the device's full status, so the reading is fresh.
      publications.push({topic: topics.command, payload: operation === "stop" ? "stop" : "status_update"});
      trace("command", "sent", null, {operation});
    } else {
      trace("command", "ignored", "unknown-operation", {operation});
    }
  } else {
    const message = readShellyMessage(msg, topics, state.status, ["current_pos"]);
    if (message.kind === "status") {
      state.status = message.status;
      state.complete = true;
      read(now.toISOString(), true);
    } else if (message.kind === "change") {
      state.status = message.status;
      // Stamped when received, as a status reply is, never with the
      // device's own ts: a Shelly whose clock is behind (no time server, a
      // drifting clock) would have every change dropped as older than the
      // last reading. MQTT's delay is far below what the controller resolves.
      // Only a change of position or movement is a new reading; a power or
      // temperature update mid-travel isn't.
      const {change} = message;
      if (Object.hasOwn(change, "current_pos") || Object.hasOwn(change, "state") || Object.hasOwn(change, "pos_control")) {
        read(now.toISOString(), false);
      }
    } else if (message.kind === "online") {
      readings.push({cover: {kind: "availability", online: message.online}});
      trace("availability", message.online ? "online" : "offline");
      // Back online, its position may have changed while it was away.
      if (message.online) requestStatus("online");
    } else if (msg.topic === topics.events) {
      trace("event", "ignored", "not-this-cover");
    } else {
      trace("message", "ignored", "unrelated-message", {topic: typeof msg.topic === "string" ? msg.topic : null});
    }
  }

  const status = state.status;
  const text = !status ? "waiting for the device"
    : status.pos_control === false || (state.complete && !Object.hasOwn(status, "current_pos")) ? "not calibrated"
      : `${typeof status.state === "string" ? status.state : "unknown"} · ${status.current_pos ?? "?"}%`;
  return {state, publications, readings, traces, status: {text, calibrated: Boolean(status) && status!.pos_control !== false && (!state.complete || Object.hasOwn(status!, "current_pos"))}};
}
