"use strict";

import {TARGETS, type TheatreMetrics, type TheatreTarget} from "./theatre-activity-controller";

const NAME = /^[a-z][a-z0-9_-]*$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface TheatreStateContractConfig {
  area: string;
  displayName: string;
  baseTopic: string;
  discoveryPrefix: string;
  activities: string[];
}

export interface ContractRequest {
  requestId: string;
  generation: number;
  activity: string;
  requestedAt: string;
}

export interface TheatreStateContractState {
  generation: number;
  lastRequest: ContractRequest | null;
}

export interface TheatreStateSnapshot {
  kind: "state";
  area: string;
  requestId: string | null;
  generation: number;
  desiredActivity: string | null;
  requestedAt: string | null;
  currentActivity: string;
  phase: string;
  availability: string;
  transitionStartedAt: string | null;
  transitionCompletedAt: string | null;
  targets: Partial<Record<TheatreTarget, Record<string, unknown> | null>>;
  failure: Record<string, unknown> | null;
  degraded: Array<Record<string, unknown>>;
  metrics?: TheatreMetrics;
}

export interface TheatreStateContractMessage {
  topic?: string;
  payload?: unknown;
  retain?: boolean;
  theatre?: TheatreStateSnapshot | Record<string, unknown>;
  theatreStateContract?: {kind: "startup"};
}

export interface ContractPublication {
  topic: string;
  payload: string;
  retain: true;
}

export interface ContractRequestOutput {
  theatre: {
    kind: "intent";
    requestId: string;
    generation: number;
    activity: string;
    requestedAt: string;
  };
}

export function normaliseStateContractConfig(
  config: Partial<TheatreStateContractConfig> = {}
): TheatreStateContractConfig {
  const area = String(config.area || "").trim();
  if (!NAME.test(area)) throw new Error("area must be a lowercase identifier");
  const displayName = String(config.displayName || "").trim();
  if (!displayName) throw new Error("displayName is required");
  const baseTopic = String(config.baseTopic || `home/${area}/theatre`).replace(/^\/+|\/+$/g, "");
  const discoveryPrefix = String(config.discoveryPrefix || "homeassistant").replace(/^\/+|\/+$/g, "");
  if (!baseTopic || /[+#]/.test(baseTopic)) throw new Error("baseTopic must be a concrete MQTT topic");
  if (!discoveryPrefix || /[+#]/.test(discoveryPrefix)) {
    throw new Error("discoveryPrefix must be a concrete MQTT topic prefix");
  }
  if (!Array.isArray(config.activities) || config.activities.length === 0) {
    throw new Error("activities must be a non-empty array");
  }
  const activities = config.activities.map((activity) => String(activity));
  if (activities.some((activity) => !NAME.test(activity))) {
    throw new Error("activities must contain lowercase identifiers");
  }
  if (new Set(activities).size !== activities.length) throw new Error("activities must be unique");
  return {area, displayName, baseTopic, discoveryPrefix, activities};
}

function createState(saved: Partial<TheatreStateContractState> = {}): TheatreStateContractState {
  const lastRequest = saved.lastRequest && typeof saved.lastRequest === "object"
    ? {...saved.lastRequest}
    : null;
  return {
    generation: Number.isInteger(saved.generation) && (saved.generation ?? -1) >= 0
      ? saved.generation!
      : 0,
    lastRequest
  };
}

function parsePayload(payload: unknown): Record<string, unknown> {
  let value = payload;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new Error("theatre request payload must be valid JSON");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("theatre request payload must be an object");
  }
  return value as Record<string, unknown>;
}

function validTimestamp(value: unknown, fallback: string): string {
  const timestamp = value === undefined ? fallback : String(value);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("requestedAt must be an ISO timestamp");
  return timestamp;
}

function publication(topic: string, payload: unknown): ContractPublication {
  return {
    topic,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    retain: true
  };
}

function device(config: TheatreStateContractConfig) {
  return {
    identifiers: [`nodered_${config.area}_theatre`],
    name: `${config.displayName} Theatre Controller`,
    manufacturer: "Node-RED",
    model: "Deterministic theatre activity controller"
  };
}

function discoveryPublications(config: TheatreStateContractConfig): ContractPublication[] {
  const {area, baseTopic, discoveryPrefix} = config;
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
        command_topic: `${baseTopic}/request`,
        state_topic: `${baseTopic}/desired`,
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
        state_topic: `${baseTopic}/current`,
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
        state_topic: `${baseTopic}/phase`,
        device: controllerDevice
      }
    },
    {
      component: "sensor",
      objectId: `${area}_theatre_availability`,
      payload: {
        name: "Availability",
        unique_id: `${area}_theatre_availability`,
        default_entity_id: `sensor.${area}_theatre_availability`,
        icon: "mdi:check-network-outline",
        state_topic: `${baseTopic}/availability`,
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
        state_topic: `${baseTopic}/failure`,
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
        state_topic: `${baseTopic}/metrics`,
        value_template: "{{ value_json.lastTransitionMs if value_json.lastTransitionMs is not none else 'unknown' }}",
        json_attributes_topic: `${baseTopic}/metrics`,
        unit_of_measurement: "ms",
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
        state_topic: `${baseTopic}/health/${target}`,
        value_template: "{{ value_json.status }}",
        json_attributes_topic: `${baseTopic}/health/${target}`,
        entity_category: "diagnostic",
        device: controllerDevice
      }
    });
  }
  return entries.map(({component, objectId, payload}) => publication(
    `${discoveryPrefix}/${component}/${objectId}/config`,
    payload
  ));
}

