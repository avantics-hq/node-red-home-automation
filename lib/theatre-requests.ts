"use strict";

// The theatre contract's own decisions, apart from MQTT and Home Assistant
// (theatre-state-contract.ts publishes them), as the room's decisions are
// apart from room-publishing.ts: which activity request to pass on, under
// which generation, and what the activity controller's snapshots mean for
// the request in hand and the operational SLO.

import type {TheatreTarget} from "./theatre-profiles";
import type {TheatreMetrics, TheatreSnapshot} from "./theatre-state";
import {evaluateTheatreSlo, type TheatreSloAssessment, type TheatreSloConfig, type TheatreSloState} from "./theatre-slo";
import {REQUEST_ID} from "./topic-names";

export interface ContractRequest {
  requestId: string;
  generation: number;
  activity: string;
  requestedAt: string;
}

export interface TheatreRequestState {
  generation: number;
  lastRequest: ContractRequest | null;
  slo: TheatreSloState;
}

// The activity controller's published state, as the contract reads it: the
// same snapshot, but with targets, failure, degraded entries and metrics
// taken as they arrive rather than in the controller's exact shapes.
export type TheatreStateSnapshot =
  Omit<TheatreSnapshot, "availability" | "targets" | "failure" | "degraded" | "metrics"> & {
    availability: string;
    targets: Partial<Record<TheatreTarget, Record<string, unknown> | null>>;
    failure: Record<string, unknown> | null;
    degraded: Array<Record<string, unknown>>;
    metrics?: TheatreMetrics;
  };

export function createTheatreRequestState(saved: Partial<TheatreRequestState> = {}): TheatreRequestState {
  const lastRequest = saved.lastRequest && typeof saved.lastRequest === "object"
    ? {...saved.lastRequest}
    : null;
  return {
    generation: Number.isInteger(saved.generation) && (saved.generation ?? -1) >= 0
      ? saved.generation!
      : 0,
    lastRequest,
    slo: {
      samples: Array.isArray(saved.slo?.samples) ? saved.slo.samples.map((sample) => ({...sample})) : []
    }
  };
}

function validTimestamp(value: unknown, fallback: string): string {
  const timestamp = value === undefined ? fallback : String(value);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("requestedAt must be an ISO timestamp");
  return timestamp;
}

// An activity request: a new one takes the next generation; the same
// request again is passed on as it was. An invalid one is an error.
export function takeTheatreRequest(
  state: TheatreRequestState,
  request: {requestId?: unknown; activity?: unknown; requestedAt?: unknown},
  activities: string[],
  now: Date
): "accepted" | "duplicate" {
  const requestId = String(request.requestId || "");
  const activity = String(request.activity || "");
  if (!REQUEST_ID.test(requestId)) throw new Error("requestId is invalid");
  if (!activities.includes(activity)) throw new Error("unknown theatre activity");
  const requestedAt = validTimestamp(request.requestedAt, now.toISOString());
  if (state.lastRequest?.requestId === requestId) {
    if (state.lastRequest.activity !== activity) {
      throw new Error("requestId cannot be reused for another activity");
    }
    return "duplicate";
  }
  state.generation += 1;
  state.lastRequest = {requestId, generation: state.generation, activity, requestedAt};
  return "accepted";
}

// The activity controller's snapshot, checked for the fields the contract
// relies on.
export function asTheatreSnapshot(value: unknown): TheatreStateSnapshot {
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

// A snapshot older than the request in hand is stale; a current one
// becomes the request in hand and a sample for the SLO, whose assessment
// it returns.
export function takeTheatreSnapshot(
  state: TheatreRequestState,
  event: TheatreStateSnapshot,
  sloConfig: TheatreSloConfig,
  now: Date
): TheatreSloAssessment | null {
  if (event.generation < state.generation) return null;
  state.generation = event.generation;
  if (event.requestId && event.desiredActivity) {
    state.lastRequest = {
      requestId: event.requestId,
      generation: event.generation,
      activity: event.desiredActivity,
      requestedAt: event.requestedAt || event.transitionStartedAt || now.toISOString()
    };
  }
  const slo = evaluateTheatreSlo(state.slo, event, sloConfig, now);
  state.slo = slo.state;
  return slo.assessment;
}
