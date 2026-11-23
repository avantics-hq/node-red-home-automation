"use strict";

import type {LightStyle} from "./light-styling";

export interface ObservedLight {
  on: boolean;
  brightness: unknown;
  color_temp: unknown;
}

// Whether a light already shows a style, by its own latest report. A bulb
// that missed a command reports something else, so it is not "styled".
export function alreadyStyled(style: LightStyle, observed: ObservedLight | undefined): boolean {
  return observed?.on === true &&
    Number(observed.brightness) === style.brightness &&
    Number(observed.color_temp) === style.color_temp;
}
