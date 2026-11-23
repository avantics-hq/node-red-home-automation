"use strict";

interface SunCalcApi {
  getTimes(date: Date, latitude: number, longitude: number): {
    sunrise: Date;
    solarNoon: Date;
    sunset: Date;
    nadir: Date;
  };
}

const SunCalc: SunCalcApi = require("suncalc");

export interface RoomTarget {
  id: string;
  stateTopic: string;
  commandTopic: string;
}

export interface RoomConfig {
  area: string;
  displayName: string;
  targets: RoomTarget[];
  initialSleep: boolean;
  latitude: number;
  longitude: number;
  sleepBrightnessPct: number;
  maxBrightnessPct: number;
  minBrightnessPct: number;
  sleepColorTempKelvin: number;
  minColorTempKelvin: number;
  maxColorTempKelvin: number;
  refreshTransitionSeconds: number;
  initialTransitionSeconds: number;
  // Optional daily schedule, as "HH:MM" in the Node-RED host's local time.
  // When both are set, circadian levels follow it instead of the sun.
  wakeTime?: string;
  bedTime?: string;
}

export interface RoomObservation {
  on: boolean;
  brightness: unknown;
  color_temp: unknown;
  observedAt: string;
}

export interface ExpectedCommand {
  fingerprint: string;
  expires: number;
  // Power state this command sets, while no state report has confirmed it yet.
  on?: boolean;
  // The command topic echo has been seen; the entry now only marks the command in flight.
  echoed?: boolean;
}

// Who controls a light. A target with no entry is "in-control": circadian may
// style and refresh it. "overridden": another owner (an activity, a scene)
// holds it until released. "manual": a person changed it.
export type TargetControlState = "in-control" | "overridden" | "manual";
export type TargetControl = {state: "manual"} | {state: "overridden"; owner: string};

export interface RoomState {
  observed: Record<string, RoomObservation>;
  desired: Record<string, boolean>;
  control: Record<string, TargetControl>;
  expected: Record<string, ExpectedCommand[]>;
  circadianEnabled: boolean;
  sleeping: boolean;
}

export interface LightingEvent {
  kind?: string;
  targets?: string[];
  target?: string;
  state?: string;
  values?: Record<string, unknown>;
  updateOnOnly?: boolean;
  updateOffOnly?: boolean;
  preserveManual?: boolean;
  manual?: boolean;
  // A person asked for this (a wall-switch press); it reaches held lights.
  person?: boolean;
  owner?: string;
  source?: string;
  refresh?: boolean;
  retained?: boolean;
  enabled?: boolean;
}

export interface RoomMessage {
  lighting?: LightingEvent;
  topic?: string;
  payload?: unknown;
  retain?: boolean;
}

