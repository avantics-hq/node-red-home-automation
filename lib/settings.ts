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

// An on/off setting. A setting absent from an older saved flow takes its
// default; true/"true" and false/"false" are read as such; anything else is
// an error naming the setting.
export function booleanSetting(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const read = optionalBooleanSetting(value, label);
  return read ?? fallback;
}

// An on/off setting that can be "not set": null (what the editor stores for
// it) or absent. Returns null for "not set"; the caller applies its documented
// meaning. An empty string is not "not set" and is an error.
export function optionalBooleanSetting(value: unknown, label: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${label} must be on or off`);
}

// A text setting. Absent from an older saved flow: its default (or, with no
// default, an error). Otherwise it must not be empty.
export function textSetting(value: unknown, label: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

// A JSON setting, parsed. Absent from an older saved flow: its default.
// Otherwise it must be JSON text that parses; the caller checks its shape.
export function jsonSetting(value: unknown, label: string, fallback: unknown): unknown {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // Reported below.
    }
  }
  throw new Error(`${label} must be valid JSON`);
}

// One of a fixed set of words, such as a scheme name. Absent or null is "not
// set" (null), for the caller to give its documented meaning; anything else
// that isn't one of the choices is an error naming them.
export function optionalChoiceSetting<Choice extends string>(value: unknown, label: string, choices: readonly Choice[]): Choice | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && (choices as readonly string[]).includes(value)) return value as Choice;
  throw new Error(`${label} must be ${choices.slice(0, -1).join(", ")}${choices.length > 1 ? " or " : ""}${choices.at(-1)}`);
}

// The rule for a value set at runtime (from Home Assistant, say) over a
// setting: it lasts until the node is deployed with a different setting,
// which then applies. `savedSetting` is the setting the saved value was
// based on; state saved before such values were recorded has none, so the
// setting applies.
export function keptOverride<Value extends string | number>(savedValue: unknown, savedSetting: unknown, setting: Value): Value {
  return savedSetting === setting && typeof savedValue === typeof setting ? savedValue as Value : setting;
}
