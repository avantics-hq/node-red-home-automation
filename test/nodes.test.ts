"use strict";

import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import type {NodeInitializer} from "node-red";
import registerActivityLighting from "../nodes/activity-lighting-controller";
import registerBacklighting from "../nodes/backlighting-controller";
import registerTheatreActivity from "../nodes/theatre-activity-controller";
import registerTheatreStateContract from "../nodes/theatre-state-contract";
import registerAvr from "../nodes/avr-controller";
import registerCover from "../nodes/cover-controller";
import registerDisplay from "../nodes/display-mode-controller";
import registerMotion from "../nodes/motion-policy";
import registerSwitch from "../nodes/switch-policy";
import registerOccupancy from "../nodes/occupancy-fusion";
import registerRoom from "../nodes/room-controller";
import registerHouse from "../nodes/house-schedule";
import registerSource from "../nodes/source-capability-controller";
import type {TraceRecord} from "../lib/bounded-trace";
import {transitionActivityLighting} from "../lib/activity-lighting-controller";
import {transitionAvr} from "../lib/avr-controller";
import {transitionBacklighting} from "../lib/backlighting-controller";
import {normaliseConfig as normaliseDisplayConfig, transitionDisplay} from "../lib/display-mode-controller";
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
  error(error: unknown, msg?: unknown): void;
  status(status: unknown): void;
  context(): RuntimeContext;
  // What Node-RED does to the node's context once it has closed.
  closeContext?(): void;
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

// For tests of what a node keeps across a redeploy or restart: those need a
// configured context store, the setup the README recommends.
const STORE = {contextStore: true};

function runtime(
  register: NodeInitializer,
  credentials: Record<string, string> = {},
  {contextStore = false}: {contextStore?: boolean} = {}
): {Constructor: RuntimeConstructor; events: EventEmitter; flowNodeIds: Set<string>} {
  let Constructor: RuntimeConstructor | undefined;
  const globalValues = new Map<string, unknown>([["MOTION_ENABLED_STATE", true]]);
  // Every node's context, by node ID. As in Node-RED 5.0.10, a node's context
  // is deleted when it closes (a redeploy of it, or a restart) unless a
  // context store is configured (runtime/lib/nodes/Node.js:359-370,
  // context/index.js:557-583); contextStore: true simulates one.
  const values = new Map<string, unknown>();
  // Node-RED's runtime events, such as "flows:started" after a deploy.
  const events = new EventEmitter();
  const flowNodeIds = new Set<string>();
  const RED = {
    events,
    nodes: {
      createNode(node: RuntimeNode, config?: {id?: string}) {
        (node as RuntimeNode & {credentials: Record<string, string>}).credentials = credentials;
        // As Node-RED does, the node takes its ID from its saved config.
        (node as RuntimeNode & {id?: string}).id = config?.id;
        flowNodeIds.add(config?.id ?? "");
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
        // Each node ID has its own context, as in Node-RED; nodes built
        // without one share it.
        const own = (key: string) => `${config?.id ?? ""}:${key}`;
        node.closeContext = () => {
          if (contextStore) return;
          for (const key of [...values.keys()]) if (key.startsWith(`${config?.id ?? ""}:`)) values.delete(key);
        };
        node.context = () => ({
          get: (key: string) => values.get(own(key)),
          set: (key: string, value: unknown) => {
            values.set(own(key), value);
          },
          global: {
            get: (key: string) => globalValues.get(key),
            set: (key: string, value: unknown) => {
              globalValues.set(key, value);
            }
          }
        });
      },
      // The deployed flows: every node built here, until a test deletes one.
      eachNode(callback: (node: {id: string}) => void) {
        for (const id of flowNodeIds) callback({id});
      },
      registerType(_name: string, implementation: RuntimeConstructor) {
        Constructor = implementation;
      }
    }
  };
  register(RED as unknown as Parameters<NodeInitializer>[0]);
  assert.ok(Constructor);
  return {Constructor, events, flowNodeIds};
}

function receive<T>(
  node: RuntimeNode,
  msg: Record<string, unknown>
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const sent: T[] = [];
    // As Node-RED's done does, an error is reported against the message.
    node.emit("input", msg, (message: T) => sent.push(message), (error?: Error) => {
      if (error) {
        node.error(error, msg);
        reject(error);
      } else {
        resolve(sent);
      }
    });
  });
}

// Closes the node, then deals with its context as Node-RED does.
function close(node: RuntimeNode): Promise<void> {
  return new Promise<void>((resolve) => {
    node.emit("close", false, resolve);
  }).then(() => node.closeContext?.());
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
  // Lighting intents on output 1.
  assert.equal((sent[0] as unknown as [WireMessage, null])[0]?.lighting?.state, "ON");
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
  // Occupancy events on output 1; nothing on output 2 with publishing off.
  const sent = await receive<[WireMessage, null]>(node, {source: "motion", payload: {motion: true}});
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.[1], null);
  assert.equal(sent[0]?.[0]?.source, "occupancy");
  const occupancy = sent[0]?.[0]?.payload as {occupied?: boolean} | undefined;
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
  assert.equal(startup[0]?.[1]?.length, 14);
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
  const {Constructor} = runtime(registerMotion, {}, STORE);
  const before = new Constructor(motionConfig);
  await receive<WireMessage>(before, {source: "occupancy", payload: {occupied: false}});
  assert.equal(typeof savedState(before).offTimerDueAt, "number");
  await close(before);

  const after = new Constructor(motionConfig);
  t.after(() => close(after));
  assert.equal(after.sent.length, 0);
  await wait(400);
  assert.deepEqual((after.sent as Array<[WireMessage, null]>).map(([message]) => message.lighting?.state), ["OFF"]);
  assert.equal(savedState(after).offTimerDueAt, null);
});

test("motion adapter started with nothing saved sends its off intent after the vacancy delay", async (t) => {
  const {Constructor} = runtime(registerMotion);
  const node = new Constructor({...motionConfig, id: "motion-cold"});
  t.after(() => close(node));
  assert.equal(node.sent.length, 0, "nothing sent at the start");
  await wait(400);
  assert.deepEqual((node.sent as Array<[WireMessage, null]>).map(([message]) => message.lighting?.state), ["OFF"]);

  // Occupancy before the delay cancels it.
  const occupied = new Constructor({...motionConfig, id: "motion-cold-occupied"});
  t.after(() => close(occupied));
  await receive(occupied, {source: "occupancy", payload: {occupied: true}});
  await wait(400);
  assert.ok(!(occupied.sent as Array<[WireMessage, null]>).some(([message]) => message.lighting?.state === "OFF"));
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
  assert.deepEqual((after.sent as Array<[WireMessage, null]>).map(([message]) => message.lighting?.state), ["OFF"]);
});

