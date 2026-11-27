"use strict";

// The theatre contract's MQTT and Home Assistant side: it reads activity
// requests from MQTT, publishes what the activity controller reports as
// retained topics, and announces the Home Assistant entities. What to do
// with a request or a snapshot is theatre-requests.ts's.

import {TARGETS} from "./theatre-profiles";
import {theatreDiscovery, theatreTopic, type TheatreTopicName} from "./theatre-ha-discovery";
import {normaliseTheatreSloConfig, type TheatreSloAssessment, type TheatreSloConfig} from "./theatre-slo";
import {
  asTheatreSnapshot,
  createTheatreRequestState,
  takeTheatreRequest,
  takeTheatreSnapshot,
  type ContractRequest,
  type TheatreRequestState,
  type TheatreStateSnapshot
} from "./theatre-requests";
import type {TraceEntry} from "./bounded-trace";
import {OFFLINE, ONLINE, discoveryPrefixSetting, type IdScheme} from "./ha-discovery";
import {homeTopic, IDENTIFIER, publishingArea} from "./topic-names";


export type {ContractRequest, TheatreStateSnapshot} from "./theatre-requests";
export type TheatreStateContractState = TheatreRequestState;

export interface TheatreStateContractConfig {
  // The Node-RED node's ID, and how the contract names its Home Assistant
  // device and entities: absent means the area scheme.
  nodeId?: string;
  idScheme?: IdScheme;
  area: string;
  displayName: string;
  baseTopic: string;
  discoveryPrefix: string;
  activities: string[];
  slo: TheatreSloConfig;
  // Publish Home Assistant discovery. Unset means on, as before the setting
  // existed.
  discovery?: boolean;
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
  const discovery = config.discovery !== false;
  // The area names the default base topic, so it is needed without one. It
  // also names an area-scheme contract's entities; a node-scheme contract's
  // are named after the node, and its entity IDs fall back to the display
  // name. Otherwise it is optional.
  const area = publishingArea(String(config.area || "").trim(),
    !config.baseTopic || (discovery && config.idScheme !== "node"));
  const displayName = String(config.displayName || area).trim();
  if (discovery && !displayName) throw new Error("displayName is required");
  const baseTopic = String(config.baseTopic || homeTopic(area, "theatre")).replace(/^\/+|\/+$/g, "");
  const discoveryPrefix = discoveryPrefixSetting(config.discoveryPrefix);
  if (!baseTopic || /[+#]/.test(baseTopic)) throw new Error("baseTopic must be a concrete MQTT topic");
  if (!Array.isArray(config.activities) || config.activities.length === 0) {
    throw new Error("activities must be a non-empty array");
  }
  const activities = config.activities.map((activity) => String(activity));
  if (activities.some((activity) => !IDENTIFIER.test(activity))) {
    throw new Error("activities must contain lowercase identifiers");
  }
  if (new Set(activities).size !== activities.length) throw new Error("activities must be unique");
  return {
    ...(config.nodeId ? {nodeId: config.nodeId} : {}),
    area,
    displayName,
    baseTopic,
    discoveryPrefix,
    activities,
    slo: normaliseTheatreSloConfig(config.slo),
    discovery,
    ...(config.idScheme ? {idScheme: config.idScheme} : {})
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

function publication(topic: string, payload: unknown): ContractPublication {
  return {
    topic,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    retain: true
  };
}

// When the latest transition started and finished, and which targets it
// left degraded: the Phase sensor's attributes in Home Assistant.
function transitionDetails(event: TheatreStateSnapshot) {
  const timestamp = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    startedAt: timestamp(event.transitionStartedAt),
    completedAt: timestamp(event.transitionCompletedAt),
    degraded: (Array.isArray(event.degraded) ? event.degraded : []).map((entry) => ({
      target: String(entry.target),
      reason: String(entry.reason)
    }))
  };
}

// What the contract publishes from each controller snapshot, one retained
// topic per entry, in this order. The publications and the list of topics
// the contract publishes both come from this table.
const STATE_TOPICS: Array<[TheatreTopicName, (event: TheatreStateSnapshot, slo: TheatreSloAssessment) => unknown]> = [
  ["desired", (event) => (event.requestId && event.desiredActivity
    ? {
      requestId: event.requestId,
      generation: event.generation,
      activity: event.desiredActivity,
      requestedAt: event.requestedAt
    }
    : null)],
  ["current", (event) => event.currentActivity],
  ["phase", (event) => event.phase],
  ["transition", (event) => transitionDetails(event)],
  ["failure", (event) => event.failure],
  ["readiness", (event) => event.availability],
  ["metrics", (event) => event.metrics || {
    requests: 0,
    ready: 0,
    failed: 0,
    superseded: 0,
    manualOverrides: 0,
    driftEvents: 0,
    recoveriesAdopted: 0,
    recoveriesUnknown: 0,
    lastTransitionMs: null,
    maxTransitionMs: null,
    lastOutcome: null,
    targets: {}
  }],
  ["slo", (_event, slo) => slo],
  ["slo/breach", (_event, slo) => (slo.status === "breached" ? "ON" : "OFF")],
  ...TARGETS.map((target): [TheatreTopicName, (event: TheatreStateSnapshot) => unknown] => [
    `health/${target}`,
    (event) => event.targets[target] || {
      status: "unknown",
      observedAt: null,
      classification: null,
      failure: null,
      details: null
    }
  ])
];

function statePublications(
  event: TheatreStateSnapshot,
  config: TheatreStateContractConfig,
  slo: TheatreSloAssessment
): ContractPublication[] {
  return STATE_TOPICS.map(([name, value]) => publication(theatreTopic(config.baseTopic, name), value(event, slo)));
}


function requestPublications(
  request: ContractRequest,
  config: TheatreStateContractConfig
): ContractPublication[] {
  const base = config.baseTopic;
  return [
    publication(theatreTopic(base, "desired"), request),
    publication(theatreTopic(base, "phase"), "requested"),
    publication(theatreTopic(base, "failure"), null),
    publication(theatreTopic(base, "readiness"), "unknown")
  ];
}

// Every retained topic the contract publishes, for clearing those it no
// longer does after a change: discovery entries, whenever they are published
// or cleared at each start, its availability, and its state topics.
export function theatreRetainedTopics(config: TheatreStateContractConfig): string[] {
  const discovery = config.discovery !== false || config.area
    ? theatreDiscovery(config).map(({topic}) => topic)
    : [];
  return [
    ...discovery,
    theatreTopic(config.baseTopic, "availability"),
    ...STATE_TOPICS.map(([name]) => theatreTopic(config.baseTopic, name))
  ];
}

// What the contract publishes as the flows start and as it stops: with
// discovery on, its entries, as the other publishing nodes announce theirs,
// so Home Assistant has them without a startup message; and its
// availability, so Home Assistant shows its entities as available only while
// it runs. Removing entries when discovery is off stays with the startup
// message.
export function theatreStartingPublications(config: TheatreStateContractConfig): ContractPublication[] {
  const entries = config.discovery !== false ? theatreDiscovery(config) : [];
  return [
    ...entries.map(({topic, payload}) => publication(topic, payload)),
    publication(theatreTopic(config.baseTopic, "availability"), ONLINE)
  ];
}

export function theatreStoppingPublications(config: TheatreStateContractConfig): ContractPublication[] {
  return [publication(theatreTopic(config.baseTopic, "availability"), OFFLINE)];
}

export function transitionTheatreStateContract(
  saved: Partial<TheatreStateContractState> | undefined,
  msg: TheatreStateContractMessage,
  suppliedConfig: Partial<TheatreStateContractConfig>,
  nowValue: Date | string | number = new Date()
) {
  const config = normaliseStateContractConfig(suppliedConfig);
  const state = createTheatreRequestState(saved);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid date");
  const requests: ContractRequestOutput[] = [];
  const publications: ContractPublication[] = [];
  const traces: TraceEntry[] = [];

  function trace(event: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) {
    traces.push({event, outcome, reason, details});
  }

  if (msg.theatreStateContract?.kind === "startup") {
    // Discovery switched off: empty retained entries remove the entities
    // from Home Assistant.
    const entries = config.discovery !== false || config.area ? theatreDiscovery(config) : [];
    publications.push(...entries.map(({topic, payload}) =>
      publication(topic, config.discovery !== false ? payload : "")));
    publications.push(publication(theatreTopic(config.baseTopic, "availability"), ONLINE));
    trace("startup", "discovery", null, {publications: publications.length});
  } else if (msg.topic === theatreTopic(config.baseTopic, "request")) {
    if (msg.retain === true) {
      trace("request", "ignored", "retained-request");
    } else {
      const payload = parsePayload(msg.payload);
      const outcome = takeTheatreRequest(state, payload, config.activities, now);
      const request = state.lastRequest!;
      requests.push({theatre: {kind: "intent", ...request}});
      if (outcome === "duplicate") {
        trace("request", "duplicate", null, {requestId: request.requestId, generation: request.generation});
      } else {
        trace("request", "accepted", null, {requestId: request.requestId, generation: state.generation, activity: request.activity});
      }
      publications.push(...requestPublications(request, config));
    }
  } else if (msg.theatre && typeof msg.theatre === "object" && msg.theatre.kind === "state") {
    const event = asTheatreSnapshot(msg.theatre);
    const assessment = takeTheatreSnapshot(state, event, config.slo, now);
    if (!assessment) {
      trace("state", "ignored", "stale-generation", {generation: event.generation});
    } else {
      publications.push(...statePublications(event, config, assessment));
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
