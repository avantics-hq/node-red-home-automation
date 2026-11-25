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

export function zigbeeColorTemp(kelvin: number): number {
  return Math.round(1_000_000 / kelvin);
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

// An intent's or profile's values as Zigbee2MQTT fields: brightnessPct and
// colorTempKelvin converted; anything else (an effect, say) passed on as it
// is. brightness and color_temp are Zigbee2MQTT's own units, accepted as
// they are during 5.x and reported as `legacy` so the node can warn.
export function lightValues(values: Record<string, unknown>): {values: Record<string, unknown>; legacy: boolean} {
  const converted: Record<string, unknown> = {};
  let legacy = false;
  for (const [key, value] of Object.entries(values)) {
    if (key === "brightnessPct" && typeof value === "number" && Number.isFinite(value)) {
      converted.brightness = zigbeeBrightness(value);
    } else if (key === "colorTempKelvin" && typeof value === "number" && Number.isFinite(value) && value > 0) {
      converted.color_temp = zigbeeColorTemp(value);
    } else {
      if (key === "brightness" || key === "color_temp") legacy = true;
      converted[key] = value;
    }
  }
  return {values: converted, legacy};
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
