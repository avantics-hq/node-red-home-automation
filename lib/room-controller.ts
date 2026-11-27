"use strict";

import type {TraceEntry} from "./bounded-trace";
import type {LightStyle} from "./light-styling";
import {alreadyStyled, lightCommand, lightValues, readLightReport, setsLightValues, type LightReport} from "./z2m-light";
import {ECHO_WINDOW_MS, checkCommandEcho, checkStateReport, parsePayload, rememberCommand, type ExpectedCommand} from "./command-echo";

export {fingerprint, parsePayload, type ExpectedCommand} from "./command-echo";

export interface RoomTarget {
  id: string;
  stateTopic: string;
  commandTopic: string;
  // A light that only switches on and off: it is never sent brightness,
  // colour or a transition.
  onOffOnly?: boolean;
}

export interface RoomConfig {
  area: string;
  displayName: string;
  targets: RoomTarget[];
  // The transition for a light switched on, styled or with an intent's
  // values. A restyle of a light already on uses the style's own.
  initialTransitionSeconds: number;
}

// How lights should look, as a style source (such as the circadian lighting
// policy) last said: values null means style nothing. It stands until
// `until`, so a source that stopped stops affecting lights.
export interface RoomStyle {
  values: LightStyle | null;
  transitionSeconds: number;
  until: string;
  source: string;
}

// Two rules awaiting the person's confirmation for 6.0.0, each one switch:
// whether an intent's values alone make a light manual, as before 6.0 (now
// only manual: true does), and whether an intent's refresh: true still
// restyles with the style's transition (removed in 6.0).
export const VALUES_MAKE_MANUAL = false;
export const INTENT_REFRESH = false;

export interface RoomObservation extends LightReport {
  observedAt: string;
}


// Who controls a light. A target with no entry is "in-control": a style may
// restyle it. "overridden": another owner (an activity, a scene)
// holds it until released. "manual": a person changed it.
export type TargetControlState = "in-control" | "overridden" | "manual";
export type TargetControl = {state: "manual"} | {state: "overridden"; owner: string};

// Traced when an intent gives brightness or color_temp, Zigbee2MQTT's own
// units, removed in 6.0: left out of the command, and the node warns.
export const REMOVED_LIGHT_UNITS = "removed-light-units";

// Traced when an intent's brightnessPct or colorTempKelvin is unusable (not
// a number, or a kelvin of 0 or less): it is left out of the command, and
// the node warns.
export const INVALID_LIGHT_VALUES = "invalid-light-values";

// Traced when an intent gives values for a light that only switches on and
// off: they are left out, and the node warns.
export const ON_OFF_ONLY = "on-off-only";

// The settings a room had for circadian lighting before 6.0, now the
// circadian lighting policy's. A room whose saved settings still have any of
// them hasn't been migrated: it is an invalid configuration, so it can't
// quietly run unstyled. Empty, as a new 6.0 room has them, means absent.
export const MOVED_CIRCADIAN_SETTINGS = [
  "houseSchedule", "wakeTime", "bedTime", "maxBrightnessPct", "maxColorTempKelvin", "sleepBrightnessPct",
  "sleepColorTempKelvin", "refreshTransitionSeconds", "refreshSeconds", "initialSleep",
  // A room saved by 2.x and never re-saved has only these, ignored since 3.0.
  "latitude", "longitude", "minBrightnessPct", "minColorTempKelvin"
] as const;

export function movedCircadianSettings(config: Record<string, unknown>): string[] {
  return MOVED_CIRCADIAN_SETTINGS.filter((key) => config[key] !== undefined && config[key] !== null && config[key] !== "");
}

// Traced when the room is sent circadian, sleep or schedule messages, which
// the circadian lighting policy takes since 6.0: ignored, and the node warns.
export const MOVED_TO_CIRCADIAN = "moved-to-circadian";

