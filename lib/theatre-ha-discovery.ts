"use strict";

// The theatre's Home Assistant view: the topic names its state is published
// on, and the discovery entries that describe them. Home Assistant may send
// a request on the request topic, which the state contract acts on.

import {DISCOVERY_ORIGIN, discoveryDevice, discoveryEntity, type DiscoveryOwner} from "./ha-discovery";
import {TARGETS, type TheatreTarget} from "./theatre-profiles";

export type TheatreTopicName =
  | "request"
  | "desired"
  | "current"
  | "phase"
  // When the latest transition started and finished, and which targets it
  // left degraded.
  | "transition"
  // The node's own availability, online or offline, for Home Assistant.
  | "availability"
  // The theatre's readiness: unknown, available, degraded or unavailable.
  | "readiness"
  | "failure"
  | "metrics"
  | "slo"
  | "slo/breach"
  | `health/${TheatreTarget}`;

// The one place a theatre topic is named, for discovery and state alike.
export function theatreTopic(baseTopic: string, name: TheatreTopicName): string {
  return `${baseTopic}/${name}`;
}

export interface TheatreDiscoveryConfig extends DiscoveryOwner {
  displayName: string;
  baseTopic: string;
  activities: string[];
}

function device(config: TheatreDiscoveryConfig) {
  return {
    ...discoveryDevice(config, "theatre"),
    name: `${config.displayName} Theatre Controller`,
    manufacturer: "Node-RED",
    model: "Deterministic theatre activity controller"
  };
}

function theatreEntries(config: TheatreDiscoveryConfig) {
  const {baseTopic} = config;
  const controllerDevice = device(config);
  const entries: Array<{component: string; entity: string; payload: Record<string, unknown>}> = [
    {
      component: "select",
      entity: `theatre_activity`,
      payload: {
        name: "Requested activity",
        icon: "mdi:theater",
        command_topic: theatreTopic(baseTopic, "request"),
        state_topic: theatreTopic(baseTopic, "desired"),
        value_template: "{{ value_json.activity if value_json else none }}",
        command_template: "{\"requestId\":\"ha-{{ now().strftime('%Y%m%d%H%M%S%f') }}\",\"activity\":\"{{ value }}\"}",
        options: config.activities,
        optimistic: false,
        device: controllerDevice
      }
    },
    {
      component: "sensor",
      entity: `theatre_current`,
      payload: {
        name: "Current activity",
        icon: "mdi:play-circle-outline",
        state_topic: theatreTopic(baseTopic, "current"),
        device: controllerDevice
      }
    },
    {
      component: "sensor",
      entity: `theatre_phase`,
      payload: {
        name: "Phase",
        icon: "mdi:state-machine",
        state_topic: theatreTopic(baseTopic, "phase"),
        json_attributes_topic: theatreTopic(baseTopic, "transition"),
        device: controllerDevice
      }
    },
    {
      component: "sensor",
      entity: `theatre_availability`,
      payload: {
        // Named "Readiness" so it isn't mistaken for Home Assistant's own
        // availability; it keeps its entity name, so its entity ID carries over.
        name: "Readiness",
        icon: "mdi:check-network-outline",
        state_topic: theatreTopic(baseTopic, "readiness"),
        entity_category: "diagnostic",
        device: controllerDevice
      }
    },
    {
      component: "sensor",
      entity: `theatre_failure`,
      payload: {
        name: "Failure",
        icon: "mdi:alert-circle-outline",
        state_topic: theatreTopic(baseTopic, "failure"),
        value_template: "{{ value_json.reason if value_json else '' }}",
        entity_category: "diagnostic",
        device: controllerDevice
      }
    },
    {
      component: "sensor",
      entity: `theatre_transition_metrics`,
      payload: {
        name: "Transition latency",
        icon: "mdi:timer-check-outline",
        state_topic: theatreTopic(baseTopic, "metrics"),
        value_template: "{{ value_json.lastTransitionMs if value_json.lastTransitionMs is not none else 'unknown' }}",
        json_attributes_topic: theatreTopic(baseTopic, "metrics"),
        unit_of_measurement: "ms",
        entity_category: "diagnostic",
        device: controllerDevice
      }
    },
    {
      component: "sensor",
      entity: `theatre_slo_status`,
      payload: {
        name: "Operational SLO",
        icon: "mdi:target-account",
        state_topic: theatreTopic(baseTopic, "slo"),
        value_template: "{{ value_json.status }}",
        json_attributes_topic: theatreTopic(baseTopic, "slo"),
        entity_category: "diagnostic",
        device: controllerDevice
      }
    },
    {
      component: "binary_sensor",
      entity: `theatre_slo_breach`,
      payload: {
        name: "Operational SLO breach",
        icon: "mdi:alert-decagram-outline",
        state_topic: theatreTopic(baseTopic, "slo/breach"),
        payload_on: "ON",
        payload_off: "OFF",
        device_class: "problem",
        entity_category: "diagnostic",
        device: controllerDevice
      }
    }
  ];
  for (const target of TARGETS) {
    entries.push({
      component: "sensor",
      entity: `theatre_${target}_health`,
      payload: {
        name: `${target[0]?.toUpperCase()}${target.slice(1)} health`,
        icon: "mdi:heart-pulse",
        state_topic: theatreTopic(baseTopic, `health/${target}`),
        value_template: "{{ value_json.status }}",
        json_attributes_topic: theatreTopic(baseTopic, `health/${target}`),
        entity_category: "diagnostic",
        device: controllerDevice
      }
    });
  }
  return entries;
}

export function theatreDiscovery(config: TheatreDiscoveryConfig): Array<{topic: string; payload: Record<string, unknown>}> {
  return theatreEntries(config).map(({component, entity, payload}) => {
    const ids = discoveryEntity(config, component, entity);
    // The IDs follow the name, as they always have, so an area-scheme entry
    // is the same, byte for byte, as before the schemes existed.
    const {name, ...rest} = payload;
    return {
      topic: ids.topic,
      payload: {
        name,
        unique_id: ids.uniqueId,
        default_entity_id: ids.defaultEntityId,
        ...rest,
        availability_topic: theatreTopic(config.baseTopic, "availability"),
        origin: DISCOVERY_ORIGIN
      }
    };
  });
}
