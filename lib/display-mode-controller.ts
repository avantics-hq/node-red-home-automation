"use strict";

import {boundObservedAt, isOutOfOrder, parseObservedAt} from "./observation-time";
import {asTargetStatus, targetStateEvent, type TargetStateEvent} from "./target-state";

export type DisplayMode = "off" | "tv" | "projector";
export type DisplayDevice = "tv" | "screen" | "projector";

const MODES: Record<DisplayMode, true> = {off: true, tv: true, projector: true};
const DEVICES = ["tv", "screen", "projector"] as const;

export interface DisplayConfig {
  screenOpenPosition: number;
  screenTolerance: number;
  pollMs: number;
  queryTimeoutMs: number;
  tvTimeoutMs: number;
  screenTimeoutMs: number;
  projectorWarmupMs: number;
  projectorMinimumWarmupMs: number;
  projectorShutdownConfirmMs: number;
  projectorCooldownMs: number;
  maxAttempts: number;
  projectorOnWatts: number;
  projectorOffWatts: number;
  projectorPowerFallback?: boolean;
}

interface DisplayDesired {
  requestId: string;
  generation: number;
  mode: DisplayMode;
}

interface DeviceObservation {
  observedAt: string;
  source: string;
}

interface TvObservation extends DeviceObservation {
  power: "on" | "standby";
}

interface ScreenObservation extends DeviceObservation {
  position: number;
  state: string;
}

interface ProjectorObservation extends DeviceObservation {
  watts: number;
  power: "unknown" | "on" | "standby" | "transitioning";
}

interface DisplayObserved {
  tv: TvObservation | null;
  screen: ScreenObservation | null;
  projector: ProjectorObservation | null;
}

export interface DisplayCommand {
  device: DisplayDevice;
  operation: string;
  requestId: string | null;
  generation: number;
  attempt: number;
  [key: string]: unknown;
}

interface DisplayPending {
  device: DisplayDevice;
  operation: string;
  command: DisplayCommand;
  attempt: number;
  retryable: boolean;
  deadlineAt: number;
  nextAt: number;
  readyAt?: number;
}

interface DisplayFailure {
  device: DisplayDevice;
  operation: string;
  reason: string;
  occurredAt: string;
}

export interface DisplayState {
  desired: DisplayDesired | null;
  generation: number;
  phase: string;
  observed: DisplayObserved;
  seen: Record<DisplayDevice, boolean>;
  querying: Record<DisplayDevice, boolean>;
  pending: DisplayPending | null;
  failure: DisplayFailure | null;
  blockedGeneration: number | null;
  classification: "manual_override" | null;
  lastAttempt: number;
  fallbackUsed: boolean;
}

export type DisplayInputEvent =
  | {kind: "startup"}
  | {kind: "intent"; requestId: string; generation: number; mode: DisplayMode}
  | {
    kind: "observed";
    device: DisplayDevice;
    generation?: number;
    observedAt?: string;
    source?: string;
    power?: string;
    position?: number;
    state?: string;
    watts?: number;
  }
  | {
    kind: "transport_failed";
    device: DisplayDevice;
    operation: string;
    generation?: number;
    reason?: string;
  }
  | {kind: "tick"; generation?: number}
  | {kind: "refresh"};

export interface DisplayMessage {
  display?: DisplayInputEvent;
}

export type DisplayTargetState = TargetStateEvent<"display", Record<string, unknown>, DisplayFailure>;

export interface DisplayOutputEvent {
  display: Record<string, unknown>;
}

function iso(now: Date): string {
  return now.toISOString();
}

