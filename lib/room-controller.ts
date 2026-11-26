"use strict";

import type {TraceEntry} from "./bounded-trace";
import type {CircadianLighting} from "./circadian";
import type {DaySchedule} from "./circadian-schedule";
import {requestedSchedule, savedSchedule, withActiveSchedule} from "./room-schedule";
import {alreadyStyled, lightCommand, lightValues, readLightReport, setsLightValues, type LightCommand, type LightReport} from "./z2m-light";
import {ECHO_WINDOW_MS, checkCommandEcho, checkStateReport, parsePayload, rememberCommand, type ExpectedCommand} from "./command-echo";

export {fingerprint, parsePayload, type ExpectedCommand} from "./command-echo";

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
  refreshTransitionSeconds: number;
  initialTransitionSeconds: number;
  // How a light should look at a given moment; the node builds it from its
  // schedule and light settings.
  lighting: CircadianLighting;
  // The wake and bed times that lighting follows, as configured. Absent means
  // the default day.
  schedule?: DaySchedule;
}

export interface RoomObservation extends LightReport {
  observedAt: string;
}


// Who controls a light. A target with no entry is "in-control": circadian may
// style and refresh it. "overridden": another owner (an activity, a scene)
// holds it until released. "manual": a person changed it.
export type TargetControlState = "in-control" | "overridden" | "manual";
export type TargetControl = {state: "manual"} | {state: "overridden"; owner: string};

// Traced when an intent gives brightness or color_temp in Zigbee2MQTT's own
// units rather than brightnessPct or colorTempKelvin: still accepted during
// 5.x, and the node warns.
export const LEGACY_LIGHT_UNITS = "legacy-light-units";

// Traced when an intent's brightnessPct or colorTempKelvin is unusable (not
// a number, or a kelvin of 0 or less): it is left out of the command, and
// the node warns.
export const INVALID_LIGHT_VALUES = "invalid-light-values";

export interface RoomState {
  observed: Record<string, RoomObservation>;
  desired: Record<string, boolean>;
  control: Record<string, TargetControl>;
  expected: Record<string, ExpectedCommand[]>;
  circadianEnabled: boolean;
  sleeping: boolean;
  // The wake and bed times in use, and the configured times they were based
  // on. A "schedule" message changes a time until the node is deployed with
  // a different setting for it, which then applies.
  schedule: DaySchedule;
  scheduleSetting: DaySchedule;
  // When a person last set each light: a person or manual intent, or someone
  // else's command seen on the light's command topic (epoch ms).
  personAt: Record<string, number>;
  // Lights the room hasn't been told about since it started with nothing
  // saved (a first deploy, or a redeploy or restart without a context
  // store), when it can't know which were held or set by a person. It leaves
  // them as they are, with no periodic restyle, until an intent or release
  // names them or circadian lighting is switched on.
  untold: string[];
  // When the room last restyled each light after someone else's bare ON
  // (epoch ms): at most one such restyle per light per echo window.
  restyledAt: Record<string, number>;
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
  // On a motion OFF: when the room went vacant (ISO time).
  vacantSince?: string;
  // On a "schedule" message: new wake or bed times, "HH:MM".
  wakeTime?: string;
  bedTime?: string;
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
    sleeping: saved.sleeping === undefined ? config.initialSleep : saved.sleeping === true,
    ...savedSchedule(config, saved),
    personAt: Object.fromEntries(Object.entries(saved.personAt || {})
      .filter(([, at]) => Number.isFinite(at))),
    untold: Array.isArray(saved.untold)
      ? saved.untold.filter((id) => config.targets.some((target) => target.id === id))
      : [],
    restyledAt: Object.fromEntries(Object.entries(saved.restyledAt || {})
      .filter(([target, at]) => Number.isFinite(at) && config.targets.some((entry) => entry.id === target)))
  };
}

