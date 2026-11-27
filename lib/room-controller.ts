"use strict";

import type {TraceEntry} from "./bounded-trace";
import type {LightStyle} from "./light-styling";
import {isLightReading, type LightCommandMessage, type LightField, type LightRoomMessage} from "./light-contract";
import {REMOVED_LIGHT_FIELDS} from "./z2m-light";
import {ECHO_WINDOW_MS, checkStateReport, commandSent, commandSkipped, rememberCommand, type ExpectedCommand} from "./command-echo";

export {fingerprint, parsePayload, type ExpectedCommand} from "./command-echo";

// A light, by the room's id for it. Its device is reached through its
// adapter (such as the Zigbee2MQTT light), which the id also names.
export interface RoomTarget {
  id: string;
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


// A light's last reading, as its adapter gave it.
export interface RoomObservation {
  on: boolean;
  brightnessPct?: number;
  colorTempKelvin?: number;
  fields?: LightField[];
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

// The targets of a room saved before 6.0, which named each light's
// Zigbee2MQTT topics (stateTopic, commandTopic): they move to a light
// adapter each, so such a room hasn't been migrated either. Their ids.
export function targetsWithTopics(targets: unknown): string[] {
  let parsed: unknown = targets;
  if (typeof targets === "string") {
    try { parsed = JSON.parse(targets); } catch { return []; }
  }
  return Array.isArray(parsed)
    ? parsed.filter((target) => target && typeof target === "object" && ("stateTopic" in target || "commandTopic" in target))
      .map((target) => String((target as {id?: unknown}).id))
    : [];
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
  // Each light's availability, as its adapter last reported it: shown on its
  // control state and the node's status, never acted on.
  available: Record<string, boolean>;
  // Numbers the room's commands, for the ids its adapters answer with.
  commandSeq: number;
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
  // A light adapter's reading (light-contract.ts).
  light?: unknown;
  topic?: string;
  payload?: unknown;
  retain?: boolean;
}

// A retained MQTT publication: a light's control state, the room's
// availability, its discovery.
export interface RoomOutput {
  topic: string;
  payload: unknown;
  retain: boolean;
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
      .filter(([target, at]) => Number.isFinite(at) && config.targets.some((entry) => entry.id === target))),
    available: Object.fromEntries(Object.entries(saved.available || {}).filter(([, online]) => typeof online === "boolean")),
    commandSeq: Number.isInteger(saved.commandSeq) ? saved.commandSeq! : 0
  };
}

// A brightness percent or kelvin as a number: a number, or a finite numeric
// string; null otherwise.
function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

