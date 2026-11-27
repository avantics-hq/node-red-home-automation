"use strict";

// The owners holding each of a room's lights (an activity, a scene), as a
// stack per light, and what the light was before the first of them took it.
// Pure bookkeeping: the room controller decides who may take a light, and
// applies what a release hands back.

import type {LightCommandMessage} from "./light-contract";

// What an owner asked a held light for, to give back to it when a newer
// owner lets go. Null when not known (state saved before 6.1).
export type HeldSpec = Pick<LightCommandMessage, "state" | "brightnessPct" | "colorTempKelvin" | "transitionSeconds" | "extra">;

// What a light was when its first owner took it.
export interface HeldFrom {
  control: "in-control" | "manual";
  on: boolean;
  brightnessPct?: number;
  colorTempKelvin?: number;
}

// The owners holding an overridden light, oldest first: the newest is its
// control entry's owner and sets the light. `before` is null when not known
// (state saved before 6.1).
export interface LightHold {
  owners: Array<{owner: string; spec: HeldSpec | null}>;
  before: HeldFrom | null;
}

// What releasing an owner hands back.
export type Released =
  // Not one of the light's owners.
  | {kind: "none"}
  // Beneath a newer owner: dropped, and the light is left as it is.
  | {kind: "dropped"}
  // The owner beneath takes the light, with what it last asked for.
  | {kind: "next"; owner: string; spec: HeldSpec | null}
  // The last owner let go: the light goes back to what it was.
  | {kind: "restore"; before: HeldFrom | null};

export function newHold(owner: string, before: HeldFrom): LightHold {
  return {owners: [{owner, spec: null}], before};
}

// The hold of a light overridden under state saved before 6.1: its one
// owner, with nothing known of what it was before.
export function legacyHold(owner: string): LightHold {
  return {owners: [{owner, spec: null}], before: null};
}

export function savedHolds(saved: unknown, overridden: (target: string) => boolean): Record<string, LightHold> {
  if (!saved || typeof saved !== "object") return {};
  return Object.fromEntries(Object.entries(saved as Record<string, LightHold>)
    .filter(([target, hold]) => overridden(target) && Array.isArray(hold?.owners) && hold.owners.length > 0)
    .map(([target, hold]) => [target, {
      owners: hold.owners.map((entry) => ({owner: String(entry.owner), spec: entry.spec ? {...entry.spec} : null})),
      before: hold.before ? {...hold.before} : null
    }]));
}

// An owner asking for a light already held: "top" when it already holds it,
// "beneath" when it is under a newer owner (its request is kept for when
// the newer lets go, and the light is left as it is), "pushed" when it is new
// and now on top.
export function addOwner(hold: LightHold, owner: string): "top" | "beneath" | "pushed" {
  const index = hold.owners.findIndex((entry) => entry.owner === owner);
  if (index === hold.owners.length - 1) return "top";
  if (index >= 0) return "beneath";
  hold.owners.push({owner, spec: null});
  return "pushed";
}

export function setOwnerSpec(hold: LightHold, owner: string, spec: HeldSpec): void {
  const entry = hold.owners.find((held) => held.owner === owner);
  if (entry) entry.spec = {...spec, ...(spec.extra ? {extra: {...spec.extra}} : {})};
}

// Whether the owner on top holds the light off.
export function heldOff(hold: LightHold | undefined): boolean {
  return hold?.owners.at(-1)?.spec?.state === "OFF";
}

// Lets go of one owner, or of every owner (null).
export function releaseOwner(hold: LightHold, owner: string | null): Released {
  const index = owner === null ? 0 : hold.owners.findIndex((entry) => entry.owner === owner);
  if (index < 0) return {kind: "none"};
  if (owner !== null && index < hold.owners.length - 1) {
    hold.owners.splice(index, 1);
    return {kind: "dropped"};
  }
  if (owner !== null && hold.owners.length > 1) {
    hold.owners.pop();
    const next = hold.owners.at(-1)!;
    return {kind: "next", owner: next.owner, spec: next.spec ? {...next.spec} : null};
  }
  return {kind: "restore", before: hold.before};
}
