"use strict";

// Powering a device whose only power command is a toggle, judged from a
// power reading (a projector lamp behind a power meter). A toggle sent at
// the wrong moment switches a warming lamp off, so the sequence is careful:
// - start: one toggle, then wait for "on", and not before the minimum
//   warm-up even if the meter already reads on;
// - shutdown: one toggle, then read the meter after shutdownConfirmMs; if it
//   is still on, the lamp wants a second, confirming toggle, then the
//   cool-down until it reads standby;
// - a reading between the bands is a lamp warming or cooling: wait for it to
//   settle, never toggle on it.
// These functions decide each step from the pending step, the reading and
// the time; the display reducer sends the commands and traces them. The
// operation names are kept as the display has always saved and reported
// them.

import type {PowerReading} from "./power-reading";

export const TOGGLE_START = "projector_start";
export const TOGGLE_SETTLE = "projector_settle";
export const TOGGLE_SHUTDOWN_OBSERVE = "projector_shutdown_observe";
export const TOGGLE_SHUTDOWN_CONFIRM = "projector_shutdown_confirm";
export const TOGGLE_COOLDOWN = "projector_cooldown";

export interface TogglePowerTiming {
  pollMs: number;
  queryTimeoutMs: number;
  warmupMs: number;
  minimumWarmupMs: number;
  shutdownConfirmMs: number;
  cooldownMs: number;
}

// A pending toggle-power step, as the display keeps it.
export interface TogglePending<Device, Command> {
  device: Device;
  operation: string;
  command: Command;
  attempt: number;
  retryable: boolean;
  deadlineAt: number;
  nextAt: number;
  readyAt?: number;
}

// Whether a toggle-power step is done, from the reading; undefined for an
// operation that isn't one of them.
export function togglePowerSatisfied(operation: string, power: PowerReading | undefined): boolean | undefined {
  switch (operation) {
    case TOGGLE_START: return power === "on";
    case TOGGLE_SETTLE: return power === "on" || power === "standby";
    case TOGGLE_SHUTDOWN_OBSERVE:
    case TOGGLE_SHUTDOWN_CONFIRM:
    case TOGGLE_COOLDOWN: return power === "standby";
    default: return undefined;
  }
}

// When a started lamp may count as on: not before the minimum warm-up.
export function startReadyAt(nowMs: number, timing: TogglePowerTiming): number {
  return nowMs + timing.minimumWarmupMs;
}

// Reading on during the minimum warm-up: when to look again, or null when
// the reading may stand.
export function holdForWarmup(pending: {operation: string; readyAt?: number; deadlineAt: number}, power: PowerReading | undefined, nowMs: number): number | null {
  if (pending.operation !== TOGGLE_START || pending.readyAt === undefined || power !== "on" || nowMs >= pending.readyAt) return null;
  return Math.min(pending.deadlineAt, pending.readyAt);
}

// The shutdown's first toggle: read the meter after shutdownConfirmMs.
export function shutdownRequestPending<Device, Command>(device: Device, command: Command, nowMs: number, timing: TogglePowerTiming): TogglePending<Device, Command> {
  return {
    device,
    operation: TOGGLE_SHUTDOWN_OBSERVE,
    command,
    attempt: 1,
    retryable: false,
    deadlineAt: nowMs + timing.shutdownConfirmMs + timing.queryTimeoutMs,
    nextAt: nowMs + timing.shutdownConfirmMs
  };
}

// Time to read the meter after the shutdown toggle: the step now waits for
// that reading, for at most queryTimeoutMs.
export function beginShutdownConfirm(pending: {operation: string; nextAt: number; deadlineAt: number}, nowMs: number, timing: TogglePowerTiming): void {
  pending.operation = TOGGLE_SHUTDOWN_CONFIRM;
  pending.nextAt = nowMs + timing.queryTimeoutMs;
  pending.deadlineAt = pending.nextAt;
}

// Still on after the shutdown toggle: it wants the confirming toggle.
export function needsShutdownConfirm(pending: {operation: string}, power: PowerReading | undefined): boolean {
  return pending.operation === TOGGLE_SHUTDOWN_CONFIRM && power === "on";
}

// After the confirming toggle: the cool-down, until it reads standby.
export function cooldownPending<Device, Command>(device: Device, command: Command, nowMs: number, timing: TogglePowerTiming): TogglePending<Device, Command> {
  return {
    device,
    operation: TOGGLE_COOLDOWN,
    command,
    attempt: 1,
    retryable: false,
    deadlineAt: nowMs + timing.cooldownMs,
    nextAt: nowMs + timing.pollMs
  };
}
