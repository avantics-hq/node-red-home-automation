"use strict";

import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import type {NodeInitializer} from "node-red";
import registerActivityLighting from "../nodes/activity-lighting-controller";
import registerBacklighting from "../nodes/backlighting-controller";
import registerTheatreActivity from "../nodes/theatre-activity-controller";
import registerTheatreStateContract from "../nodes/theatre-state-contract";
import registerAvr from "../nodes/avr-controller";
import registerDisplay from "../nodes/display-mode-controller";
import registerMotion from "../nodes/motion-policy";
import registerSwitch from "../nodes/switch-policy";
import registerOccupancy from "../nodes/occupancy-fusion";
import registerRoom from "../nodes/room-controller";
import registerSource from "../nodes/source-capability-controller";
import type {TraceRecord} from "../lib/bounded-trace";
import {transitionActivityLighting} from "../lib/activity-lighting-controller";
import {transitionAvr} from "../lib/avr-controller";
import {transitionBacklighting} from "../lib/backlighting-controller";
import {transitionDisplay} from "../lib/display-mode-controller";
import {transitionSource} from "../lib/source-capability-controller";

interface RuntimeContext {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  global: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
}

interface RuntimeNode {
  on: EventEmitter["on"];
  emit: EventEmitter["emit"];
  sent: unknown[];
  errors: unknown[];
  statuses: unknown[];
  send(message: unknown): void;
  error(error: unknown): void;
  status(status: unknown): void;
  context(): RuntimeContext;
}

interface WireMessage {
  source?: string;
  payload?: unknown;
  topic?: string;
  retain?: boolean;
  lighting?: Record<string, unknown>;
  avr_command?: Record<string, unknown>;
  activityLighting?: Record<string, unknown>;
  activityLightingCommand?: Record<string, unknown>;
  backlighting?: Record<string, unknown>;
  backlightingCommand?: Record<string, unknown>;
  sourceCommand?: Record<string, unknown>;
  theatreCommand?: Record<string, unknown>;
  theatreStateContract?: Record<string, unknown>;
  theatre?: Record<string, unknown>;
}

type SendEnvelope = Array<WireMessage[] | null>;
type RuntimeConstructor = new (config: Record<string, unknown>) => RuntimeNode;

function runtime(
  register: NodeInitializer,
  credentials: Record<string, string> = {}
): {Constructor: RuntimeConstructor} {
  let Constructor: RuntimeConstructor | undefined;
  const globalValues = new Map<string, unknown>([["MOTION_ENABLED_STATE", true]]);
  // Shared by every node built from this runtime, as Node-RED keeps a node's
  // memory context across a redeploy.
  const values = new Map<string, unknown>();
  const RED = {
    nodes: {
      createNode(node: RuntimeNode) {
        (node as RuntimeNode & {credentials: Record<string, string>}).credentials = credentials;
        const emitter = new EventEmitter();
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.sent = [];
        node.errors = [];
        node.statuses = [];
        node.send = (message: unknown) => {
          node.sent.push(message);
        };
        node.error = (error: unknown) => {
          node.errors.push(error);
        };
        node.status = (status: unknown) => {
          node.statuses.push(status);
        };
        node.context = () => ({
          get: (key: string) => values.get(key),
          set: (key: string, value: unknown) => {
            values.set(key, value);
          },
          global: {
            get: (key: string) => globalValues.get(key),
            set: (key: string, value: unknown) => {
              globalValues.set(key, value);
            }
          }
        });
      },
      registerType(_name: string, implementation: RuntimeConstructor) {
        Constructor = implementation;
      }
    }
  };
  register(RED as unknown as Parameters<NodeInitializer>[0]);
  assert.ok(Constructor);
  return {Constructor};
}

function receive<T>(
  node: RuntimeNode,
  msg: Record<string, unknown>
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const sent: T[] = [];
    node.emit("input", msg, (message: T) => sent.push(message), (error?: Error) => {
      if (error) reject(error);
      else resolve(sent);
    });
  });
}

function close(node: RuntimeNode): Promise<void> {
  return new Promise<void>((resolve) => {
    node.emit("close", false, resolve);
  });
}

function traces(node: RuntimeNode): TraceRecord[] {
  return node.context().get("trace") as TraceRecord[];
}

