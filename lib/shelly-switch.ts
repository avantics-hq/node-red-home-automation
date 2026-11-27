"use strict";

// One switch channel of a Shelly Gen2+ relay, over the device's own MQTT
// API, used the way the device is set up. No broker connection here: device
// messages arrive from an MQTT in node, and publications leave for an MQTT
// out node.
//
// The node reads the device's own configuration for its channel (the
// switch's in_mode and its input's type) at startup and whenever the device
// comes online:
// - detached: the relay stays on, powering smart bulbs, and the wall
//   switch's presses are reported. They go to the switch lighting policy:
//   a switch-type input's on/off states as edges, a button-type input's
//   pushes as actions. The relay is never commanded.
// - any other mode (follow, flip, momentary and so on): the relay is the
//   light. Its on/off state is reported, and on/off commands are sent.
// The node's Mode setting overrides what was read, and decides when the
// configuration can't be read.
//
// From Shelly's Gen2 API documentation (RPC channels, Mqtt, Shelly, Switch,
// Input and Notifications; see also shelly-gen2.ts):
// - an RPC request is {id, src, method, params} on <prefix>/rpc, and its
//   response goes to <src>/rpc, whatever src is; this node's src lies under
//   the device's prefix, so the reply reaches the same MQTT in node;
// - Shelly.GetConfig returns every component's configuration: "switch:<n>"
//   has in_mode (momentary, follow, flip, detached, cycle, activate), and
//   "input:<n>" has type (switch, button, analog, count);
// - "status_update" on <prefix>/command makes the device publish its whole
//   status on <prefix>/status, holding "switch:<n>" (output, source) and
//   "input:<n>" (state, null for a button);
// - a button-type input's pushes arrive as NotifyEvent frames on
//   <prefix>/events/rpc: single_push, double_push, triple_push, long_push,
//   btn_down and btn_up; a switch-type input's state changes as
//   NotifyStatus for "input:<n>".

import type {TraceEntry} from "./bounded-trace";
import {isObject, parsedPayload, type MqttPublication} from "./mqtt-message";
import {readShellyMessage, shellyTopics} from "./shelly-gen2";

export const SHELLY_SWITCH_MODES = ["auto", "detached", "relay"] as const;
export type ShellySwitchMode = typeof SHELLY_SWITCH_MODES[number];

// How long to wait for the device's configuration before taking it as
// unreadable.
export const CONFIG_TIMEOUT_MS = 10_000;

export interface ShellySwitchConfig {
  // The device's MQTT topic prefix: its device ID unless one is set on the device.
  topicPrefix: string;
  // The switch's ID on the device: 0, or 1 and up on a device with more.
  channel: number;
  // auto: as the device is configured; detached or relay: as set here.
  mode: ShellySwitchMode;
}

export interface DeviceSetup {
  inMode: string;
  inputType: string;
  inputId: number;
}

export interface ShellySwitchState {
  // What the device's configuration says, once read.
  setup: DeviceSetup | null;
  // "reading" while a request is out, "read", or "unreadable".
  setupStatus: "reading" | "read" | "unreadable";
  // When the outstanding configuration request was sent (ms), and its id.
  requestedAt: number | null;
  requestId: number;
  online: boolean;
  // The relay's last reported output, and whether an input is known on.
  relayOn: boolean | null;
  inputState: boolean | null;
}

export interface ShellySwitchMessage {
  topic?: unknown;
  payload?: unknown;
  // From the node: at startup, and a tick to check on a request.
  shellySwitch?: {kind?: unknown};
  // A relay-mode command: {power: "on" | "off"}.
  switchCommand?: {power?: unknown};
}

// What goes to the switch lighting policy (detached), as its messages take
// them, or the relay's state (relay mode).
export type SwitchReading =
  | {source: "switch"; payload: {state: boolean}; baseline?: true; observedAt: string}
  | {source: "switch-action"; payload: {action: "single" | "double" | "long"}; observedAt: string}
  | {source: "switch-availability"; payload: "online" | "offline"}
  | {switchState: {kind: "observed"; on: boolean; person: boolean; observedAt: string}}
  | {switchState: {kind: "availability"; online: boolean}};

const ACTIONS: Record<string, "single" | "double" | "long"> = {single_push: "single", double_push: "double", long_push: "long"};

