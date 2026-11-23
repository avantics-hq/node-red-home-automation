"use strict";

// A Zigbee2MQTT light as the room controller sees it: the command payload it
// sends, the state report it reads back, and the command fields that set a
// light's values. Brightness is on Zigbee2MQTT's 1-254 scale and colour
// temperature in mireds (see light-styling).

import type {LightStyle} from "./light-styling";

// What a state report says about a light.
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

// A command for a light: OFF on its own, otherwise the state with a style
// faded in over the transition.
export function lightCommand(state: string, style: LightStyle, transitionSeconds: number): LightCommand {
  if (state === "OFF") return {state};
  return {state, ...style, transition: transitionSeconds};
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
  return report?.on === true &&
    Number(report.brightness) === style.brightness &&
    Number(report.color_temp) === style.color_temp;
}
