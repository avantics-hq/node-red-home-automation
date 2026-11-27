"use strict";

// The neutral light contract between the room lighting controller and the
// adapter for each light (such as the Zigbee2MQTT light): commands one way,
// readings the other, both on msg.light and each naming the room's id for
// the light as its `target`. Values are the package's own: brightness in
// percent and colour temperature in kelvin. An adapter for any other kind of
// light implements the same messages.

// A command for one light, from the room.
export interface LightCommandMessage {
  kind: "command";
  target: string;
  state: "ON" | "OFF";
  // 0-100: 0 is the dimmest the light goes, not off.
  brightnessPct?: number;
  // Above 0.
  colorTempKelvin?: number;
  // The fade, in seconds. Absent: none given.
  transitionSeconds?: number;
  // Other fields an intent gave (an effect, say), passed on as they are.
  extra?: Record<string, unknown>;
  // A restyle of a light already on, to the room's current style: an
  // adapter may skip it when the light already shows exactly that, and then
  // answers "skipped". Never set on any other command.
  restyle?: boolean;
  // Who asked (motion, a wall switch, an activity…), and the room's id for
  // this command, which a "skipped" or "echo-changed" reading names.
  source: string;
  id: string;
}

// A request for a fresh reading, as the room sends each light at startup.
export interface LightObserveMessage {
  kind: "observe";
  target: string;
}

export type LightRoomMessage = LightCommandMessage | LightObserveMessage;

// The value fields a light reports at all.
export type LightField = "brightness" | "colorTemp";

// What an adapter tells the room.
export type LightReading =
  // The light's own report. The values are the device's, converted back
  // (for people and for "does it report brightness at all"); equality is
  // judged by the adapter, as showsLast: it shows exactly the last command
  // sent to it, in the device's own units.
  | {kind: "observed"; target: string; on: boolean; brightnessPct?: number; colorTempKelvin?: number;
    fields: LightField[]; showsLast: boolean; observedAt: string}
  // Someone else's command, seen on the light's command path: its power
  // (ON, OFF, TOGGLE, or "" when it sets none), and whether it sets values.
  | {kind: "external"; target: string; state: string; setsValues: boolean; observedAt: string}
  // One of the room's own commands, seen again changed on the way (a
  // function rewrote it): never someone else's.
  | {kind: "echo-changed"; target: string; id: string | null; state: string}
  // A restyle the adapter didn't send, as the light already shows it. Its
  // time is the light's last real report's.
  | {kind: "skipped"; target: string; id: string; observedAt: string}
  // Whether the light is reachable. Shown, never acted on.
  | {kind: "availability"; target: string; online: boolean};

export function isLightReading(value: unknown): value is LightReading {
  if (!value || typeof value !== "object") return false;
  const reading = value as {kind?: unknown; target?: unknown};
  return typeof reading.target === "string" &&
    ["observed", "external", "echo-changed", "skipped", "availability"].includes(String(reading.kind));
}