test("motion adapter emits intents and persists standard traces", async (t) => {
  const {Constructor} = runtime(registerMotion);
  const node = new Constructor({
    area: "kitchen",
    onTargets: "[\"cooking\",\"dining\"]",
    offTargets: "[\"cooking\",\"dining\",\"cabinets\"]",
    defaultDelaySeconds: 30,
    defaultIlluminanceCutoff: 150,
    switchWindowMs: 500
  });
  t.after(() => close(node));

  await receive<WireMessage>(node, {source: "illuminance", payload: 1});
  const sent = await receive<WireMessage>(
    node,
    {source: "occupancy", payload: {occupied: true, trigger: "motion"}}
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.lighting?.state, "ON");
  const trace = traces(node);
  assert.equal(trace.at(-1)?.component, "motion-policy");
  assert.equal(trace.at(-1)?.area, "kitchen");
  assert.equal(trace.at(-1)?.event, "occupancy");
  assert.equal(trace.at(-1)?.outcome, "emit-on");
  assert.equal(node.errors.length, 0);
});

test("switch adapter emits gestures without motion state", async (t) => {
  const {Constructor} = runtime(registerSwitch);
  const node = new Constructor({
    area: "room",
    targets: "[\"main\"]",
    switchWindowMs: 500
  });
  t.after(() => close(node));

  assert.deepEqual(
    await receive<WireMessage>(node, {
      source: "switch-action",
      payload: {action: "double"},
      retain: true
    }),
    []
  );
  const sent = await receive<WireMessage>(node, {
    source: "switch-action",
    payload: {action: "double"}
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.lighting?.state, "ON");
  assert.deepEqual(sent[0]?.lighting?.values, {brightness: 254});
  assert.equal(traces(node).at(-1)?.component, "switch-policy");
  assert.equal(node.errors.length, 0);
});

test("occupancy adapter emits normalised occupancy and standard traces", async () => {
  const {Constructor} = runtime(registerOccupancy);
  const node = new Constructor({
    area: "kitchen",
    presenceMode: "hold"
  });

  assert.deepEqual(
    await receive<WireMessage>(node, {source: "presence", payload: {presence: true}}),
    []
  );
  const sent = await receive<WireMessage>(node, {source: "motion", payload: {motion: true}});
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.source, "occupancy");
  const occupancy = sent[0]?.payload as {occupied?: boolean} | undefined;
  assert.equal(occupancy?.occupied, true);
  const trace = traces(node);
  assert.equal(trace.at(-1)?.component, "occupancy-fusion");
  assert.equal(trace.at(-1)?.event, "motion");
  assert.equal(trace.at(-1)?.outcome, "triggered");
  assert.equal(node.errors.length, 0);
});

test("room adapter publishes startup messages and standard traces", async (t) => {
  const {Constructor} = runtime(registerRoom);
  const node = new Constructor({
    area: "kitchen",
    displayName: "Kitchen",
    targets: "[{\"id\":\"cooking\",\"stateTopic\":\"home/kitchen/light/group/cooking\",\"commandTopic\":\"home/kitchen/light/group/cooking/set\"}]",
    latitude: 51.5074,
    longitude: -0.1278,
    minBrightnessPct: 1,
    maxBrightnessPct: 100,
    minColorTempKelvin: 2000,
    maxColorTempKelvin: 5500,
    sleepBrightnessPct: 1,
    sleepColorTempKelvin: 1000,
    initialTransitionSeconds: 1,
    refreshTransitionSeconds: 45,
    refreshSeconds: 90,
    initialSleep: false
  });
  t.after(() => close(node));

  const startup = await receive<SendEnvelope>(node, {lighting: {kind: "startup"}});
  assert.equal(startup.length, 1);
  assert.equal(
    startup[0]?.[0]?.[0]?.topic,
    "homeassistant/switch/kitchen_circadian_lighting/config"
  );
  const commanded = await receive<SendEnvelope>(node, {
    lighting: {kind: "intent", targets: ["cooking"], state: "OFF", source: "test"}
  });
  const commandPayload = commanded[0]?.[0]?.[0]?.payload as {state?: string} | undefined;
  assert.equal(commandPayload?.state, "OFF");
  assert.deepEqual(
    await receive<SendEnvelope>(node, {
      topic: "home/kitchen/light/group/cooking/set",
      payload: {state: "ON"},
      retain: true,
      lighting: {kind: "command-observed", target: "cooking"}
    }),
    []
  );
  const trace = traces(node);
  assert.equal(trace.at(-1)?.component, "room-controller");
  assert.equal(trace.at(-1)?.event, "intent");
  assert.equal(trace.at(-1)?.outcome, "commanded");
  assert.equal(node.errors.length, 0);
});

