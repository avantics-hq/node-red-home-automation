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

export interface MqttPublication {
  topic: string;
  payload: string;
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
  const component = `cover:${config.channel}`;
  return {
    command: `${config.topicPrefix}/command/${component}`,
    status: `${config.topicPrefix}/status/${component}`,
    events: `${config.topicPrefix}/events/rpc`,
    online: `${config.topicPrefix}/online`,
    component
  };
}

const MOTIONS: Record<string, CoverMotion> = {
  opening: "opening",
  closing: "closing",
  open: "stopped",
  closed: "stopped",
  stopped: "stopped"
};

// An MQTT in node may hand over a parsed object, a string or a Buffer.
function parsed(payload: unknown): unknown {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : payload;
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
  } else if (msg.topic === topics.status) {
    const status = parsed(msg.payload);
    if (!isObject(status)) throw new Error(`${topics.status} must carry the cover's status object`);
    state.status = {...status};
    state.complete = true;
    read(now.toISOString(), true);
  } else if (msg.topic === topics.events) {
    const received = parsed(msg.payload);
    const frame = isObject(received) && (received.method === "NotifyStatus" || received.method === "NotifyFullStatus") &&
      isObject(received.params) ? {method: received.method, params: received.params} : null;
    const change = frame?.params[topics.component];
    if (!frame || !isObject(change)) {
      trace("event", "ignored", "not-this-cover");
    } else {
      // A partial status: a key reported as null has gone.
      const status: Record<string, unknown> = frame.method === "NotifyFullStatus" ? {} : {...state.status};
      for (const [key, value] of Object.entries(change)) {
        if (value === null && key !== "current_pos") delete status[key];
        else status[key] = value;
      }
      state.status = status;
      if (frame.method === "NotifyFullStatus") state.complete = true;
      const ts = Number(frame.params.ts);
      const observedAt = Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : now.toISOString();
      // Only a change of position or movement is a new reading; a power or
      // temperature update mid-travel isn't.
      if (frame.method === "NotifyFullStatus" || Object.hasOwn(change, "current_pos") || Object.hasOwn(change, "state") ||
        Object.hasOwn(change, "pos_control")) {
        read(observedAt, false);
      }
    }
  } else if (msg.topic === topics.online) {
    const online = parsed(msg.payload);
    if (online !== true && online !== false) throw new Error(`${topics.online} must be true or false`);
    readings.push({cover: {kind: "availability", online}});
    trace("availability", online ? "online" : "offline");
    // Back online, its position may have changed while it was away.
    if (online) requestStatus("online");
  } else {
    trace("message", "ignored", "unrelated-message", {topic: typeof msg.topic === "string" ? msg.topic : null});
  }

  const status = state.status;
  const text = !status ? "waiting for the device"
    : status.pos_control === false || (state.complete && !Object.hasOwn(status, "current_pos")) ? "not calibrated"
      : `${typeof status.state === "string" ? status.state : "unknown"} · ${status.current_pos ?? "?"}%`;
  return {state, publications, readings, traces, status: {text, calibrated: Boolean(status) && status!.pos_control !== false && (!state.complete || Object.hasOwn(status!, "current_pos"))}};
}
