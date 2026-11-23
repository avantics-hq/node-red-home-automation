"use strict";

// The room's MQTT and Home Assistant side, as the theatre state contract is
// for the theatre: it turns MQTT the room reads into room events, and the
// room controller's decisions into the retained topics other systems read.
// The room controller itself only decides about lights.

import type {TraceEntry} from "./bounded-trace";
import {clockMinutes} from "./circadian-schedule";
import {DEFAULT_DISCOVERY_PREFIX, type IdScheme} from "./ha-discovery";
import {
  transitionRoom,
  type RoomConfig,
  type RoomMessage,
  type RoomOutput,
  type RoomState
} from "./room-controller";
import {
  circadianCommandTopic,
  circadianStateMessage,
  circadianStateTopic,
  roomAvailabilityMessage,
  roomAvailabilityTopic,
  roomControlTopic,
  roomDiscovery,
  scheduleCommandTopic,
  scheduleStateMessages,
  scheduleStateTopic,
  sleepCommandTopic,
  sleepStateMessage,
  sleepStateTopic,
  type RoomDiscoveryConfig
} from "./room-lighting-discovery";
import {areaId} from "./topic-names";

type PublishSettings = {area: string; publishState?: boolean; discovery?: boolean};

// What the room's publishing needs beyond the controller's own settings: the
// Node-RED node it runs in and how it names its Home Assistant device and
// entity. Absent means the area scheme every room used before node IDs.
export interface RoomPublishingConfig {
  nodeId?: string;
  idScheme?: IdScheme;
}

type PublishingRoomConfig = RoomConfig & RoomPublishingConfig;

function targetIds(config: RoomConfig): string[] {
  return config.targets.map((target) => target.id);
}

function discoveryConfig(config: PublishingRoomConfig): RoomDiscoveryConfig {
  return {...config, discoveryPrefix: config.discoveryPrefix ?? DEFAULT_DISCOVERY_PREFIX};
}

// Every retained topic the room publishes, for clearing those it no longer
// does after a change. The discovery entry counts whenever the room has an
// area, as it is published or cleared at each start.
export function roomRetainedTopics(config: PublishingRoomConfig): string[] {
  const topics = areaId(config.area) ? roomDiscovery(discoveryConfig(config), targetIds(config)).map(({topic}) => topic) : [];
  if (roomPublishesState(config)) {
    topics.push(roomAvailabilityTopic(config.area), circadianStateTopic(config.area), sleepStateTopic(config.area));
    topics.push(scheduleStateTopic(config.area, "wake-time"), scheduleStateTopic(config.area, "bed-time"));
    topics.push(...config.targets.map((target) => roomControlTopic(config.area, target.id)));
  }
  return topics;
}

// Whether the room publishes state under its area, and its circadian
// switch's discovery, which reads that state.
export function roomPublishesState(config: PublishSettings): boolean {
  return config.area !== "" && config.publishState !== false;
}

export function roomPublishesDiscovery(config: PublishSettings): boolean {
  return roomPublishesState(config) && config.discovery !== false;
}

// What the room publishes as it starts and as it stops, when it publishes at
// all, so Home Assistant shows its entities as available only while it runs.
export function roomStartingOutputs(config: PublishSettings): RoomOutput[] {
  return roomPublishesState(config) ? [roomAvailabilityMessage(config.area, true)] : [];
}

export function roomStoppingOutputs(config: PublishSettings): RoomOutput[] {
  return roomPublishesState(config) ? [roomAvailabilityMessage(config.area, false)] : [];
}

// A time from Home Assistant's time entity ("HH:MM:SS", in ISO format), or
// "HH:MM", as the room's "HH:MM"; null if it isn't one.
function clockTime(payload: unknown): string | null {
  const match = typeof payload === "string" ? /^(\d{2}:\d{2})(?::[0-5]\d(?:\.\d+)?)?$/.exec(payload.trim()) : null;
  return match && clockMinutes(match[1]) !== null ? match[1]! : null;
}

function onOff(payload: unknown): boolean | null {
  const requested = typeof payload === "string" ? payload.trim().toUpperCase() : "";
  return requested === "ON" ? true : requested === "OFF" ? false : null;
}