test("room adapter deploys a saved configuration from before schedules, ignoring coordinates", async (t) => {
  // Saved by 2.2.x: latitude, longitude and the minimum settings, no times.
  const {Constructor} = runtime(registerRoom);
  const node = new Constructor({
    area: "room",
    displayName: "Room",
    targets: "[{\"id\":\"main\",\"stateTopic\":\"room/light/main\",\"commandTopic\":\"room/light/main/set\"}]",
    latitude: 51.5074,
    longitude: -0.1278,
    minBrightnessPct: 1,
    minColorTempKelvin: 2000
  });
  t.after(() => close(node));
  assert.deepEqual(node.errors, []);
  assert.notEqual((node.statuses.at(-1) as {text?: string} | undefined)?.text, "invalid configuration");
  // It commands the light; the default schedule's values are tested in the reducer.
  const sent = await receive<Array<Array<{payload?: Record<string, unknown>; topic?: string}>>>(node, {
    lighting: {kind: "intent", targets: ["main"], state: "ON", source: "motion"}
  });
  const command = sent.flat(2).find((message) => message.topic === "room/light/main/set");
  assert.equal(command?.payload?.state, "ON");
  assert.equal(typeof command?.payload?.brightness, "number");
});

test("AVR adapter emits protocol commands and bounded traces", async (t) => {
  const {Constructor} = runtime(registerAvr);
  const node = new Constructor({
    area: "lounge",
    sources: "{\"shield\":\"SAT/CBL\",\"playstation\":\"GAME\"}",
    retryMs: 2000,
    maxAttempts: 3
  });
  t.after(() => close(node));

  await receive<SendEnvelope>(
    node,
    {avr: {kind: "observed", line: "PWON\rZMON\rSISAT/CBL\rMV31\r"}}
  );
  const sent = await receive<SendEnvelope>(node, {
    avr: {
      kind: "intent",
      requestId: "adapter-test",
      generation: 1,
      power: "on",
      source: "playstation"
    }
  });
  const payload = sent[0]?.[0]?.[0]?.payload;
  assert.ok(Buffer.isBuffer(payload));
  assert.equal(payload.toString(), "SIGAME\r");
  assert.equal(sent[0]?.[0]?.[0]?.avr_command?.operation, "source");
  const trace = traces(node);
  assert.equal(trace.at(-1)?.component, "avr-controller");
  const accepted = trace.find((entry) => entry.event === "intent");
  assert.equal(accepted?.outcome, "accepted");
  assert.equal(trace.at(-1)?.event, "command");
  assert.equal(node.errors.length, 0);
});

test("source adapter emits semantic commands and target-state evidence", async (t) => {
  const {Constructor} = runtime(registerSource);
  const node = new Constructor({
    area: "lounge",
    sources: JSON.stringify({
      streamer: {activation: "command", deactivation: "command", confirmation: "active"}
    }),
    pollMs: 2000,
    confirmationTimeoutMs: 15000,
    maxAttempts: 2
  });
  t.after(() => close(node));

  const intent = await receive<SendEnvelope>(node, {
    sourceCapability: {
      kind: "intent",
      requestId: "source-adapter-test",
      generation: 1,
      sourceId: "streamer",
      action: "activate"
    }
  });
  assert.equal(intent[0]?.[0]?.[0]?.sourceCommand?.operation, "activate");
  assert.equal(intent[1]?.[1]?.[0]?.theatre?.status, "transitioning");

  const observedAt = new Date().toISOString();
  const observed = await receive<SendEnvelope>(node, {
    sourceCapability: {
      kind: "observed",
      sourceId: "streamer",
      generation: 1,
      status: "active",
      observedAt
    }
  });
  assert.equal(observed[0]?.[1]?.[0]?.theatre?.status, "ready");
  const trace = traces(node);
  assert.equal(trace.at(-1)?.component, "source-capability-controller");
  assert.equal(trace.at(-1)?.outcome, "ready");
  assert.equal(node.errors.length, 0);
});

