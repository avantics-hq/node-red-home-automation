"use strict";

// A Zigbee2MQTT light as the room controller sees it: the command payload it
// sends, the state report it reads back, and the command fields that set a
// light's values. Zigbee2MQTT takes brightness on a 1-254 scale and colour
// temperature in mireds; the package's own values are brightness percent
// and colour temperature in kelvin, and this module converts between them.

import type {LightStyle} from "./light-styling";

// What a state report says about a light, in Zigbee2MQTT's units.
export interface LightReport {
  on: boolean;
  brightness: unknown;
  color_temp: unknown;
}

// A state report, or null when it carries no ON/OFF state.
export function readLightReport(payload: Record<string, unknown>): LightReport | null {
  const state = String(payload.state).toUpperCase();
  if (state !== "ON" && state !== "OFF") return null;
  return {on: state === "ON", brightness: payload.brightness ?? null, color_temp: payload.color_temp ?? null};
}

export type LightCommand = {
  state: string;
  brightness?: number;
  color_temp?: number;
  transition?: number;
};

// Brightness percent as Zigbee2MQTT's 1-254, and kelvin as mireds.
export function zigbeeBrightness(percent: number): number {
  return Math.min(254, Math.max(1, Math.round(percent * 254 / 100)));
}

// Rounded after trimming float noise to 12 significant digits, so a mired
// value that is exactly n.5 in decimal rounds up as it always has, rather than
// down because its kelvin round trip left it a hair under.
export function zigbeeColorTemp(kelvin: number): number {
  return Math.round(Number((1_000_000 / kelvin).toPrecision(12)));
}

function zigbeeStyle(style: LightStyle): {brightness: number; color_temp: number} {
  return {brightness: zigbeeBrightness(style.brightnessPct), color_temp: zigbeeColorTemp(style.colorTempKelvin)};
}

// A command for a light: OFF on its own, otherwise the state with a style
// faded in over the transition.
export function lightCommand(state: string, style: LightStyle, transitionSeconds: number): LightCommand {
  if (state === "OFF") return {state};
  return {state, ...zigbeeStyle(style), transition: transitionSeconds};
}

// A brightness percent or kelvin as a number: a number, or a finite numeric
// string; null otherwise.
function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

// The package's own value fields and the Zigbee2MQTT field each becomes.
const NEUTRAL_FIELDS = {brightnessPct: "brightness", colorTempKelvin: "color_temp"} as const;

// An intent's or profile's values as Zigbee2MQTT fields: brightnessPct and
// colorTempKelvin converted; anything else (an effect, say) passed on as it
// is. brightness and color_temp are Zigbee2MQTT's own units, accepted as
// they are during 5.x and reported as `legacy` so the node can warn; given
// with the new field too, the new one wins, whatever the order, and the old
// one is `superseded`. An unusable brightnessPct or colorTempKelvin is
// `invalid` and never reaches the device.
export function lightValues(values: Record<string, unknown>): {
  values: Record<string, unknown>;
  legacy: boolean;
  superseded: string[];
  invalid: string[];
} {
  const converted: Record<string, unknown> = {};
  const superseded: string[] = [];
  const invalid: string[] = [];
  let legacy = false;
  const neutral: Record<string, number> = {};
  for (const [field, device] of Object.entries(NEUTRAL_FIELDS) as Array<[keyof typeof NEUTRAL_FIELDS, string]>) {
    if (!Object.hasOwn(values, field)) continue;
    const number = numberValue(values[field]);
    if (number === null || (field === "colorTempKelvin" && number <= 0)) invalid.push(field);
    else neutral[device] = field === "brightnessPct" ? zigbeeBrightness(number) : zigbeeColorTemp(number);
  }
  for (const [key, value] of Object.entries(values)) {
    if (Object.hasOwn(NEUTRAL_FIELDS, key)) continue;
    if (key === "brightness" || key === "color_temp") {
      if (Object.hasOwn(neutral, key)) {
        superseded.push(key);
        continue;
      }
      legacy = true;
    }
    converted[key] = value;
  }
  return {values: {...converted, ...neutral}, legacy, superseded, invalid};
}

// Command fields that set a light's values rather than just its power.
const VALUE_FIELDS = [
  "brightness", "brightness_percent", "color", "color_temp", "color_temp_kelvin",
  "effect", "hue", "saturation", "x", "y"
];

export function setsLightValues(command: Record<string, unknown>): boolean {
  return VALUE_FIELDS.some((field) => Object.hasOwn(command, field));
}

// Whether a light already shows a style, by its own latest report. A bulb
// that missed a command reports something else, so it is not "styled".
export function alreadyStyled(style: LightStyle, report: LightReport | undefined): boolean {
  const expected = zigbeeStyle(style);
  return report?.on === true &&
    Number(report.brightness) === expected.brightness &&
    Number(report.color_temp) === expected.color_temp;
}