// Settings may be editor strings. The prefix names the user's own device,
// so it has no default.
export function normaliseShellySwitchConfig(config: {topicPrefix?: unknown; channel?: unknown; mode?: unknown}): ShellySwitchConfig {
  const topicPrefix = String(config.topicPrefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!topicPrefix) throw new Error("the device's MQTT topic prefix is required");
  if (/[+#]/.test(topicPrefix)) throw new Error("the MQTT topic prefix can't contain + or #");
  const channel = config.channel === undefined || config.channel === "" ? 0 : Number(config.channel);
  if (!Number.isInteger(channel) || channel < 0) throw new Error("the switch ID must be a whole number from 0");
  const mode = config.mode === undefined || config.mode === "" ? "auto" : String(config.mode);
  if (!(SHELLY_SWITCH_MODES as readonly string[]).includes(mode)) throw new Error("mode must be auto, detached or relay");
  return {topicPrefix, channel, mode: mode as ShellySwitchMode};
}

export function shellySwitchTopics(config: ShellySwitchConfig) {
  const component = shellyTopics(config.topicPrefix, `switch:${config.channel}`);
  // This node's RPC source: under the device's prefix, so the reply on
  // <src>/rpc arrives through the same MQTT in node; one per channel.
  const source = `${config.topicPrefix}/home-automation-switch-${config.channel}`;
  return {
    ...component,
    rpc: `${config.topicPrefix}/rpc`,
    reply: `${source}/rpc`,
    source,
    deviceCommand: `${config.topicPrefix}/command`,
    deviceStatus: `${config.topicPrefix}/status`
  };
}

// The mode the node works in: the setting, or with auto, the device's.
export function effectiveMode(config: ShellySwitchConfig, state: Pick<ShellySwitchState, "setup">): "detached" | "relay" | null {
  if (config.mode !== "auto") return config.mode;
  if (!state.setup) return null;
  return state.setup.inMode === "detached" ? "detached" : "relay";
}

export function transitionShellySwitch(
  saved: Partial<ShellySwitchState> | undefined,
  msg: ShellySwitchMessage,
  config: ShellySwitchConfig,
  now: Date
) {
  const state: ShellySwitchState = {
    setup: isObject(saved?.setup) ? {...saved.setup} as DeviceSetup : null,
    setupStatus: saved?.setupStatus === "read" || saved?.setupStatus === "unreadable" ? saved.setupStatus : "reading",
    requestedAt: Number.isFinite(saved?.requestedAt) ? saved!.requestedAt! : null,
    requestId: Number.isInteger(saved?.requestId) ? saved!.requestId! : 0,
    online: saved?.online !== false,
    relayOn: typeof saved?.relayOn === "boolean" ? saved.relayOn : null,
    inputState: typeof saved?.inputState === "boolean" ? saved.inputState : null
  };
  const topics = shellySwitchTopics(config);
  const nowMs = now.getTime();
  const observedAt = now.toISOString();
  const publications: MqttPublication[] = [];
  const readings: SwitchReading[] = [];
  const traces: TraceEntry[] = [];
  const trace = (event: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) => {
    traces.push({event, outcome, reason, details});
  };
  const mode = () => effectiveMode(config, state);

  // Asks for the device's configuration and its whole status (the baseline).
  function readDevice(reason: string) {
    state.requestId += 1;
    state.requestedAt = nowMs;
    if (state.setupStatus !== "read") state.setupStatus = "reading";
    publications.push({topic: topics.rpc, payload: JSON.stringify({id: state.requestId, src: topics.source, method: "Shelly.GetConfig"})});
    publications.push({topic: topics.deviceCommand, payload: "status_update"});
    trace("device", "reading", reason);
  }

  // The input's on/off state, to the switch policy in detached mode.
  function inputState(value: unknown, baseline: boolean) {
    if (typeof value !== "boolean") return;
    state.inputState = value;
    if (mode() === "detached" && state.setup?.inputType !== "button") {
      readings.push({source: "switch", payload: {state: value}, ...(baseline ? {baseline: true as const} : {}), observedAt});
    }
  }

  // The relay's output: in relay mode the light's state; in detached mode a
  // check that the bulbs still have power.
  function relayOutput(status: Record<string, unknown>) {
    if (typeof status.output !== "boolean") return;
    state.relayOn = status.output;
    if (mode() === "relay") {
      // The device names the source of the last change: its own input is a person at the switch.
      const person = status.source === "button" || status.source === "switch" || status.source === "input";
      readings.push({switchState: {kind: "observed", on: status.output, person, observedAt}});
    } else if (mode() === "detached" && !status.output) {
      trace("relay", "off", "bulbs-unpowered");
    }
  }

  const inputKey = () => `input:${state.setup?.inputId ?? config.channel}`;

  const command = msg.switchCommand;
  const own = msg.shellySwitch;
  if (isObject(own) && own.kind === "startup") {
    readDevice("startup");
  } else if (isObject(own) && own.kind === "tick") {
    if (state.setupStatus === "reading" && state.requestedAt !== null && nowMs - state.requestedAt >= CONFIG_TIMEOUT_MS) {
      state.setupStatus = state.setup ? "read" : "unreadable";
      trace("device", state.setup ? "kept" : "unreadable", "no-reply");
    }
  } else if (isObject(command)) {
    if (mode() !== "relay") {
      // Detached, the relay powers the bulbs: never switched from here.
      trace("command", "refused", mode() === "detached" ? "detached" : "mode-unknown", {power: String(command.power)});
    } else if (command.power !== "on" && command.power !== "off") {
      trace("command", "ignored", "invalid-power", {power: String(command.power)});
    } else if (!state.online) {
      trace("command", "refused", "offline", {power: command.power});
    } else {
      publications.push({topic: topics.command, payload: command.power});
      trace("command", "sent", null, {power: command.power});
    }
  } else if (msg.topic === topics.reply) {
    const frame = parsedPayload(msg.payload);
    if (!isObject(frame) || frame.id !== state.requestId) {
      trace("device", "ignored", "not-our-request");
    } else {
      const result = isObject(frame.result) ? frame.result : null;
      const switchConfig = result && isObject(result[`switch:${config.channel}`]) ? result[`switch:${config.channel}`] as Record<string, unknown> : null;
      const inputId = switchConfig && Number.isInteger(switchConfig.input_id) ? switchConfig.input_id as number : config.channel;
      const inputConfig = result && isObject(result[`input:${inputId}`]) ? result[`input:${inputId}`] as Record<string, unknown> : null;
      if (switchConfig && typeof switchConfig.in_mode === "string" && inputConfig && typeof inputConfig.type === "string") {
        state.setup = {inMode: switchConfig.in_mode, inputType: inputConfig.type, inputId};
        state.setupStatus = "read";
        trace("device", "read", null, {...state.setup});
        // The status may have come first: what it said, now the mode is known.
        if (state.inputState !== null) inputState(state.inputState, true);
        if (state.relayOn !== null && mode() === "relay") {
          readings.push({switchState: {kind: "observed", on: state.relayOn, person: false, observedAt}});
        }
      } else {
        state.setupStatus = state.setup ? "read" : "unreadable";
        trace("device", "unreadable", isObject(frame.error) ? "error-reply" : "no-switch-config");
      }
      state.requestedAt = null;
    }
  } else if (msg.topic === topics.deviceStatus) {
    // The whole device status: the baseline for both the input and the relay.
    const status = parsedPayload(msg.payload);
    if (!isObject(status)) throw new Error(`${topics.deviceStatus} must carry the device's status object`);
    const relay = status[topics.component];
    const input = status[inputKey()];
    if (isObject(relay)) relayOutput(relay);
    if (isObject(input)) inputState(input.state, true);
  } else if (msg.topic === topics.events) {
    const frame = parsedPayload(msg.payload);
    const params = isObject(frame) && isObject(frame.params) ? frame.params : null;
    if (isObject(frame) && frame.method === "NotifyEvent" && params && Array.isArray(params.events)) {
      for (const event of params.events) {
        if (!isObject(event) || event.component !== inputKey()) continue;
        const action = typeof event.event === "string" ? ACTIONS[event.event] : undefined;
        if (action && mode() === "detached") readings.push({source: "switch-action", payload: {action}, observedAt});
        trace("input", action ? "action" : "ignored", action ? null : "unmapped-event", {event: String(event.event)});
      }
    } else if (isObject(frame) && frame.method === "NotifyStatus" && params) {
      const relay = params[topics.component];
      const input = params[inputKey()];
      if (isObject(relay) && Object.hasOwn(relay, "output")) relayOutput(relay);
      if (isObject(input) && Object.hasOwn(input, "state")) inputState(input.state, false);
    }
  } else {
    const message = readShellyMessage(msg, topics, null);
    if (message.kind === "status") {
      relayOutput(message.status);
    } else if (message.kind === "online") {
      state.online = message.online;
      trace("availability", message.online ? "online" : "offline");
      if (mode() === "detached") readings.push({source: "switch-availability", payload: message.online ? "online" : "offline"});
      if (mode() === "relay") readings.push({switchState: {kind: "availability", online: message.online}});
      // Back online: read its configuration again, and a fresh baseline.
      if (message.online) readDevice("online");
    } else if (msg.topic !== topics.rpc && msg.topic !== topics.command && msg.topic !== topics.deviceCommand) {
      trace("message", "ignored", "unrelated-message", {topic: typeof msg.topic === "string" ? msg.topic : null});
    }
  }

  return {state, publications, readings, traces, status: shellySwitchStatus(config, state)};
}

// What the node's status shows: the mode found, and anything to act on.
export function shellySwitchStatus(config: ShellySwitchConfig, state: ShellySwitchState): {text: string; fill: "green" | "yellow" | "red" | "grey"} {
  if (!state.online) return {text: "offline", fill: "grey"};
  const setup = state.setup ? `${state.setup.inMode}, ${state.setup.inputType} input` : null;
  const mode = effectiveMode(config, state);
  if (!mode) {
    return state.setupStatus === "reading"
      ? {text: "reading the device's configuration", fill: "grey"}
      : {text: "configuration unreadable: set Mode", fill: "red"};
  }
  const found = config.mode === "auto" ? setup : `${mode} (set)${setup ? `, device ${setup}` : ""}`;
  if (mode === "detached" && state.relayOn === false) return {text: `${found} · relay off: bulbs unpowered`, fill: "yellow"};
  const now = mode === "relay" && state.relayOn !== null ? ` · ${state.relayOn ? "on" : "off"}` : "";
  return {text: `${found ?? mode}${now}`, fill: "green"};
}
