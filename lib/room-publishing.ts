"use strict";

// The room's MQTT and Home Assistant side, as the theatre state contract is
// for the theatre: it turns the room controller's decisions into the
// retained topics other systems read. The room controller itself only
// decides about lights. Its circadian, sleep, wake and bed entities and set
// topics moved to the circadian lighting policy in 6.0.

import {roomCircadianDiscoveryTopics} from "./circadian-publishing";
import {DEFAULT_DISCOVERY_PREFIX, type IdScheme} from "./ha-discovery";
import {
  transitionRoom,
  type RoomConfig,
  type RoomMessage,
  type RoomOutput,
  type RoomState
} from "./room-controller";
import {
  roomAvailabilityMessage,
  roomAvailabilityTopic,
  roomControlTopic,
  roomDiscovery,
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
  // Where Home Assistant listens for discovery. Absent means its default.
  discoveryPrefix?: string;
  // Publish each light's control state over MQTT, and its Home Assistant
  // discovery (which needs the state). Both are named after the area. Unset
  // means on, as before these settings existed.
  publishState?: boolean;
  discovery?: boolean;
}

type PublishingRoomConfig = RoomConfig & RoomPublishingConfig;

function targetIds(config: RoomConfig): string[] {
  return config.targets.map((target) => target.id);
}

function discoveryConfig(config: PublishingRoomConfig): RoomDiscoveryConfig {
  return {...config, discoveryPrefix: config.discoveryPrefix ?? DEFAULT_DISCOVERY_PREFIX};
}

// Every retained topic the room publishes, for clearing those it no longer
// does after a change. The discovery entries count whenever the room has an
// area, as they are published or cleared at each start.
export function roomRetainedTopics(config: PublishingRoomConfig): string[] {
  const topics = areaId(config.area) ? roomDiscovery(discoveryConfig(config), targetIds(config)).map(({topic}) => topic) : [];
  if (roomPublishesState(config)) {
    topics.push(roomAvailabilityTopic(config.area));
    topics.push(...config.targets.map((target) => roomControlTopic(config.area, target.id)));
  }
  return topics;
}

// The state topics of the circadian lighting policy, which a room published
// before 6.0 and may still have in its record of what it published. They are
// never the room's to clear now: a circadian node with the same area
// publishes them.
const CIRCADIAN_STATE = /^home\/[^/]+\/(?:circadian|sleep|wake-time|bed-time)\/state$/;

export function withoutCircadianState(recorded: readonly string[]): string[] {
  return recorded.filter((topic) => !CIRCADIAN_STATE.test(topic));
}

// Whether the room publishes its control states and availability under its
// area, and their discovery.
export function roomPublishesState(config: PublishSettings): boolean {
  return config.area !== "" && config.publishState !== false;
}

export function roomPublishesDiscovery(config: PublishSettings): boolean {
  return roomPublishesState(config) && config.discovery !== false;
}

// The circadian, sleep, wake and bed entities the room published before
// 6.0, cleared at every start: the circadian lighting policy publishes its
// own, and no 6.0 node publishes these, so clearing them is always safe.
function oldCircadianClears(config: PublishingRoomConfig): RoomOutput[] {
  // A room that publishes nothing cleared them itself before 6.0, when its
  // publishing was switched off.
  if (areaId(config.area) === "" || !roomPublishesState(config)) return [];
  const prefix = discoveryConfig(config).discoveryPrefix;
  return roomCircadianDiscoveryTopics({area: config.area, discoveryPrefix: prefix}, config.idScheme === "node" ? "node" : "area", config.nodeId)
    .map((topic) => ({topic, payload: "", retain: true}));
}

// Each light's control sensor, or with discovery switched off, empty
// retained entries that remove them.
function roomDiscoveryOutputs(config: PublishingRoomConfig): RoomOutput[] {
  if (areaId(config.area) === "") return [];
  return roomDiscovery(discoveryConfig(config), targetIds(config))
    .map((entry) => (roomPublishesDiscovery(config) ? entry : {topic: entry.topic, payload: "", retain: true}));
}

// What the room publishes as the flows start and as it stops: its old
// circadian entries cleared, then with discovery on, its entries, and when it
// publishes at all, its availability, so Home Assistant shows its entities as
// available only while it runs. Removing its entries when discovery is off
// waits for the startup message: under the area scheme, another room could
// publish them.
export function roomStartingOutputs(config: PublishingRoomConfig): RoomOutput[] {
  const entries = roomPublishesDiscovery(config) ? roomDiscoveryOutputs(config) : [];
  return [...oldCircadianClears(config), ...entries, ...(roomPublishesState(config) ? [roomAvailabilityMessage(config.area, true)] : [])];
}

// At the startup message: as at the flows start, and with discovery off,
// its entries removed.
function roomStartupOutputs(config: PublishingRoomConfig): RoomOutput[] {
  return [...oldCircadianClears(config), ...roomDiscoveryOutputs(config), ...(roomPublishesState(config) ? [roomAvailabilityMessage(config.area, true)] : [])];
}

export function roomStoppingOutputs(config: PublishSettings): RoomOutput[] {
  return roomPublishesState(config) ? [roomAvailabilityMessage(config.area, false)] : [];
}

// A light's retained control state: in-control, overridden or manual.
function controlMessage(config: RoomConfig, state: RoomState, targetId: string): RoomOutput {
  const entry = state.control[targetId];
  const available = state.available[targetId];
  return {
    topic: roomControlTopic(config.area, targetId),
    // Its availability once its adapter has reported it: shown, never acted on.
    payload: {state: entry?.state ?? "in-control", owner: entry?.state === "overridden" ? entry.owner : null,
      ...(available !== undefined ? {available} : {})},
    retain: true
  };
}

// The room's transition with its MQTT side. At startup, the discovery
// entries (or their removal) and availability come first and every light's
// control state last; any light whose control state changed has it
// published after the commands.
export function publishRoom(
  saved: Partial<RoomState> | undefined,
  msg: RoomMessage,
  config: PublishingRoomConfig,
  now?: Date | string | number
) {
  const result = transitionRoom(saved, msg, config, now);
  const kind = msg.lighting?.kind;
  const publishes = roomPublishesState(config);
  const before: RoomOutput[] = kind === "startup" ? roomStartupOutputs(config) : [];
  const controls = publishes
    ? config.targets
      .filter((target) => kind === "startup" || result.controlChanged.includes(target.id))
      .map((target) => controlMessage(config, result.state, target.id))
    : [];
  return {
    ...result,
    outputs: [...before, ...result.outputs, ...controls]
  };
}