// A circadian light command for this moment.
export function adaptivePayload(
  lightState: string,
  isRefresh: boolean,
  sleeping: boolean,
  now: Date,
  config: RoomConfig
): LightCommand {
  if (lightState === "OFF") return {state: lightState};
  return lightCommand(lightState, config.lighting.styleAt(now, sleeping),
    isRefresh ? config.refreshTransitionSeconds : config.initialTransitionSeconds);
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
  if (saved === undefined) state.untold = config.targets.map((target) => target.id);
  // The settings with lighting on the times in use; a schedule change
  // below replaces it.
  let active = withActiveSchedule(config, state);
  const targetById = Object.fromEntries(config.targets.map((target) => [target.id, target]));
  const traces: TraceEntry[] = [];
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

  function told(targetId: string) {
    state.untold = state.untold.filter((id) => id !== targetId);
  }

  function intendedOn(targetId: string): boolean {
    if (Object.hasOwn(state.desired, targetId)) return state.desired[targetId] === true;
    return state.observed[targetId]?.on === true;
  }

  function command(targetId: string, payload: unknown, source: string): RoomOutput | null {
    const target = targetById[targetId];
    if (!target) return null;
    state.expected[targetId] = rememberCommand(state.expected[targetId], payload, nowMs);
    return {
      topic: target.commandTopic,
      payload,
      retain: false,
      lighting_command: {area: config.area, target: targetId, source}
    };
  }

  function refreshCommands(source: string): RoomOutput[] {
    if (!state.circadianEnabled) return [];
    const commands: Array<RoomOutput | null> = [];
    for (const target of config.targets) {
      if (!intendedOn(target.id) || controlOf(target.id) !== "in-control") continue;
      if (state.untold.includes(target.id)) {
        trace("refresh", "skipped", "not-told-since-start", {target: target.id});
        continue;
      }
      // Nothing to change when the light last reported exactly this style.
      if (alreadyStyled(active.lighting.styleAt(now, state.sleeping), state.observed[target.id])) {
        trace("refresh", "skipped", "already-at-level", {target: target.id});
        continue;
      }
      commands.push(command(target.id, adaptivePayload("ON", true, state.sleeping, now, active), source));
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
      // Motion switches off a vacant room, but not a light a person set after
      // the room went vacant: they are using it.
      const vacantSince = typeof event.vacantSince === "string" ? Date.parse(event.vacantSince) : NaN;
      if (event.source === "motion" && resolvedState === "OFF" && Number.isFinite(vacantSince) &&
        (state.personAt[targetId] ?? -Infinity) >= vacantSince) {
        trace("intent", "ignored", "person-set-after-vacancy", {target: targetId, vacantSince: event.vacantSince});
        continue;
      }
      if (person) state.personAt[targetId] = now.getTime();
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
        // The intent's values in the light's own units (z2m-light).
        const device = lightValues(manualValues);
        if (device.legacy) trace("intent", "accepted", LEGACY_LIGHT_UNITS, {target: targetId, values: manualValues});
        if (device.superseded.length) trace("intent", "accepted", "legacy-light-units-ignored", {target: targetId, ignored: device.superseded});
        if (device.invalid.length) trace("intent", "accepted", INVALID_LIGHT_VALUES, {target: targetId, dropped: device.invalid, values: manualValues});
        payload = {state: "ON", ...device.values};
        if (!Object.hasOwn(payload, "transition")) {
          payload.transition = config.initialTransitionSeconds;
        }
      } else if (state.circadianEnabled && controlOf(targetId) === "in-control") {
        payload = adaptivePayload("ON", event.refresh === true, state.sleeping, now, active);
      } else {
        payload = {state: "ON"};
      }
      state.desired[targetId] = resolvedState === "ON";
      told(targetId);
      commands.push(command(targetId, payload, event.source || "intent"));
    }
    return commands.filter((entry): entry is RoomOutput => entry !== null);
  }

  // What the room publishes, and the MQTT it reads for itself, are
  // room-publishing.ts's; this decides about lights only.
  const event: LightingEvent = msg.lighting || {};
  if (event.kind === "observed") {
    const target = event.target ? targetById[event.target] : targetForTopic(msg.topic, "stateTopic");
    const parsed = parsePayload(msg.payload);
    const payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    const light = payload ? readLightReport(payload) : null;
    if (target && light) {
      const previousOn = state.observed[target.id]?.on;
      const nextOn = light.on;
      state.observed[target.id] = {...light, observedAt: now.toISOString()};
      if (previousOn !== nextOn) {
        trace("state-observed", "changed", null, {
          target: target.id,
          state: nextOn ? "ON" : "OFF"
        });
      }
      const report = checkStateReport(state.expected[target.id], nextOn, nowMs);
      state.expected[target.id] = report.queue;
      if (report.verdict === "confirms") {
        // Our own command, now done: the intended state already says so.
        // A confirmed OFF deliberately leaves control alone: our OFFs come
        // from OFF intents, which already returned the light to in-control.
        trace("state-observed", "confirmed", "own-command", {target: target.id, state: nextOn ? "ON" : "OFF"});
      } else if (report.verdict === "stale") {
        // Older than our pending command; the light will report again.
        trace("state-observed", "ignored", "stale-report", {target: target.id, state: nextOn ? "ON" : "OFF"});
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
      const echo = checkCommandEcho(state.expected[target.id], payload, nowMs);
      state.expected[target.id] = echo.queue;
      if (echo.changed) {
        // Our own command, changed on the way to MQTT (the command path
        // should pass it through as it is): never answered as someone else's.
        trace("command-observed", "ignored", "mutated-own-command", {target: target.id, state: String(payload.state || "").toUpperCase()});
      }
      if (!echo.own) {
        const requestedState = String(payload.state || "").toUpperCase();
        if (requestedState === "OFF") {
          state.desired[target.id] = false;
          setControl(target.id, null, "external-off");
        } else if (requestedState === "ON") {
          state.desired[target.id] = true;
          if (setsLightValues(payload)) {
            setControl(target.id, {state: "manual"}, "external-values");
          } else if (state.circadianEnabled && controlOf(target.id) === "in-control") {
            // At most one restyle per light per echo window, whatever comes
            // back: a bare ON delivered twice (two subscriptions, or a QoS
            // redelivery) can't make the room answer itself in a loop.
            const last = state.restyledAt[target.id];
            if (last !== undefined && nowMs - last >= 0 && nowMs - last < ECHO_WINDOW_MS) {
              trace("external-command", "suppressed", "restyled-recently", {target: target.id});
            } else {
              const corrective = command(
                target.id,
                adaptivePayload("ON", false, state.sleeping, now, active),
                "external-bare-on"
              );
              if (corrective) {
                outputs.push(corrective);
                state.restyledAt[target.id] = nowMs;
              }
            }
            // Styled now, so the refresh keeps it in step from here.
            told(target.id);
          }
        } else if (requestedState === "TOGGLE") {
          state.desired[target.id] = !intendedOn(target.id);
        }
        state.personAt[target.id] = now.getTime();
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
    if (state.circadianEnabled) {
      // Switching circadian lighting on takes the lights back, so the room
      // has been told about every light.
      for (const target of config.targets) told(target.id);
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
  } else if (event.kind === "schedule") {
    const next = requestedSchedule(state.schedule, event);
    if (!next) {
      trace("schedule", "ignored", "invalid-times", {wakeTime: event.wakeTime, bedTime: event.bedTime});
    } else if (next.wakeTime !== state.schedule.wakeTime || next.bedTime !== state.schedule.bedTime) {
      state.schedule = next;
      active = withActiveSchedule(config, state);
      trace("schedule", "changed", null, {...next});
      outputs.push(...refreshCommands("schedule-changed"));
    }
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
      told(targetId);
      if (state.circadianEnabled && intendedOn(targetId)) {
        const restyle = command(targetId, adaptivePayload("ON", true, state.sleeping, now, active), event.source || "release");
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

  const onCount = Object.values(state.desired).filter(Boolean).length;
  const control = Object.fromEntries(config.targets.map((target) => [target.id, controlOf(target.id)]));
  const manualCount = Object.values(control).filter((entry) => entry === "manual").length;
  const overriddenCount = Object.values(control).filter((entry) => entry === "overridden").length;
  return {
    state,
    outputs,
    traces,
    // The lights whose control state changed, in configured order.
    controlChanged: config.targets.map((target) => target.id).filter((id) => controlChanged.has(id)),
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
