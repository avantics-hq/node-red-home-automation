"use strict";

// A Shelly switch channel's relay as a room light, on the neutral light
// contract (light-contract.ts): the room's commands become the relay's MQTT
// control commands, on or off only, and the relay's reports become the
// room's readings. shelly-switch.ts reads the device and calls this for a
// node with a Target; the device's own topics and messages stay there and in
// shelly-gen2.ts.
//
// From Shelly's Gen2 API documentation (Mqtt): <prefix>/command/switch:<n>
// takes "on", "off" or "toggle", and "status_update" makes the device publish
// the switch's status on <prefix>/status/switch:<n>.

import type {TraceEntry} from "./bounded-trace";
import {checkCommandEcho, checkStateReport, rememberCommand, type ExpectedCommand} from "./command-echo";
import type {LightReading} from "./light-contract";
import type {MqttPublication} from "./mqtt-message";

export interface RelayLightState {
  // The relay commands it sent lately: to know their echoes on the command
  // topic, and which report confirms them.
  expected: ExpectedCommand[];
  // The power it last sent, for showsLast.
  lastOn: boolean | null;
  // When the relay last reported, for a skipped restyle's answer.
  reportedAt: string | null;
  // Someone else's command it last reported as external, so the relay's
  // report of that change isn't reported again.
  externalOn: boolean | null;
}

export function createRelayLightState(saved: Partial<RelayLightState> | undefined): RelayLightState {
  return {
    expected: Array.isArray(saved?.expected) ? saved!.expected.map((entry) => ({...entry})) : [],
    lastOn: typeof saved?.lastOn === "boolean" ? saved.lastOn : null,
    reportedAt: typeof saved?.reportedAt === "string" ? saved.reportedAt : null,
    externalOn: typeof saved?.externalOn === "boolean" ? saved.externalOn : null
  };
}

// The relay command as remembered and matched: the room's power, as the echo
// queue reads it.
const asCommand = (on: boolean) => ({state: on ? "ON" : "OFF"});

export interface RelayLightStep {
  publications: MqttPublication[];
  readings: LightReading[];
  traces: TraceEntry[];
}

const step = (): RelayLightStep => ({publications: [], readings: [], traces: []});

// A room message for this light: a command switches the relay; an observe
// asks it to report. Brightness, colour and the rest don't apply to a relay
// and are left out (the room's target should be marked onOffOnly).
export function relayLightFromRoom(
  state: RelayLightState,
  light: {kind?: unknown; state?: unknown; restyle?: unknown; id?: unknown},
  target: string,
  commandTopic: string,
  relayOn: boolean | null,
  nowMs: number
): RelayLightStep {
  const out = step();
  if (light.kind === "observe") {
    out.publications.push({topic: commandTopic, payload: "status_update"});
    out.traces.push({event: "observe", outcome: "sent", reason: null, details: {}});
    return out;
  }
  const on = light.state === "ON";
  if (light.state !== "ON" && light.state !== "OFF") {
    out.traces.push({event: "command", outcome: "ignored", reason: "not-on-or-off", details: {state: String(light.state)}});
    return out;
  }
  if (light.restyle === true) {
    // A relay has no style: a restyle of a light already on changes nothing.
    if (relayOn === true) {
      out.readings.push({kind: "skipped", target, id: String(light.id), observedAt: state.reportedAt ?? new Date(nowMs).toISOString()});
      out.traces.push({event: "command", outcome: "skipped", reason: "relay-has-no-style", details: {id: light.id}});
      return out;
    }
    out.readings.push({kind: "sent", target, id: String(light.id)});
  }
  state.expected = rememberCommand(state.expected, asCommand(on), nowMs);
  state.lastOn = on;
  out.publications.push({topic: commandTopic, payload: on ? "on" : "off"});
  out.traces.push({event: "command", outcome: "sent", reason: null, details: {id: light.id, power: on ? "on" : "off"}});
  return out;
}

// A command seen on the relay's command topic: its own echo, or someone
// else's (another flow, the device's own app over MQTT), which the room may
// take as a person's change.
export function relayLightCommandSeen(state: RelayLightState, payload: unknown, target: string, nowMs: number): RelayLightStep {
  const out = step();
  const text = typeof payload === "string" ? payload.trim().toLowerCase() : "";
  if (text !== "on" && text !== "off" && text !== "toggle") return out;
  if (text !== "toggle") {
    const echo = checkCommandEcho(state.expected, asCommand(text === "on"), nowMs);
    state.expected = echo.queue;
    if (echo.own) {
      out.traces.push({event: "command", outcome: "own", reason: "echo", details: {power: text}});
      return out;
    }
    state.externalOn = text === "on";
  }
  out.readings.push({kind: "external", target, state: text.toUpperCase(), setsValues: false, observedAt: new Date(nowMs).toISOString()});
  out.traces.push({event: "command", outcome: "external", reason: null, details: {power: text}});
  return out;
}

// The relay's output as it reports it: the room's reading, and a change it
// didn't cause (a person at a switch the relay follows, another flow) as
// someone else's, unless already reported from their command.
export function relayLightReport(state: RelayLightState, on: boolean, previous: boolean | null, target: string, nowMs: number): RelayLightStep {
  const out = step();
  const observedAt = new Date(nowMs).toISOString();
  const report = checkStateReport(state.expected, on, nowMs);
  state.expected = report.queue;
  state.reportedAt = observedAt;
  const changed = previous !== null && previous !== on;
  if (changed && report.verdict === "external" && state.externalOn !== on) {
    out.readings.push({kind: "external", target, state: on ? "ON" : "OFF", setsValues: false, observedAt});
    out.traces.push({event: "relay", outcome: "external", reason: null, details: {on}});
  }
  state.externalOn = null;
  out.readings.push({kind: "observed", target, on, fields: [], showsLast: state.lastOn === on, observedAt});
  return out;
}
