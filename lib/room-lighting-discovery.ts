"use strict";

// The room controller's Home Assistant view: a discovery entry for its
// circadian switch and the retained state that entry reads. Home Assistant
// may send ON/OFF on the command topic, which the room controller acts on.

import {DISCOVERY_ORIGIN, OFFLINE, ONLINE, discoveryDevice, discoveryEntity, type DiscoveryOwner} from "./ha-discovery";
import {areaId} from "./topic-names";

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

// The retained circadian state, as Home Assistant reads it.
export function circadianStateMessage(area: string, enabled: boolean): DiscoveryMessage {
  return {topic: circadianStateTopic(area), payload: enabled ? "ON" : "OFF", retain: true};
}

export interface RoomDiscoveryConfig extends DiscoveryOwner {
  displayName: string;
}

const CIRCADIAN_ENTITY = "circadian_lighting";

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
        device: {
          ...discoveryDevice(config, "lighting"),
          name: displayName + " Lighting Controller",
          manufacturer: "Node-RED",
          model: "Composable circadian lighting"
        },
        origin: DISCOVERY_ORIGIN
      },
      retain: true
    },
    circadianStateMessage(area, circadianEnabled)
  ];
}
