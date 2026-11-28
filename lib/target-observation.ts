"use strict";

// The recovery probe and its answer, for every theatre target owner.
//
// After a start with nothing saved, the theatre activity controller sends
// each owner a refresh with no request (requestId null, generation 0): the
// probe. An owner with no request of its own answers it by reading its
// device and reporting what it shows, in the activity profiles' terms, on
// the output its target states use:
//   msg.theatre = {kind: "target_observation", target, observedAt, values}
// The activity controller adopts the one activity those observations match,
// if any, and commands nothing.

export function isProbe(event: {kind?: unknown; requestId?: unknown; generation?: unknown}): boolean {
  return event.kind === "refresh" && (event.requestId === null || event.requestId === undefined || event.requestId === "") &&
    !(Number.isInteger(event.generation) && (event.generation as number) >= 1);
}

export interface TargetObservationOutput {
  theatre: {kind: "target_observation"; target: string; observedAt: string; values: Record<string, unknown>};
}

export function targetObservation(target: string, observedAt: string, values: Record<string, unknown>): TargetObservationOutput {
  return {theatre: {kind: "target_observation", target, observedAt, values}};
}
