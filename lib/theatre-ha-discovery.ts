"use strict";

// The theatre's Home Assistant view: the topic names its state is published
// on, and the discovery entries that describe them. Home Assistant may send
// a request on the request topic, which the state contract acts on.

import {DISCOVERY_ORIGIN, areaId} from "./ha-discovery";
import {TARGETS, type TheatreTarget} from "./theatre-profiles";

export type TheatreTopicName =
  | "request"
  | "desired"
  | "current"
  | "phase"
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

export interface TheatreDiscoveryConfig {
  area: string;
  displayName: string;
  baseTopic: string;
  discoveryPrefix: string;
  activities: string[];
}

function device(config: TheatreDiscoveryConfig) {
  return {
    identifiers: [`nodered_${areaId(config.area)}_theatre`],
    name: `${config.displayName} Theatre Controller`,
    manufacturer: "Node-RED",
    model: "Deterministic theatre activity controller"
  };
}

export function theatreDiscovery(config: TheatreDiscoveryConfig): Array<{topic: string; payload: Record<string, unknown>}> {
  const {baseTopic, discoveryPrefix} = config;
  const area = areaId(config.area);
  const controllerDevice = device(config);
  const entries: Array<{component: string; objectId: string; payload: Record<string, unknown>}> = [
    {
      component: "select",
      objectId: `${area}_theatre_activity`,
      payload: {
        name: "Requested activity",
        unique_id: `${area}_theatre_activity`,
        default_entity_id: `select.${area}_theatre_activity`,
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
      objectId: `${area}_theatre_current`,
      payload: {
        name: "Current activity",
        unique_id: `${area}_theatre_current`,
        default_entity_id: `sensor.${area}_theatre_current`,
        icon: "mdi:play-circle-outline",
        state_topic: theatreTopic(baseTopic, "current"),
        device: controllerDevice
      }
    },
    {
      component: "sensor",
      objectId: `${area}_theatre_phase`,
      payload: {
        name: "Phase",
        unique_id: `${area}_theatre_phase`,
        default_entity_id: `sensor.${area}_theatre_phase`,
        icon: "mdi:state-machine",
        state_topic: theatreTopic(baseTopic, "phase"),
        device: controllerDevice
      }
    },
    {
      component: "sensor",
      objectId: `${area}_theatre_availability`,
      payload: {
        // Named "Readiness" so it isn't mistaken for Home Assistant's own
        // availability; its IDs are kept so the entity carries over.
        name: "Readiness",
        unique_id: `${area}_theatre_availability`,
        default_entity_id: `sensor.${area}_theatre_availability`,
        icon: "mdi:check-network-outline",
        state_topic: theatreTopic(baseTopic, "readiness"),
        entity_category: "diagnostic",
        device: controllerDevice
      }
    },
    {
      component: "sensor",
      objectId: `${area}_theatre_failure`,
      payload: {
        name: "Failure",
        unique_id: `${area}_theatre_failure`,
        default_entity_id: `sensor.${area}_theatre_failure`,
        icon: "mdi:alert-circle-outline",
        state_topic: theatreTopic(baseTopic, "failure"),
        value_template: "{{ value_json.reason if value_json else '' }}",
        entity_category: "diagnostic",
        device: controllerDevice
      }
    },
    {
      component: "sensor",
      objectId: `${area}_theatre_transition_metrics`,
      payload: {
        name: "Transition latency",
        unique_id: `${area}_theatre_transition_metrics`,
        default_entity_id: `sensor.${area}_theatre_transition_metrics`,
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
      objectId: `${area}_theatre_slo_status`,
      payload: {
        name: "Operational SLO",
        unique_id: `${area}_theatre_slo_status`,
        default_entity_id: `sensor.${area}_theatre_slo_status`,
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
      objectId: `${area}_theatre_slo_breach`,
      payload: {
        name: "Operational SLO breach",
        unique_id: `${area}_theatre_slo_breach`,
        default_entity_id: `binary_sensor.${area}_theatre_slo_breach`,
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
      objectId: `${area}_theatre_${target}_health`,
      payload: {
        name: `${target[0]?.toUpperCase()}${target.slice(1)} health`,
        unique_id: `${area}_theatre_${target}_health`,
        default_entity_id: `sensor.${area}_theatre_${target}_health`,
        icon: "mdi:heart-pulse",
        state_topic: theatreTopic(baseTopic, `health/${target}`),
        value_template: "{{ value_json.status }}",
        json_attributes_topic: theatreTopic(baseTopic, `health/${target}`),
        entity_category: "diagnostic",
        device: controllerDevice
      }
    });
  }
  return entries.map(({component, objectId, payload}) => ({
    topic: `${discoveryPrefix}/${component}/${objectId}/config`,
    payload: {...payload, availability_topic: theatreTopic(baseTopic, "availability"), origin: DISCOVERY_ORIGIN}
  }));
}
