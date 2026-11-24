"use strict";

// What a power meter's reading says about a device: on at or above
// onWatts, in standby at or below offWatts. Between the two the device is
// warming up or cooling down: it keeps its last settled state, or is
// transitioning if it had none. Any device with a power meter in front of
// it can be read this way, not only a projector lamp.

export type PowerReading = "unknown" | "on" | "standby" | "transitioning";

export function classifyPower(
  watts: number,
  previous: PowerReading = "unknown",
  bands: {onWatts: number; offWatts: number}
): PowerReading {
  if (!Number.isFinite(watts) || watts < 0) return "unknown";
  if (watts >= bands.onWatts) return "on";
  if (watts <= bands.offWatts) return "standby";
  return previous === "on" || previous === "standby" ? previous : "transitioning";
}
