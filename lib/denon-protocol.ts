"use strict";

// The Denon receiver's text protocol, as this package speaks it: the commands
// it sends and the status lines it reads back. Each command and line ends in
// a carriage return.

export type AvrPower = "on" | "standby";
export type MainZone = "on" | "off";

// Asks for power, main zone, source and volume.
export const QUERY_COMMAND = "PW?\rZM?\rSI?\rMV?\r";
export const POWER_ON = "PWON\r";
export const POWER_STANDBY = "PWSTANDBY\r";
export const ZONE_ON = "ZMON\r";

export function selectSource(code: string): string {
  return "SI" + code + "\r";
}

export type ParsedAvrLine =
  | {field: "power"; value: AvrPower; line: string}
  | {field: "mainZone"; value: MainZone; line: string}
  | {field: "source"; value: string | null; sourceCode: string; line: string}
  | {field: "volume"; value: number | null; line: string};

// Configured source names mapped to the receiver's source codes, each code
// valid and used once.
export function parseSourceCodes(value: unknown): Record<string, string> {
  const sources = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const entries = Object.entries(sources);
  if (entries.some(([name, code]) =>
    !name ||
    !code || typeof code !== "string" ||
    !/^[A-Z0-9][A-Z0-9 /._-]*$/.test(code)
  )) {
    throw new Error("sources must map names to Denon source codes");
  }
  const typedEntries = entries as Array<[string, string]>;
  if (new Set(typedEntries.map(([, code]) => code)).size !== typedEntries.length) {
    throw new Error("Denon source codes must be unique");
  }
  return Object.fromEntries(typedEntries);
}

// The package's volume is in dB. A Denon receiver's master volume runs
// from 0 to 98 in half steps, where 80 is 0 dB: -80 to +18 dB. This module
// converts at its edges, so the receiver's strings stay as they are.
export const VOLUME_STEP_DB = 0.5;
export const VOLUME_MIN_DB = -80;
export const VOLUME_MAX_DB = 18;
const DENON_ZERO_DB = 80;

// Volume moves in half steps.
export function roundVolume(value: number): number {
  return Math.round(value * 2) / 2;
}

// "MV" volume digits: two for a whole step, a trailing 5 for a half step;
// read as dB.
function parseVolume(raw: string): number | null {
  if (!/^\d{2,3}$/.test(raw)) return null;
  const denon = raw.length === 2 ? Number(raw) : Number(raw.slice(0, 2)) + Number(raw.slice(2)) / 10;
  return denon - DENON_ZERO_DB;
}

// A volume in the receiver's own 0-98 as dB: absolute values convert,
// relative ones are already a change in dB. Used only for a receiver state
// saved before 5.0, restored once (see createAvrState).
export function legacyVolumeDb(value: number, mode: "absolute" | "relative"): number {
  return mode === "absolute" ? value - DENON_ZERO_DB : value;
}

// A volume in dB as the receiver's "MV" command.
export function formatVolumeCommand(db: number): string {
  const rounded = roundVolume(db);
  if (!Number.isFinite(db) || rounded < VOLUME_MIN_DB || rounded > VOLUME_MAX_DB || Math.abs(db - rounded) > 0.001) {
    throw new Error("volume must be a half-step between -80 and 18 dB");
  }
  const denon = rounded + DENON_ZERO_DB;
  const whole = Math.floor(denon).toString().padStart(2, "0");
  return "MV" + whole + (Number.isInteger(denon) ? "" : "5") + "\r";
}

export function parseAvrLine(
  value: unknown,
  sources: Record<string, string>
): ParsedAvrLine | null {
  const line = String(value ?? "").trim();
  if (line === "PWON") return {field: "power", value: "on", line};
  if (line === "PWOFF" || line === "PWSTANDBY") {
    return {field: "power", value: "standby", line};
  }
  if (line === "ZMON") return {field: "mainZone", value: "on", line};
  if (line === "ZMOFF") return {field: "mainZone", value: "off", line};
  if (/^SI.+/.test(line)) {
    const sourceCode = line.slice(2);
    const source = Object.entries(sources).find(([, code]) => code === sourceCode)?.[0] || null;
    return {field: "source", value: source, sourceCode, line};
  }
  if (/^MV\d{2,3}$/.test(line)) {
    return {field: "volume", value: parseVolume(line.slice(2)), line};
  }
  return null;
}
