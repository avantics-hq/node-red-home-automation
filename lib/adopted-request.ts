"use strict";

// A theatre device controller that starts with nothing saved (a redeploy or
// restart without a context store) adopts the request the theatre activity
// controller's refresh carries, with its wanted values, so it can report on
// it. It only ever reads the device for that request: a device found in the
// wanted state reports ready, and one that isn't is a manual override, with
// nothing commanded until a new explicit request. The five device reducers
// share these rules so they stay the same.

export const ADOPTED_MISMATCH = "adopted-mismatch";

export interface AdoptedRequest {
  requestId: string;
  generation: number;
}

// The request a refresh carries, if this node can adopt it: it has nothing
// desired, and the generation isn't older than its own. Each reducer checks
// the wanted values itself.
export function adoptableRefresh(
  event: {kind: string; requestId?: unknown; generation?: unknown},
  state: {desired: unknown; generation: number}
): AdoptedRequest | null {
  if (event.kind !== "refresh" || state.desired) return null;
  if (typeof event.requestId !== "string" || event.requestId === "") return null;
  if (!Number.isInteger(event.generation) || (event.generation as number) < Math.max(1, state.generation)) return null;
  return {requestId: event.requestId, generation: event.generation as number};
}

export interface AdoptableState {
  generation: number;
  // The generation this node adopted from a refresh, while it is current.
  adoptedGeneration: number | null;
  phase: string;
}

export function savedAdoptedGeneration(saved: {adoptedGeneration?: unknown}): number | null {
  return Number.isInteger(saved.adoptedGeneration) ? saved.adoptedGeneration as number : null;
}

export function isAdopted(state: AdoptableState): boolean {
  return state.adoptedGeneration !== null && state.adoptedGeneration === state.generation;
}

// For an adopted request, keeps only the commands that read the device. Any
// other command means the reducer tried to bring the device to the wanted
// state, so it isn't in it: the result says so, and the caller records a
// manual override instead.
export function readsOnly<Command>(
  state: AdoptableState,
  commands: Command[],
  reads: (command: Command) => boolean
): {commands: Command[]; mismatch: boolean} {
  if (!isAdopted(state)) return {commands, mismatch: false};
  const kept = commands.filter(reads);
  return {commands: kept, mismatch: kept.length !== commands.length};
}
