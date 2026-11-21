"use strict";

import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import type {NodeInitializer} from "node-red";
import registerActivityLighting from "../nodes/activity-lighting-controller";
import registerBacklighting from "../nodes/backlighting-controller";
import registerAvr from "../nodes/avr-controller";
import registerMotion from "../nodes/motion-policy";
import registerOccupancy from "../nodes/occupancy-fusion";
import registerRoom from "../nodes/room-controller";
import registerSource from "../nodes/source-capability-controller";
import type {TraceRecord} from "../lib/bounded-trace";

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
  lighting?: Record<string, unknown>;
  avr_command?: Record<string, unknown>;
  activityLighting?: Record<string, unknown>;
  activityLightingCommand?: Record<string, unknown>;
  backlighting?: Record<string, unknown>;
  backlightingCommand?: Record<string, unknown>;
  sourceCommand?: Record<string, unknown>;
  theatre?: Record<string, unknown>;
}

type SendEnvelope = Array<WireMessage[] | null>;
type RuntimeConstructor = new (config: Record<string, unknown>) => RuntimeNode;

function runtime(register: NodeInitializer): {Constructor: RuntimeConstructor} {
  let Constructor: RuntimeConstructor | undefined;
  const globalValues = new Map<string, unknown>([["MOTION_ENABLED_STATE", true]]);
  const RED = {
    nodes: {
      createNode(node: RuntimeNode) {
        const emitter = new EventEmitter();
        const values = new Map<string, unknown>();
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
  const trace = traces(node);
  assert.equal(trace.at(-1)?.component, "room-controller");
  assert.equal(trace.at(-1)?.event, "intent");
  assert.equal(trace.at(-1)?.outcome, "commanded");
  assert.equal(node.errors.length, 0);
});

test("room adapter requires deployment coordinates", () => {
  const {Constructor} = runtime(registerRoom);
  const node = new Constructor({
    area: "room",
    displayName: "Room",
    targets: "[]"
  });

  assert.match(String(node.errors[0]), /latitude is required/);
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
