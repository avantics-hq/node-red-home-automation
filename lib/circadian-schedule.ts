"use strict";

// A daily wake and bed schedule, and how far into the day a given moment is.
// Pure: it knows nothing about lights, and takes the time it is asked about.

// After waking, the day level rises over this long; before bed it winds down
// over the three hours that evidence on evening light exposure points to
// (Brown et al. 2022, PLOS Biology).
export const WAKE_RISE_MINUTES = 60;
export const WIND_DOWN_MINUTES = 180;
// A conventional day, used until a room is given its own times.
export const DEFAULT_WAKE_TIME = "07:00";
export const DEFAULT_BED_TIME = "23:00";

const MINUTES_PER_DAY = 24 * 60;
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface DaySchedule {
  wakeTime: string;
  bedTime: string;
}

// Minutes after midnight for an "HH:MM" clock time, or null if it is not one.
export function clockMinutes(value: unknown): number | null {
  const match = typeof value === "string" ? CLOCK_TIME.exec(value.trim()) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// A usable schedule from configured times: a blank time takes its default;
// each must be "HH:MM" and they must differ.
export function resolveSchedule(wakeTime?: unknown, bedTime?: unknown): DaySchedule {
  const wake = (typeof wakeTime === "string" ? wakeTime.trim() : "") || DEFAULT_WAKE_TIME;
  const bed = (typeof bedTime === "string" ? bedTime.trim() : "") || DEFAULT_BED_TIME;
  const wakeMinutes = clockMinutes(wake);
  const bedMinutes = clockMinutes(bed);
  if (wakeMinutes === null || bedMinutes === null) throw new Error("wake and bed times must both be HH:MM (24-hour)");
  if (wakeMinutes === bedMinutes) throw new Error("wake and bed times must differ");
  return {wakeTime: wake, bedTime: bed};
}

// Ease in and out, so neither end of a ramp is a visible step.
function ease(fraction: number): number {
  return fraction * fraction * (3 - 2 * fraction);
}

// The day level, from 0 (asleep) to 1 (full day), for the given local time.
// Times wrap at midnight, so a bed time after midnight or a wake time later
// than the bed time both work. A waking day shorter than the rise and the
// wind-down together shortens both in proportion.
export function scheduleLevel(now: Date, wakeTime: string, bedTime: string): number {
  const wake = clockMinutes(wakeTime);
  const bed = clockMinutes(bedTime);
  if (wake === null || bed === null || wake === bed) throw new Error("wake and bed times must be different HH:MM times");
  const awakeMinutes = (bed - wake + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const minuteOfDay = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const sinceWake = (minuteOfDay - wake + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (sinceWake >= awakeMinutes) return 0;

  const shrink = Math.min(1, awakeMinutes / (WAKE_RISE_MINUTES + WIND_DOWN_MINUTES));
  const rise = WAKE_RISE_MINUTES * shrink;
  const windDown = WIND_DOWN_MINUTES * shrink;
  if (sinceWake < rise) return ease(sinceWake / rise);
  const untilBed = awakeMinutes - sinceWake;
  return untilBed < windDown ? ease(untilBed / windDown) : 1;
}

// New times from a "schedule" message, each "HH:MM", with a time left out
// staying as it is; null if they aren't valid, different times.
export function requestedSchedule(current: DaySchedule, event: {wakeTime?: unknown; bedTime?: unknown}): DaySchedule | null {
  const next = {
    wakeTime: typeof event.wakeTime === "string" ? event.wakeTime.trim() : current.wakeTime,
    bedTime: typeof event.bedTime === "string" ? event.bedTime.trim() : current.bedTime
  };
  const wake = clockMinutes(next.wakeTime);
  const bed = clockMinutes(next.bedTime);
  return wake === null || bed === null || wake === bed ? null : next;
}
