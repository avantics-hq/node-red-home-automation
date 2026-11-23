"use strict";

// Telling the room controller's own light commands from other people's.
// Each target keeps a short queue of commands it sent; the command topic's
// echo and the light's state reports are checked against it. Pure: each
// function takes a queue and returns the new one.

// How long a sent command is remembered, and how many per target.
export const ECHO_WINDOW_MS = 5000;
export const ECHO_QUEUE_LIMIT = 8;

export interface ExpectedCommand {
  fingerprint: string;
  expires: number;
  // Power state this command sets, while no state report has confirmed it yet.
  on?: boolean;
  // The command topic echo has been seen; the entry now only marks the command in flight.
  echoed?: boolean;
}

export function parsePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try { return JSON.parse(payload) as unknown; } catch { return payload; }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
  }
  return value;
}

// The same payload always gives the same fingerprint, whatever its key order.
export function fingerprint(payload: unknown): string {
  return JSON.stringify(stable(payload));
}

function live(queue: ExpectedCommand[] | undefined, nowMs: number): ExpectedCommand[] {
  return (queue || []).filter((entry) => entry.expires > nowMs).map((entry) => ({...entry}));
}

// Remember a command just sent.
export function rememberCommand(queue: ExpectedCommand[] | undefined, payload: unknown, nowMs: number): ExpectedCommand[] {
  const next = live(queue, nowMs);
  const entry: ExpectedCommand = {fingerprint: fingerprint(payload), expires: nowMs + ECHO_WINDOW_MS};
  const requested = payload && typeof payload === "object"
    ? String((payload as Record<string, unknown>).state || "").toUpperCase()
    : "";
  if (requested === "ON" || requested === "OFF") entry.on = requested === "ON";
  next.push(entry);
  return next.slice(-ECHO_QUEUE_LIMIT);
}

// What a state report means against the power commands still pending:
// - "confirms": it matches our latest pending power command, which is now
//   done, so the pending power commands are cleared;
// - "stale": it contradicts that command, which is still on its way;
// - "external": no power command is pending, so the change came from
//   someone else.
export type StateReportVerdict = "confirms" | "stale" | "external";

export function checkStateReport(
  queue: ExpectedCommand[] | undefined,
  observedOn: boolean,
  nowMs: number
): {queue: ExpectedCommand[]; verdict: StateReportVerdict} {
  const next = live(queue, nowMs);
  const latest = next.filter((entry) => entry.on !== undefined).at(-1);
  const verdict: StateReportVerdict = latest === undefined ? "external" : latest.on === observedOn ? "confirms" : "stale";
  if (verdict === "confirms") {
    for (const entry of next) delete entry.on;
  }
  return {
    queue: next.filter((entry) => entry.on !== undefined || entry.echoed !== true),
    verdict
  };
}

// A command seen on the command topic: one of ours (its first echo), or
// someone else's.
export function checkCommandEcho(
  queue: ExpectedCommand[] | undefined,
  payload: unknown,
  nowMs: number
): {queue: ExpectedCommand[]; own: boolean} {
  const next = live(queue, nowMs);
  const ownIndex = next.findIndex((entry) => entry.echoed !== true && entry.fingerprint === fingerprint(payload));
  const own = next[ownIndex];
  if (!own) return {queue: next, own: false};
  // Keep an unconfirmed power command as in flight for state reports.
  if (own.on === undefined) next.splice(ownIndex, 1);
  else own.echoed = true;
  return {queue: next, own: true};
}
