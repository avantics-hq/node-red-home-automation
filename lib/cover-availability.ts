"use strict";

// What both kinds of cover do when the device says it went offline or came
// back: offline, it drops the move it was following and remembers its
// phase; back online, it takes that phase up again and reads the cover anew.
// Shared so the position and open/close covers stay alike.

export interface CoverAvailability {
  available: boolean;
  phase: string;
  phaseBeforeUnavailable: string | null;
  pending: unknown;
}

// Applies a change of availability; says which way it went, or null when it
// was no change. The caller clears what it observed and re-reads on "online".
export function applyCoverAvailability(state: CoverAvailability, online: unknown): "offline" | "online" | null {
  if (online !== true && online !== false) throw new Error("cover availability online must be true or false");
  if (!online && state.available) {
    state.available = false;
    state.phaseBeforeUnavailable = state.phase;
    state.pending = null;
    state.phase = "unavailable";
    return "offline";
  }
  if (online && !state.available) {
    state.available = true;
    state.phase = state.phaseBeforeUnavailable ?? "idle";
    state.phaseBeforeUnavailable = null;
    return "online";
  }
  return null;
}
