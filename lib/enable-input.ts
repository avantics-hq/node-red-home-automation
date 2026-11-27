"use strict";

// An enable, sleep or pause input from a flow: true or false only. Anything
// else, such as "on" or "ON" (accepted before 6.0), is refused and traced,
// never read as off. Home Assistant's ON and OFF reach a node through its
// set topics, which translate them to true or false.
export const NOT_TRUE_OR_FALSE = "not-true-or-false";

export function enableValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// A refused value as it can be shown in a trace and a warning.
export function describeValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