function initialState(saved: Partial<DisplayState> = {}): DisplayState {
  return {
    desired: saved.desired || null,
    generation: Number.isInteger(saved.generation) ? saved.generation! : 0,
    phase: saved.phase || "idle",
    observed: saved.observed || {tv: null, screen: null, projector: null},
    seen: saved.seen || {tv: false, screen: false, projector: false},
    querying: saved.querying || {tv: false, screen: false, projector: false},
    pending: saved.pending || null,
    failure: saved.failure || null,
    blockedGeneration: saved.blockedGeneration || null,
    classification: saved.classification === "manual_override" ? "manual_override" : null,
    lastAttempt: Number.isInteger(saved.lastAttempt) && (saved.lastAttempt ?? -1) >= 0
      ? saved.lastAttempt!
      : 0,
    fallbackUsed: saved.fallbackUsed === true
  };
}

export function classifyProjectorPower(
  watts: number,
  previous: ProjectorObservation["power"] = "unknown",
  config: Partial<DisplayConfig> = {}
): ProjectorObservation["power"] {
  const onWatts = Number(config.projectorOnWatts ?? 20);
  const offWatts = Number(config.projectorOffWatts ?? 10);
  if (!Number.isFinite(watts) || watts < 0) return "unknown";
  if (watts >= onWatts) return "on";
  if (watts <= offWatts) return "standby";
  return previous === "on" || previous === "standby" ? previous : "transitioning";
}

function statusFor(state: DisplayState) {
  const mode = state.desired?.mode || "none";
  const text = state.phase === "failed"
    ? `${mode}: ${state.failure?.reason || "failed"}`
    : `${mode}: ${state.phase}`;
  return {phase: state.phase, text};
}

function displayEvent(
  kind: string,
  state: DisplayState,
  details: Record<string, unknown> = {}
): DisplayOutputEvent {
  return {
    display: {
      kind,
      requestId: state.desired?.requestId || null,
      generation: state.desired?.generation || state.generation,
      mode: state.desired?.mode || null,
      ...details
    }
  };
}

function commandFor(
  state: DisplayState,
  device: DisplayDevice,
  operation: string,
  values: Record<string, unknown> = {},
  attempt = 1
): DisplayCommand {
  return {
    device,
    operation,
    requestId: state.desired?.requestId || null,
    generation: state.desired?.generation || state.generation,
    attempt,
    ...values
  };
}

function queryFor(state: DisplayState, device: DisplayDevice): DisplayCommand {
  const operation = device === "screen" ? "query_position" : "query_power";
  return commandFor(state, device, operation);
}

function allSeen(state: DisplayState): boolean {
  return DEVICES.every((device) => state.seen[device]);
}

function screenAtPosition(
  observed: ScreenObservation | null,
  target: number,
  tolerance: number
): boolean {
  if (!observed || !Number.isFinite(observed.position)) return false;
  if (observed.state === "opening" || observed.state === "closing") return false;
  return Math.abs(observed.position - target) <= tolerance;
}

function operationSatisfied(
  operation: string,
  observed: DisplayObserved,
  config: DisplayConfig
): boolean {
  switch (operation) {
    case "tv_on": return observed.tv?.power === "on";
    case "tv_standby": return observed.tv?.power === "standby";
    case "screen_open": return screenAtPosition(observed.screen, config.screenOpenPosition, config.screenTolerance);
    case "screen_close": return screenAtPosition(observed.screen, 0, config.screenTolerance);
    case "projector_start": return observed.projector?.power === "on";
    case "projector_settle": return observed.projector?.power === "on" || observed.projector?.power === "standby";
    case "projector_shutdown_observe":
    case "projector_shutdown_confirm":
    case "projector_cooldown": return observed.projector?.power === "standby";
    default: return false;
  }
}