function statePublications(
  event: TheatreStateSnapshot,
  config: TheatreStateContractConfig
): ContractPublication[] {
  const base = config.baseTopic;
  const desired = event.requestId && event.desiredActivity
    ? {
      requestId: event.requestId,
      generation: event.generation,
      activity: event.desiredActivity,
      requestedAt: event.requestedAt
    }
    : null;
  const outputs = [
    publication(`${base}/desired`, desired),
    publication(`${base}/current`, event.currentActivity),
    publication(`${base}/phase`, event.phase),
    publication(`${base}/failure`, event.failure),
    publication(`${base}/availability`, event.availability),
    publication(`${base}/metrics`, event.metrics || {
      requests: 0,
      ready: 0,
      failed: 0,
      superseded: 0,
      manualOverrides: 0,
      driftEvents: 0,
      recoveriesAdopted: 0,
      recoveriesSafeOff: 0,
      lastTransitionMs: null,
      maxTransitionMs: null,
      lastOutcome: null,
      targets: {}
    })
  ];
  for (const target of TARGETS) {
    const health = event.targets[target];
    outputs.push(publication(`${base}/health/${target}`, health || {
      status: "unknown",
      observedAt: null,
      classification: null,
      failure: null,
      details: null
    }));
  }
  return outputs;
}

function requestPublications(
  request: ContractRequest,
  config: TheatreStateContractConfig
): ContractPublication[] {
  const base = config.baseTopic;
  return [
    publication(`${base}/desired`, request),
    publication(`${base}/phase`, "requested"),
    publication(`${base}/failure`, null),
    publication(`${base}/availability`, "unknown")
  ];
}

function asStateSnapshot(value: unknown): TheatreStateSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("theatre state must be an object");
  }
  const event = value as Partial<TheatreStateSnapshot>;
  if (event.kind !== "state") throw new Error("theatre state kind must be state");
  if (!Number.isInteger(event.generation) || (event.generation ?? -1) < 0) {
    throw new Error("theatre state generation must be a non-negative integer");
  }
  if (typeof event.currentActivity !== "string" || typeof event.phase !== "string" ||
    typeof event.availability !== "string") {
    throw new Error("theatre state must define currentActivity, phase and availability");
  }
  if (!event.targets || typeof event.targets !== "object" || Array.isArray(event.targets)) {
    throw new Error("theatre state targets must be an object");
  }
  return event as TheatreStateSnapshot;
}

export function transitionTheatreStateContract(
  saved: Partial<TheatreStateContractState> | undefined,
  msg: TheatreStateContractMessage,
  suppliedConfig: Partial<TheatreStateContractConfig>,
  nowValue: Date | string | number = new Date()
) {
  const config = normaliseStateContractConfig(suppliedConfig);
  const state = createState(saved);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid date");
  const requests: ContractRequestOutput[] = [];
  const publications: ContractPublication[] = [];
  const traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [];

  function trace(event: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) {
    traces.push({event, outcome, reason, details});
  }

  if (msg.theatreStateContract?.kind === "startup") {
    publications.push(...discoveryPublications(config));
    trace("startup", "discovery", null, {publications: publications.length});
  } else if (msg.topic === `${config.baseTopic}/request`) {
    if (msg.retain === true) {
      trace("request", "ignored", "retained-request");
    } else {
      const payload = parsePayload(msg.payload);
      const requestId = String(payload.requestId || "");
      const activity = String(payload.activity || "");
      if (!REQUEST_ID.test(requestId)) throw new Error("requestId is invalid");
      if (!config.activities.includes(activity)) throw new Error("unknown theatre activity");
      const requestedAt = validTimestamp(payload.requestedAt, now.toISOString());
      if (state.lastRequest?.requestId === requestId) {
        if (state.lastRequest.activity !== activity) {
          throw new Error("requestId cannot be reused for another activity");
        }
        requests.push({theatre: {kind: "intent", ...state.lastRequest}});
        trace("request", "duplicate", null, {requestId, generation: state.lastRequest.generation});
      } else {
        state.generation += 1;
        state.lastRequest = {requestId, generation: state.generation, activity, requestedAt};
        requests.push({theatre: {kind: "intent", ...state.lastRequest}});
        trace("request", "accepted", null, {requestId, generation: state.generation, activity});
      }
      publications.push(...requestPublications(state.lastRequest, config));
    }
  } else if (msg.theatre && typeof msg.theatre === "object" && msg.theatre.kind === "state") {
    const event = asStateSnapshot(msg.theatre);
    if (event.generation < state.generation) {
      trace("state", "ignored", "stale-generation", {generation: event.generation});
    } else {
      state.generation = event.generation;
      if (event.requestId && event.desiredActivity) {
        state.lastRequest = {
          requestId: event.requestId,
          generation: event.generation,
          activity: event.desiredActivity,
          requestedAt: event.requestedAt || event.transitionStartedAt || now.toISOString()
        };
      }
      publications.push(...statePublications(event, config));
      trace("state", "published", null, {
        generation: event.generation,
        phase: event.phase,
        publications: publications.length
      });
    }
  } else {
    trace("message", "ignored", "unrelated-message");
  }

  return {
    state,
    requests,
    publications,
    traces,
    status: {
      phase: requests.length ? "requested" : publications.length ? "published" : "idle",
      text: state.lastRequest
        ? `${state.lastRequest.activity} · ${state.generation}`
        : "waiting for state"
    }
  };
}
