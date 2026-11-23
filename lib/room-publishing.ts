"use strict";

// The room's MQTT and Home Assistant side, as the theatre state contract is
// for the theatre: it turns MQTT the room reads into room events, and the
// room controller's decisions into the retained topics other systems read.
// The room controller itself only decides about lights.

import type {TraceEntry} from "./bounded-trace";
import {DEFAULT_DISCOVERY_PREFIX} from "./ha-discovery";
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
  roomAvailabilityMessage,
  roomControlTopic,
  roomLightingDiscovery
} from "./room-lighting-discovery";
import {areaId} from "./topic-names";

type PublishSettings = {area: string; publishState?: boolean; discovery?: boolean};

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

// MQTT the room reads, as room events: the circadian switch's set topic,
// where Home Assistant sends ON or OFF. Read only while the room publishes,
// as the switch is only discovered then; a bare MQTT message, or one a flow
// tagged as observed, is accepted. Anything else passes through unchanged.
export function roomInbound(msg: RoomMessage, config: PublishSettings): {msg: RoomMessage; traces: TraceEntry[]} {
  const event = msg.lighting || {};
  if (!roomPublishesState(config) || msg.topic !== circadianCommandTopic(config.area) ||
    !(!event.kind || event.kind === "observed" || event.kind === "command-observed")) {
    return {msg, traces: []};
  }
  const requested = typeof msg.payload === "string" ? msg.payload.trim().toUpperCase() : "";
  if (msg.retain === true || event.retained === true) {
    return {
      msg: {...msg, lighting: {kind: "ignored"}},
      traces: [{event: "circadian-set", outcome: "ignored", reason: "retained-message", details: {}}]
    };
  }
  if (requested === "ON" || requested === "OFF") {
    return {msg: {...msg, lighting: {kind: "circadian", enabled: requested === "ON"}}, traces: []};
  }
  return {
    msg: {...msg, lighting: {kind: "ignored"}},
    traces: [{
      event: "circadian-set",
      outcome: "ignored",
      reason: "not-on-or-off",
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
  config: RoomConfig,
  now?: Date | string | number
) {
  const inbound = roomInbound(msg, config);
  const result = transitionRoom(saved, inbound.msg, config, now);
  const kind = inbound.msg.lighting?.kind;
  const publishes = roomPublishesState(config);
  const before: RoomOutput[] = [];
  if (kind === "startup") {
    if (areaId(config.area) !== "") {
      const discoveryConfig = {...config, discoveryPrefix: config.discoveryPrefix ?? DEFAULT_DISCOVERY_PREFIX};
      const entry = roomLightingDiscovery(discoveryConfig, result.state.circadianEnabled)[0]!;
      // Discovery switched off: an empty retained entry removes the switch
      // from Home Assistant.
      before.push(roomPublishesDiscovery(config) ? entry : {topic: entry.topic, payload: "", retain: true});
    }
    if (publishes) {
      before.push(roomAvailabilityMessage(config.area, true));
      before.push(circadianStateMessage(config.area, result.state.circadianEnabled));
    }
  } else if (kind === "circadian" && publishes) {
    before.push(circadianStateMessage(config.area, result.state.circadianEnabled));
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
