"use strict";

// Observation times reported by devices and flows. A time more than
// CLOCK_SKEW_MS ahead of the receiver's clock is treated as observed on
// receipt, so one bad clock cannot make every later report look older.
export const CLOCK_SKEW_MS = 1000;

// An ISO string or non-negative epoch milliseconds; anything else is null.
export function parseObservedAt(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export interface BoundedObservation {
  ms: number;
  observedAt: string;
  // True when the reported time was beyond the skew limit and replaced by now.
  skewed: boolean;
}

// The time to store for a parsed observation. Times within the limit keep the
// reported string unchanged.
export function boundObservedAt(reported: string, ms: number, nowMs: number): BoundedObservation {
  if (ms > nowMs + CLOCK_SKEW_MS) return {ms: nowMs, observedAt: new Date(nowMs).toISOString(), skewed: true};
  return {ms, observedAt: reported, skewed: false};
}

// Whether a report is older than the stored one. A stored time beyond the skew
// limit (saved before this rule existed) counts as now, so it releases.
export function isOutOfOrder(ms: number, previous: unknown, nowMs: number): boolean {
  const previousMs = parseObservedAt(previous);
  if (previousMs === null) return false;
  return ms < (previousMs > nowMs + CLOCK_SKEW_MS ? nowMs : previousMs);
}

export function isFresh(ms: number | null, nowMs: number, freshnessMs: number): boolean {
  return ms !== null && nowMs - ms <= freshnessMs && ms <= nowMs + CLOCK_SKEW_MS;
}