export interface RoomState {
  observed: Record<string, RoomObservation>;
  desired: Record<string, boolean>;
  control: Record<string, TargetControl>;
  expected: Record<string, ExpectedCommand[]>;
  // The style last received, or none yet.
  style: RoomStyle | null;
  // When a person last set each light: a person or manual intent, or someone
  // else's command seen on the light's command topic (epoch ms).
  personAt: Record<string, number>;
  // Lights the room hasn't been told about since it started with nothing
  // saved (a first deploy, or a redeploy or restart without a context
  // store), when it can't know which were held or set by a person. It leaves
  // them as they are, with no restyle, until an intent or release names them
  // or a style takes lights back (circadian lighting switched on).
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
  // Before 6.0, styled a light with the restyle transition (see
  // INTENT_REFRESH).
  refresh?: boolean;
  retained?: boolean;
  // On a motion OFF: when the room went vacant (ISO time).
  vacantSince?: string;
  // On a "style": how lights should look (values null: style nothing),
  // the transition for lights already on, when it goes stale, and whether to
  // take back the lights a person set.
  transitionSeconds?: number;
  until?: string;
  takeBack?: boolean;
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
    style: savedStyle(saved.style),
    personAt: Object.fromEntries(Object.entries(saved.personAt || {})
      .filter(([, at]) => Number.isFinite(at))),
    untold: Array.isArray(saved.untold)
      ? saved.untold.filter((id) => config.targets.some((target) => target.id === id))
      : [],
    restyledAt: Object.fromEntries(Object.entries(saved.restyledAt || {})
      .filter(([target, at]) => Number.isFinite(at) && config.targets.some((entry) => entry.id === target)))
  };
}

