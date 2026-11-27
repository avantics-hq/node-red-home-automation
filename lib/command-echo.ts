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
  // Power state this command sets, kept after a state report confirms it, to
  // know its echo even when something on the way rewrote the payload.
  power?: boolean;
  // The command topic echo has been seen. The entry is kept until it
  // expires, so a duplicate or late echo of the same command is still ours.
  echoed?: boolean;
  // The room's id for the command, when it gave one.
  id?: string;
  // A restyle the light's adapter may still skip: kept, but not counted
  // towards the queue's limit until the adapter says it sent it
  // (commandSent), and dropped if it says it skipped it (commandSkipped).
  tentative?: boolean;
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

// At most ECHO_QUEUE_LIMIT entries, tentative ones aside: the oldest go.
function trimmed(queue: ExpectedCommand[]): ExpectedCommand[] {
  let excess = queue.filter((entry) => entry.tentative !== true).length - ECHO_QUEUE_LIMIT;
  return queue.filter((entry) => {
    if (excess > 0 && entry.tentative !== true) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

// Remember a command just sent: with an id, the room's own; tentative for a
// restyle its adapter may skip.
export function rememberCommand(queue: ExpectedCommand[] | undefined, payload: unknown, nowMs: number,
  {id, tentative = false}: {id?: string; tentative?: boolean} = {}): ExpectedCommand[] {
  const next = live(queue, nowMs);
  const entry: ExpectedCommand = {fingerprint: fingerprint(payload), expires: nowMs + ECHO_WINDOW_MS,
    ...(id !== undefined ? {id} : {}), ...(tentative ? {tentative: true} : {})};
  const requested = payload && typeof payload === "object"
    ? String((payload as Record<string, unknown>).state || "").toUpperCase()
    : "";
  if (requested === "ON" || requested === "OFF") {
    entry.on = requested === "ON";
    entry.power = entry.on;
  }
  next.push(entry);
  return trimmed(next);
}

// A tentative command its adapter sent after all: now an ordinary entry.
export function commandSent(queue: ExpectedCommand[] | undefined, id: string, nowMs: number): ExpectedCommand[] {
  return trimmed(live(queue, nowMs).map((entry) => {
    if (entry.id !== id) return entry;
    const {tentative: _tentative, ...sent} = entry;
    return sent;
  }));
}

// A tentative command its adapter skipped: as if never sent.
export function commandSkipped(queue: ExpectedCommand[] | undefined, id: string, nowMs: number): ExpectedCommand[] {
  return live(queue, nowMs).filter((entry) => entry.id !== id);
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
  return {queue: next, verdict};
}

// A command seen on the command topic: one of ours, or someone else's.
// - Exactly a command we sent in the echo window is ours, even when its echo
//   was already seen: a duplicate or late echo.
// - A bare ON or OFF that arrives while one of our commands with that power
//   isn't echoed yet is taken as that command, changed on the way (a
//   function between the controller and MQTT out that cut the payload to
//   {"state":"ON"}, say): `changed`. That command is then marked echoed but
//   kept, so its own exact echo, if it still comes, is ours too. Without
//   this the controller answered its own command as someone else's, which
//   looped.
export function checkCommandEcho(
  queue: ExpectedCommand[] | undefined,
  payload: unknown,
  nowMs: number
): {queue: ExpectedCommand[]; own: boolean; changed: boolean} {
  const next = live(queue, nowMs);
  const print = fingerprint(payload);
  let ownIndex = next.findIndex((entry) => entry.echoed !== true && entry.fingerprint === print);
  if (ownIndex < 0) {
    const repeat = next.findIndex((entry) => entry.echoed === true && entry.fingerprint === print);
    if (repeat >= 0) return {queue: next, own: true, changed: false};
  }
  let changed = false;
  if (ownIndex < 0) {
    const requested = payload && typeof payload === "object"
      ? String((payload as Record<string, unknown>).state || "").toUpperCase()
      : "";
    if (requested === "ON" || requested === "OFF") {
      for (let index = next.length - 1; index >= 0 && ownIndex < 0; index -= 1) {
        if (next[index]!.echoed !== true && next[index]!.power === (requested === "ON")) ownIndex = index;
      }
      changed = ownIndex >= 0;
    }
  }
  const own = next[ownIndex];
  if (!own) return {queue: next, own: false, changed: false};
  // Kept until it expires: for state reports while its power is unconfirmed,
  // and to know a repeat of its echo.
  own.echoed = true;
  return {queue: next, own: true, changed};
}