test("activity lighting adapter preserves ownership and emits target evidence", async (t) => {
  const {Constructor} = runtime(registerActivityLighting);
  const node = new Constructor({
    area: "lounge",
    profiles: JSON.stringify({
      tv: {targets: ["wall", "lamp"], values: {brightness: 64}}
    }),
    confirmationTimeoutMs: 15000,
    maxAttempts: 2
  });
  t.after(() => close(node));

  const intent = await receive<SendEnvelope>(node, {
    activityLighting: {
      kind: "intent",
      requestId: "lighting-adapter-test",
      generation: 1,
      profile: "tv"
    }
  });
  assert.equal(intent[0]?.[0]?.[0]?.lighting?.preserveManual, true);
  assert.equal(intent[0]?.[0]?.[0]?.lighting?.updateOnOnly, true);
  assert.equal(intent[1]?.[1]?.[0]?.theatre?.status, "transitioning");

  const observedAt = new Date().toISOString();
  await receive<SendEnvelope>(node, {
    activityLighting: {
      kind: "observed",
      generation: 1,
      target: "wall",
      on: true,
      manual: true,
      values: {brightness: 254},
      observedAt
    }
  });
  const observed = await receive<SendEnvelope>(node, {
    activityLighting: {
      kind: "observed",
      generation: 1,
      target: "lamp",
      on: false,
      values: {},
      observedAt
    }
  });
  assert.equal(observed[0]?.[1]?.[0]?.theatre?.status, "ready");
  assert.equal(traces(node).at(-1)?.component, "activity-lighting-controller");
  assert.equal(node.errors.length, 0);
});

test("backlighting adapter waits for observed power before ready", async (t) => {
  const {Constructor} = runtime(registerBacklighting);
  const node = new Constructor({
    area: "lounge",
    pollMs: 2000,
    confirmationTimeoutMs: 15000,
    maxAttempts: 2
  });
  t.after(() => close(node));

  const intent = await receive<SendEnvelope>(node, {
    backlighting: {
      kind: "intent",
      requestId: "backlighting-adapter-test",
      generation: 1,
      power: "on"
    }
  });
  assert.equal(intent[0]?.[0]?.[0]?.backlightingCommand?.operation, "set_power");
  assert.equal(intent[1]?.[1]?.[0]?.theatre?.status, "transitioning");

  const result = await receive<SendEnvelope>(node, {
    backlighting: {
      kind: "command_result",
      generation: 1,
      ok: true
    }
  });
  assert.notEqual(result[0]?.[1]?.[0]?.theatre?.status, "ready");

  const observed = await receive<SendEnvelope>(node, {
    backlighting: {
      kind: "observed",
      generation: 1,
      power: "on",
      observedAt: new Date().toISOString()
    }
  });
  assert.equal(observed[0]?.[1]?.[0]?.theatre?.status, "ready");
  assert.equal(traces(node).at(-1)?.component, "backlighting-controller");
  assert.equal(node.errors.length, 0);
});

test("theatre activity adapter emits semantic target plans and complete state", async (t) => {
  const {Constructor} = runtime(registerTheatreActivity);
  const profile = {
    display: {mode: "tv"},
    avr: {power: "on", source: "streamer"},
    source: {action: "activate", sourceId: "streamer", readiness: "required"},
    lighting: {profile: "tv"},
    backlighting: {power: "on"}
  };
  const node = new Constructor({
    area: "lounge",
    freshnessMs: 30000,
    activityProfiles: JSON.stringify({tv_streamer: profile})
  });
  t.after(() => close(node));

  const sent = await receive<SendEnvelope>(node, {
    theatre: {
      kind: "intent",
      requestId: "activity-adapter-test",
      generation: 1,
      activity: "tv_streamer",
      requestedAt: "2026-11-21T17:00:00.000Z"
    }
  });
  assert.equal(sent[0]?.[0]?.length, 5);
  assert.equal(sent[0]?.[0]?.[0]?.theatreCommand?.target, "display");
  const state = sent[1]?.[1]?.find((entry) => entry.theatre?.kind === "state");
  assert.equal(state?.theatre?.desiredActivity, "tv_streamer");
  assert.equal(state?.theatre?.requestedAt, "2026-11-21T17:00:00.000Z");
  assert.equal(traces(node).at(-1)?.component, "theatre-activity-controller");
  assert.equal(node.errors.length, 0);
});

