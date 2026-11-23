"use strict";

import {scheduleLevel, type DaySchedule} from "./circadian-schedule";
import {styleAtLevel, type LightLevels, type LightStyle} from "./light-styling";

// What the room controller asks of circadian lighting: how should a light
// look at this moment? A different curve is a different implementation.
export interface CircadianLighting {
  styleAt(now: Date, sleeping: boolean): LightStyle;
  // The same lighting on another wake and bed schedule. Required, so a
  // lighting can't silently ignore times set at runtime.
  withSchedule(schedule: DaySchedule): CircadianLighting;
}

// Circadian lighting that follows a wake and bed schedule; sleep mode holds
// the sleep settings.
export function scheduledLighting(schedule: DaySchedule, levels: LightLevels): CircadianLighting {
  return {
    styleAt(now, sleeping) {
      return styleAtLevel(sleeping ? 0 : scheduleLevel(now, schedule.wakeTime, schedule.bedTime), levels);
    },
    withSchedule(next) {
      return scheduledLighting(next, levels);
    }
  };
}
