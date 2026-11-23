"use strict";

// What every target owner reports to the theatre activity controller: one
// envelope, with details that belong to the owner.

export type TargetStatus =
  | "discovering"
  | "transitioning"
  | "confirming"
  | "ready"
  | "waiting_for_source"
  | "failed"
  | "unavailable";

const TARGET_STATUSES: Record<TargetStatus, true> = {
  discovering: true,
  transitioning: true,
  confirming: true,
  ready: true,
  waiting_for_source: true,
  failed: true,
  unavailable: true
};

export function isTargetStatus(value: unknown): value is TargetStatus {
  return typeof value === "string" && Object.hasOwn(TARGET_STATUSES, value);
}

// An owner's phase when it is already a target status, or the given status.
export function asTargetStatus(phase: string, otherwise: TargetStatus): TargetStatus {
  return isTargetStatus(phase) ? phase : otherwise;
}

export interface TargetStateEvent<Target extends string = string, Details = Record<string, unknown>, Failure = Record<string, unknown>> {
  kind: "target_state";
  target: Target;
  requestId: string;
  generation: number;
  status: TargetStatus;
  observedAt: string;
  details: Details;
  classification?: "manual_override";
  failure?: Failure;
}

export function targetStateEvent<Target extends string, Details, Failure>(fields: {
  target: Target;
  requestId: string;
  generation: number;
  status: TargetStatus;
  observedAt: string;
  details: Details;
  classification?: "manual_override" | null;
  failure?: Failure | null;
}): TargetStateEvent<Target, Details, Failure> {
  const event: TargetStateEvent<Target, Details, Failure> = {
    kind: "target_state",
    target: fields.target,
    requestId: fields.requestId,
    generation: fields.generation,
    status: fields.status,
    observedAt: fields.observedAt,
    details: fields.details
  };
  if (fields.classification) event.classification = fields.classification;
  if (fields.failure) event.failure = {...fields.failure};
  return event;
}