// A finite number, or the default for missing or unusable input.
function setting(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normaliseConfig(config: Partial<DisplayConfig> = {}): DisplayConfig {
  const projectorWarmupMs = Math.max(1000, setting(config.projectorWarmupMs, 60000));
  return {
    screenOpenPosition: setting(config.screenOpenPosition, 82),
    screenTolerance: Math.max(0, setting(config.screenTolerance, 2)),
    pollMs: Math.max(250, setting(config.pollMs, 2000)),
    queryTimeoutMs: Math.max(1000, setting(config.queryTimeoutMs, 5000)),
    tvTimeoutMs: Math.max(1000, setting(config.tvTimeoutMs, 30000)),
    screenTimeoutMs: Math.max(1000, setting(config.screenTimeoutMs, 65000)),
    projectorWarmupMs,
    projectorMinimumWarmupMs: Math.min(
      projectorWarmupMs,
      Math.max(0, setting(config.projectorMinimumWarmupMs, 15000))
    ),
    projectorShutdownConfirmMs: Math.max(1000, setting(config.projectorShutdownConfirmMs, 5000)),
    projectorCooldownMs: Math.max(1000, setting(config.projectorCooldownMs, 120000)),
    maxAttempts: Math.max(1, Math.floor(setting(config.maxAttempts, 2))),
    projectorOnWatts: setting(config.projectorOnWatts, 20),
    projectorOffWatts: setting(config.projectorOffWatts, 10),
    projectorPowerFallback: config.projectorPowerFallback === true
  };
}

function modeSatisfied(state: DisplayState, config: DisplayConfig): boolean {
  if (!state.desired || !allSeen(state)) return false;
  if (state.desired.mode === "tv") {
    return state.observed.tv?.power === "on" &&
      state.observed.projector?.power === "standby" &&
      screenAtPosition(state.observed.screen, 0, config.screenTolerance);
  }
  if (state.desired.mode === "projector") {
    return state.observed.tv?.power === "standby" &&
      state.observed.projector?.power === "on" &&
      screenAtPosition(state.observed.screen, config.screenOpenPosition, config.screenTolerance);
  }
  return state.observed.tv?.power === "standby" &&
    state.observed.projector?.power === "standby" &&
    screenAtPosition(state.observed.screen, 0, config.screenTolerance);
}

export function transitionDisplay(
  saved: Partial<DisplayState> | undefined,
  msg: DisplayMessage,
  suppliedConfig: Partial<DisplayConfig> = {},
  now = new Date()
) {
  const config = normaliseConfig(suppliedConfig);
  const state = initialState(saved);
  const previousPhase = state.phase;
  // Set when a device reading is stored: only then may a settled display
  // report itself ready again.
  let observationAccepted = false;
  const event = msg?.display;
  const commands: DisplayCommand[] = [];
  const events: DisplayOutputEvent[] = [];
  const targetStates: Array<{theatre: DisplayTargetState}> = [];
  const traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [];

  function trace(name: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) {
    traces.push({event: name, outcome, reason, details});
  }

  function fail(device: DisplayDevice, operation: string, reason: string) {
    state.pending = null;
    state.phase = "failed";
    state.blockedGeneration = state.desired?.generation || state.generation;
    state.failure = {device, operation, reason, occurredAt: iso(now)};
    events.push(displayEvent("failed", state, {failure: state.failure}));
    trace("transition", "failed", reason, {device, operation});
  }

  function issue(device: DisplayDevice, operation: string, command: DisplayCommand, timeoutMs: number, retryable = true) {
    const attempt = command.attempt || 1;
    state.pending = {
      device,
      operation,
      command,
      attempt,
      retryable,
      deadlineAt: now.getTime() + timeoutMs,
      nextAt: now.getTime() + config.pollMs
    };
    state.phase = "transitioning";
    commands.push(command);
    trace("command", "emitted", null, {device, operation, attempt});
    state.lastAttempt = Math.max(state.lastAttempt, attempt);
    if (device === "projector" && operation.startsWith("projector_") &&
      config.projectorPowerFallback) {
      state.fallbackUsed = true;
    }
  }

  function issueTv(power: "on" | "standby") {
    const operation = power === "on" ? "tv_on" : "tv_standby";
    issue("tv", operation, commandFor(state, "tv", "set_power", {power}), config.tvTimeoutMs);
  }

  function issueScreen(position: number) {
    const operation = position === 0 ? "screen_close" : "screen_open";
    issue("screen", operation, commandFor(state, "screen", "set_position", {position}), config.screenTimeoutMs);
  }

  function issueProjectorStart() {
    issue(
      "projector",
      "projector_start",
      commandFor(state, "projector", "power_toggle", {reason: "start"}),
      config.projectorWarmupMs,
      false
    );
    if (!state.pending) throw new Error("projector start did not create pending state");
    state.pending.readyAt = now.getTime() + config.projectorMinimumWarmupMs;
  }

  function issueProjectorShutdown() {
    const command = commandFor(state, "projector", "power_toggle", {reason: "shutdown-request"});
    state.pending = {
      device: "projector",
      operation: "projector_shutdown_observe",
      command,
      attempt: 1,
      retryable: false,
      deadlineAt: now.getTime() + config.projectorShutdownConfirmMs + config.queryTimeoutMs,
      nextAt: now.getTime() + config.projectorShutdownConfirmMs
    };
    state.phase = "transitioning";
    commands.push(command);
    trace("command", "emitted", null, {device: "projector", operation: "shutdown-request", attempt: 1});
    state.lastAttempt = Math.max(state.lastAttempt, 1);
    if (config.projectorPowerFallback) state.fallbackUsed = true;
  }

  function beginDiscovery() {
    state.phase = "discovering";
    for (const device of DEVICES) {
      if (!state.seen[device] && !state.querying[device]) {
        state.querying[device] = true;
        commands.push(queryFor(state, device));
      }
    }
  }

  // A reading between projectorOffWatts and projectorOnWatts is a lamp warming
  // up or cooling down: re-query at pollMs until it settles, never toggle on it.
  // Either phase may legitimately last up to its own timeout.
  function awaitProjectorPower() {
    state.pending = {
      device: "projector",
      operation: "projector_settle",
      command: queryFor(state, "projector"),
      attempt: 1,
      retryable: false,
      deadlineAt: now.getTime() + Math.max(config.projectorWarmupMs, config.projectorCooldownMs),
      nextAt: now.getTime() + config.pollMs
    };
    state.phase = "transitioning";
    trace("projector", "settling", null, {watts: state.observed.projector?.watts ?? null});
  }

  function markReady() {
    if (state.phase !== "ready") {
      state.phase = "ready";
      state.failure = null;
      events.push(displayEvent("ready", state));
      trace("transition", "ready");
    }
    state.classification = null;
  }

  function reconcile() {
    if (!state.desired) {
      state.phase = allSeen(state) ? "idle" : state.phase;
      return;
    }
    if (state.blockedGeneration === state.desired.generation) {
      state.phase = "failed";
      return;
    }
    if (state.classification === "manual_override") {
      state.phase = "manual_override";
      return;
    }
    if (state.pending) return;
    if (!allSeen(state)) {
      beginDiscovery();
      return;
    }

    const mode = state.desired.mode;
    if (mode === "tv") {
      if (state.observed.tv?.power !== "on") return issueTv("on");
      if (state.observed.projector?.power !== "standby") {
        if (state.observed.projector?.power === "on") return issueProjectorShutdown();
        return awaitProjectorPower();
      }
      if (!screenAtPosition(state.observed.screen, 0, config.screenTolerance)) return issueScreen(0);
      return markReady();
    }

    if (mode === "projector") {
      if (state.observed.tv?.power !== "standby") return issueTv("standby");
      if (!screenAtPosition(state.observed.screen, config.screenOpenPosition, config.screenTolerance)) {
        return issueScreen(config.screenOpenPosition);
      }
      if (state.observed.projector?.power !== "on") {
        if (state.observed.projector?.power === "standby") return issueProjectorStart();
        return awaitProjectorPower();
      }
      return markReady();
    }

    if (state.observed.tv?.power !== "standby") return issueTv("standby");
    if (state.observed.projector?.power !== "standby") {
      if (state.observed.projector?.power === "on") return issueProjectorShutdown();
      return awaitProjectorPower();
    }
    if (!screenAtPosition(state.observed.screen, 0, config.screenTolerance)) return issueScreen(0);
    return markReady();
  }

  function acceptObservation(event: Extract<DisplayInputEvent, {kind: "observed"}>) {
    const device = event.device;
    if (!DEVICES.includes(device)) throw new Error("unknown display observation device");
    if (Number.isInteger(event.generation) && state.desired && event.generation !== state.desired.generation) {
      trace("observation", "ignored", "stale-generation", {device, generation: event.generation});
      return;
    }
    // A future time counts as now; a reading older than the stored one (an
    // overlapping poll answering late) is ignored.
    const reportedMs = event.observedAt ? parseObservedAt(event.observedAt) : null;
    const bounded = reportedMs === null ? null : boundObservedAt(event.observedAt!, reportedMs, now.getTime());
    if (bounded?.skewed) {
      trace("observation", "adjusted", "clock-skew", {device, reported: event.observedAt, usedAt: bounded.observedAt});
    }
    const observedAt = bounded ? bounded.observedAt : event.observedAt || iso(now);
    if (isOutOfOrder(parseObservedAt(observedAt) ?? now.getTime(), state.observed[device]?.observedAt, now.getTime())) {
      trace("observation", "ignored", "out-of-order", {device});
      return;
    }
    const source = event.source || "unknown";
    if (device === "tv") {
      if (event.power !== "on" && event.power !== "standby") throw new Error("invalid TV power observation");
      state.observed.tv = {power: event.power, observedAt, source};
    } else if (device === "screen") {
      const position = Number(event.position);
      if (!Number.isFinite(position) || position < 0 || position > 100) throw new Error("invalid screen position");
      state.observed.screen = {position, state: event.state || "unknown", observedAt, source};
    } else {
      const watts = Number(event.watts);
      if (!Number.isFinite(watts) || watts < 0) throw new Error("invalid projector power observation");
      const previous = state.observed.projector?.power || "unknown";
      state.observed.projector = {
        watts,
        power: classifyProjectorPower(watts, previous, config),
        observedAt,
        source
      };
    }
    state.seen[device] = true;
    observationAccepted = true;
    state.querying[device] = false;
    trace("observation", "accepted", null, {device});

    if (state.phase === "ready" && !state.pending && state.desired &&
      allSeen(state) && !modeSatisfied(state, config)) {
      state.phase = "manual_override";
      state.classification = "manual_override";
      events.push(displayEvent("manual_override", state, {device}));
      trace("observation", "manual_override", null, {device});
      return;
    }

    if (!state.pending || state.pending.device !== device) return reconcile();
    if (state.pending.operation === "projector_start" &&
      state.pending.readyAt !== undefined &&
      state.observed.projector?.power === "on" && now.getTime() < state.pending.readyAt) {
      state.pending.nextAt = Math.min(state.pending.deadlineAt, state.pending.readyAt);
      return;
    }
    if (operationSatisfied(state.pending.operation, state.observed, config)) {
      state.pending = null;
      return reconcile();
    }
    if (state.pending.operation === "projector_shutdown_confirm" && device === "projector") {
      if (state.observed.projector?.power === "on") {
        const command = commandFor(state, "projector", "power_toggle", {reason: "shutdown-confirm"});
        commands.push(command);
        state.pending = {
          device: "projector",
          operation: "projector_cooldown",
          command,
          attempt: 1,
          retryable: false,
          deadlineAt: now.getTime() + config.projectorCooldownMs,
          nextAt: now.getTime() + config.pollMs
        };
        trace("command", "emitted", null, {device: "projector", operation: "shutdown-confirm", attempt: 1});
        state.lastAttempt = Math.max(state.lastAttempt, 1);
        if (config.projectorPowerFallback) state.fallbackUsed = true;
      }
    }
  }

  function handleTick(event: Extract<DisplayInputEvent, {kind: "tick"}>) {
    const pending = state.pending;
    if (!pending) return reconcile();
    if (Number.isInteger(event.generation) && state.desired && event.generation !== state.desired.generation) {
      trace("timer", "ignored", "stale-generation", {generation: event.generation});
      return;
    }
    if (now.getTime() < pending.nextAt) return;

    if (pending.operation === "projector_shutdown_observe") {
      commands.push(queryFor(state, "projector"));
      pending.operation = "projector_shutdown_confirm";
      pending.nextAt = now.getTime() + config.queryTimeoutMs;
      pending.deadlineAt = pending.nextAt;
      trace("command", "emitted", null, {device: "projector", operation: "query-before-confirm", attempt: 1});
      return;
    }

    if (now.getTime() >= pending.deadlineAt) {
      if (pending.retryable && pending.attempt < config.maxAttempts) {
        const attempt = pending.attempt + 1;
        const retried = {...pending.command, attempt};
        commands.push(retried);
        pending.command = retried;
        pending.attempt = attempt;
        const timeout = pending.device === "tv" ? config.tvTimeoutMs : config.screenTimeoutMs;
        pending.deadlineAt = now.getTime() + timeout;
        pending.nextAt = now.getTime() + config.pollMs;
        trace("command", "retried", null, {device: pending.device, operation: pending.operation, attempt});
        state.lastAttempt = Math.max(state.lastAttempt, attempt);
        return;
      }
      return fail(
        pending.device,
        pending.operation,
        pending.operation === "projector_settle" ? "projector-power-unsettled" : "confirmation-timeout"
      );
    }

    commands.push(queryFor(state, pending.device));
    pending.nextAt = Math.min(pending.deadlineAt, now.getTime() + config.pollMs);
    trace("command", "emitted", null, {device: pending.device, operation: "confirmation-query"});
  }

  if (!event || typeof event.kind !== "string") throw new Error("msg.display.kind is required");

  if (event.kind === "startup") {
    // A projector power operation in flight cannot be repeated safely (a
    // second toggle can switch a warming lamp off), so it survives startup
    // and is only re-observed; everything else is rediscovered.
    const inFlight = state.pending && !state.pending.retryable ? state.pending : null;
    state.pending = null;
    state.seen = {tv: false, screen: false, projector: false};
    state.querying = {tv: false, screen: false, projector: false};
    beginDiscovery();
    if (inFlight) {
      const deadlineAt = Math.max(inFlight.deadlineAt, now.getTime() + config.queryTimeoutMs);
      state.pending = {...inFlight, deadlineAt, nextAt: Math.min(deadlineAt, now.getTime() + config.pollMs)};
      state.phase = "transitioning";
    }
    trace("startup", "querying", inFlight ? "projector-operation-kept" : null);
  } else if (event.kind === "intent") {
    if (!Object.hasOwn(MODES, event.mode)) throw new Error("display mode must be off, tv or projector");
    if (typeof event.requestId !== "string" || !event.requestId) throw new Error("display requestId is required");
    if (!Number.isInteger(event.generation) || event.generation < 1) throw new Error("display generation must be a positive integer");

    if (event.generation < state.generation) {
      events.push(displayEvent("rejected", state, {reason: "stale-generation"}));
      trace("intent", "rejected", "stale-generation");
    } else if (event.generation === state.generation && state.desired) {
      const same = state.desired.requestId === event.requestId && state.desired.mode === event.mode;
      if (!same) {
        events.push(displayEvent("rejected", state, {reason: "request-conflict"}));
        trace("intent", "rejected", "request-conflict");
      }
    } else {
      if (state.desired && state.phase !== "ready") {
        events.push(displayEvent("superseded", state, {supersededBy: event.requestId}));
      }
      state.desired = {requestId: event.requestId, generation: event.generation, mode: event.mode};
      state.generation = event.generation;
      state.failure = null;
      state.classification = null;
      state.lastAttempt = 0;
      state.fallbackUsed = false;
      state.blockedGeneration = null;
      state.pending = null;
      state.seen = {tv: false, screen: false, projector: false};
      state.querying = {tv: false, screen: false, projector: false};
      beginDiscovery();
      trace("intent", "accepted", null, {mode: event.mode});
    }
  } else if (event.kind === "observed") {
    acceptObservation(event);
  } else if (event.kind === "transport_failed") {
    if (Number.isInteger(event.generation) && state.desired && event.generation !== state.desired.generation) {
      trace("transport", "ignored", "stale-generation", {device: event.device});
    } else if (state.querying[event.device]) {
      state.querying[event.device] = false;
      fail(event.device, event.operation, event.reason || "transport-failed");
    } else if (state.pending && state.pending.device === event.device &&
      state.pending.command.operation === event.operation) {
      if (state.pending.retryable && state.pending.attempt < config.maxAttempts) {
        const attempt = state.pending.attempt + 1;
        const retried = {...state.pending.command, attempt};
        state.pending.command = retried;
        state.pending.attempt = attempt;
        commands.push(retried);
        trace("command", "retried", event.reason || "transport-failed", {
          device: event.device, operation: state.pending.operation, attempt
        });
        state.lastAttempt = Math.max(state.lastAttempt, attempt);
      } else {
        fail(event.device, state.pending.operation, event.reason || "transport-failed");
      }
    } else {
      trace("transport", "ignored", "confirmation-query-failed", {device: event.device});
    }
  } else if (event.kind === "tick") {
    handleTick(event);
  } else if (event.kind === "refresh") {
    // Re-confirm a settled display from fresh readings; its target state
    // follows them. These queries are not discovery, so a failed one is
    // ignored rather than failing the request.
    if (state.desired && state.phase === "ready" && !state.pending) {
      for (const device of DEVICES) commands.push(queryFor(state, device));
      trace("refresh", "querying");
    } else {
      trace("refresh", "reported", null, {phase: state.phase});
    }
  } else {
    throw new Error("unknown display event kind");
  }

  // The theatre activity controller's view of this target. A settled display
  // reports ready only with a reading taken in this event, stamped with the
  // oldest of the device readings every mode relies on, so it is only as
  // fresh as its least recent confirmation.
  if (state.desired) {
    const readings = DEVICES.map((device) => parseObservedAt(state.observed[device]?.observedAt));
    const confirmedMs = readings.every((ms): ms is number => ms !== null) ? Math.min(...readings) : null;
    const status = state.phase === "manual_override"
      ? "transitioning"
      : asTargetStatus(state.phase, "confirming");
    if (!(status === "ready" && previousPhase === "ready" && !observationAccepted)) {
      const theatre: DisplayTargetState = targetStateEvent({
        target: "display",
        requestId: state.desired.requestId,
        generation: state.desired.generation,
        status,
        observedAt: status === "ready" && confirmedMs !== null ? new Date(confirmedMs).toISOString() : now.toISOString(),
        details: {
          mode: state.desired.mode,
          observed: {
            tv: state.observed.tv?.power ?? null,
            screen: state.observed.screen?.position ?? null,
            projector: state.observed.projector?.power ?? null
          },
          recovery: {mode: state.phase === "ready" ? state.desired.mode : null},
          metrics: {
            attempts: state.lastAttempt,
            retries: Math.max(0, state.lastAttempt - 1),
            fallbackUsed: state.fallbackUsed
          }
        },
        classification: state.classification,
        failure: state.failure
      });
      targetStates.push({theatre});
    }
  }

  events.unshift(displayEvent("state", state, {
    phase: state.phase,
    observed: state.observed,
    failure: state.failure,
    classification: state.classification,
    metrics: {
      attempts: state.lastAttempt,
      retries: Math.max(0, state.lastAttempt - 1),
      fallbackUsed: state.fallbackUsed
    }
  }));
  return {state, commands, events, targetStates, traces, status: statusFor(state)};
}