// A style as received or saved, or null if it isn't one. State saved before
// 6.0 has none.
function savedStyle(style: unknown): RoomStyle | null {
  if (!style || typeof style !== "object") return null;
  const entry = style as Partial<RoomStyle>;
  const values = entry.values && typeof entry.values === "object" &&
    Number.isFinite(entry.values.brightnessPct) && Number.isFinite(entry.values.colorTempKelvin) && entry.values.colorTempKelvin > 0
    ? {brightnessPct: entry.values.brightnessPct, colorTempKelvin: entry.values.colorTempKelvin}
    : null;
  if (typeof entry.until !== "string" || !Number.isFinite(Date.parse(entry.until))) return null;
  return {
    values,
    transitionSeconds: Number.isFinite(entry.transitionSeconds) ? Number(entry.transitionSeconds) : 0,
    until: entry.until,
    source: typeof entry.source === "string" && entry.source ? entry.source : "style"
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
  if (saved === undefined) state.untold = config.targets.map((target) => target.id);
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

  function onOffOnly(targetId: string): boolean {
    return targetById[targetId]?.onOffOnly === true;
  }

  // The style in force: one with values that hasn't gone stale.
  function currentStyle(): LightStyle | null {
    const style = state.style;
    return style?.values && Date.parse(style.until) > nowMs ? style.values : null;
  }

  // A style command for a light, over a transition; null for a light that
  // only switches on and off, or with no style in force.
  function styled(targetId: string, transitionSeconds: number): Record<string, unknown> | null {
    const style = currentStyle();
    return style && !onOffOnly(targetId) ? lightCommand("ON", style, transitionSeconds) : null;
  }

  // Each light that is on and the room's to style, moved to the style in
  // force over the style's transition.
  function restyleCommands(source: string): RoomOutput[] {
    const style = currentStyle();
    if (!style || !state.style) return [];
    const commands: Array<RoomOutput | null> = [];
    for (const target of config.targets) {
      if (!intendedOn(target.id) || controlOf(target.id) !== "in-control") continue;
      if (onOffOnly(target.id)) continue;
      if (state.untold.includes(target.id)) {
        trace("refresh", "skipped", "not-told-since-start", {target: target.id});
        continue;
      }
      // Nothing to change when the light last reported exactly this style.
      if (alreadyStyled(style, state.observed[target.id])) {
        trace("refresh", "skipped", "already-at-level", {target: target.id});
        continue;
      }
      commands.push(command(target.id, lightCommand("ON", style, state.style.transitionSeconds), source));
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
      } else if (event.manual === true || (VALUES_MAKE_MANUAL && manualValues && event.source !== "activity")) {
        setControl(targetId, {state: "manual"}, "manual-intent");
      }

      let payload: Record<string, unknown>;
      if (resolvedState === "OFF") {
        payload = {state: "OFF"};
      } else if (manualValues && onOffOnly(targetId)) {
        // Nothing to set on a light that only switches: left out, and the
        // node warns.
        trace("intent", "accepted", ON_OFF_ONLY, {target: targetId, dropped: Object.keys(manualValues)});
        payload = {state: "ON"};
      } else if (manualValues) {
        // The intent's values in the light's own units (z2m-light).
        const device = lightValues(manualValues);
        if (device.removed.length) trace("intent", "accepted", REMOVED_LIGHT_UNITS, {target: targetId, dropped: device.removed, values: manualValues});
        if (device.invalid.length) trace("intent", "accepted", INVALID_LIGHT_VALUES, {target: targetId, dropped: device.invalid, values: manualValues});
        payload = {state: "ON", ...device.values};
        if (!Object.hasOwn(payload, "transition")) {
          payload.transition = config.initialTransitionSeconds;
        }
      } else {
        // A bare ON: the style in force for a light the room controls,
        // otherwise just on.
        const transition = INTENT_REFRESH && event.refresh === true && state.style ? state.style.transitionSeconds : config.initialTransitionSeconds;
        payload = (controlOf(targetId) === "in-control" ? styled(targetId, transition) : null) ?? {state: "ON"};
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
          if (setsLightValues(payload) && !onOffOnly(target.id)) {
            setControl(target.id, {state: "manual"}, "external-values");
          } else if (currentStyle() && !onOffOnly(target.id) && controlOf(target.id) === "in-control") {
            // At most one restyle per light per echo window, whatever comes
            // back: a bare ON delivered twice (two subscriptions, or a QoS
            // redelivery) can't make the room answer itself in a loop.
            const last = state.restyledAt[target.id];
            if (last !== undefined && nowMs - last >= 0 && nowMs - last < ECHO_WINDOW_MS) {
              trace("external-command", "suppressed", "restyled-recently", {target: target.id});
            } else {
              const corrective = command(target.id, styled(target.id, config.initialTransitionSeconds), "external-bare-on");
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
  } else if (event.kind === "circadian" || event.kind === "sleep" || event.kind === "schedule") {
    // The circadian lighting policy's since 6.0: the node warns.
    trace(event.kind, "ignored", MOVED_TO_CIRCADIAN);
  } else if (event.kind === "style") {
    const previous = state.style;
    const next = savedStyle({...event, source: event.source});
    if (!next) {
      trace("style", "ignored", "not-a-style");
    } else {
      state.style = next;
      // Traced when it starts or stops styling, or comes from someone else,
      // not at every interval.
      if (!previous || (previous.values === null) !== (next.values === null) || previous.source !== next.source) {
        trace("style", "changed", null, {source: next.source, styling: next.values !== null});
      }
      if (event.takeBack === true) {
        // The one time a style changes who controls a light: circadian
        // lighting switched on takes back what a person set, and the room
        // has then been told about every light. Other owners keep theirs.
        for (const target of config.targets) {
          told(target.id);
          if (controlOf(target.id) === "manual") setControl(target.id, null, "taken-back");
        }
      }
      outputs.push(...restyleCommands(next.source));
    }
  } else if (event.kind === "release") {
    // Hand overridden lights back; an owner name releases only that owner's lights.
    const targets = Array.isArray(event.targets) ? event.targets : config.targets.map((target) => target.id);
    const owner = typeof event.owner === "string" && event.owner ? event.owner : null;
    for (const targetId of targets) {
      const entry = state.control[targetId];
      if (!targetById[targetId] || entry?.state !== "overridden" || (owner && entry.owner !== owner)) continue;
      setControl(targetId, null, "released");
      told(targetId);
      // Back in the room's style, over the style's own transition.
      const style = intendedOn(targetId) && state.style ? styled(targetId, state.style.transitionSeconds) : null;
      if (style) {
        const restyle = command(targetId, style, event.source || "release");
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
      // Whether a style is in force, and whose it is.
      styled: currentStyle() !== null,
      styleSource: state.style?.source ?? null,
      onCount,
      manualCount,
      overriddenCount,
      control
    }
  };
}
