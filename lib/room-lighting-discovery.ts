"use strict";

// The room controller's Home Assistant view: a discovery entry for its
// circadian switch and the retained state that entry reads. Home Assistant
// may send ON/OFF on the command topic, which the room controller acts on.

import {DISCOVERY_ORIGIN, OFFLINE, ONLINE, areaId} from "./ha-discovery";

export interface DiscoveryMessage {
  topic: string;
  payload: unknown;
  retain: boolean;
}

export function circadianStateTopic(area: string): string {
  return "home/" + areaId(area) + "/circadian/state";
}

export function circadianCommandTopic(area: string): string {
  return "home/" + areaId(area) + "/circadian/set";
}

// The room's own availability, online or offline, for Home Assistant.
export function roomAvailabilityTopic(area: string): string {
  return "home/" + areaId(area) + "/lighting/availability";
}

export function roomAvailabilityMessage(area: string, online: boolean): DiscoveryMessage {
  return {topic: roomAvailabilityTopic(area), payload: online ? ONLINE : OFFLINE, retain: true};
}

// The retained circadian state, as Home Assistant reads it.
export function circadianStateMessage(area: string, enabled: boolean): DiscoveryMessage {
  return {topic: circadianStateTopic(area), payload: enabled ? "ON" : "OFF", retain: true};
}

export interface RoomDiscoveryConfig {
  area: string;
  displayName: string;
  discoveryPrefix: string;
}

// The discovery entry for the room's circadian switch, then its state.
export function roomLightingDiscovery(config: RoomDiscoveryConfig, circadianEnabled: boolean): DiscoveryMessage[] {
  const {area, displayName} = config;
  const objectId = areaId(area) + "_circadian_lighting";
  return [
    {
      topic: config.discoveryPrefix + "/switch/" + objectId + "/config",
      payload: {
        name: displayName + " Circadian Lighting",
        unique_id: objectId,
        default_entity_id: "switch." + objectId,
        icon: "mdi:clock-time-seven-outline",
        command_topic: circadianCommandTopic(area),
        state_topic: circadianStateTopic(area),
        availability_topic: roomAvailabilityTopic(area),
        payload_on: "ON",
        payload_off: "OFF",
        optimistic: false,
        device: {
          identifiers: ["nodered_" + areaId(area) + "_lighting"],
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