test("motion adapter arms nothing at startup without a pending off-timer", async (t) => {
  const {Constructor} = runtime(registerMotion, {}, STORE);
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
  const {Constructor} = runtime(registerActivityLighting, {}, STORE);
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
  const {Constructor} = runtime(registerBacklighting, {}, STORE);
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
  const {Constructor} = runtime(registerDisplay, {tvPsk: "synthetic"}, STORE);
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
  const {Constructor} = runtime(registerAvr, {}, STORE);
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
    area: "room", freshnessMs: 30000, activityProfiles: profiles
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

test("AVR adapter rejects a configuration the reducer would reject, at deploy", () => {
  for (const [label, overrides, reason] of [
    ["lowercase source code", {sources: "{\"shield\":\"sat/cbl\"}"}, /Denon source codes/],
    ["minimum volume above maximum", {minVolume: 70, maxVolume: 60}, /volume bounds/]
  ] as const) {
    const {Constructor} = runtime(registerAvr);
    const node = new Constructor({
      area: "lounge",
      sources: "{\"shield\":\"SAT/CBL\"}",
      retryMs: 2000,
      maxAttempts: 3,
      ...overrides
    });
    const status = node.statuses.at(-1) as {fill?: string; text?: string} | undefined;
    assert.equal(status?.fill, "red", label);
    assert.equal(status?.text, "invalid configuration", label);
    assert.match(String(node.errors[0]), /^invalid configuration: /, label);
    assert.match(String(node.errors[0]), reason, label);
    // Inert: no input handler was registered.
    assert.equal(node.emit("input", {avr: {kind: "startup"}}, () => {}, () => {}), false, label);
  }
});

test("room adapter rejects an unusable wake and bed schedule at deploy", () => {
  for (const [label, times, reason] of [
    ["not a time", {wakeTime: "7am", bedTime: "23:00"}, /HH:MM/],
    ["a blank wake time is an error", {wakeTime: "", bedTime: "07:00"}, /wake time is required/],
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

test("the example theatre flow reaches ready with no translation and stays ready through refreshes", async (t) => {
  t.mock.timers.enable({apis: ["setTimeout", "setInterval", "Date"], now: Date.parse("2026-11-23T20:00:00Z")});
  const flow = JSON.parse(readFileSync(resolve(__dirname, "../../examples/Home theatre activity.json"), "utf8")) as
    Array<Record<string, unknown> & {id: string; type: string; name?: string; wires?: string[][]}>;
  const registers: Record<string, NodeInitializer> = {
    "home-theatre-state-contract": registerTheatreStateContract,
    "home-theatre-activity-controller": registerTheatreActivity,
    "home-display-mode-controller": registerDisplay,
    "home-avr-controller": registerAvr,
    "home-source-capability-controller": registerSource,
    "home-activity-lighting-controller": registerActivityLighting,
    "home-backlighting-controller": registerBacklighting
  };

  // The devices behind the controllers. The display controller reaches its
  // devices itself, so they answer its HTTP calls.
  const devices = {tv: "standby", screen: 0, projectorWatts: 0, avr: {PW: "STANDBY", ZM: "OFF", SI: "GAME", MV: "30"},
    source: {status: "inactive", changedAt: ""}, backlighting: "off"};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    let answer: unknown = {};
    if (href.endsWith("/sony/system")) {
      if (body.method === "getPowerStatus") answer = {result: [{status: devices.tv === "on" ? "active" : "standby"}]};
      else {
        devices.tv = (body.params as Array<{status: boolean}>)[0]!.status ? "on" : "standby";
        answer = {result: []};
      }
    } else if (href.includes("Cover.GetStatus")) answer = {current_pos: devices.screen, state: "stopped"};
    else if (href.includes("Cover.GoToPosition")) devices.screen = Number(body.pos);
    else if (href.includes("Switch.GetStatus")) answer = {apower: devices.projectorWatts};
    return new Response(JSON.stringify(answer), {status: 200, headers: {"content-type": "application/json"}});
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const nodes = new Map<string, RuntimeNode>();
  for (const entry of flow) {
    const register = registers[entry.type];
    if (!register) continue;
    // What the example leaves for the user to fill in.
    const config = entry.type === "home-display-mode-controller"
      ? {...entry, tvHost: "tv.example", screenHost: "screen.example", projectorMeterHost: "meter.example"}
      : entry.type === "home-theatre-state-contract"
        ? {...entry, area: "lounge"}
        : entry;
    const node = new (runtime(register, {tvPsk: "example"}).Constructor)(config);
    assert.deepEqual(node.errors, [], entry.type);
    nodes.set(entry.id, node);
    t.after(() => close(node));
  }
  const byId = new Map(flow.map((entry) => [entry.id, entry]));
  const property = (msg: Record<string, unknown>, path: string) =>
    path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], msg);
  const queue: Array<[string, Record<string, unknown>]> = [];
  const refreshes: string[] = [];

  function route(id: string, envelope: unknown) {
    const outputs = Array.isArray(envelope) ? envelope : [envelope];
    outputs.forEach((output, index) => {
      for (const msg of output === null || output === undefined ? [] : Array.isArray(output) ? output : [output]) {
        for (const target of byId.get(id)!.wires?.[index] ?? []) queue.push([target, structuredClone(msg)]);
      }
    });
  }

  // The devices answer the commands that reach the example's debug nodes.
  function device(name: string, msg: Record<string, unknown>) {
    const now = new Date().toISOString();
    if (name === "avr commands") {
      for (const query of Buffer.from(msg.payload as Uint8Array).toString("utf8").split("\r").filter(Boolean)) {
        const code = query.slice(0, 2) as keyof typeof devices.avr;
        if (!query.endsWith("?")) devices.avr[code] = query.slice(2);
        queue.push([avrId, {avr: {kind: "observed", line: code + devices.avr[code]}}]);
      }
    } else if (name === "source commands") {
      const command = msg.sourceCommand as {operation: string; generation: number; sourceId: string};
      if (command.operation !== "observe") {
        devices.source = {status: command.operation === "activate" ? "active" : "inactive", changedAt: now};
      }
      // A quiet source: its reading keeps the time it last changed.
      queue.push([sourceId, {sourceCapability: {kind: "observed", generation: command.generation, sourceId: command.sourceId,
        status: devices.source.status, observedAt: devices.source.changedAt || now}}]);
    } else if (name === "backlighting commands") {
      const command = msg.backlightingCommand as {operation: string; generation: number; power: string};
      if (command.operation === "set_power") devices.backlighting = command.power;
      queue.push([backlightingId, {backlighting: {kind: "observed", generation: command.generation,
        power: devices.backlighting, observedAt: now}}]);
    }
  }
  const idOf = (type: string) => flow.find((entry) => entry.type === type)!.id;
  const avrId = idOf("home-avr-controller");
  const sourceId = idOf("home-source-capability-controller");
  const backlightingId = idOf("home-backlighting-controller");
  const activityId = idOf("home-theatre-activity-controller");

  async function settle() {
    for (let round = 0; round < 200; round += 1) {
      for (let flush = 0; flush < 5; flush += 1) await new Promise((done) => setImmediate(done));
      for (const [id, node] of nodes) for (const envelope of node.sent.splice(0)) route(id, envelope);
      if (!queue.length) return;
      while (queue.length) {
        const [id, msg] = queue.shift()!;
        const entry = byId.get(id)!;
        const node = nodes.get(id);
        if (node) {
          for (const envelope of await receive<unknown>(node, msg)) route(id, envelope);
        } else if (entry.type === "switch") {
          const rules = entry.rules as Array<{t: string; v: string}>;
          const value = property(msg, String(entry.property));
          const envelope = rules.map((rule) => {
            assert.equal(rule.t, "eq");
            return rule.v === value ? msg : null;
          });
          if (property(msg, "theatreCommand.kind") === "refresh") refreshes.push(String(value));
          route(id, envelope);
        } else if (entry.type === "change") {
          for (const rule of entry.rules as Array<{t: string; p: string; to: string}>) {
            assert.equal(rule.t, "move");
            msg[rule.to] = msg[rule.p];
            delete msg[rule.p];
          }
          route(id, msg);
        } else if (entry.type === "debug") {
          device(String(entry.name), msg);
        } else {
          assert.fail(`unexpected node type ${entry.type}`);
        }
      }
    }
    assert.fail("the flow did not settle");
  }
  const activity = () => nodes.get(activityId)!.context().get("state") as
    {phase: string; currentActivity: string; degraded: Array<{target: string; reason: string}>};

  // The example's injects: start the contract, then ask for the tv activity.
  for (const entry of flow.filter((candidate) => candidate.type === "inject")) {
    const msg: Record<string, unknown> = {};
    for (const prop of entry.props as Array<{p: string; v: string; vt: string}>) {
      // The inject's topic names the area the user gives the contract.
      msg[prop.p] = prop.vt === "json" ? JSON.parse(prop.v) : prop.v.replace("<area>", "lounge");
    }
    queue.push([entry.wires![0]![0]!, msg]);
    await settle();
  }
  for (let second = 0; second < 180 && activity().phase !== "ready"; second += 1) {
    t.mock.timers.tick(1000);
    await settle();
  }
  assert.equal(activity().phase, "ready", JSON.stringify((nodes.get(activityId)!.context().get("state") as Record<string, unknown>).failure) +
    JSON.stringify((nodes.get(activityId)!.context().get("state") as Record<string, unknown>).targets));
  assert.equal(activity().currentActivity, "tv");

  // Five minutes of refreshes: every required target and the source keep
  // re-confirming, so none of them is reported stale or unanswered.
  for (let second = 0; second < 300; second += 1) {
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(activity().phase, "ready", `at ${second} s: ${JSON.stringify(activity().degraded)}`);
  }
  for (const target of ["display", "avr", "source", "backlighting"]) assert.ok(refreshes.includes(target), target);
  assert.deepEqual(activity().degraded.filter((entry) => entry.target !== "lighting"), []);

  // The example's off activity confirms too: the receiver goes to standby.
  const contractId = idOf("home-theatre-state-contract");
  queue.push([contractId, {topic: "home/lounge/theatre/request", payload: {requestId: "example-request-2", activity: "off"}}]);
  await settle();
  for (let second = 0; second < 180 && activity().currentActivity !== "off"; second += 1) {
    t.mock.timers.tick(1000);
    await settle();
  }
  const offState = nodes.get(activityId)!.context().get("state") as Record<string, unknown>;
  assert.equal(activity().phase, "ready", JSON.stringify(offState.targets));
  assert.equal(activity().currentActivity, "off");
  assert.equal(devices.avr.PW, "STANDBY");
});

test("every adapter shows the same badge for a configuration it cannot use, and logs why", () => {
  // One badge text lets people, and the Node-RED smoke, spot any broken node;
  // the reason goes to node.error.
  const broken: Array<[string, NodeInitializer, Record<string, unknown>, RegExp]> = [
    ["activity lighting", registerActivityLighting, {area: "room", profiles: "{not json"}, /JSON/],
    ["source capability", registerSource, {area: "room", sources: "{not json"}, /JSON/],
    ["theatre activity", registerTheatreActivity, {area: "room", activityProfiles: "{not json"}, /JSON/],
    ["theatre state contract", registerTheatreStateContract, {area: "room", activities: "{not json"}, /./],
    ["display", registerDisplay, {area: "room", tvHost: "", screenHost: "", projectorMeterHost: ""}, /TV host is required/],
    ["motion", registerMotion, {area: "room", onTargets: "[1]"}, /targets/],
    ["switch", registerSwitch, {area: "room", targets: "{not json"}, /JSON|targets/]
  ];
  for (const [name, register, config, reason] of broken) {
    const node = new (runtime(register).Constructor)(config);
    assert.deepEqual(node.statuses.at(-1), {fill: "red", shape: "ring", text: "invalid configuration"}, name);
    assert.equal(node.errors.length, 1, name);
    assert.match(String(node.errors[0]), /^invalid configuration: /, name);
    assert.match(String(node.errors[0]), reason, name);
  }
});

test("an emptied or non-numeric number setting is an invalid configuration that names the setting", () => {
  // One node per family; the setting is otherwise valid config for that node.
  const cases: Array<[string, NodeInitializer, Record<string, unknown>, string]> = [
    ["receiver", registerAvr, {area: "a", sources: "{}", retryMs: ""}, "retry interval"],
    ["display", registerDisplay, {area: "a", tvHost: "tv", screenHost: "s", projectorMeterHost: "m", tvTimeoutMs: "  "}, "TV timeout"],
    ["source", registerSource, {area: "a", sources: "{\"streamer\":{\"activation\":\"command\",\"deactivation\":\"command\",\"confirmation\":\"active\"}}", pollMs: "abc"}, "poll interval"],
    ["backlighting", registerBacklighting, {area: "a", maxAttempts: ""}, "max attempts"],
    ["activity lighting", registerActivityLighting, {area: "a", profiles: "{\"off\":{\"targets\":[],\"values\":{}}}", confirmationTimeoutMs: ""}, "confirmation timeout"],
    ["room", registerRoom, {area: "a", targets: "[]", refreshSeconds: ""}, "refresh interval"],
    ["motion", registerMotion, {area: "a", onTargets: "[\"main\"]", defaultDelaySeconds: "abc"}, "vacancy delay"],
    ["switch", registerSwitch, {area: "a", targets: "[\"main\"]", switchWindowMs: ""}, "switch window"],
    ["theatre activity", registerTheatreActivity, {area: "a", freshnessMs: "", activityProfiles: JSON.stringify({
      off: {display: {mode: "off"}, avr: {power: "standby"}, source: {action: "deactivate", readiness: "optional"}, lighting: {profile: "off"}, backlighting: {power: "off"}}
    })}, "freshness"],
    ["theatre state contract", registerTheatreStateContract, {area: "a", activities: "[\"off\"]", sloWindowSize: ""}, "SLO window"]
  ];
  for (const [name, register, config, label] of cases) {
    const node = new (runtime(register, {tvPsk: "key"}).Constructor)(config);
    assert.deepEqual(node.statuses.at(-1), {fill: "red", shape: "ring", text: "invalid configuration"}, name);
    assert.deepEqual(node.errors.map(String), [`invalid configuration: ${label} must be a number`], name);
  }
});

test("a number setting absent from an older saved flow takes its default; a typed 0 is kept", async (t) => {
  const node = new (runtime(registerMotion).Constructor)({area: "hall", onTargets: "[\"main\"]", defaultIlluminanceCutoff: "0"});
  t.after(() => close(node));
  assert.deepEqual(node.errors, []);
  await receive(node, {source: "motion", payload: true});
  const state = node.context().get("state") as {delaySeconds: number; illuminanceCutoff: number};
  assert.equal(state.delaySeconds, 120, "absent: the default");
  assert.equal(state.illuminanceCutoff, 0, "typed 0 is kept");
});

test("the theatre contract requires an area: its topics and Home Assistant IDs are built from it", () => {
  for (const [name, register] of [["theatre state contract", registerTheatreStateContract]] as const) {
    for (const area of [undefined, "", "  "]) {
      const node = new (runtime(register).Constructor)(area === undefined ? {} : {area});
      assert.deepEqual(node.statuses.at(-1), {fill: "red", shape: "ring", text: "invalid configuration"}, `${name} ${JSON.stringify(area)}`);
      assert.deepEqual(node.errors.map(String), ["invalid configuration: area is required"], name);
    }
  }
});

test("every other node runs with no area, and reports none instead of a made-up one", async (t) => {
  const backlighting = new (runtime(registerBacklighting).Constructor)({});
  t.after(() => close(backlighting));
  assert.deepEqual(backlighting.errors, []);
  await receive(backlighting, {backlighting: {kind: "intent", requestId: "r1", generation: 1, power: "on"}});
  assert.equal(traces(backlighting).at(-1)?.area, "");

  const receiver = new (runtime(registerAvr).Constructor)({sources: "{\"shield\":\"SAT/CBL\"}"});
  t.after(() => close(receiver));
  assert.deepEqual(receiver.errors, []);
  const sent = await receive<SendEnvelope>(receiver, {avr: {kind: "intent", requestId: "r1", generation: 1, power: "on"}});
  const events = sent.flatMap((envelope) => envelope[1] ?? []);
  assert.ok(events.length > 0);
  for (const event of events as Array<{avr?: {area?: string}}>) if (event.avr) assert.equal(event.avr.area, "");

  const theatre = new (runtime(registerTheatreActivity).Constructor)({activityProfiles: JSON.stringify({
    off: {display: {mode: "off"}, avr: {power: "standby"}, source: {action: "deactivate", readiness: "optional"}, lighting: {profile: "off"}, backlighting: {power: "off"}}
  })});
  t.after(() => close(theatre));
  assert.deepEqual(theatre.errors, []);
  const state = await receive<SendEnvelope>(theatre, {theatre: {kind: "intent", requestId: "r1", generation: 1, activity: "off"}});
  const snapshot = state.flatMap((envelope) => envelope[1] ?? []).find((message) => message.theatre?.kind === "state");
  assert.equal(snapshot?.theatre?.area, "");

  // The rest may reject {} for other settings, but never for the area. A node
  // that rejected its configuration started nothing, so only started ones close.
  for (const register of [registerActivityLighting, registerDisplay, registerMotion, registerSwitch, registerOccupancy, registerSource]) {
    const node = new (runtime(register).Constructor)({});
    // Occupancy keeps no timers and registers no close handler.
    if (node.errors.length === 0 && register !== registerOccupancy) t.after(() => close(node));
    assert.equal(node.errors.some((error) => /area/.test(String(error))), false);
  }
});

test("a room controller with publishing off and no area still commands its lights, and publishes nothing else", async (t) => {
  const node = new (runtime(registerRoom).Constructor)({
    publishState: false,
    discovery: false,
    targets: "[{\"id\":\"main\",\"stateTopic\":\"room/light/main\",\"commandTopic\":\"room/light/main/set\"}]"
  });
  t.after(() => close(node));
  assert.deepEqual(node.errors, []);
  const startup = await receive<Array<Array<{topic?: string}>>>(node, {lighting: {kind: "startup"}});
  const on = await receive<Array<Array<{topic?: string; payload?: Record<string, unknown>}>>>(node, {
    lighting: {kind: "intent", targets: ["main"], state: "ON", source: "motion"}
  });
  const circadian = await receive<Array<Array<{topic?: string}>>>(node, {lighting: {kind: "circadian", enabled: false}});
  const topics = [...startup, ...on, ...circadian].flat(2).map((message) => message.topic);
  assert.deepEqual(topics, ["room/light/main/set"], "only the light's own command topic");
  assert.equal((on.flat(2).find((message) => message.topic === "room/light/main/set") as {payload?: Record<string, unknown>}).payload?.state, "ON");
});

test("publish settings: the area is required only when something named after it is published", async (t) => {
  const room = runtime(registerRoom).Constructor;
  const targets = "[{\"id\":\"main\",\"stateTopic\":\"room/light/main\",\"commandTopic\":\"room/light/main/set\"}]";
  // A saved flow from before the settings: both count as on, so it needs an area.
  for (const settings of [{}, {publishState: true, discovery: false}, {publishState: false, discovery: true}]) {
    const node = new room({targets, ...settings});
    assert.deepEqual(node.errors.map(String), ["invalid configuration: area is required"], JSON.stringify(settings));
  }
  const quiet = new room({targets, publishState: false, discovery: false});
  t.after(() => close(quiet));
  assert.deepEqual(quiet.errors, []);
  const legacy = new room({targets, area: "hall"});
  t.after(() => close(legacy));
  const startup = await receive<Array<Array<{topic?: string}>>>(legacy, {lighting: {kind: "startup"}});
  assert.ok(startup.flat(2).some((message) => message.topic === "homeassistant/switch/hall_circadian_lighting/config"),
    "an older saved flow keeps publishing discovery");

  const contract = runtime(registerTheatreStateContract).Constructor;
  const base = {activities: "[\"off\"]"};
  for (const settings of [{}, {discovery: true, baseTopic: "media/theatre"}, {discovery: false}]) {
    const node = new contract({...base, ...settings});
    assert.deepEqual(node.errors.map(String), ["invalid configuration: area is required"], JSON.stringify(settings));
  }
  const topicOnly = new contract({...base, discovery: false, baseTopic: "media/theatre"});
  assert.deepEqual(topicOnly.errors, []);
  const cleared = await receive<Array<Array<{topic?: string; payload?: unknown}>>>(new contract({...base, area: "hall", discovery: "false"}), {theatreStateContract: {kind: "startup"}});
  const clearedMessages = cleared.flat(2).filter((message) => message !== null);
  const discoveryMessages = clearedMessages.filter((message) => message.topic !== "home/hall/theatre/availability");
  assert.ok(discoveryMessages.length > 0 && discoveryMessages.every((message) => message.payload === ""), "discovery off clears its entries");
});

test("publish settings: null and a missing field mean on; only false means off", async (t) => {
  const room = runtime(registerRoom).Constructor;
  const targets = "[{\"id\":\"main\",\"stateTopic\":\"room/light/main\",\"commandTopic\":\"room/light/main/set\"}]";
  const discoveryOf = async (settings: Record<string, unknown>) => {
    const node = new room({targets, area: "hall", ...settings});
    t.after(() => close(node));
    assert.deepEqual(node.errors, []);
    const startup = await receive<Array<Array<{topic?: string; payload?: unknown} | null>>>(node, {lighting: {kind: "startup"}});
    const entry = startup.flat(2).find((message) => message?.topic === "homeassistant/switch/hall_circadian_lighting/config");
    return entry ? (typeof entry.payload === "object" ? "published" : "cleared") : "none";
  };
  assert.equal(await discoveryOf({publishState: null, discovery: null}), "published", "null (the editor's not-set) is on");
  assert.equal(await discoveryOf({}), "published", "an old flow without the fields is on");
  assert.equal(await discoveryOf({publishState: true, discovery: false}), "cleared", "false (what onadd sets) is off");
  assert.equal(await discoveryOf({publishState: true, discovery: "false"}), "cleared");
  // An empty string is not "not set": it's an invalid configuration.
  const emptied = new room({targets, area: "hall", publishState: "", discovery: ""});
  assert.deepEqual(emptied.errors.map(String), ["invalid configuration: publish state must be on or off"]);
});

test("an emptied JSON or text setting is an invalid configuration that names the setting", () => {
  const cases: Array<[string, NodeInitializer, Record<string, unknown>, string]> = [
    ["receiver", registerAvr, {sources: ""}, "sources must be valid JSON"],
    ["display", registerDisplay, {tvHost: "tv", screenHost: " ", projectorMeterHost: "m"}, "screen host is required"],
    ["source", registerSource, {sources: "{broken"}, "sources must be valid JSON"],
    ["activity lighting", registerActivityLighting, {profiles: "{\"off\":{\"targets\":[],\"values\":{}}}", owner: ""}, "owner is required"],
    ["room", registerRoom, {targets: "", publishState: false, discovery: false}, "targets must be valid JSON"],
    ["motion", registerMotion, {onTargets: "[\"main\"]", offTargets: ""}, "off targets must be valid JSON"],
    ["switch", registerSwitch, {targets: ""}, "targets must be valid JSON"],
    ["occupancy", registerOccupancy, {presenceMode: "always"}, "presence sensor must be none or hold"],
    ["theatre activity", registerTheatreActivity, {activityProfiles: ""}, "activity profiles must be valid JSON"],
    ["theatre state contract", registerTheatreStateContract, {area: "a", activities: "[\"off\"]", discoveryPrefix: ""}, "discovery prefix is required"]
  ];
  for (const [name, register, config, reason] of cases) {
    const node = new (runtime(register, {tvPsk: "key"}).Constructor)(config);
    assert.deepEqual(node.statuses.at(-1), {fill: "red", shape: "ring", text: "invalid configuration"}, name);
    assert.deepEqual(node.errors.map(String), [`invalid configuration: ${reason}`], name);
  }
});

test("the display's projector fallback reads \"true\" as on", async (t) => {
  const node = new (runtime(registerDisplay, {tvPsk: "key"}).Constructor)({tvHost: "tv", screenHost: "s", projectorMeterHost: "m", projectorPowerFallback: "true"});
  t.after(() => close(node));
  assert.deepEqual(node.errors, []);
  assert.equal(normaliseDisplayConfig({projectorPowerFallback: "true"}).projectorPowerFallback, true);
  assert.equal(normaliseDisplayConfig({projectorPowerFallback: "false"}).projectorPowerFallback, false);
  assert.throws(() => normaliseDisplayConfig({projectorPowerFallback: "maybe"}), /projector power fallback must be on or off/);
});

test("discovery basics: the room checks a publishing area and uses its discovery prefix", async (t) => {
  const room = runtime(registerRoom).Constructor;
  const targets = "[{\"id\":\"main\",\"stateTopic\":\"room/light/main\",\"commandTopic\":\"room/light/main/set\"}]";
  for (const settings of [{publishState: true, discovery: false}, {publishState: false, discovery: true}]) {
    const node = new room({targets, area: "!!!", ...settings});
    assert.deepEqual(node.errors.map(String), ["invalid configuration: area must contain a letter or digit"], JSON.stringify(settings));
  }
  const contract = new (runtime(registerTheatreStateContract).Constructor)({area: "!!!", activities: "[\"off\"]"});
  assert.deepEqual(contract.errors.map(String), ["invalid configuration: area must contain a letter or digit"]);
  const emptiedPrefix = new room({targets, area: "hall", discoveryPrefix: " "});
  assert.deepEqual(emptiedPrefix.errors.map(String), ["invalid configuration: discovery prefix is required"]);

  // A room that publishes nothing may use any label.
  const quiet = new room({targets, area: "Living Room", publishState: false, discovery: false});
  t.after(() => close(quiet));
  assert.deepEqual(quiet.errors, []);

  const prefixed = new room({targets, area: "hall", discoveryPrefix: "ha", publishState: true, discovery: true});
  t.after(() => close(prefixed));
  const startup = await receive<Array<Array<{topic?: string; payload?: Record<string, unknown>} | null>>>(prefixed, {lighting: {kind: "startup"}});
  const entry = startup.flat(2).find((message) => message?.topic === "ha/switch/hall_circadian_lighting/config");
  assert.equal((entry?.payload?.origin as {name?: string} | undefined)?.name, "@avantics/node-red-home-automation");
});

test("availability: publishing nodes send a retained offline as they stop", async () => {
  const targets = "[{\"id\":\"main\",\"stateTopic\":\"room/light/main\",\"commandTopic\":\"room/light/main/set\"}]";
  const sentOnClose = async (node: RuntimeNode) => {
    const before = node.sent.length;
    await close(node);
    return node.sent.slice(before);
  };
  const room = runtime(registerRoom).Constructor;
  assert.deepEqual(await sentOnClose(new room({targets, area: "hall", publishState: true, discovery: true})),
    [[[{topic: "home/hall/lighting/availability", payload: "offline", retain: true}]]]);
  assert.deepEqual(await sentOnClose(new room({targets, area: "hall", publishState: false, discovery: false})), [],
    "a room that publishes nothing sends nothing");

  const contract = runtime(registerTheatreStateContract).Constructor;
  assert.deepEqual(await sentOnClose(new contract({area: "den", activities: "[\"off\"]", discovery: false})),
    [[null, [{topic: "home/den/theatre/availability", payload: "offline", retain: true}]]]);
});

test("availability: a node redeployed on its own is available again without a startup message", async (t) => {
  const availability = (node: RuntimeNode) => JSON.stringify(node.sent).match(/"topic":"[^"]*\/availability","payload":"(online|offline)"/g) ?? [];
  const targets = "[{\"id\":\"main\",\"stateTopic\":\"room/light/main\",\"commandTopic\":\"room/light/main/set\"}]";
  const roomRuntime = runtime(registerRoom);
  const roomConfig = {targets, area: "hall", publishState: true, discovery: true};
  const before = new roomRuntime.Constructor(roomConfig);
  await receive(before, {lighting: {kind: "startup"}});
  await close(before);
  assert.match(String(availability(before).at(-1)), /offline/);
  // Node-RED reconstructs the node, then announces the flows started.
  const after = new roomRuntime.Constructor(roomConfig);
  t.after(() => close(after));
  roomRuntime.events.emit("flows:started");
  assert.deepEqual(after.sent, [[[{topic: "home/hall/lighting/availability", payload: "online", retain: true}]]]);
  roomRuntime.events.emit("flows:started");
  assert.equal(after.sent.length, 1, "once per construction");

  // A different node, so its own context.
  const quiet = new roomRuntime.Constructor({id: "quiet", targets, area: "hall", publishState: false, discovery: false});
  t.after(() => close(quiet));
  const quietRuntime = roomRuntime;
  quietRuntime.events.emit("flows:started");
  assert.deepEqual(quiet.sent, [], "a room that publishes nothing announces nothing");

  const contractRuntime = runtime(registerTheatreStateContract);
  const contract = new contractRuntime.Constructor({area: "lounge", activities: "[\"off\"]"});
  await close(contract);
  const again = new contractRuntime.Constructor({area: "lounge", activities: "[\"off\"]"});
  t.after(() => close(again));
  contractRuntime.events.emit("flows:started");
  assert.deepEqual(again.sent, [[null, [{topic: "home/lounge/theatre/availability", payload: "online", retain: true}]]]);
  // A node closed before the flows start announces nothing.
  const closedEarly = new contractRuntime.Constructor({area: "den", activities: "[\"off\"]"});
  await close(closedEarly);
  const sentBefore = closedEarly.sent.length;
  contractRuntime.events.emit("flows:started");
  assert.equal(closedEarly.sent.length, sentBefore);
});

test("ID schemes: a saved node keeps its area-named entities; a new node names them after itself", async (t) => {
  const targets = "[{\"id\":\"main\",\"stateTopic\":\"room/light/main\",\"commandTopic\":\"room/light/main/set\"}]";
  const room = runtime(registerRoom).Constructor;
  const discoveryOf = async (settings: Record<string, unknown>) => {
    const node = new room({targets, area: "hall", publishState: true, discovery: true, ...settings});
    t.after(() => close(node));
    assert.deepEqual(node.errors, []);
    const startup = await receive<SendEnvelope>(node, {lighting: {kind: "startup"}});
    const entry = startup.flat(2).find((message) => String(message?.topic).endsWith("/config"));
    const payload = entry?.payload as {unique_id: string; default_entity_id: string; device: {identifiers: string[]}};
    return [entry?.topic, payload.unique_id, payload.default_entity_id, payload.device.identifiers[0]];
  };
  const entityId = ["switch", "hall_circadian_lighting"].join(".");
  assert.deepEqual(await discoveryOf({id: "saved1"}),
    ["homeassistant/switch/hall_circadian_lighting/config", "hall_circadian_lighting", entityId, "nodered_hall_lighting"],
    "no idScheme: as every room published before");
  assert.deepEqual(await discoveryOf({id: "saved2", idScheme: null}),
    ["homeassistant/switch/hall_circadian_lighting/config", "hall_circadian_lighting", entityId, "nodered_hall_lighting"]);
  assert.deepEqual(await discoveryOf({id: "new1", idScheme: "node"}),
    ["homeassistant/switch/nrha_new1_circadian_lighting/config", "nrha_new1_circadian_lighting", entityId, "nrha_new1"],
    "a new node: named after the node, with the same entity ID");
  const junk = new room({targets, area: "hall", idScheme: "random"});
  assert.deepEqual(junk.errors.map(String), ["invalid configuration: ID scheme must be area or node"]);

  const contract = runtime(registerTheatreStateContract).Constructor;
  const theatre = new contract({id: "c9", idScheme: "node", area: "lounge", activities: "[\"off\"]"});
  t.after(() => close(theatre));
  const startup = await receive<SendEnvelope>(theatre, {theatreStateContract: {kind: "startup"}});
  const topics = startup.flat(2).map((message) => String(message?.topic));
  assert.ok(topics.includes("homeassistant/select/nrha_c9_theatre_activity/config"), topics.join());
});

test("ID schemes: after an area change, a node clears the retained topics it no longer publishes", async (t) => {
  const targets = "[{\"id\":\"main\",\"stateTopic\":\"room/light/main\",\"commandTopic\":\"room/light/main/set\"}]";
  const topicsCleared = async (idScheme: string | null) => {
    const room = runtime(registerRoom, {}, STORE).Constructor;
    const settings = {id: "r1", targets, publishState: true, discovery: true, idScheme};
    const first = new room({...settings, area: "hall"});
    await receive(first, {lighting: {kind: "startup"}});
    await close(first);
    const unchanged = new room({...settings, area: "hall"});
    assert.equal((await receive<SendEnvelope>(unchanged, {lighting: {kind: "startup"}})).length, 1, "nothing changed: no clears");
    await close(unchanged);
    const renamed = new room({...settings, area: "den"});
    t.after(() => close(renamed));
    const startup = await receive<SendEnvelope>(renamed, {lighting: {kind: "startup"}});
    return (startup[0]?.[0] ?? []).map((message) => [message.topic, message.payload]);
  };
  // A new node keeps its discovery topic, which now points at home/den.
  assert.deepEqual(await topicsCleared("node"), [
    ["home/hall/lighting/availability", ""],
    ["home/hall/circadian/state", ""],
    ["home/hall/sleep/state", ""],
    ["home/hall/wake-time/state", ""],
    ["home/hall/bed-time/state", ""],
    ["home/hall/lighting/main/control", ""]
  ]);
  // A saved node's discovery topic is named after the area, so it moves too
  // and the old entry is cleared, rather than left behind as before.
  assert.deepEqual(await topicsCleared(null), [
    ["homeassistant/switch/hall_circadian_lighting/config", ""],
    ["homeassistant/switch/hall_sleep/config", ""],
    ["homeassistant/time/hall_wake_time/config", ""],
    ["homeassistant/time/hall_bed_time/config", ""],
    ["homeassistant/sensor/hall_main_control/config", ""],
    ["home/hall/lighting/availability", ""],
    ["home/hall/circadian/state", ""],
    ["home/hall/sleep/state", ""],
    ["home/hall/wake-time/state", ""],
    ["home/hall/bed-time/state", ""],
    ["home/hall/lighting/main/control", ""]
  ]);
});

test("ID schemes: after a redeploy that changes the area, the old topics are cleared once the flows start", async (t) => {
  const targets = "[{\"id\":\"main\",\"stateTopic\":\"room/light/main\",\"commandTopic\":\"room/light/main/set\"}]";
  const roomRuntime = runtime(registerRoom, {}, STORE);
  const settings = {id: "r5", idScheme: "node", targets, publishState: true, discovery: true};
  const first = new roomRuntime.Constructor({...settings, area: "hall"});
  roomRuntime.events.emit("flows:started");
  await close(first);
  const renamed = new roomRuntime.Constructor({...settings, area: "den"});
  t.after(() => close(renamed));
  // No startup message: the flows starting is enough.
  roomRuntime.events.emit("flows:started");
  const started = renamed.sent as Array<Array<Array<{topic: string; payload: unknown}>>>;
  assert.deepEqual(started[0]?.[0]?.map(({topic, payload}) => [topic, payload]), [
    ["home/hall/lighting/availability", ""],
    ["home/hall/circadian/state", ""],
    ["home/hall/sleep/state", ""],
    ["home/hall/wake-time/state", ""],
    ["home/hall/bed-time/state", ""],
    ["home/hall/lighting/main/control", ""],
    ["home/den/lighting/availability", "online"]
  ]);
  // The broker may not have been connected yet, so the startup message
  // clears them again, and from then on nothing.
  const startup = await receive<SendEnvelope>(renamed, {lighting: {kind: "startup"}});
  assert.deepEqual((startup[0]?.[0] ?? []).map(({topic}) => topic),
    ["home/hall/lighting/availability", "home/hall/circadian/state", "home/hall/sleep/state", "home/hall/wake-time/state",
      "home/hall/bed-time/state", "home/hall/lighting/main/control"]);
  const again = await receive<SendEnvelope>(renamed, {lighting: {kind: "startup"}});
  assert.equal(again.length, 1, "settled: no clears");

  const contractRuntime = runtime(registerTheatreStateContract, {}, STORE);
  const before = new contractRuntime.Constructor({id: "c5", area: "lounge", activities: "[\"off\"]"});
  contractRuntime.events.emit("flows:started");
  await close(before);
  const moved = new contractRuntime.Constructor({id: "c5", area: "lounge", baseTopic: "media/theatre", activities: "[\"off\"]"});
  t.after(() => close(moved));
  contractRuntime.events.emit("flows:started");
  const topics = ((moved.sent[0] as SendEnvelope)[1] ?? []).map((message) => [String(message.topic), message.payload]);
  assert.ok(topics.some(([topic, payload]) => topic === "home/lounge/theatre/current" && payload === ""), JSON.stringify(topics));
  assert.deepEqual(topics.at(-1), ["media/theatre/availability", "online"]);
});

test("entity cleanup: a deleted node clears what it published; a disabled or redeployed one doesn't", async () => {
  const stop = (node: RuntimeNode, removed: boolean) => new Promise<unknown[]>((resolve) => {
    const before = node.sent.length;
    node.emit("close", removed, () => resolve(node.sent.slice(before)));
  });
  const targets = "[{\"id\":\"main\",\"stateTopic\":\"room/light/main\",\"commandTopic\":\"room/light/main/set\"}]";
  const roomRuntime = runtime(registerRoom);
  const roomConfig = {id: "r1", idScheme: "node", targets, area: "hall", publishState: true, discovery: true};
  const offline = [[[{topic: "home/hall/lighting/availability", payload: "offline", retain: true}]]];

  const redeployed = new roomRuntime.Constructor(roomConfig);
  await receive(redeployed, {lighting: {kind: "startup"}});
  assert.deepEqual(await stop(redeployed, false), offline, "redeployed: only offline");
  // Disabled: Node-RED says removed, but the node is still in the flows.
  const disabled = new roomRuntime.Constructor(roomConfig);
  assert.deepEqual(await stop(disabled, true), offline, "disabled: entities kept");
  // Deleted: removed, and gone from the flows.
  const deleted = new roomRuntime.Constructor(roomConfig);
  roomRuntime.flowNodeIds.delete("r1");
  const cleared = await stop(deleted, true) as Array<Array<Array<{topic: string; payload: unknown; retain: boolean}>>>;
  assert.deepEqual(cleared[0]?.[0]?.map(({topic, payload, retain}) => [topic, payload, retain]), [
    ["homeassistant/switch/nrha_r1_circadian_lighting/config", "", true],
    ["homeassistant/switch/nrha_r1_sleep/config", "", true],
    ["homeassistant/time/nrha_r1_wake_time/config", "", true],
    ["homeassistant/time/nrha_r1_bed_time/config", "", true],
    ["homeassistant/sensor/nrha_r1_main_control/config", "", true],
    ["home/hall/lighting/availability", "", true],
    ["home/hall/circadian/state", "", true],
    ["home/hall/sleep/state", "", true],
    ["home/hall/wake-time/state", "", true],
    ["home/hall/bed-time/state", "", true],
    ["home/hall/lighting/main/control", "", true]
  ]);

  const contractRuntime = runtime(registerTheatreStateContract);
  const contract = new contractRuntime.Constructor({id: "c1", idScheme: "node", area: "lounge", activities: "[\"off\"]"});
  assert.deepEqual(await stop(contract, true), [[null, [{topic: "home/lounge/theatre/availability", payload: "offline", retain: true}]]], "disabled");
  const gone = new contractRuntime.Constructor({id: "c1", idScheme: "node", area: "lounge", activities: "[\"off\"]"});
  contractRuntime.flowNodeIds.delete("c1");
  const goneSent = await stop(gone, true) as Array<Array<Array<{topic: string; payload: unknown}> | null>>;
  const goneTopics = (goneSent[0]?.[1] ?? []).map(({topic, payload}) => (payload === "" ? topic : "not cleared"));
  assert.ok(goneTopics.includes("homeassistant/select/nrha_c1_theatre_activity/config"), goneTopics.join());
  assert.ok(goneTopics.includes("home/lounge/theatre/current") && !goneTopics.includes("not cleared"), goneTopics.join());
});

test("entity cleanup: switching Publish state off clears the room's state topics at its next start", async (t) => {
  const targets = "[{\"id\":\"main\",\"stateTopic\":\"room/light/main\",\"commandTopic\":\"room/light/main/set\"}]";
  const room = runtime(registerRoom, {}, STORE).Constructor;
  const publishing = new room({id: "r2", targets, area: "hall", publishState: true, discovery: false});
  await receive(publishing, {lighting: {kind: "startup"}});
  await close(publishing);
  const quiet = new room({id: "r2", targets, area: "hall", publishState: false, discovery: false});
  t.after(() => close(quiet));
  const startup = await receive<SendEnvelope>(quiet, {lighting: {kind: "startup"}});
  assert.deepEqual((startup[0]?.[0] ?? []).map(({topic, payload}) => [topic, payload]), [
    ["home/hall/lighting/availability", ""],
    ["home/hall/circadian/state", ""],
    ["home/hall/sleep/state", ""],
    ["home/hall/wake-time/state", ""],
    ["home/hall/bed-time/state", ""],
    ["home/hall/lighting/main/control", ""]
  ]);
});

test("occupancy publishing: off unless switched on; then its state, availability and binary sensor", async (t) => {
  const occupancyRuntime = runtime(registerOccupancy, {}, STORE);
  const quiet = new occupancyRuntime.Constructor({id: "o1", area: "Den"});
  t.after(() => close(quiet));
  occupancyRuntime.events.emit("flows:started");
  const quietMotion = await receive<SendEnvelope>(quiet, {source: "motion", payload: {motion: true}});
  assert.equal(quietMotion.length, 1, "only the occupancy event");
  assert.deepEqual(quiet.sent, [], "nothing at start either");

  const noArea = new occupancyRuntime.Constructor({id: "o2", publishState: true});
  assert.deepEqual(noArea.errors.map(String), ["invalid configuration: area is required"]);

  const node = new occupancyRuntime.Constructor({id: "o3", area: "Den", publishState: true, discovery: true});
  t.after(() => close(node));
  occupancyRuntime.events.emit("flows:started");
  const started = (node.sent[0] as SendEnvelope)[1] ?? [];
  assert.deepEqual(started.map(({topic}) => topic), [
    "homeassistant/binary_sensor/nrha_o3_occupancy/config",
    "home/den/occupancy/availability",
    "home/den/occupancy/state"
  ], "a node without a scheme set is named after the node");
  const entry = JSON.parse(String(started[0]?.payload)) as Record<string, unknown>;
  assert.deepEqual([entry.device_class, entry.state_topic, entry.availability_topic, entry.default_entity_id],
    ["occupancy", "home/den/occupancy/state", "home/den/occupancy/availability", ["binary_sensor", "den_occupancy"].join(".")]);
  assert.deepEqual([entry.name, (entry.device as {name: string}).name], ["Occupancy", "Den Occupancy"], "the device carries the area");
  assert.deepEqual(started.slice(1).map(({payload}) => payload), ["online", "OFF"]);

  const occupied = await receive<SendEnvelope>(node, {source: "motion", payload: {motion: true}});
  assert.equal((occupied[0]?.[0] as WireMessage | undefined)?.source, "occupancy");
  assert.deepEqual(occupied[1], [null, [{topic: "home/den/occupancy/state", payload: "ON", retain: true}]]);
  // A startup message announces the node again, with the current state.
  const startup = await receive<SendEnvelope>(node, {source: "startup"});
  assert.deepEqual((startup[0]?.[1] ?? []).map(({payload}) => typeof payload === "string" && payload.startsWith("{") ? "entry" : payload),
    ["entry", "online", "ON"]);

  // Discovery switched off and redeployed: the entry is cleared at the next start.
  await close(node);
  const stateOnly = new occupancyRuntime.Constructor({id: "o3", area: "Den", publishState: true, discovery: false});
  t.after(() => close(stateOnly));
  const stateOnlyStartup = await receive<SendEnvelope>(stateOnly, {source: "startup"});
  assert.deepEqual((stateOnlyStartup[0]?.[1] ?? [])[0], {topic: "homeassistant/binary_sensor/nrha_o3_occupancy/config", payload: "", retain: true});
});

test("occupancy publishing: deleting the node clears its entity; disabling it only goes offline", async () => {
  const occupancyRuntime = runtime(registerOccupancy);
  const settings = {id: "o9", area: "den", publishState: true, discovery: true};
  const stop = (node: RuntimeNode, removed: boolean) => new Promise<unknown[]>((resolve) => {
    const before = node.sent.length;
    node.emit("close", removed, () => resolve(node.sent.slice(before)));
  });
  const disabled = new occupancyRuntime.Constructor(settings);
  assert.deepEqual(await stop(disabled, true), [[null, [{topic: "home/den/occupancy/availability", payload: "offline", retain: true}]]]);
  const deleted = new occupancyRuntime.Constructor(settings);
  occupancyRuntime.flowNodeIds.delete("o9");
  assert.deepEqual(await stop(deleted, true), [[null, [
    {topic: "homeassistant/binary_sensor/nrha_o9_occupancy/config", payload: "", retain: true},
    {topic: "home/den/occupancy/availability", payload: "", retain: true},
    {topic: "home/den/occupancy/state", payload: "", retain: true}
  ]]]);
});

test("a publishing node clears the discovery entries it no longer publishes, with no record of them", async (t) => {
  // No record, as after a redeploy or restart without a context store: the
  // node publishes state with discovery switched off.
  const motionRuntime = runtime(registerMotion);
  const node = new motionRuntime.Constructor({id: "m9", area: "den", onTargets: "[\"main\"]", publishState: true, discovery: false});
  t.after(() => close(node));
  assert.equal(node.context().get("retainedTopics"), undefined);
  motionRuntime.events.emit("flows:started");
  const started = (node.sent[0] as SendEnvelope)[1] ?? [];
  assert.deepEqual(started.filter(({payload}) => payload === "").map(({topic}) => topic), [
    "homeassistant/switch/nrha_m9_motion_lighting/config",
    "homeassistant/number/nrha_m9_vacancy_delay/config"
  ]);
  assert.ok(started.some(({topic, payload}) => topic === "home/den/motion/enabled/state" && payload === "ON"), "and still publishes its state");
});

test("clearing without a record never touches another node's entities: none under the area scheme", async (t) => {
  // Two motion nodes in the same area, named after the area: A publishes
  // discovery; B publishes state with discovery off.
  const motionRuntime = runtime(registerMotion);
  const a = new motionRuntime.Constructor({id: "ma", area: "den", onTargets: "[\"main\"]", publishState: true, discovery: true, idScheme: "area"});
  t.after(() => close(a));
  motionRuntime.events.emit("flows:started");
  const entriesOfA = ((a.sent[0] as SendEnvelope)[1] ?? []).map(({topic}) => String(topic)).filter((topic) => topic.endsWith("/config"));
  assert.equal(entriesOfA.length, 2);

  const b = new motionRuntime.Constructor({id: "mb", area: "den", onTargets: "[\"main\"]", publishState: true, discovery: false, idScheme: "area"});
  motionRuntime.events.emit("flows:started");
  const cleared = (sent: unknown[]) => sent.flatMap((envelope) => (envelope as SendEnvelope)[1] ?? [])
    .filter(({payload}) => payload === "").map(({topic}) => String(topic));
  assert.deepEqual(cleared(b.sent).filter((topic) => entriesOfA.includes(topic)), [], "B's start");
  assert.deepEqual(cleared(await receive<SendEnvelope>(b, {source: "startup"})).filter((topic) => entriesOfA.includes(topic)), [], "B's startup message");
  motionRuntime.flowNodeIds.delete("mb");
  const deleted = await new Promise<unknown[]>((resolve) => {
    const before = b.sent.length;
    b.emit("close", true, () => resolve(b.sent.slice(before)));
  });
  assert.deepEqual(cleared(deleted).filter((topic) => entriesOfA.includes(topic)), [], "B's delete");
});

test("motion publishing: an enable switch and a vacancy delay, set from MQTT; off unless switched on", async (t) => {
  const motionRuntime = runtime(registerMotion);
  const quiet = new motionRuntime.Constructor({id: "m0", area: "den", onTargets: "[\"main\"]"});
  t.after(() => close(quiet));
  motionRuntime.events.emit("flows:started");
  assert.deepEqual(quiet.sent, [], "nothing published");

  const node = new motionRuntime.Constructor({id: "m1", area: "den", onTargets: "[\"main\"]", defaultDelaySeconds: 120, publishState: true, discovery: true});
  t.after(() => close(node));
  motionRuntime.events.emit("flows:started");
  const started = (node.sent[0] as SendEnvelope)[1] ?? [];
  assert.deepEqual(started.map(({topic, payload}) => [topic, String(payload).startsWith("{") ? "entry" : payload]), [
    ["homeassistant/switch/nrha_m1_motion_lighting/config", "entry"],
    ["homeassistant/number/nrha_m1_vacancy_delay/config", "entry"],
    ["home/den/motion/availability", "online"],
    ["home/den/motion/enabled/state", "ON"],
    ["home/den/motion/delay/state", "120"]
  ]);
  const number = JSON.parse(String(started[1]?.payload)) as Record<string, unknown>;
  assert.deepEqual(started.slice(0, 2).map(({payload}) => (JSON.parse(String(payload)) as {name: string}).name), ["Motion lighting", "Vacancy delay"]);
  assert.deepEqual([number.min, number.max, number.step, number.unit_of_measurement, number.device_class, number.entity_category, number.command_topic],
    [0, 86400, 1, "s", "duration", "config", "home/den/motion/delay/set"]);

  const disabled = await receive<SendEnvelope>(node, {topic: "home/den/motion/enabled/set", payload: "off"});
  assert.deepEqual(disabled.at(-1)?.[1]?.map(({topic, payload}) => [topic, payload]),
    [["home/den/motion/enabled/state", "OFF"], ["home/den/motion/delay/state", "120"]]);
  const delayed = await receive<SendEnvelope>(node, {topic: "home/den/motion/delay/set", payload: "300.0"});
  assert.deepEqual(delayed.at(-1)?.[1]?.map(({payload}) => payload), ["OFF", "300"]);
  for (const [payload, extra, reason] of [["-5", {}, "not-a-delay"], ["99999", {}, "not-a-delay"], ["60", {retain: true}, "retained-message"]] as const) {
    const ignored = await receive<SendEnvelope>(node, {topic: "home/den/motion/delay/set", payload, ...extra});
    assert.deepEqual(ignored, [], reason);
    assert.equal(traces(node).at(-1)?.reason, reason);
  }
  await receive<SendEnvelope>(node, {topic: "home/den/motion/enabled/set", payload: "maybe"});
  assert.equal(traces(node).at(-1)?.reason, "not-on-or-off");
  assert.equal((node.context().get("state") as {areaEnabled: boolean}).areaEnabled, false, "junk doesn't change it");

  // Deleted: everything it published is cleared.
  const deleted = new motionRuntime.Constructor({id: "m2", area: "den", onTargets: "[\"main\"]", publishState: true, discovery: true});
  motionRuntime.flowNodeIds.delete("m2");
  const cleared = await new Promise<unknown[]>((resolve) => {
    deleted.emit("close", true, () => resolve(deleted.sent));
  });
  assert.deepEqual(((cleared[0] as SendEnvelope)[1] ?? []).map(({payload}) => payload), ["", "", "", "", ""]);
});

test("motion publishing: after a redeploy with a new vacancy setting, the delay in use is published", async (t) => {
  const motionRuntime = runtime(registerMotion, {}, STORE);
  const base = {id: "m5", area: "hall", onTargets: "[\"main\"]", publishState: true, discovery: true};
  const delays = (sent: unknown[]) => JSON.stringify(sent).match(/"topic":"home\/hall\/motion\/delay\/state","payload":"(\d+)"/g)?.map((m) => m.match(/"(\d+)"$/)![1]) ?? [];
  const first = new motionRuntime.Constructor({...base, defaultDelaySeconds: 120});
  motionRuntime.events.emit("flows:started");
  assert.deepEqual(delays(first.sent), ["120"]);
  assert.deepEqual(delays(await receive(first, {topic: "home/hall/motion/delay/set", payload: "300"})), ["300"]);
  await close(first);

  // Same setting: Home Assistant's 300 still stands.
  const same = new motionRuntime.Constructor({...base, defaultDelaySeconds: 120});
  motionRuntime.events.emit("flows:started");
  assert.deepEqual(delays(same.sent), ["300"]);
  await close(same);

  // A new setting replaces it, and that is what is published.
  const changed = new motionRuntime.Constructor({...base, defaultDelaySeconds: 600});
  t.after(() => close(changed));
  motionRuntime.events.emit("flows:started");
  assert.deepEqual(delays(changed.sent), ["600"]);
  // Nothing more to publish when nothing changes.
  assert.deepEqual(await receive(changed, {source: "illuminance", payload: 5}), []);
});

test("a new theatre contract with discovery needs only a base topic and a display name", async (t) => {
  const contract = runtime(registerTheatreStateContract).Constructor;
  const node = new contract({id: "c8", idScheme: "node", displayName: "Media Room", baseTopic: "media/theatre", activities: "[\"off\"]", discovery: true});
  t.after(() => close(node));
  assert.deepEqual(node.errors, []);
  const saved = new contract({id: "c9", displayName: "Media Room", baseTopic: "media/theatre", activities: "[\"off\"]", discovery: true});
  assert.deepEqual(saved.errors.map(String), ["invalid configuration: area is required"], "a contract saved before node IDs still needs one");
});

test("receiver publishing: off unless switched on; then power, source and volume as they change", async (t) => {
  const avrRuntime = runtime(registerAvr);
  const sources = JSON.stringify({shield: "SAT/CBL", playstation: "GAME"});
  const quiet = new avrRuntime.Constructor({id: "a0", area: "den", sources});
  t.after(() => close(quiet));
  avrRuntime.events.emit("flows:started");
  assert.deepEqual(quiet.sent, []);
  const quietReading = await receive<SendEnvelope>(quiet, {avr: {kind: "observed", line: "PWON\rZMON\rSISAT/CBL\rMV31\r"}});
  assert.ok(quietReading.every((envelope) => !envelope[2]), "nothing on output 3");

  const node = new avrRuntime.Constructor({id: "a1", area: "den", sources, publishState: true, discovery: true});
  t.after(() => close(node));
  avrRuntime.events.emit("flows:started");
  const started = (node.sent[0] as SendEnvelope)[2] ?? [];
  assert.deepEqual(started.map(({topic}) => topic), [
    "homeassistant/binary_sensor/nrha_a1_receiver_power/config",
    "homeassistant/sensor/nrha_a1_receiver_source/config",
    "homeassistant/number/nrha_a1_receiver_volume/config",
    "home/den/receiver/availability"
  ], "nothing known yet, so no state");
  const first = await receive<SendEnvelope>(node, {avr: {kind: "observed", line: "PWON\rZMON\rSISAT/CBL\rMV31\r"}});
  assert.deepEqual(first.flatMap((envelope) => envelope[2] ?? []).map(({topic, payload}) => [topic, payload]), [
    ["home/den/receiver/power/state", "ON"],
    ["home/den/receiver/source/state", "shield"],
    ["home/den/receiver/volume/state", "31"]
  ]);
  const louder = await receive<SendEnvelope>(node, {avr: {kind: "observed", line: "MV315\r"}});
  assert.deepEqual(louder.flatMap((envelope) => envelope[2] ?? []).map(({topic, payload}) => [topic, payload]),
    [["home/den/receiver/volume/state", "31.5"]], "only what changed");
  const same = await receive<SendEnvelope>(node, {avr: {kind: "observed", line: "MV315\r"}});
  assert.deepEqual(same.flatMap((envelope) => envelope[2] ?? []), []);
  const entry = JSON.parse(String(started[0]?.payload)) as Record<string, unknown>;
  assert.deepEqual([entry.name, entry.device_class, (entry.device as {name: string}).name], ["Power", "power", "den Receiver"]);
});

test("receiver volume number: a set from Home Assistant takes the receiver's own bounded, confirmed volume path", async (t) => {
  const avrRuntime = runtime(registerAvr);
  const sources = JSON.stringify({shield: "SAT/CBL"});
  const node = new avrRuntime.Constructor({id: "a2", area: "den", sources, minVolume: 10, maxVolume: 50, publishState: true, discovery: true});
  t.after(() => close(node));
  avrRuntime.events.emit("flows:started");
  const number = ((node.sent[0] as SendEnvelope)[2] ?? []).find(({topic}) => topic === "homeassistant/number/nrha_a2_receiver_volume/config");
  const entry = JSON.parse(String(number?.payload)) as Record<string, unknown>;
  assert.deepEqual([entry.command_topic, entry.state_topic, entry.min, entry.max, entry.step],
    ["home/den/receiver/volume/set", "home/den/receiver/volume/state", 10, 50, 0.5]);

  await receive(node, {avr: {kind: "observed", line: "PWON\rZMON\rSISAT/CBL\rMV31\r"}});
  const settled = () => new Promise((resolve) => setTimeout(resolve, 350));
  let sentBefore = node.sent.length;
  assert.deepEqual(await receive(node, {topic: "home/den/receiver/volume/set", payload: "35.0"}), [], "held while newer sets may come");
  await settled();
  const commands = (node.sent.slice(sentBefore) as SendEnvelope[]).flatMap((envelope) => envelope[0] ?? []).map(({payload}) => String(payload));
  assert.deepEqual(commands, ["MV35\r"], "sent to the receiver as any volume request is");
  const confirmed = await receive<SendEnvelope>(node, {avr: {kind: "observed", line: "MV35\r"}});
  const results = confirmed.flatMap((envelope) => envelope[1] ?? []).map((message) => (message as {avr?: {kind: string}}).avr?.kind);
  assert.ok(results.includes("volume_ready"), JSON.stringify(results));
  assert.deepEqual(confirmed.flatMap((envelope) => envelope[2] ?? []).map(({topic, payload}) => [topic, payload]),
    [["home/den/receiver/volume/state", "35"]], "Home Assistant sees the confirmed volume");

  for (const [msg, reason] of [
    [{topic: "home/den/receiver/volume/set", payload: "loud"}, "not-a-number"],
    [{topic: "home/den/receiver/volume/set", payload: "20", retain: true}, "retained-message"]
  ] as const) {
    assert.deepEqual(await receive(node, msg), [], reason);
    assert.equal(traces(node).at(-1)?.reason, reason);
  }

  // With the receiver off, the request is rejected the usual way.
  await receive(node, {avr: {kind: "observed", line: "PWSTANDBY\r"}});
  sentBefore = node.sent.length;
  await receive(node, {topic: "home/den/receiver/volume/set", payload: "20"});
  await settled();
  const rejected = (node.sent.slice(sentBefore) as SendEnvelope[]).flatMap((envelope) => envelope[1] ?? []).map((message) => (message as {avr?: {kind: string; reason?: string}}).avr);
  assert.ok(rejected.some((avr) => avr?.kind === "volume_rejected" && avr.reason === "receiver-not-ready"), JSON.stringify(rejected));
});

test("receiver volume number: a burst of sets becomes one request for the last value", async (t) => {
  const avrRuntime = runtime(registerAvr);
  const node = new avrRuntime.Constructor({id: "a3", area: "den", sources: JSON.stringify({shield: "SAT/CBL"}), publishState: true, discovery: true});
  t.after(() => close(node));
  await receive(node, {avr: {kind: "observed", line: "PWON\rZMON\rSISAT/CBL\rMV31\r"}});
  const before = node.sent.length;
  for (let step = 0; step < 10; step += 1) {
    await receive(node, {topic: "home/den/receiver/volume/set", payload: String(32 + step)});
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  const sent = node.sent.slice(before) as SendEnvelope[];
  assert.deepEqual(sent.flatMap((envelope) => envelope[0] ?? []).map(({payload}) => String(payload)), ["MV41\r"], "one command, for the last value");
  // No superseded step was ever sent, so the receiver's reading of the last
  // value confirms it.
  const confirmed = await receive<SendEnvelope>(node, {avr: {kind: "observed", line: "MV41\r"}});
  const results = confirmed.flatMap((envelope) => envelope[1] ?? []).map((message) => (message as {avr?: {kind: string}}).avr?.kind);
  assert.ok(results.includes("volume_ready"), JSON.stringify(results));
  assert.ok(!results.includes("volume_manual_override"));
});

test("house schedule node: tells the rooms when the flows start and when a time changes", async (t) => {
  const houseRuntime = runtime(registerHouse);
  const node = new houseRuntime.Constructor({id: "house1", wakeTime: "07:00", bedTime: "23:00", houseName: "house", publishState: true, discovery: true});
  t.after(() => close(node));
  assert.deepEqual(node.errors, []);
  houseRuntime.events.emit("flows:started");
  const started = node.sent as SendEnvelope[];
  const toRooms = started.flatMap((envelope) => envelope[0] ?? []).map((message) => (message as {lighting?: unknown}).lighting);
  assert.deepEqual(toRooms, [{kind: "schedule", wakeTime: "07:00", bedTime: "23:00"}], "rooms realign at every start");
  const announced = started.flatMap((envelope) => envelope[1] ?? []).map(({topic}) => topic);
  assert.ok(announced.includes("homeassistant/time/nrha_house1_wake_time/config"), announced.join());
  assert.ok(announced.includes("home/house/schedule/wake-time/state"), announced.join());

  const changed = await receive<SendEnvelope>(node, {lighting: {kind: "schedule", bedTime: "22:30"}});
  assert.deepEqual(changed.flatMap((envelope) => envelope[0] ?? []).map((message) => (message as {lighting?: unknown}).lighting),
    [{kind: "schedule", wakeTime: "07:00", bedTime: "22:30"}]);
  assert.deepEqual(changed.flatMap((envelope) => envelope[1] ?? []).map(({topic, payload}) => [topic, payload]),
    [["home/house/schedule/wake-time/state", "07:00:00"], ["home/house/schedule/bed-time/state", "22:30:00"]]);
  // From Home Assistant, on its own set topic.
  const fromHa = await receive<SendEnvelope>(node, {topic: "home/house/schedule/wake-time/set", payload: "06:15:00"});
  assert.deepEqual(fromHa.flatMap((envelope) => envelope[0] ?? []).map((message) => (message as {lighting?: {wakeTime: string}}).lighting?.wakeTime), ["06:15"]);
  assert.deepEqual(await receive(node, {topic: "home/house/schedule/wake-time/set", payload: "soon"}), []);
  assert.equal(traces(node).at(-1)?.reason, "not-a-time");
});

test("one flows:started listener however many nodes wait: no MaxListenersExceededWarning past ten", async () => {
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => warnings.push(warning);
  process.on("warning", onWarning);
  try {
    const motionRuntime = runtime(registerMotion);
    const nodes = Array.from({length: 12}, (_, i) => new motionRuntime.Constructor({
      id: `many${i}`, area: `room${i}`, onTargets: "[\"main\"]", publishState: true, discovery: true
    }));
    assert.equal(motionRuntime.events.listenerCount("flows:started"), 1);
    motionRuntime.events.emit("flows:started");
    // Each node's start-up publishing ran once.
    assert.deepEqual(nodes.map((node) => node.sent.length), Array(12).fill(1));
    // Once: a second start doesn't run them again.
    motionRuntime.events.emit("flows:started");
    assert.deepEqual(nodes.map((node) => node.sent.length), Array(12).fill(1));
    await Promise.all(nodes.map((node) => close(node)));
    // Warnings are emitted on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings.filter(({name}) => name === "MaxListenersExceededWarning"), []);

    // A node that closes before the flows start never runs.
    const early = new motionRuntime.Constructor({id: "early", area: "hall", onTargets: "[\"main\"]", publishState: true});
    await close(early);
    const before = early.sent.length;
    motionRuntime.events.emit("flows:started");
    assert.equal(early.sent.length, before, "a closed node's callback is gone");
  } finally {
    process.off("warning", onWarning);
  }
});

test("house schedule node: announces on every flows:started, not only its own, until it closes", async () => {
  const houseRuntime = runtime(registerHouse);
  const node = new houseRuntime.Constructor({id: "house2"});
  const toRooms = () => (node.sent as SendEnvelope[]).flatMap((envelope) => envelope[0] ?? []).length;
  houseRuntime.events.emit("flows:started");
  // A deploy of other nodes (a room added) starts the flows again.
  houseRuntime.events.emit("flows:started");
  assert.equal(toRooms(), 2);
  await close(node);
  houseRuntime.events.emit("flows:started");
  assert.equal(toRooms(), 2, "closed: no longer listening");
  assert.equal(houseRuntime.events.listenerCount("flows:started"), 1, "one listener for the runtime, not one per node");
});

test("cover node: simple requests, presets, and a moving signal on output 3", async (t) => {
  const node = new (runtime(registerCover).Constructor)({presets: "{\"partial\":60}"});
  t.after(() => close(node));
  assert.deepEqual(node.errors, []);
  const opened = await receive<SendEnvelope>(node, {payload: "partial"});
  const command = (opened[0]?.[0]?.[0] as {cover_command?: {operation: string; position: number}} | undefined)?.cover_command;
  assert.deepEqual([command?.operation, command?.position], ["set_position", 60]);
  assert.deepEqual(opened[0]?.[2], {topic: "moving", payload: true}, "moving while the move is unconfirmed");
  const reported = await receive<SendEnvelope>(node, {cover: {kind: "observed", position: 60, motion: "stopped", observedAt: new Date().toISOString(), battery: 90}});
  assert.deepEqual(reported[0]?.[2], {topic: "moving", payload: false});
  const theatre = (reported[0]?.[1]?.[0] as {theatre?: {status: string; details: {position: number}}} | undefined)?.theatre;
  assert.deepEqual([theatre?.status, theatre?.details.position], ["ready", 60]);
  assert.match(String((node.statuses.at(-1) as {text: string}).text), /battery 90%/);
  assert.deepEqual(await receive(node, {payload: "half"}), [], "unknown requests are ignored");
  assert.equal(traces(node).at(-1)?.reason, "unknown-request");
  // Already there: nothing to send.
  assert.deepEqual((await receive<SendEnvelope>(node, {payload: 60}))[0]?.[0], null);

  const bad = new (runtime(registerCover).Constructor)({presets: "{\"open\":10}"});
  assert.match(String(bad.errors[0]), /invalid configuration: preset name open/);
});

test("cover node: a button stops a moving cover, and an offline cover rejects requests", async (t) => {
  const node = new (runtime(registerCover).Constructor)({});
  t.after(() => close(node));
  await receive(node, {cover: {kind: "observed", position: 20, motion: "opening", observedAt: new Date().toISOString()}});
  const stopped = await receive<SendEnvelope>(node, {payload: "open", stopIfMoving: true});
  assert.equal((stopped[0]?.[0]?.[0] as {cover_command?: {operation: string}} | undefined)?.cover_command?.operation, "stop");
  await receive(node, {cover: {kind: "observed", position: 30, motion: "stopped", observedAt: new Date().toISOString()}});
  const opened = await receive<SendEnvelope>(node, {payload: "open", stopIfMoving: true});
  assert.equal((opened[0]?.[0]?.[0] as {cover_command?: {operation: string; position: number}} | undefined)?.cover_command?.position, 100);

  await receive(node, {cover: {kind: "availability", online: false}});
  assert.match(String((node.statuses.at(-1) as {text: string}).text), /unavailable/);
  const offline = await receive<SendEnvelope>(node, {payload: "close"});
  assert.equal(offline[0]?.[0], null, "nothing sent");
  assert.ok((offline[0]?.[1] ?? []).some((message) => (message as {theatre?: {status: string}}).theatre?.status === "unavailable"));
  const back = await receive<SendEnvelope>(node, {cover: {kind: "availability", online: true}});
  assert.equal((back[0]?.[0]?.[0] as {cover_command?: {operation: string}} | undefined)?.cover_command?.operation, "observe");
});

test("cover node: an open/close-only cover takes open, close and stop, not positions", async (t) => {
  const node = new (runtime(registerCover).Constructor)({coverType: "open-close", travelMs: 20000});
  t.after(() => close(node));
  assert.deepEqual(node.errors, []);
  const opened = await receive<SendEnvelope>(node, {payload: "open"});
  assert.equal((opened[0]?.[0]?.[0] as {cover_command?: {operation: string}} | undefined)?.cover_command?.operation, "open");
  assert.deepEqual(opened[0]?.[2], {topic: "moving", payload: true});
  assert.deepEqual(await receive(node, {payload: 40}), []);
  assert.equal(traces(node).at(-1)?.reason, "position-not-supported");
  const ended = await receive<SendEnvelope>(node, {cover: {kind: "observed", state: "open", motion: "stopped", observedAt: new Date().toISOString()}});
  const theatre = (ended[0]?.[1]?.[0] as {theatre?: {status: string; details: {state: string; evidence: string}}} | undefined)?.theatre;
  assert.deepEqual([theatre?.status, theatre?.details.state, theatre?.details.evidence], ["ready", "open", "reported"]);
  assert.deepEqual(ended[0]?.[2], {topic: "moving", payload: false});
  const bad = new (runtime(registerCover).Constructor)({coverType: "curtain"});
  assert.deepEqual(bad.errors.map(String), ["invalid configuration: cover type must be position or open-close"]);
});
