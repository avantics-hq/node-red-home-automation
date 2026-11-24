"use strict";

// The room controller's Home Assistant view: a discovery entry for its
// circadian switch and the retained state that entry reads. Home Assistant
// may send ON/OFF on the command topic, which the room controller acts on.

import {DISCOVERY_ORIGIN, OFFLINE, ONLINE, discoveryDevice, discoveryEntity, type DiscoveryOwner} from "./ha-discovery";
import {areaId} from "./topic-names";
import type {DaySchedule} from "./circadian-schedule";

export interface DiscoveryMessage {
  topic: string;
  payload: unknown;
  retain: boolean;
}

// The one place a room topic is named: home/<area ID>/<name>.
export function roomTopic(area: string, name: string): string {
  return "home/" + areaId(area) + "/" + name;
}

export function circadianStateTopic(area: string): string {
  return roomTopic(area, "circadian/state");
}

export function circadianCommandTopic(area: string): string {
  return roomTopic(area, "circadian/set");
}

// The room's own availability, online or offline, for Home Assistant.
export function roomAvailabilityTopic(area: string): string {
  return roomTopic(area, "lighting/availability");
}

export function roomAvailabilityMessage(area: string, online: boolean): DiscoveryMessage {
  return {topic: roomAvailabilityTopic(area), payload: online ? ONLINE : OFFLINE, retain: true};
}

// A light's control state: in-control, overridden or manual.
export function roomControlTopic(area: string, targetId: string): string {
  return roomTopic(area, "lighting/" + targetId + "/control");
}

// Sleep, and the wake and bed times, each with a state topic and a set
// topic Home Assistant commands.
export function sleepStateTopic(area: string): string {
  return roomTopic(area, "sleep/state");
}

export function sleepCommandTopic(area: string): string {
  return roomTopic(area, "sleep/set");
}

export type ScheduleTime = "wake-time" | "bed-time";

export function scheduleStateTopic(area: string, time: ScheduleTime): string {
  return roomTopic(area, time + "/state");
}

export function scheduleCommandTopic(area: string, time: ScheduleTime): string {
  return roomTopic(area, time + "/set");
}

export function sleepStateMessage(area: string, sleeping: boolean): DiscoveryMessage {
  return {topic: sleepStateTopic(area), payload: sleeping ? "ON" : "OFF", retain: true};
}

// The times in use, "HH:MM:SS" as Home Assistant's time entity reads them.
export function scheduleStateMessages(area: string, schedule: DaySchedule): DiscoveryMessage[] {
  return [
    {topic: scheduleStateTopic(area, "wake-time"), payload: schedule.wakeTime + ":00", retain: true},
    {topic: scheduleStateTopic(area, "bed-time"), payload: schedule.bedTime + ":00", retain: true}
  ];
}

// The retained circadian state, as Home Assistant reads it.
export function circadianStateMessage(area: string, enabled: boolean): DiscoveryMessage {
  return {topic: circadianStateTopic(area), payload: enabled ? "ON" : "OFF", retain: true};
}

export interface RoomDiscoveryConfig extends DiscoveryOwner {
  displayName: string;
  // "house": the room follows a house schedule, so it has no time entities
  // of its own.
  timesFrom?: "room" | "house";
}

const CIRCADIAN_ENTITY = "circadian_lighting";

function roomDevice(config: RoomDiscoveryConfig) {
  return {
    ...discoveryDevice(config, "lighting"),
    name: config.displayName + " Lighting Controller",
    manufacturer: "Node-RED",
    model: "Composable circadian lighting"
  };
}

// One more entity on the room's device, with the IDs, availability and
// origin every room entity carries.
function roomEntity(config: RoomDiscoveryConfig, component: string, entity: string, name: string, fields: Record<string, unknown>): DiscoveryMessage {
  const ids = discoveryEntity(config, component, entity);
  return {
    topic: ids.topic,
    payload: {
      name: config.displayName + " " + name,
      unique_id: ids.uniqueId,
      default_entity_id: ids.defaultEntityId,
      ...fields,
      availability_topic: roomAvailabilityTopic(config.area),
      device: roomDevice(config),
      origin: DISCOVERY_ORIGIN
    },
    retain: true
  };
}

// Every discovery entry the room publishes: its circadian switch, a sleep
// switch, its wake and bed times, and each light's control state.
function roomTimeEntities(config: RoomDiscoveryConfig): DiscoveryMessage[] {
  const time = (which: ScheduleTime, entity: string, name: string, icon: string) => roomEntity(config, "time", entity, name, {
    icon,
    command_topic: scheduleCommandTopic(config.area, which),
    state_topic: scheduleStateTopic(config.area, which),
    entity_category: "config"
  });
  return [
    time("wake-time", "wake_time", "Wake time", "mdi:weather-sunset-up"),
    time("bed-time", "bed_time", "Bed time", "mdi:weather-night")
  ];
}

// The discovery topics of the room's own wake and bed time entities.
export function roomTimeDiscoveryTopics(config: RoomDiscoveryConfig): string[] {
  return roomTimeEntities(config).map(({topic}) => topic);
}

export function roomDiscovery(config: RoomDiscoveryConfig, targetIds: string[]): DiscoveryMessage[] {
  const {area} = config;
  return [
    roomLightingDiscovery(config, false)[0]!,
    roomEntity(config, "switch", "sleep", "Sleep", {
      icon: "mdi:sleep",
      command_topic: sleepCommandTopic(area),
      state_topic: sleepStateTopic(area),
      payload_on: "ON",
      payload_off: "OFF",
      optimistic: false
    }),
    ...(config.timesFrom === "house" ? [] : roomTimeEntities(config)),
    ...targetIds.map((id) => roomEntity(config, "sensor", id + "_control", id + " control", {
      icon: "mdi:account-lock-outline",
      state_topic: roomControlTopic(area, id),
      value_template: "{{ value_json.state }}",
      json_attributes_topic: roomControlTopic(area, id),
      json_attributes_template: "{{ {'owner': value_json.owner} | tojson }}",
      entity_category: "diagnostic"
    }))
  ];
}

// The discovery entry for the room's circadian switch, then its state.
export function roomLightingDiscovery(config: RoomDiscoveryConfig, circadianEnabled: boolean): DiscoveryMessage[] {
  const {area, displayName} = config;
  const ids = discoveryEntity(config, "switch", CIRCADIAN_ENTITY);
  return [
    {
      topic: ids.topic,
      payload: {
        name: displayName + " Circadian Lighting",
        unique_id: ids.uniqueId,
        default_entity_id: ids.defaultEntityId,
        icon: "mdi:clock-time-seven-outline",
        command_topic: circadianCommandTopic(area),
        state_topic: circadianStateTopic(area),
        availability_topic: roomAvailabilityTopic(area),
        payload_on: "ON",
        payload_off: "OFF",
        optimistic: false,
        device: roomDevice(config),
        origin: DISCOVERY_ORIGIN
      },
      retain: true
    },
    circadianStateMessage(area, circadianEnabled)
  ];
}