test("theatre state adapter bridges non-retained requests and retained HA truth", async (t) => {
  const {Constructor} = runtime(registerTheatreStateContract);
  const node = new Constructor({
    area: "lounge",
    displayName: "Lounge",
    baseTopic: "home/lounge/theatre",
    discoveryPrefix: "homeassistant",
    activities: "[\"off\",\"tv_streamer\"]"
  });
  t.after(() => close(node));

  const startup = await receive<SendEnvelope>(node, {
    theatreStateContract: {kind: "startup"}
  });
  assert.equal(startup[0]?.[1]?.length, 13);
  assert.equal(startup[0]?.[1]?.every((entry) => entry.retain === true), true);

  const requested = await receive<SendEnvelope>(node, {
    topic: "home/lounge/theatre/request",
    payload: {requestId: "mqtt-adapter-test", activity: "tv_streamer"},
    retain: false
  });
  assert.equal(requested[0]?.[0]?.[0]?.theatre?.kind, "intent");
  assert.equal(requested[0]?.[0]?.[0]?.theatre?.generation, 1);

  const published = await receive<SendEnvelope>(node, {
    theatre: {
      kind: "state",
      area: "lounge",
      requestId: "mqtt-adapter-test",
      generation: 1,
      desiredActivity: "tv_streamer",
      requestedAt: new Date().toISOString(),
      currentActivity: "unknown",
      phase: "transitioning",
      availability: "unknown",
      transitionStartedAt: new Date().toISOString(),
      transitionCompletedAt: null,
      targets: {},
      failure: null,
      degraded: []
    }
  });
  const phase = published[0]?.[1]?.find((entry) => entry.topic === "home/lounge/theatre/phase");
  assert.equal(phase?.payload, "transitioning");
  assert.equal(phase?.retain, true);
  assert.equal(traces(node).at(-1)?.component, "theatre-state-contract");
  assert.equal(node.errors.length, 0);
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function savedState(node: RuntimeNode): Record<string, unknown> {
  return node.context().get("state") as Record<string, unknown>;
}

const motionConfig = {
  area: "kitchen",
  onTargets: "[\"cooking\"]",
  offTargets: "[\"cooking\"]",
  defaultDelaySeconds: 0.2,
  defaultIlluminanceCutoff: 150,
  switchWindowMs: 500
};

test("motion adapter re-arms a pending off-timer after a redeploy", async (t) => {
  const {Constructor} = runtime(registerMotion);
  const before = new Constructor(motionConfig);
  await receive<WireMessage>(before, {source: "occupancy", payload: {occupied: false}});
  assert.equal(typeof savedState(before).offTimerDueAt, "number");
  await close(before);

  const after = new Constructor(motionConfig);
  t.after(() => close(after));
  assert.equal(after.sent.length, 0);
  await wait(400);
  assert.deepEqual((after.sent as WireMessage[]).map((message) => message.lighting?.state), ["OFF"]);
  assert.equal(savedState(after).offTimerDueAt, null);
});

test("motion adapter fires an off-timer that fell due during the restart straight away", async (t) => {
  const {Constructor} = runtime(registerMotion);
  const before = new Constructor({...motionConfig, defaultDelaySeconds: 30});
  await receive<WireMessage>(before, {source: "occupancy", payload: {occupied: false}});
  await close(before);
  before.context().set("state", {...savedState(before), offTimerDueAt: Date.now() - 1000});

  const after = new Constructor({...motionConfig, defaultDelaySeconds: 30});
  t.after(() => close(after));
  await wait(50);
  assert.deepEqual((after.sent as WireMessage[]).map((message) => message.lighting?.state), ["OFF"]);
});

test("motion adapter arms nothing at startup without a pending off-timer", async (t) => {
  const {Constructor} = runtime(registerMotion);
  const before = new Constructor(motionConfig);
  await receive<WireMessage>(before, {source: "occupancy", payload: {occupied: false}});
  await receive<WireMessage>(before, {source: "occupancy", payload: {occupied: true}});
  assert.equal(savedState(before).offTimerDueAt, null);
  await close(before);

  const after = new Constructor(motionConfig);
  t.after(() => close(after));
  await wait(400);
  assert.equal(after.sent.length, 0);
});

test("activity lighting adapter re-observes a deadline that passed during a redeploy", async (t) => {
  const {Constructor} = runtime(registerActivityLighting);
  const lightingConfig = {
    area: "lounge",
    profiles: JSON.stringify({tv: {targets: ["wall"], values: {brightness: 64}}}),
    confirmationTimeoutMs: 15000,
    maxAttempts: 1
  };
  const before = new Constructor(lightingConfig);
  await receive<SendEnvelope>(before, {
    activityLighting: {kind: "intent", requestId: "lighting-redeploy", generation: 1, profile: "tv"}
  });
  await close(before);
  const state = savedState(before);
  const pending = state.pending as Record<string, unknown>;
  before.context().set("state", {...state, pending: {...pending, deadlineAt: Date.now() - 1000}});

  const after = new Constructor(lightingConfig);
  t.after(() => close(after));
  assert.equal(after.sent.length, 0);
  await wait(50);
  const envelopes = after.sent as SendEnvelope[];
  assert.deepEqual(envelopes.flatMap((envelope) => envelope[0] ?? []).map((message) => message.activityLightingCommand?.operation), ["observe"]);
  assert.deepEqual(envelopes.map((envelope) => envelope[1]?.[0]?.theatre?.status).filter(Boolean), ["confirming"]);
  assert.equal(traces(after).at(-1)?.event, "startup");
});

test("backlighting adapter re-observes a pending command after a redeploy", async (t) => {
  const {Constructor} = runtime(registerBacklighting);
  const backlightingConfig = {area: "lounge", pollMs: 2000, confirmationTimeoutMs: 15000, maxAttempts: 2};
  const before = new Constructor(backlightingConfig);
  await receive<SendEnvelope>(before, {
    backlighting: {kind: "intent", requestId: "backlighting-redeploy", generation: 1, power: "on"}
  });
  await close(before);
  const state = savedState(before);
  const pending = state.pending as Record<string, unknown>;
  before.context().set("state", {...state, pending: {...pending, nextAt: Date.now() + 100}});

  const after = new Constructor(backlightingConfig);
  t.after(() => close(after));
  assert.equal(after.sent.length, 0);
  await wait(50);
  const operations = (after.sent as SendEnvelope[]).flatMap((envelope) => envelope[0] ?? [])
    .map((message) => message.backlightingCommand?.operation);
  assert.deepEqual(operations, ["observe"]);
  assert.equal((savedState(after).pending as Record<string, unknown>).operation, "observe");
});

// Fake TV, screen and projector meter: TV in standby, screen open, projector at `watts`.
function fakeDisplayDevices(t: {after(fn: () => void): void}) {
  const realFetch = globalThis.fetch;
  const devices = {watts: 2};
  globalThis.fetch = (async (url: string | URL | Request) => {
    const key = String(url instanceof Request ? url.url : url);
    const body = key.includes("sony")
      ? {result: [{status: "standby"}], id: 50}
      : key.includes("Cover.GetStatus")
        ? {current_pos: 100, state: "stopped"}
        : {apower: devices.watts};
    return new Response(JSON.stringify(body), {status: 200});
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return devices;
}

const displayConfig = {
  area: "lounge",
  tvHost: "tv.invalid",
  screenHost: "screen.invalid",
  projectorMeterHost: "projector.invalid",
  screenOpenPosition: 100
};

function powerToggles(node: RuntimeNode): number {
  return (node.sent as Array<Array<Record<string, unknown> | null>>)
    .filter((envelope) => envelope[0]?.payload === "power").length;
}

async function displayStartingProjector(t: {after(fn: () => void): void}) {
  const devices = fakeDisplayDevices(t);
  const {Constructor} = runtime(registerDisplay, {tvPsk: "synthetic"});
  const before = new Constructor(displayConfig);
  await receive<SendEnvelope>(before, {display: {kind: "intent", requestId: "display-restart", generation: 1, mode: "projector"}});
  await wait(200);
  assert.equal((savedState(before).pending as Record<string, unknown>).operation, "projector_start");
  assert.equal(powerToggles(before), 1);
  await close(before);
  return {Constructor, before, devices};
}

test("display adapter recovers a projector start that timed out during a restart", async (t) => {
  // dev-review repro: the projector warmed up while Node-RED was down.
  const {Constructor, before, devices} = await displayStartingProjector(t);
  const state = savedState(before);
  before.context().set("state", {
    ...state,
    // Downtime longer than the warm-up: its deadline and minimum have passed.
    pending: {...(state.pending as Record<string, unknown>), deadlineAt: Date.now() - 1000, nextAt: Date.now() - 1000, readyAt: Date.now() - 1000}
  });
  devices.watts = 300;

  const after = new Constructor(displayConfig);
  t.after(() => close(after));
  await wait(300);
  assert.equal(savedState(after).failure, null);
  await receive<SendEnvelope>(after, {display: {kind: "startup"}});
  await wait(300);
  const recovered = savedState(after);
  assert.equal(recovered.phase, "ready");
  assert.equal(recovered.failure, null);
  assert.equal(recovered.blockedGeneration, null);
  assert.equal(powerToggles(after), 0);
  assert.equal(traces(after).some((entry) => entry.outcome === "failed"), false);
});

test("display adapter redeploy during warm-up never toggles the projector again", async (t) => {
  // dev-review: a startup during warm-up used to re-issue the start toggle,
  // switching the warming projector off. The start in flight is now kept.
  const {Constructor, devices} = await displayStartingProjector(t);
  devices.watts = 5;

  const after = new Constructor(displayConfig);
  t.after(() => close(after));
  await wait(300);
  assert.equal(powerToggles(after), 0);
  await receive<SendEnvelope>(after, {display: {kind: "startup"}});
  await wait(300);
  assert.equal(powerToggles(after), 0);
  assert.equal((savedState(after).pending as Record<string, unknown>).operation, "projector_start");
});

test("AVR adapter recovers a source change whose retries ran out during a restart", async (t) => {
  const {Constructor} = runtime(registerAvr);
  const avrConfig = {area: "lounge", sources: "{\"shield\":\"SAT/CBL\",\"playstation\":\"GAME\"}", retryMs: 1000, maxAttempts: 3};
  const before = new Constructor(avrConfig);
  await receive<SendEnvelope>(before, {avr: {kind: "observed", line: "PWON\rZMON\rSISAT/CBL\rMV31\r"}});
  await receive<SendEnvelope>(before, {avr: {kind: "intent", requestId: "avr-restart", generation: 1, power: "on", source: "playstation"}});
  await close(before);
  const state = savedState(before);
  before.context().set("state", {
    ...state,
    pending: {...(state.pending as Record<string, unknown>), attempt: 3, deadlineAt: Date.now() - 1000}
  });

  const after = new Constructor(avrConfig);
  t.after(() => close(after));
  await wait(50);
  await receive<SendEnvelope>(after, {avr: {kind: "startup"}});
  await receive<SendEnvelope>(after, {avr: {kind: "observed", line: "PWON\rZMON\rSIGAME\rMV31\r"}});
  const recovered = savedState(after);
  assert.equal(recovered.phase, "ready");
  assert.equal(recovered.blockedGeneration, null);
  assert.equal(traces(after).some((entry) => entry.outcome === "failed"), false);
  const statuses = (after.sent as SendEnvelope[]).flatMap((envelope) => envelope[1] ?? [])
    .map((message) => message.theatre?.status);
  assert.equal(statuses.includes("failed"), false);
});

test("a flow startup after the construction startup changes nothing but repeats discovery", () => {
  // Same clock for both, so a harmless second startup reproduces the first exactly.
  const now = new Date("2026-11-21T10:00:00Z");
  const later = new Date("2026-11-21T10:05:00Z");
  const twice = (
    name: string,
    transition: (saved: unknown, msg: Record<string, unknown>, config: unknown, at: Date) => {state: unknown; commands: unknown; events: unknown},
    key: string,
    config: unknown,
    intent: Record<string, unknown>
  ) => {
    const pending = transition(undefined, {[key]: {kind: "intent", requestId: name, generation: 1, ...intent}}, config, now).state;
    const first = transition(pending, {[key]: {kind: "startup"}}, config, later);
    const second = transition(first.state, {[key]: {kind: "startup"}}, config, later);
    assert.deepEqual(second.state, first.state, name);
    assert.deepEqual(second.commands, first.commands, name);
    assert.deepEqual(second.events, first.events, name);
  };
  type Loose = Parameters<typeof twice>[1];
  twice("activity", transitionActivityLighting as unknown as Loose, "activityLighting", {
    profiles: {tv: {targets: ["wall"], values: {brightness: 64}}}, confirmationTimeoutMs: 15000, maxAttempts: 2
  }, {profile: "tv"});
  twice("backlighting", transitionBacklighting as unknown as Loose, "backlighting", {
    pollMs: 2000, confirmationTimeoutMs: 15000, maxAttempts: 2
  }, {power: "on"});
  twice("source", transitionSource as unknown as Loose, "sourceCapability", {
    sources: {streamer: {activation: "command", deactivation: "command", confirmation: "active"}},
    pollMs: 2000, confirmationTimeoutMs: 15000, maxAttempts: 2
  }, {sourceId: "streamer", action: "activate"});
  twice("avr", transitionAvr as unknown as Loose, "avr", {
    area: "lounge", sources: {shield: "SAT/CBL", playstation: "GAME"}, retryMs: 1000, maxAttempts: 3, minVolume: 0, maxVolume: 60
  }, {power: "on", source: "playstation"});
  twice("display", transitionDisplay as unknown as Loose, "display", {
    screenOpenPosition: 82, screenTolerance: 2, pollMs: 1000, queryTimeoutMs: 1000, tvTimeoutMs: 4000,
    screenTimeoutMs: 5000, projectorWarmupMs: 4000, projectorMinimumWarmupMs: 3000, projectorShutdownConfirmMs: 2000,
    projectorCooldownMs: 5000, maxAttempts: 2, projectorOnWatts: 20, projectorOffWatts: 10, projectorPowerFallback: false
  }, {mode: "projector"});
});

test("wired contract and activity controller never lose a request to a recovery generation", async (t) => {
  // Wired as in examples/Home theatre activity.json: contract output 1 to the
  // controller, controller output 2 back to the contract. The user's request
  // reaches the contract before the controller's recovery snapshot does.
  const profiles = JSON.stringify({
    off: {display: {mode: "off"}, avr: {power: "off"}, source: {action: "deactivate", readiness: "optional"}, lighting: {profile: "off"}, backlighting: {power: "off"}},
    tv: {display: {mode: "tv"}, avr: {power: "on", source: "shield"}, source: {action: "activate", sourceId: "streamer", readiness: "required"}, lighting: {profile: "tv"}, backlighting: {power: "on"}}
  });
  const contract = new (runtime(registerTheatreStateContract).Constructor)({
    area: "room", displayName: "Room", baseTopic: "home/room/theatre", discoveryPrefix: "homeassistant", activities: "[\"off\",\"tv\"]"
  });
  const controller = new (runtime(registerTheatreActivity).Constructor)({
    area: "room", freshnessMs: 30000, recoveryOffActivity: "off", activityProfiles: profiles
  });
  t.after(() => close(contract));
  t.after(() => close(controller));
  const output = (envelopes: SendEnvelope[], index: number) => envelopes.flatMap((envelope) => envelope[index] ?? []);

  await receive<SendEnvelope>(controller, {theatre: {kind: "startup"}});
  const recovery = await receive<SendEnvelope>(controller, {theatre: {kind: "recover", reason: "startup", observations: {}}});
  const snapshots = output(recovery, 1);

  // Two back-to-back requests reach the contract before any snapshot does.
  const first = await receive<SendEnvelope>(contract, {topic: "home/room/theatre/request", payload: {requestId: "user-request-1", activity: "tv"}});
  const second = await receive<SendEnvelope>(contract, {topic: "home/room/theatre/request", payload: {requestId: "user-request-2", activity: "off"}});
  const intents = [...output(first, 0), ...output(second, 0)];
  assert.equal(intents.length, 2);
  const states: Array<Record<string, unknown>> = [];
  for (const intent of intents) {
    const answer = await receive<SendEnvelope>(controller, intent as Record<string, unknown>);
    assert.equal(output(answer, 1).some((message) => message.theatre?.kind === "rejected"), false);
    states.push(...output(answer, 1) as Array<Record<string, unknown>>);
  }
  const state = controller.context().get("state") as {desired: {requestId: string; activity: string; generation: number}};
  assert.equal(state.desired.requestId, "user-request-2");
  assert.equal(state.desired.activity, "off");

  // The late recovery snapshots and the new states then reach the contract in order.
  for (const message of [...snapshots, ...states]) await receive<SendEnvelope>(contract, message as Record<string, unknown>);
  const contractState = contract.context().get("state") as {generation: number};
  assert.equal(contractState.generation, state.desired.generation);
});

test("room adapter rejects an unusable wake and bed schedule at deploy", () => {
  for (const [label, times, reason] of [
    ["not a time", {wakeTime: "7am", bedTime: "23:00"}, /HH:MM/],
    ["a blank wake time defaults to 07:00, the same as bed", {wakeTime: "", bedTime: "07:00"}, /differ/],
    ["the same time", {wakeTime: "07:00", bedTime: "07:00"}, /differ/]
  ] as const) {
    const {Constructor} = runtime(registerRoom);
    const node = new Constructor({area: "room", displayName: "Room", targets: "[]", latitude: 0, longitude: 0, ...times});
    const status = node.statuses.at(-1) as {fill?: string; text?: string} | undefined;
    assert.equal(status?.fill, "red", label);
    assert.equal(status?.text, "invalid configuration", label);
    assert.match(String(node.errors[0]), /^invalid configuration: /, label);
    assert.match(String(node.errors[0]), reason, label);
  }
});
