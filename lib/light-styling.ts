"use strict";

// Turns a day level into what a light should show. It knows nothing about
// schedules or time: level 0 is the sleep settings, level 1 the daytime ones.

export interface LightLevels {
  sleepBrightnessPct: number;
  maxBrightnessPct: number;
  sleepColorTempKelvin: number;
  maxColorTempKelvin: number;
}

// Brightness in percent and colour temperature in kelvin, unrounded: a
// light's adapter turns them into its device's units (z2m-light for
// Zigbee2MQTT).
export interface LightStyle {
  brightnessPct: number;
  colorTempKelvin: number;
}

export function styleAtLevel(level: number, levels: LightLevels): LightStyle {
  const percent = levels.sleepBrightnessPct + (levels.maxBrightnessPct - levels.sleepBrightnessPct) * level;
  // Colour moves evenly in mireds (reciprocal megakelvin): equal mired steps
  // look evenly spaced, where equal kelvin steps would bunch up at the cool
  // end.
  const sleepMired = 1_000_000 / levels.sleepColorTempKelvin;
  const dayMired = 1_000_000 / levels.maxColorTempKelvin;
  return {
    brightnessPct: percent,
    colorTempKelvin: 1_000_000 / (sleepMired + (dayMired - sleepMired) * level)
  };
}
