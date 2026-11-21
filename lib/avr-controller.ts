"use strict";

export const QUERY_COMMAND = "PW?\rZM?\rSI?\rMV?\r";

export type AvrPower = "on" | "standby";
export type MainZone = "on" | "off";
export type AvrField = "power" | "mainZone" | "source" | "volume";

export interface AvrConfig {
  area: string;
  sources: Record<string, string>;
  retryMs: number;
  maxAttempts: number;
}

export interface AvrObserved {
  power: AvrPower | null;
  mainZone: MainZone | null;
  source: string | null;
  sourceCode: string | null;
  volume: number | null;
  at: string | null;
}

export interface AvrDesired {
  requestId: string;
  generation: number;
  power: AvrPower;
  source: string | null;
}

export interface AvrPending {
  operation: string;
  payload: string;
  attempt: number;
  deadlineAt: number;
}

export interface AvrFailure {
  operation: string;
  attempts: number;
  at: string;
}

export interface AvrState {
  observed: AvrObserved;
  seen: Record<AvrField, boolean>;
  desired: AvrDesired | null;
  generation: number;
  pending: AvrPending | null;
  phase: string;
  failure: AvrFailure | null;
  blockedGeneration: number | null;
  querySentAt: number | null;
  classification: "manual_override" | null;
  lastAttempt: number;
}

export type AvrInputEvent =
  | {kind: "startup" | "refresh"}
  | {kind: "observed"; line?: unknown}
  | {
    kind: "intent";
    requestId: string;
    generation: number;
    power: AvrPower;
    source?: string | null;
  }
  | {kind: "tick"};

export interface AvrMessage {
  avr?: AvrInputEvent;
  payload?: unknown;
}

export interface AvrCommand {
  payload: string;
  avrCommand: {
    area: string;
    operation: string;
    requestId: string | null;
    generation: number;
    attempt: number;
  };
}

export interface AvrOutputEvent {
  payload?: unknown;
  avr: {
    kind: string;
    reason?: string;
    [key: string]: unknown;
  };
}

export type ParsedAvrLine =
  | {field: "power"; value: AvrPower; line: string}
  | {field: "mainZone"; value: MainZone; line: string}
  | {field: "source"; value: string | null; sourceCode: string; line: string}
  | {field: "volume"; value: number | null; line: string};

function parseSources(value: unknown): Record<string, string> {
  const sources = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const entries = Object.entries(sources);
  if (entries.some(([name, code]) =>
    !name ||
    !code || typeof code !== "string" ||
    !/^[A-Z0-9][A-Z0-9 /._-]*$/.test(code)
  )) {
    throw new Error("sources must map names to Denon source codes");
  }
  const typedEntries = entries as Array<[string, string]>;
  if (new Set(typedEntries.map(([, code]) => code)).size !== typedEntries.length) {
    throw new Error("Denon source codes must be unique");
  }
  return Object.fromEntries(typedEntries);
}

export function createAvrState(
  _config: AvrConfig,
  saved: Partial<AvrState> = {}
): AvrState {
  const observed = saved.observed || {} as Partial<AvrObserved>;
  const seen = saved.seen || {} as Partial<Record<AvrField, boolean>>;
  return {
    observed: {
      power: observed.power === "on" || observed.power === "standby" ? observed.power : null,
      mainZone: observed.mainZone === "on" || observed.mainZone === "off" ? observed.mainZone : null,
      source: typeof observed.source === "string" ? observed.source : null,
      sourceCode: typeof observed.sourceCode === "string" ? observed.sourceCode : null,
      volume: Number.isFinite(observed.volume) ? observed.volume! : null,
      at: typeof observed.at === "string" ? observed.at : null
    },
    seen: {
      power: seen.power === true,
      mainZone: seen.mainZone === true,
      source: seen.source === true,
      volume: seen.volume === true
    },
    desired: saved.desired && typeof saved.desired === "object" ? {...saved.desired} : null,
    generation: Number.isInteger(saved.generation) && (saved.generation ?? -1) >= 0 ? saved.generation! : 0,
    pending: saved.pending && typeof saved.pending === "object" ? {...saved.pending} : null,
    phase: typeof saved.phase === "string" ? saved.phase : "unknown",
    failure: saved.failure && typeof saved.failure === "object" ? {...saved.failure} : null,
    blockedGeneration: Number.isInteger(saved.blockedGeneration) ? saved.blockedGeneration! : null,
    querySentAt: Number.isFinite(saved.querySentAt) ? saved.querySentAt! : null,
    classification: saved.classification === "manual_override" ? "manual_override" : null,
    lastAttempt: Number.isInteger(saved.lastAttempt) && (saved.lastAttempt ?? -1) >= 0
      ? saved.lastAttempt!
      : 0
  };
}

