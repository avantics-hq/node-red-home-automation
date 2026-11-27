"use strict";

// The room controller's Home Assistant view: its availability, and a sensor
// for each light's control state (in-control, overridden or manual). Its
// circadian, sleep, wake and bed entities moved to the circadian lighting
// policy in 6.0 (circadian-publishing.ts).

import {DISCOVERY_ORIGIN, OFFLINE, ONLINE, discoveryDevice, discoveryEntity, type DiscoveryOwner} from "./ha-discovery";
import {homeTopic} from "./topic-names";

export interface DiscoveryMessage {
  topic: string;
  payload: unknown;
  retain: boolean;
}

// The one place a room topic is named: home/<area ID>/<name>.
export function roomTopic(area: string, name: string): string {
  return homeTopic(area, name);
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

export interface RoomDiscoveryConfig extends DiscoveryOwner {
  displayName: string;
}

function roomDevice(config: RoomDiscoveryConfig) {
  return {
    ...discoveryDevice(config, "lighting"),
    name: config.displayName + " Lighting Controller",
    manufacturer: "Node-RED",
    model: "Room lighting controller"
  };
}

// Each light's control state, as a sensor on the room's device.
export function roomDiscovery(config: RoomDiscoveryConfig, targetIds: string[]): DiscoveryMessage[] {
  return targetIds.map((id) => {
    const ids = discoveryEntity(config, "sensor", id + "_control");
    return {
      topic: ids.topic,
      payload: {
        name: config.displayName + " " + id + " control",
        unique_id: ids.uniqueId,
        default_entity_id: ids.defaultEntityId,
        icon: "mdi:account-lock-outline",
        state_topic: roomControlTopic(config.area, id),
        value_template: "{{ value_json.state }}",
        json_attributes_topic: roomControlTopic(config.area, id),
        json_attributes_template: "{{ {'owner': value_json.owner, 'available': value_json.available} | tojson }}",
        entity_category: "diagnostic",
        availability_topic: roomAvailabilityTopic(config.area),
        device: roomDevice(config),
        origin: DISCOVERY_ORIGIN
      },
      retain: true
    };
  });
}