// An intent's values for a light: brightnessPct and colorTempKelvin as
// numbers, anything else (an effect, say) passed on as it is, in its order.
// brightness and color_temp, Zigbee2MQTT's own units removed in 6.0, are
// `removed`; an unusable brightnessPct or colorTempKelvin is `invalid`.
// Neither reaches the light.
export function intentValues(values: Record<string, unknown>) {
  const extra: Record<string, unknown> = {};
  const removed: string[] = [];
  const invalid: string[] = [];
  let brightnessPct: number | undefined;
  let colorTempKelvin: number | undefined;
  for (const [key, value] of Object.entries(values)) {
    if (key === "brightnessPct" || key === "colorTempKelvin") {
      const number = numberValue(value);
      if (number === null || (key === "colorTempKelvin" && number <= 0)) invalid.push(key);
      else if (key === "brightnessPct") brightnessPct = number;
      else colorTempKelvin = number;
    } else if ((REMOVED_LIGHT_FIELDS as readonly string[]).includes(key)) {
      removed.push(key);
    } else {
      extra[key] = value;
    }
  }
  return {brightnessPct, colorTempKelvin, extra, removed, invalid};
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
  // Light commands (and requests for readings), for the lights' adapters.
  const commands: LightRoomMessage[] = [];

  function trace(event: string, outcome: string, reason: string | null = null, details: Record<string, unknown> = {}) {
    traces.push({event, outcome, reason, details});
  }

  const controlChanged = new Set<string>();
  // Lights whose availability changed, for their control state publications.
  const availabilityChanged = new Set<string>();

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

  // What a command sets, before it is numbered and sent.
  type Spec = Omit<LightCommandMessage, "kind" | "target" | "source" | "id">;

  // A command for a light, remembered for its power until a reading confirms
  // it; a restyle only tentatively, until its adapter says it sent it.
  function command(targetId: string, spec: Spec, source: string): LightCommandMessage | null {
    if (!targetById[targetId]) return null;
    state.commandSeq += 1;
    const id = String(state.commandSeq);
    state.expected[targetId] = rememberCommand(state.expected[targetId], {state: spec.state}, nowMs, {id, tentative: spec.restyle === true});
    const message: LightCommandMessage = {kind: "command", target: targetId, ...spec, source, id};
    commands.push(message);
    return message;
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
  function styled(targetId: string, transitionSeconds: number): Spec | null {
    const style = currentStyle();
    return style && !onOffOnly(targetId)
      ? {state: "ON", brightnessPct: style.brightnessPct, colorTempKelvin: style.colorTempKelvin, transitionSeconds}
      : null;
  }

  // Each light that is on and the room's to style, moved to the style in
  // force over the style's transition.
  // Each light that is on and the room's to style, moved to the style in
  // force over the style's transition. Its adapter skips a light that
  // already shows it (and says so).
  function restyleLights(source: string): void {
    const style = currentStyle();
    if (!style || !state.style) return;
    for (const target of config.targets) {
      if (!intendedOn(target.id) || controlOf(target.id) !== "in-control") continue;
      if (onOffOnly(target.id)) continue;
      if (state.untold.includes(target.id)) {
        trace("refresh", "skipped", "not-told-since-start", {target: target.id});
        continue;
      }
      command(target.id, {state: "ON", brightnessPct: style.brightnessPct, colorTempKelvin: style.colorTempKelvin,
        transitionSeconds: state.style.transitionSeconds, restyle: true}, source);
    }
  }

  function emitIntent(event: LightingEvent): LightCommandMessage[] {
    const targets = Array.isArray(event.targets)
      ? event.targets
      : config.targets.map((target) => target.id);
    const requestedState = String(event.state || "").toUpperCase();
    if (!["ON", "OFF", "TOGGLE"].includes(requestedState)) return [];
    const sent: Array<LightCommandMessage | null> = [];
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
      } else if (event.manual === true) {
        // Only a person's change makes a light manual: since 6.0, an intent's
        // values alone don't.
        setControl(targetId, {state: "manual"}, "manual-intent");
      }

      let spec: Spec;
      if (resolvedState === "OFF") {
        spec = {state: "OFF"};
      } else if (manualValues && onOffOnly(targetId)) {
        // Nothing to set on a light that only switches: left out, and the
        // node warns.
        trace("intent", "accepted", ON_OFF_ONLY, {target: targetId, dropped: Object.keys(manualValues)});
        spec = {state: "ON"};
      } else if (manualValues) {
        const values = intentValues(manualValues);
        if (values.removed.length) trace("intent", "accepted", REMOVED_LIGHT_UNITS, {target: targetId, dropped: values.removed, values: manualValues});
        if (values.invalid.length) trace("intent", "accepted", INVALID_LIGHT_VALUES, {target: targetId, dropped: values.invalid, values: manualValues});
        spec = {
          state: "ON",
          ...(Object.keys(values.extra).length ? {extra: values.extra} : {}),
          ...(values.brightnessPct !== undefined ? {brightnessPct: values.brightnessPct} : {}),
          ...(values.colorTempKelvin !== undefined ? {colorTempKelvin: values.colorTempKelvin} : {}),
          // An intent's own transition (among its other fields) stands.
          transitionSeconds: config.initialTransitionSeconds
        };
      } else {
        // A bare ON: the style in force for a light the room controls,
        // otherwise just on.
        spec = (controlOf(targetId) === "in-control" ? styled(targetId, config.initialTransitionSeconds) : null) ?? {state: "ON"};
      }
      state.desired[targetId] = resolvedState === "ON";
      told(targetId);
      sent.push(command(targetId, spec, event.source || "intent"));
    }
    return sent.filter((entry): entry is LightCommandMessage => entry !== null);
  }

  // What the room publishes, and the MQTT it reads for itself, are
  // room-publishing.ts's; this decides about lights only.
  const event: LightingEvent = msg.lighting || {};
  const reading = isLightReading(msg.light) && targetById[msg.light.target] ? msg.light : null;
  if (reading?.kind === "observed") {
    const target = targetById[reading.target]!;
    const previousOn = state.observed[target.id]?.on;
    const nextOn = reading.on === true;
    state.observed[target.id] = {
      on: nextOn,
      ...(typeof reading.brightnessPct === "number" ? {brightnessPct: reading.brightnessPct} : {}),
      ...(typeof reading.colorTempKelvin === "number" ? {colorTempKelvin: reading.colorTempKelvin} : {}),
      fields: Array.isArray(reading.fields) ? [...reading.fields] : [],
      observedAt: now.toISOString()
    };
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
  } else if (reading?.kind === "echo-changed") {
    // Our own command, changed on the way (the command path should pass it
    // through as it is): never answered as someone else's. Its adapter knew.
    trace("command-observed", "ignored", "mutated-own-command", {target: reading.target, state: String(reading.state || "").toUpperCase()});
  } else if (reading?.kind === "skipped") {
    // A restyle its adapter didn't send: the light already shows it.
    state.expected[reading.target] = commandSkipped(state.expected[reading.target], String(reading.id), nowMs);
    trace("refresh", "skipped", "already-at-level", {target: reading.target});
  } else if (reading?.kind === "sent") {
    state.expected[reading.target] = commandSent(state.expected[reading.target], String(reading.id), nowMs);
  } else if (reading?.kind === "availability") {
    // Shown, never acted on.
    if (state.available[reading.target] !== reading.online) {
      state.available[reading.target] = reading.online === true;
      availabilityChanged.add(reading.target);
      trace("availability", reading.online ? "online" : "offline", null, {target: reading.target});
    }
  } else if (reading?.kind === "external") {
    // Someone else's command, as its adapter told it from the room's own.
    const target = targetById[reading.target]!;
    const requestedState = String(reading.state || "").toUpperCase();
    if (requestedState === "OFF") {
      state.desired[target.id] = false;
      setControl(target.id, null, "external-off");
    } else if (requestedState === "ON") {
      state.desired[target.id] = true;
      if (reading.setsValues === true && !onOffOnly(target.id)) {
        setControl(target.id, {state: "manual"}, "external-values");
      } else if (currentStyle() && !onOffOnly(target.id) && controlOf(target.id) === "in-control") {
        // At most one restyle per light per echo window, whatever comes
        // back: a bare ON delivered twice (two subscriptions, or a QoS
        // redelivery) can't make the room answer itself in a loop.
        const last = state.restyledAt[target.id];
        if (last !== undefined && nowMs - last >= 0 && nowMs - last < ECHO_WINDOW_MS) {
          trace("external-command", "suppressed", "restyled-recently", {target: target.id});
        } else if (command(target.id, styled(target.id, config.initialTransitionSeconds)!, "external-bare-on")) {
          state.restyledAt[target.id] = nowMs;
        }
        // Styled now, so a style keeps it in step from here.
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
  } else if (event.kind === "startup") {
    // Each light is asked for a fresh reading, rather than waiting for a change.
    for (const target of config.targets) commands.push({kind: "observe", target: target.id});
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
      restyleLights(next.source);
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
      if (style) command(targetId, style, event.source || "release");
    }
  } else if (event.kind === "intent") {
    const sent = emitIntent(event).map(({target, state: power}) => ({target, state: power}));
    trace("intent", sent.length ? "commanded" : "suppressed", sent.length ? null : "no-command-required", {
      source: event.source || "intent",
      state: String(event.state || "").toUpperCase(),
      targets: Array.isArray(event.targets)
        ? event.targets
        : config.targets.map((target) => target.id),
      commands: sent
    });
  }

  const onCount = Object.values(state.desired).filter(Boolean).length;
  const control = Object.fromEntries(config.targets.map((target) => [target.id, controlOf(target.id)]));
  const manualCount = Object.values(control).filter((entry) => entry === "manual").length;
  const overriddenCount = Object.values(control).filter((entry) => entry === "overridden").length;
  const offlineCount = config.targets.filter((target) => state.available[target.id] === false).length;
  return {
    state,
    outputs,
    // Light commands for the lights' adapters, in the order sent.
    commands,
    traces,
    // The lights whose control state, or availability, changed, in
    // configured order.
    controlChanged: config.targets.map((target) => target.id).filter((id) => controlChanged.has(id) || availabilityChanged.has(id)),
    status: {
      // Whether a style is in force, and whose it is.
      styled: currentStyle() !== null,
      styleSource: state.style?.source ?? null,
      onCount,
      offlineCount,
      manualCount,
      overriddenCount,
      control
    }
  };
}