// The set topics the room reads, what each payload means as a room event,
// and the trace reason when it means nothing.
function setTopics(area: string) {
  return [
    {name: "circadian-set", topic: circadianCommandTopic(area), invalid: "not-on-or-off",
      event: (payload: unknown) => {
        const enabled = onOff(payload);
        return enabled === null ? null : {kind: "circadian", enabled};
      }},
    {name: "sleep-set", topic: sleepCommandTopic(area), invalid: "not-on-or-off",
      event: (payload: unknown) => {
        const enabled = onOff(payload);
        return enabled === null ? null : {kind: "sleep", enabled};
      }},
    {name: "wake-time-set", topic: scheduleCommandTopic(area, "wake-time"), invalid: "not-a-time",
      event: (payload: unknown) => {
        const wakeTime = clockTime(payload);
        return wakeTime === null ? null : {kind: "schedule", wakeTime};
      }},
    {name: "bed-time-set", topic: scheduleCommandTopic(area, "bed-time"), invalid: "not-a-time",
      event: (payload: unknown) => {
        const bedTime = clockTime(payload);
        return bedTime === null ? null : {kind: "schedule", bedTime};
      }}
  ];
}

// MQTT the room reads, as room events: the set topics of its Home Assistant
// entities (circadian lighting and sleep, ON or OFF; wake and bed times).
// Read only while the room publishes, as the entities are only discovered
// then; a bare MQTT message, or one a flow tagged as observed, is accepted.
// Anything else passes through unchanged.
export function roomInbound(msg: RoomMessage, config: PublishSettings): {msg: RoomMessage; traces: TraceEntry[]} {
  const event = msg.lighting || {};
  const set = roomPublishesState(config) && (!event.kind || event.kind === "observed" || event.kind === "command-observed")
    ? setTopics(config.area).find(({topic}) => topic === msg.topic)
    : undefined;
  if (!set) return {msg, traces: []};
  if (msg.retain === true || event.retained === true) {
    return {
      msg: {...msg, lighting: {kind: "ignored"}},
      traces: [{event: set.name, outcome: "ignored", reason: "retained-message", details: {}}]
    };
  }
  const mapped = set.event(msg.payload);
  if (mapped) return {msg: {...msg, lighting: mapped}, traces: []};
  return {
    msg: {...msg, lighting: {kind: "ignored"}},
    traces: [{
      event: set.name,
      outcome: "ignored",
      reason: set.invalid,
      details: {payload: typeof msg.payload === "string" ? msg.payload : null}
    }]
  };
}

// A light's retained control state: in-control, overridden or manual.
function controlMessage(config: RoomConfig, state: RoomState, targetId: string): RoomOutput {
  const entry = state.control[targetId];
  return {
    topic: roomControlTopic(config.area, targetId),
    payload: {state: entry?.state ?? "in-control", owner: entry?.state === "overridden" ? entry.owner : null},
    retain: true
  };
}

// The room's transition with its MQTT side: incoming MQTT becomes room
// events, and the controller's decisions are published. At startup, the
// discovery entry (or its removal), availability and circadian state come
// first and every light's control state last; a circadian change publishes
// the circadian state before the lights are restyled; any light whose control
// state changed has it published after the commands.
export function publishRoom(
  saved: Partial<RoomState> | undefined,
  msg: RoomMessage,
  config: PublishingRoomConfig,
  now?: Date | string | number
) {
  const inbound = roomInbound(msg, config);
  const result = transitionRoom(saved, inbound.msg, config, now);
  const kind = inbound.msg.lighting?.kind;
  const publishes = roomPublishesState(config);
  const before: RoomOutput[] = [];
  if (kind === "startup") {
    if (areaId(config.area) !== "") {
      // Discovery switched off: empty retained entries remove the entities
      // from Home Assistant.
      for (const entry of roomDiscovery(discoveryConfig(config), targetIds(config))) {
        before.push(roomPublishesDiscovery(config) ? entry : {topic: entry.topic, payload: "", retain: true});
      }
    }
    if (publishes) {
      before.push(roomAvailabilityMessage(config.area, true));
      before.push(circadianStateMessage(config.area, result.state.circadianEnabled));
      before.push(sleepStateMessage(config.area, result.state.sleeping));
      before.push(...scheduleStateMessages(config.area, result.state.schedule));
    }
  } else if (kind === "circadian" && publishes) {
    before.push(circadianStateMessage(config.area, result.state.circadianEnabled));
  } else if (kind === "sleep" && publishes) {
    before.push(sleepStateMessage(config.area, result.state.sleeping));
  } else if (kind === "schedule" && publishes) {
    before.push(...scheduleStateMessages(config.area, result.state.schedule));
  }
  const controls = publishes
    ? config.targets
      .filter((target) => kind === "startup" || result.controlChanged.includes(target.id))
      .map((target) => controlMessage(config, result.state, target.id))
    : [];
  return {
    ...result,
    outputs: [...before, ...result.outputs, ...controls],
    traces: [...inbound.traces, ...result.traces]
  };
}