function parseVolume(raw: string): number | null {
  if (!/^\d{2,3}$/.test(raw)) return null;
  if (raw.length === 2) return Number(raw);
  return Number(raw.slice(0, 2)) + Number(raw.slice(2)) / 10;
}

export function parseAvrLine(
  value: unknown,
  sources: Record<string, string>
): ParsedAvrLine | null {
  const line = String(value ?? "").trim();
  if (line === "PWON") return {field: "power", value: "on", line};
  if (line === "PWOFF" || line === "PWSTANDBY") {
    return {field: "power", value: "standby", line};
  }
  if (line === "ZMON") return {field: "mainZone", value: "on", line};
  if (line === "ZMOFF") return {field: "mainZone", value: "off", line};
  if (/^SI.+/.test(line)) {
    const sourceCode = line.slice(2);
    const source = Object.entries(sources).find(([, code]) => code === sourceCode)?.[0] || null;
    return {field: "source", value: source, sourceCode, line};
  }
  if (/^MV\d{2,3}$/.test(line)) {
    return {field: "volume", value: parseVolume(line.slice(2)), line};
  }
  return null;
}

export function transitionAvr(
  saved: Partial<AvrState> | undefined,
  msg: AvrMessage,
  rawConfig: Partial<AvrConfig>,
  nowValue: Date | string | number = new Date()
) {
  const config = {
    area: rawConfig.area || "room",
    sources: parseSources(rawConfig.sources),
    retryMs: Math.max(250, Number(rawConfig.retryMs) || 2000),
    maxAttempts: Math.max(1, Math.floor(Number(rawConfig.maxAttempts) || 3))
  };
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const nowMs = now.getTime();
  const state = createAvrState(config, saved);
  const commands: AvrCommand[] = [];
  const events: AvrOutputEvent[] = [];
  const traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [];
  const event: AvrInputEvent | {kind: "unknown"} = msg.avr || {kind: "unknown"};
  const before = JSON.stringify({
    observed: state.observed,
    seen: state.seen,
    desired: state.desired,
    generation: state.generation,
    pending: state.pending,
    phase: state.phase,
    failure: state.failure,
    blockedGeneration: state.blockedGeneration,
    classification: state.classification,
    lastAttempt: state.lastAttempt
  });
  let forceStateEvent = false;

  function trace(name: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) {
    traces.push({event: name, outcome, reason, details});
  }

  function requiredFields(): AvrField[] {
    if (!state.desired) return [];
    if (state.desired.power === "standby") return ["power"];
    const fields: AvrField[] = ["power", "mainZone"];
    if (state.desired.source) fields.push("source");
    return fields;
  }

  function hasFreshTargetState() {
    return requiredFields().every((field) => state.seen[field] === true);
  }

  function desiredSourceCode() {
    return state.desired?.source ? config.sources[state.desired.source] : null;
  }

  function targetSatisfied() {
    if (!state.desired || !hasFreshTargetState()) return false;
    if (state.desired.power === "standby") return state.observed.power === "standby";
    return state.observed.power === "on" &&
      state.observed.mainZone === "on" &&
      (!state.desired.source || state.observed.sourceCode === desiredSourceCode());
  }

  function operationSatisfied(operation: string): boolean {
    if (operation === "query") return hasFreshTargetState();
    if (operation === "power-on") return state.seen.power && state.observed.power === "on";
    if (operation === "main-zone-on") return state.seen.mainZone && state.observed.mainZone === "on";
    if (operation === "source") {
      return state.seen.source && state.observed.sourceCode === desiredSourceCode();
    }
    if (operation === "standby") return state.seen.power && state.observed.power === "standby";
    return false;
  }

  function emitCommand(operation: string, payload: string, attempt: number) {
    commands.push({
      payload,
      avrCommand: {
        area: config.area,
        operation,
        requestId: state.desired?.requestId || null,
        generation: state.desired?.generation ?? state.generation,
        attempt
      }
    });
    state.pending = {
      operation,
      payload,
      attempt,
      deadlineAt: nowMs + config.retryMs
    };
    state.phase = operation === "query" ? "discovering" : "transitioning";
    trace("command", "emitted", null, {operation, attempt});
    state.lastAttempt = Math.max(state.lastAttempt, attempt);
  }

  function ready() {
    const desired = state.desired;
    if (!desired) throw new Error("AVR cannot become ready without desired state");
    const changed = state.phase !== "ready";
    state.pending = null;
    state.phase = "ready";
    state.failure = null;
    state.blockedGeneration = null;
    if (changed) {
      events.push({
        avr: {
          kind: "ready",
          area: config.area,
          requestId: desired.requestId,
          generation: desired.generation
        }
      });
      trace("request", "ready", null, {
        requestId: desired.requestId,
        generation: desired.generation
      });
    }
  }

  function reconcile(allowQuery = true) {
    if (!state.desired) {
      state.pending = null;
      state.phase = Object.values(state.seen).some(Boolean) ? "idle" : "discovering";
      return;
    }

    if (state.classification === "manual_override") {
      state.pending = null;
      state.phase = "manual_override";
      return;
    }
    if (!state.pending && state.phase === "ready" && hasFreshTargetState() && !targetSatisfied()) {
      state.classification = "manual_override";
      state.phase = "manual_override";
      events.push({
        avr: {
          kind: "manual_override",
          area: config.area,
          requestId: state.desired.requestId,
          generation: state.desired.generation,
          observed: {...state.observed}
        }
      });
      trace("observation", "manual_override");
      return;
    }

    if (state.pending && operationSatisfied(state.pending.operation)) state.pending = null;
    if (targetSatisfied()) {
      ready();
      return;
    }
    if (state.blockedGeneration === state.desired.generation) return;
    if (state.pending) return;

    if (!hasFreshTargetState()) {
      state.phase = "discovering";
      if (allowQuery) emitCommand("query", QUERY_COMMAND, 1);
      return;
    }

    if (state.desired.power === "standby") {
      emitCommand("standby", "PWSTANDBY\r", 1);
    } else if (state.observed.power !== "on") {
      emitCommand("power-on", "PWON\r", 1);
    } else if (state.observed.mainZone !== "on") {
      emitCommand("main-zone-on", "ZMON\r", 1);
    } else if (state.desired.source && state.observed.sourceCode !== desiredSourceCode()) {
      emitCommand("source", "SI" + desiredSourceCode() + "\r", 1);
    }
  }

  function validateIntent(intent: Extract<AvrInputEvent, {kind: "intent"}>): string | null {
    if (!intent.requestId || typeof intent.requestId !== "string") return "missing-request-id";
    if (!Number.isInteger(intent.generation) || intent.generation < 1) return "invalid-generation";
    if (intent.power !== "on" && intent.power !== "standby") return "invalid-power";
    if (intent.power === "standby" && intent.source) return "source-with-standby";
    if (intent.source && !Object.hasOwn(config.sources, intent.source)) return "unknown-source";
    return null;
  }

  if (event.kind === "startup" || event.kind === "refresh") {
    const requestBlocked = state.desired &&
      state.blockedGeneration === state.desired.generation;
    state.seen = {power: false, mainZone: false, source: false, volume: false};
    state.pending = null;
    state.phase = requestBlocked ? "failed" : "discovering";
    state.querySentAt = nowMs;
    commands.push({
      payload: QUERY_COMMAND,
      avrCommand: {
        area: config.area,
        operation: "query",
        requestId: state.desired?.requestId || null,
        generation: state.desired?.generation ?? state.generation,
        attempt: 1
      }
    });
    state.lastAttempt = Math.max(state.lastAttempt, 1);
    if (state.desired && !requestBlocked && state.classification !== "manual_override") {
      state.pending = {
        operation: "query",
        payload: QUERY_COMMAND,
        attempt: 1,
        deadlineAt: nowMs + config.retryMs
      };
    }
    trace(event.kind, "querying", requestBlocked ? "request-remains-blocked" : null);
    forceStateEvent = true;
  } else if (event.kind === "observed") {
    const value = event.line ?? msg.payload;
    const lines = String(value ?? "").split(/[\r\n]+/).filter(Boolean);
    let recognised = 0;
    for (const line of lines) {
      const parsed = parseAvrLine(line, config.sources);
      if (!parsed) continue;
      recognised += 1;
      let previous: string | number | null;
      let current: string | number | null;
      state.seen[parsed.field] = true;
      if (parsed.field === "source") {
        previous = state.observed.sourceCode;
        state.observed.source = parsed.value;
        state.observed.sourceCode = parsed.sourceCode;
        current = parsed.sourceCode;
      } else if (parsed.field === "power") {
        previous = state.observed.power;
        state.observed.power = parsed.value;
        current = parsed.value;
      } else if (parsed.field === "mainZone") {
        previous = state.observed.mainZone;
        state.observed.mainZone = parsed.value;
        current = parsed.value;
      } else {
        previous = state.observed.volume;
        state.observed.volume = parsed.value;
        current = parsed.value;
      }
      state.observed.at = now.toISOString();
      trace("observed", previous === current ? "unchanged" : "changed", null, {
        field: parsed.field,
        value: current
      });
    }
    if (recognised) {
      reconcile();
      forceStateEvent = true;
    }
  } else if (event.kind === "intent") {
    const reason = validateIntent(event);
    if (reason) {
      events.push({avr: {kind: "rejected", area: config.area, reason}});
      trace("intent", "rejected", reason);
    } else if (event.generation < state.generation) {
      events.push({
        avr: {
          kind: "rejected",
          area: config.area,
          requestId: event.requestId,
          generation: event.generation,
          reason: "stale-generation"
        }
      });
      trace("intent", "rejected", "stale-generation", {
        generation: event.generation,
        currentGeneration: state.generation
      });
    } else if (event.generation === state.generation && state.desired &&
      (state.desired.requestId !== event.requestId ||
        state.desired.power !== event.power ||
        state.desired.source !== (event.source || null))) {
      const conflict = state.desired.requestId === event.requestId
        ? "request-conflict"
        : "generation-conflict";
      events.push({
        avr: {
          kind: "rejected",
          area: config.area,
          requestId: event.requestId,
          generation: event.generation,
          reason: conflict
        }
      });
      trace("intent", "rejected", conflict);
    } else if (event.generation === state.generation &&
      state.desired && state.desired.requestId === event.requestId) {
      trace("intent", "duplicate", null, {requestId: event.requestId, generation: event.generation});
      reconcile();
    } else {
      if (state.desired) {
        events.push({
          avr: {
            kind: "superseded",
            area: config.area,
            requestId: state.desired.requestId,
            generation: state.desired.generation,
            supersededBy: event.requestId
          }
        });
      }
      state.generation = event.generation;
      state.desired = {
        requestId: event.requestId,
        generation: event.generation,
        power: event.power,
        source: event.source || null
      };
      state.pending = null;
      state.failure = null;
      state.blockedGeneration = null;
      state.classification = null;
      state.lastAttempt = 0;
      trace("intent", "accepted", null, {
        requestId: event.requestId,
        generation: event.generation,
        power: event.power,
        source: event.source || null
      });
      reconcile();
    }
    forceStateEvent = true;
  } else if (event.kind === "tick") {
    if (!state.pending) {
      reconcile();
    } else if (nowMs >= state.pending.deadlineAt) {
      if (operationSatisfied(state.pending.operation)) {
        state.pending = null;
        reconcile();
      } else if (state.pending.attempt >= config.maxAttempts) {
        const failed = state.pending;
        state.pending = null;
        state.phase = "failed";
        state.failure = {
          operation: failed.operation,
          attempts: failed.attempt,
          at: now.toISOString()
        };
        state.blockedGeneration = state.desired?.generation ?? null;
        events.push({
          avr: {
            kind: "failed",
            area: config.area,
            requestId: state.desired?.requestId || null,
            generation: state.desired?.generation ?? state.generation,
            operation: failed.operation,
            attempts: failed.attempt
          }
        });
        trace("request", "failed", "attempts-exhausted", {
          operation: failed.operation,
          attempts: failed.attempt
        });
      } else {
        emitCommand(state.pending.operation, state.pending.payload, state.pending.attempt + 1);
      }
    }
    forceStateEvent = true;
  }

  const after = JSON.stringify({
    observed: state.observed,
    seen: state.seen,
    desired: state.desired,
    generation: state.generation,
    pending: state.pending,
    phase: state.phase,
    failure: state.failure,
    blockedGeneration: state.blockedGeneration,
    classification: state.classification,
    lastAttempt: state.lastAttempt
  });
  if (forceStateEvent || before !== after) {
    const payload = {
      area: config.area,
      phase: state.phase,
      generation: state.generation,
      observed: {...state.observed},
      fresh: {...state.seen},
      desired: state.desired ? {...state.desired} : null,
      pending: state.pending ? {
        operation: state.pending.operation,
        attempt: state.pending.attempt,
        deadlineAt: state.pending.deadlineAt
      } : null,
      failure: state.failure,
      classification: state.classification,
      metrics: {
        attempts: state.lastAttempt,
        retries: Math.max(0, state.lastAttempt - 1),
        fallbackUsed: false
      }
    };
    events.unshift({payload, avr: {kind: "state", ...payload}});
  }

  const source = state.observed.source || state.observed.sourceCode || "unknown";
  const status = state.phase === "failed"
    ? {phase: "failed", text: "failed · " + (state.failure?.operation || "unknown")}
    : state.phase === "transitioning"
      ? {
        phase: "transitioning",
        text: (state.pending?.operation || "unknown") + " · " +
          (state.pending?.attempt || 0) + "/" + config.maxAttempts
      }
      : state.phase === "manual_override"
        ? {phase: "manual_override", text: "manual control"}
        : state.phase === "discovering"
          ? {phase: "discovering", text: "discovering"}
          : state.phase === "ready"
            ? {phase: "ready", text: (state.observed.power || "unknown") + " · " + source}
            : {phase: "idle", text: (state.observed.power || "unknown") + " · " + source};

  return {state, commands, events, traces, status};
}