export interface RoomOutput {
  topic: string;
  payload: unknown;
  retain: boolean;
  lighting_command?: {area: string; target: string; source: string};
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
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

export function fingerprint(payload: unknown): string {
  return JSON.stringify(stable(payload));
}

function savedControl(saved: Partial<RoomState> & {manual?: Record<string, boolean>}): Record<string, TargetControl> {
  if (saved.control) {
    return Object.fromEntries(Object.entries(saved.control).map(([target, entry]) => [target, {...entry}]));
  }
  // State saved before control states existed: manual: true means manual.
  return Object.fromEntries(Object.entries(saved.manual || {})
    .filter(([, manual]) => manual === true)
    .map(([target]) => [target, {state: "manual" as const}]));
}

export function createRoomState(
  config: RoomConfig,
  saved: Partial<RoomState> & {manual?: Record<string, boolean>} = {}
): RoomState {
  return {
    observed: {...(saved.observed || {})},
    desired: {...(saved.desired || {})},
    control: savedControl(saved),
    expected: Object.fromEntries(
      Object.entries(saved.expected || {}).map(([target, entries]) => [target, entries.map((entry) => ({...entry}))])
    ),
    circadianEnabled: saved.circadianEnabled !== false,
    sleeping: saved.sleeping === undefined ? config.initialSleep : saved.sleeping === true
  };
}

// The sun-position curve below and the brightness and colour-temperature rules
// in adaptivePayload are adapted (ported to TypeScript and modified) from
// Adaptive Lighting by basnijholt, https://github.com/basnijholt/adaptive-lighting
// (custom_components/adaptive_lighting/color_and_brightness.py), licensed under
// Apache-2.0; see THIRD-PARTY-NOTICES.md. They are due to be replaced by an
// original implementation.
export function sunPosition(now: Date, config: Pick<RoomConfig, "latitude" | "longitude">): number {
  const events: Array<{name: string; at: number}> = [];
  for (const dayOffset of [-1, 0, 1]) {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + dayOffset);
    const times = SunCalc.getTimes(date, config.latitude, config.longitude);
    for (const [name, at] of [
      ["sunrise", times.sunrise],
      ["noon", times.solarNoon],
      ["sunset", times.sunset],
      ["midnight", times.nadir]
    ] as const) {
      if (at instanceof Date && Number.isFinite(at.getTime())) events.push({name, at: at.getTime()});
    }
  }
  events.sort((left, right) => left.at - right.at);
  const target = now.getTime();
  const nextIndex = events.findIndex((event) => event.at > target);
  if (nextIndex < 1) throw new Error("cannot bracket the current solar event");
  const previous = events[nextIndex - 1];
  const next = events[nextIndex];
  if (!previous || !next) throw new Error("cannot bracket the current solar event");
  const nextIsHorizon = next.name === "sunrise" || next.name === "sunset";
  const h = nextIsHorizon ? previous.at : next.at;
  const x = nextIsHorizon ? next.at : previous.at;
  const sign = next.name === "sunset" || next.name === "noon" ? 1 : -1;
  return clamp(sign * (1 - Math.pow((target - h) / (h - x), 2)), -1, 1);
}

// After waking, light rises to the daytime level over this long; before bed it
// winds down to the sleep settings over the three hours that evidence on
// evening light exposure points to (Brown et al. 2022, PLOS Biology).
export const WAKE_RISE_MINUTES = 60;
export const WIND_DOWN_MINUTES = 180;

