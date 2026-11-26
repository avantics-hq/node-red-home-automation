"use strict";

// A theatre device controller that starts with nothing saved (a redeploy or
// restart without a context store) adopts the request the theatre activity
// controller's refresh carries, with its wanted values, so it can report on
// it. So does one holding an older request than the refresh's: the theatre
// moved on without sending it an intent, as when it adopts the activity the
// devices already show after a manual override or a restart, and the
// device's answers under its old request would be ignored as stale. It only ever reads the device for that request: a device found in the
// wanted state reports ready, and one that isn't is a manual override, with
// nothing commanded until a new explicit request. The five device reducers
// share these rules so they stay the same.

export const ADOPTED_MISMATCH = "adopted-mismatch";

export interface AdoptedRequest {
  requestId: string;
  generation: number;
}

// The request a refresh carries, if this node can adopt it: with nothing
// desired, one whose generation isn't older than its own; with a request,
// only a newer one. Each reducer checks the wanted values itself, and clears
// what belonged to a request it replaces.
export function adoptableRefresh(
  event: {kind: string; requestId?: unknown; generation?: unknown},
  state: {desired: unknown; generation: number}
): AdoptedRequest | null {
  if (event.kind !== "refresh") return null;
  if (typeof event.requestId !== "string" || event.requestId === "") return null;
  if (!Number.isInteger(event.generation)) return null;
  const generation = event.generation as number;
  if (state.desired ? generation <= state.generation : generation < Math.max(1, state.generation)) return null;
  return {requestId: event.requestId, generation};
}

// A newer refresh that wants exactly what this node is already doing (the
// same mode, power, source or profile): rather than adopting it read-only,
// which would drop the work in hand (a lamp warming up, a source switching),
// the node takes the refresh's request ID and generation and carries on. Not
// when it holds a manual override or a failure (`held`): those are read
// afresh by adopting. An adopted request stays read-only under the new
// generation. Returns whether it carried on.
export function carryOn(
  state: {desired: AdoptedRequest | null; generation: number; adoptedGeneration: number | null; phase: string; pending?: unknown; carried?: Carried | null},
  adoptable: AdoptedRequest | null,
  wantsSame: boolean,
  held: boolean
): boolean {
  if (!adoptable || !state.desired || !wantsSame || held) return false;
  const adopted = isAdopted(state);
  // Answers to commands already sent are tagged with the generation it
  // carries on from (see answersRequest).
  state.carried = {from: state.desired.generation, to: adoptable.generation};
  state.desired.requestId = adoptable.requestId;
  state.desired.generation = adoptable.generation;
  state.generation = adoptable.generation;
  if (adopted) state.adoptedGeneration = adoptable.generation;
  // A command in flight belongs to the request it carries on.
  const command = (state.pending as {command?: {generation?: unknown; requestId?: unknown}} | null | undefined)?.command;
  if (command && typeof command.generation === "number") {
    command.generation = adoptable.generation;
    command.requestId = adoptable.requestId;
  }
  return true;
}

// The generation a request carried on from, and the one it now has.
export interface Carried {
  from: number;
  to: number;
}

export function savedCarried(saved: {carried?: unknown}): Carried | null {
  const carried = saved.carried as Partial<Carried> | null | undefined;
  return carried && Number.isInteger(carried.from) && Number.isInteger(carried.to) ? {from: carried.from!, to: carried.to!} : null;
}

// Whether a reading or command result tagged `generation` answers the
// request `current`: its own generation, or the one it carried on from, for
// a command sent before it did. Once a later request replaces it, only that
// request's generation counts.
export function answersRequest(carried: Carried | null | undefined, current: number, generation: unknown): boolean {
  return generation === current || (Boolean(carried) && carried!.to === current && generation === carried!.from);
}

// The trace reason for an adoption: a node with nothing saved, or one whose
// request the theatre replaced.
export function adoptionReason(desired: unknown): string {
  return desired ? "newer-generation" : "nothing-desired";
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
