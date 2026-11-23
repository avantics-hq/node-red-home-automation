"use strict";

// Turns a day level into what a light should show. It knows nothing about
// schedules or time: level 0 is the sleep settings, level 1 the daytime ones.

export interface LightLevels {
  sleepBrightnessPct: number;
  maxBrightnessPct: number;
  sleepColorTempKelvin: number;
  maxColorTempKelvin: number;
}

// Brightness on Zigbee2MQTT's 1-254 scale; colour temperature in mireds.
export interface LightStyle {
  brightness: number;
  color_temp: number;
}

export function styleAtLevel(level: number, levels: LightLevels): LightStyle {
  const percent = levels.sleepBrightnessPct + (levels.maxBrightnessPct - levels.sleepBrightnessPct) * level;
  // Colour moves evenly in mireds, the unit bulbs take: equal mired steps look
  // evenly spaced, where equal kelvin steps would bunch up at the cool end.
  const sleepMired = 1_000_000 / levels.sleepColorTempKelvin;
  const dayMired = 1_000_000 / levels.maxColorTempKelvin;
  return {
    brightness: Math.min(254, Math.max(1, Math.round(percent * 254 / 100))),
    color_temp: Math.round(sleepMired + (dayMired - sleepMired) * level)
  };
}