const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Minutes after midnight for an "HH:MM" clock time, or null if it is not one.
export function clockMinutes(value: unknown): number | null {
  const match = typeof value === "string" ? CLOCK_TIME.exec(value.trim()) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// How far into the day the lights are, from 0 (sleep settings) to 1 (daytime
// settings), for the given local time. Times wrap at midnight, so a bed time
// after midnight or a wake time later than the bed time both work. When the
// waking day is shorter than the rise and the wind-down together, both are
// shortened in proportion.
export function scheduleLevel(now: Date, wakeTime: string, bedTime: string): number {
  const wake = clockMinutes(wakeTime);
  const bed = clockMinutes(bedTime);
  if (wake === null || bed === null || wake === bed) throw new Error("wake and bed times must be different HH:MM times");
  const day = 24 * 60;
  const awake = (bed - wake + day) % day;
  const minute = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const sinceWake = (minute - wake + day) % day;
  if (sinceWake >= awake) return 0;
  const scale = Math.min(1, awake / (WAKE_RISE_MINUTES + WIND_DOWN_MINUTES));
  const rise = WAKE_RISE_MINUTES * scale;
  const windDown = WIND_DOWN_MINUTES * scale;
  // Ease in and out so neither end of a ramp is a visible step.
  const ease = (fraction: number) => fraction * fraction * (3 - 2 * fraction);
  if (sinceWake < rise) return ease(sinceWake / rise);
  const untilBed = awake - sinceWake;
  if (untilBed < windDown) return ease(untilBed / windDown);
  return 1;
}

// Brightness and colour-temperature rules adapted from Adaptive Lighting
// (Apache-2.0); see the note above sunPosition.
export function adaptivePayload(
  lightState: string,
  isRefresh: boolean,
  sleeping: boolean,
  now: Date,
  config: RoomConfig
) {
  if (lightState === "OFF") return {state: lightState};
  if (config.wakeTime && config.bedTime) {
    // Between the sleep settings (level 0) and the brightest, coolest daytime
    // settings (level 1).
    const level = sleeping ? 0 : scheduleLevel(now, config.wakeTime, config.bedTime);
    const brightnessPct = config.sleepBrightnessPct + (config.maxBrightnessPct - config.sleepBrightnessPct) * level;
    const kelvin = config.sleepColorTempKelvin + (config.maxColorTempKelvin - config.sleepColorTempKelvin) * level;
    return {
      state: lightState,
      brightness: clamp(Math.round(brightnessPct * 254 / 100), 1, 254),
      color_temp: Math.floor(1000000 / (5 * Math.round(kelvin / 5))),
      transition: isRefresh ? config.refreshTransitionSeconds : config.initialTransitionSeconds
    };
  }
  const position = sunPosition(now, config);
  const brightnessPct = sleeping
    ? config.sleepBrightnessPct
    : position > 0
      ? config.maxBrightnessPct
      : (config.maxBrightnessPct - config.minBrightnessPct) * (1 + position) + config.minBrightnessPct;
  const kelvin = sleeping
    ? config.sleepColorTempKelvin
    : position > 0
      ? 5 * Math.round((config.minColorTempKelvin + (config.maxColorTempKelvin - config.minColorTempKelvin) * position) / 5)
      : config.minColorTempKelvin;
  return {
    state: lightState,
    brightness: clamp(Math.round(brightnessPct * 254 / 100), 1, 254),
    color_temp: Math.floor(1000000 / kelvin),
    transition: isRefresh ? config.refreshTransitionSeconds : config.initialTransitionSeconds
  };
}

export function transitionRoom(
  saved: Partial<RoomState> | undefined,
  msg: RoomMessage,
  config: RoomConfig,
  nowValue: Date | string | number = new Date()
) {
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const nowMs = now.getTime();
  const state = createRoomState(config, saved);
  const targetById = Object.fromEntries(config.targets.map((target) => [target.id, target]));
  const traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [];
  const outputs: RoomOutput[] = [];

  function trace(event: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) {
    traces.push({event, outcome, reason, details});
  }

  function targetForTopic(topic: string | undefined, field: "stateTopic" | "commandTopic") {
    return config.targets.find((target) => target[field] === topic);
  }

  const controlChanged = new Set<string>();

  function controlOf(targetId: string): TargetControlState {
    return state.control[targetId]?.state ?? "in-control";
  }

  function setControl(targetId: string, next: TargetControl | null, reason: string) {
    const previous = state.control[targetId] ?? null;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    if (next) state.control[targetId] = next;
    else delete state.control[targetId];
    controlChanged.add(targetId);
    trace("control", "changed", reason, {
      target: targetId,
      state: next?.state ?? "in-control",
      owner: next?.state === "overridden" ? next.owner : null,
      previous: previous?.state ?? "in-control"
    });
  }

  function controlMessage(targetId: string): RoomOutput {
    const entry = state.control[targetId];
    return {
      topic: "home/" + config.area + "/lighting/" + targetId + "/control",
      payload: {state: entry?.state ?? "in-control", owner: entry?.state === "overridden" ? entry.owner : null},
      retain: true
    };
  }

  function intendedOn(targetId: string): boolean {
    if (Object.hasOwn(state.desired, targetId)) return state.desired[targetId] === true;
    return state.observed[targetId]?.on === true;
  }

  function rememberExpected(targetId: string, payload: unknown) {
    const queue = (state.expected[targetId] || []).filter((entry) => entry.expires > nowMs);
    const entry: ExpectedCommand = {fingerprint: fingerprint(payload), expires: nowMs + 5000};
    const requested = payload && typeof payload === "object"
      ? String((payload as Record<string, unknown>).state || "").toUpperCase()
      : "";
    if (requested === "ON" || requested === "OFF") entry.on = requested === "ON";
    queue.push(entry);
    state.expected[targetId] = queue.slice(-8);
  }

  // Whether a state report is stale against the controller's own command in
  // flight. A report that matches the newest unconfirmed command confirms it.
  function contradictsOwnCommand(targetId: string, observedOn: boolean): boolean {
    const queue = (state.expected[targetId] || []).filter((entry) => entry.expires > nowMs);
    const latest = queue.filter((entry) => entry.on !== undefined).at(-1);
    if (latest && latest.on === observedOn) {
      for (const entry of queue) delete entry.on;
    }
    state.expected[targetId] = queue.filter((entry) => entry.on !== undefined || entry.echoed !== true);
    return latest !== undefined && latest.on !== observedOn;
  }

  function command(targetId: string, payload: unknown, source: string): RoomOutput | null {
    const target = targetById[targetId];
    if (!target) return null;
    rememberExpected(targetId, payload);
    return {
      topic: target.commandTopic,
      payload,
      retain: false,
      lighting_command: {area: config.area, target: targetId, source}
    };
  }

  function discoveryMessages(): RoomOutput[] {
    const objectId = config.area + "_circadian_lighting";
    return [
      {
        topic: "homeassistant/switch/" + objectId + "/config",
        payload: {
          name: config.displayName + " Circadian Lighting",
          unique_id: objectId,
          default_entity_id: "switch." + objectId,
          icon: "mdi:theme-light-dark",
          command_topic: "home/" + config.area + "/circadian/set",
          state_topic: "home/" + config.area + "/circadian/state",
          payload_on: "ON",
          payload_off: "OFF",
          optimistic: false,
          device: {
            identifiers: ["nodered_" + config.area + "_lighting"],
            name: config.displayName + " Lighting Controller",
            manufacturer: "Node-RED",
            model: "Composable circadian lighting"
          }
        },
        retain: true
      },
      {
        topic: "home/" + config.area + "/circadian/state",
        payload: state.circadianEnabled ? "ON" : "OFF",
        retain: true
      }
    ];
  }

  function refreshCommands(source: string): RoomOutput[] {
    if (!state.circadianEnabled) return [];
    const commands: Array<RoomOutput | null> = [];
    for (const target of config.targets) {
      if (!intendedOn(target.id) || controlOf(target.id) !== "in-control") continue;
      commands.push(command(
        target.id,
        adaptivePayload("ON", true, state.sleeping, now, config),
        source
      ));
    }
    return commands.filter((entry): entry is RoomOutput => entry !== null);
  }

  function emitIntent(event: LightingEvent): RoomOutput[] {
    const targets = Array.isArray(event.targets)
      ? event.targets
      : config.targets.map((target) => target.id);
    const requestedState = String(event.state || "").toUpperCase();
    if (!["ON", "OFF", "TOGGLE"].includes(requestedState)) return [];
    const commands: Array<RoomOutput | null> = [];
    const manualValues = event.values && typeof event.values === "object" ? event.values : null;
    const owner = typeof event.owner === "string" && event.owner ? event.owner : null;

    for (const targetId of targets) {
      if (!targetById[targetId]) continue;
      // A held light changes only for an owner (its own or a newer one), a
      // person (manual: true or person: true) or a release; any other intent
      // leaves it alone.
      const held = state.control[targetId];
      const person = event.manual === true || event.person === true;
      if (held?.state === "overridden" && !owner && !person) {
        trace("intent", "ignored", "held-by", {target: targetId, owner: held.owner, source: event.source || "intent"});
        continue;
      }
      const wasOn = intendedOn(targetId);
      const resolvedState = requestedState === "TOGGLE" ? (wasOn ? "OFF" : "ON") : requestedState;
      if (event.updateOnOnly === true && !wasOn) continue;
      if (event.updateOffOnly === true && wasOn) continue;
      if (event.preserveManual === true && controlOf(targetId) === "manual") continue;
      if (resolvedState === "OFF") {
        // An off light has no style to protect: it returns to the room controller.
        setControl(targetId, null, "off");
      } else if (owner) {
        setControl(targetId, {state: "overridden", owner}, "owner-intent");
      } else if (event.manual === true || (manualValues && event.source !== "activity")) {
        setControl(targetId, {state: "manual"}, "manual-intent");
      }

      let payload: Record<string, unknown>;
      if (resolvedState === "OFF") {
        payload = {state: "OFF"};
      } else if (manualValues) {
        payload = {state: "ON", ...manualValues};
        if (!Object.hasOwn(payload, "transition")) {
          payload.transition = config.initialTransitionSeconds;
        }
      } else if (state.circadianEnabled && controlOf(targetId) === "in-control") {
        payload = adaptivePayload("ON", event.refresh === true, state.sleeping, now, config);
      } else {
        payload = {state: "ON"};
      }
      state.desired[targetId] = resolvedState === "ON";
      commands.push(command(targetId, payload, event.source || "intent"));
    }
    return commands.filter((entry): entry is RoomOutput => entry !== null);
  }

  const event: LightingEvent = msg.lighting || {};
  if (event.kind === "startup") {
    outputs.push(...discoveryMessages());
    for (const target of config.targets) controlChanged.add(target.id);
  } else if (event.kind === "observed") {
    const target = event.target ? targetById[event.target] : targetForTopic(msg.topic, "stateTopic");
    const parsed = parsePayload(msg.payload);
    const payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    if (target && payload && ["ON", "OFF"].includes(String(payload.state).toUpperCase())) {
      const previousOn = state.observed[target.id]?.on;
      const nextOn = String(payload.state).toUpperCase() === "ON";
      state.observed[target.id] = {
        on: nextOn,
        brightness: payload.brightness ?? null,
        color_temp: payload.color_temp ?? null,
        observedAt: now.toISOString()
      };
      if (previousOn !== nextOn) {
        trace("state-observed", "changed", null, {
          target: target.id,
          state: nextOn ? "ON" : "OFF"
        });
      }
      if (contradictsOwnCommand(target.id, nextOn)) {
        trace("state-observed", "ignored", "own-command-in-flight", {target: target.id, state: nextOn ? "ON" : "OFF"});
      } else {
        // A change the controller didn't cause becomes the intended state.
        state.desired[target.id] = nextOn;
        if (!nextOn) setControl(target.id, null, "observed-off");
      }
    }
  } else if (event.kind === "command-observed") {
    const target = event.target ? targetById[event.target] : targetForTopic(msg.topic, "commandTopic");
    const parsed = parsePayload(msg.payload);
    const payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    if (msg.retain !== true && event.retained !== true && target && payload) {
      const queue = (state.expected[target.id] || []).filter((entry) => entry.expires > nowMs);
      const ownIndex = queue.findIndex((entry) => entry.echoed !== true && entry.fingerprint === fingerprint(payload));
      const own = queue[ownIndex];
      if (own) {
        // Keep an unconfirmed power command as in flight for state reports.
        if (own.on === undefined) queue.splice(ownIndex, 1);
        else own.echoed = true;
        state.expected[target.id] = queue;
      } else {
        state.expected[target.id] = queue;
        const requestedState = String(payload.state || "").toUpperCase();
        const fields = [
          "brightness", "brightness_percent", "color", "color_temp", "color_temp_kelvin",
          "effect", "hue", "saturation", "x", "y"
        ];
        if (requestedState === "OFF") {
          state.desired[target.id] = false;
          setControl(target.id, null, "external-off");
        } else if (requestedState === "ON") {
          state.desired[target.id] = true;
          if (fields.some((field) => Object.hasOwn(payload, field))) {
            setControl(target.id, {state: "manual"}, "external-values");
          } else if (state.circadianEnabled && controlOf(target.id) === "in-control") {
            const corrective = command(
              target.id,
              adaptivePayload("ON", false, state.sleeping, now, config),
              "external-bare-on"
            );
            if (corrective) outputs.push(corrective);
          }
        } else if (requestedState === "TOGGLE") {
          state.desired[target.id] = !intendedOn(target.id);
        }
        trace("external-command", "observed", null, {
          target: target.id,
          state: requestedState || "UNKNOWN",
          control: controlOf(target.id)
        });
      }
    }
  } else if (event.kind === "circadian") {
    const previous = state.circadianEnabled;
    state.circadianEnabled = event.enabled === true;
    if (previous !== state.circadianEnabled) {
      trace("circadian", "changed", null, {enabled: state.circadianEnabled});
    }
    outputs.push({
      topic: "home/" + config.area + "/circadian/state",
      payload: state.circadianEnabled ? "ON" : "OFF",
      retain: true
    });
    if (state.circadianEnabled) {
      // Enabling circadian takes back manual lights; other owners keep theirs.
      for (const target of config.targets) {
        if (controlOf(target.id) === "manual") setControl(target.id, null, "circadian-enabled");
      }
      outputs.push(...refreshCommands("circadian-enabled"));
    }
  } else if (event.kind === "sleep") {
    const previous = state.sleeping;
    state.sleeping = event.enabled === true;
    if (previous !== state.sleeping) trace("sleep", "changed", null, {enabled: state.sleeping});
    outputs.push(...refreshCommands("sleep-policy"));
  } else if (event.kind === "refresh") {
    outputs.push(...refreshCommands("periodic-refresh"));
  } else if (event.kind === "release") {
    // Hand overridden lights back; an owner name releases only that owner's lights.
    const targets = Array.isArray(event.targets) ? event.targets : config.targets.map((target) => target.id);
    const owner = typeof event.owner === "string" && event.owner ? event.owner : null;
    for (const targetId of targets) {
      const entry = state.control[targetId];
      if (!targetById[targetId] || entry?.state !== "overridden" || (owner && entry.owner !== owner)) continue;
      setControl(targetId, null, "released");
      if (state.circadianEnabled && intendedOn(targetId)) {
        const restyle = command(targetId, adaptivePayload("ON", true, state.sleeping, now, config), event.source || "release");
        if (restyle) outputs.push(restyle);
      }
    }
  } else if (event.kind === "intent") {
    outputs.push(...emitIntent(event));
    const commands = outputs.flatMap((message) => {
      if (!message.lighting_command) return [];
      const payload = message.payload && typeof message.payload === "object"
        ? message.payload as Record<string, unknown>
        : {};
      return [{
        target: message.lighting_command.target,
        state: String(payload.state || "").toUpperCase()
      }];
    });
    trace("intent", commands.length ? "commanded" : "suppressed", commands.length ? null : "no-command-required", {
      source: event.source || "intent",
      state: String(event.state || "").toUpperCase(),
      targets: Array.isArray(event.targets)
        ? event.targets
        : config.targets.map((target) => target.id),
      commands
    });
  }

  for (const target of config.targets) {
    if (controlChanged.has(target.id)) outputs.push(controlMessage(target.id));
  }

  const onCount = Object.values(state.desired).filter(Boolean).length;
  const control = Object.fromEntries(config.targets.map((target) => [target.id, controlOf(target.id)]));
  const manualCount = Object.values(control).filter((entry) => entry === "manual").length;
  const overriddenCount = Object.values(control).filter((entry) => entry === "overridden").length;
  return {
    state,
    outputs,
    traces,
    status: {
      circadianEnabled: state.circadianEnabled,
      sleeping: state.sleeping,
      onCount,
      manualCount,
      overriddenCount,
      control
    }
  };
}
