"use strict";

// A numeric node setting, read from the editor's value. A setting absent from
// a flow saved before it existed takes its default. Anything else must be a
// number: an emptied field, null or text is an error naming the setting, so
// the node reports it instead of running with a value nobody chose.
export function numberSetting(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value)
    : NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`);
  return parsed;
}
