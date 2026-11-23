"use strict";

// A configured number, or the fallback when it is missing, blank (a cleared
// editor field) or not a number. Node settings arrive as editor strings; this
// is how every node reads them.
export function finiteOr(value: unknown, fallback: number): number {
  if (value === null || (typeof value === "string" && value.trim() === "")) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
