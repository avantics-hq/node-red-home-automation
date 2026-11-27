"use strict";

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {runInNewContext} from "node:vm";

// Runs shelly/wall-switch-fallback.js against a simulated device: the parts
// of Shelly's scripting API it uses, a relay whose output changes with the
// calls, and a record of every call the script makes.
const script = readFileSync(resolve(__dirname, "../../shelly/wall-switch-fallback.js"), "utf8");

type Handler = (...args: unknown[]) => void;
interface Call {method: string; params: Record<string, unknown>}

function device({connected = true} = {}) {
  const calls: Call[] = [];
  const subscriptions = new Map<string, Handler>();
  const handlers: {connect?: Handler; disconnect?: Handler; status?: Handler; event?: Handler} = {};
  let isConnected = connected;
  let output = true;
  const setOutput = (on: boolean) => {
    if (on !== output) handlers.status?.({component: "switch:0", id: 0, delta: {id: 0, output: on}});
    output = on;
  };
  runInNewContext(script, {
    console: {log() {}},
    Timer: {set() { return 1; }},
    Shelly: {
      call(method: string, params: Record<string, unknown>, callback?: Handler) {
        // A copy in this context, so assertions compare plain objects.
        calls.push({method, params: JSON.parse(JSON.stringify(params))});
        const wasOn = output;
        if (method === "Switch.Toggle") setOutput(!output);
        if (method === "Switch.Set") setOutput(params.on === true);
        callback?.({was_on: wasOn}, 0, "");
      },
      addStatusHandler(handler: Handler) { handlers.status = handler; return 1; },
      addEventHandler(handler: Handler) { handlers.event = handler; return 2; }
    },
    MQTT: {
      isConnected: () => isConnected,
      subscribe(topic: string, handler: Handler) { subscriptions.set(topic, handler); },
      unsubscribe(topic: string) { return subscriptions.delete(topic); },
      setConnectHandler(handler: Handler) { handlers.connect = handler; },
      setDisconnectHandler(handler: Handler) { handlers.disconnect = handler; }
    }
  });
  return {
    calls,
    output: () => output,
    // The relay switched from its own app or web page, not by the script.
    app(on: boolean) { setOutput(on); },
    nodeRed(message: string) { subscriptions.get("node-red/status")!("node-red/status", message); },
    disconnect() { isConnected = false; handlers.disconnect!(); },
    reconnect() { isConnected = true; handlers.connect!(); },
    status(status: object) { handlers.status!(status); },
    flip(state: boolean) { handlers.status!({component: "input:0", id: 0, delta: {id: 0, state}}); },
    push(event = "single_push") { handlers.event!({component: "input:0", id: 0, info: {component: "input:0", id: 0, event}}); },
    subscribed: () => [...subscriptions.keys()]
  };
}

const toggles = (calls: Call[]) => calls.filter(({method}) => method === "Switch.Toggle").length;
const sets = (calls: Call[]) => calls.filter(({method}) => method === "Switch.Set");

test("while Node-RED is online, presses never touch the relay", () => {
  const shelly = device();
  shelly.nodeRed("online");
  shelly.flip(true);
  shelly.flip(false);
  shelly.push();
  assert.deepEqual(shelly.calls, []);
});

test("with the device's MQTT connection down, each press toggles the relay", () => {
  const shelly = device();
  shelly.nodeRed("online");
  shelly.disconnect();
  shelly.flip(true);
  shelly.push("double_push");
  shelly.push("long_push");
  assert.equal(toggles(shelly.calls), 3);
  assert.deepEqual(shelly.calls[0], {method: "Switch.Toggle", params: {id: 0, tag: "fallback-press"}});
});

test("when Node-RED announces itself offline, each press toggles the relay", () => {
  const shelly = device();
  shelly.nodeRed("online");
  shelly.nodeRed("offline");
  shelly.flip(true);
  shelly.flip(false);
  assert.equal(toggles(shelly.calls), 2);
});

test("until anything is heard from Node-RED, presses toggle the relay only while MQTT is down", () => {
  const shelly = device();
  shelly.flip(true);
  shelly.push();
  assert.equal(toggles(shelly.calls), 0, "connected, nothing heard: presses are Node-RED's");
  shelly.disconnect();
  shelly.push();
  assert.equal(toggles(shelly.calls), 1);
});

test("on recovery, a relay the fallback switched off is switched on once, and presses go back to Node-RED", () => {
  const shelly = device();
  shelly.nodeRed("online");
  shelly.disconnect();
  shelly.push();
  assert.equal(shelly.output(), false);
  shelly.reconnect();
  assert.deepEqual(sets(shelly.calls), [], "connected, but Node-RED not yet heard from again");
  assert.deepEqual(shelly.subscribed(), ["node-red/status"], "subscribed again for the retained status");
  shelly.nodeRed("online");
  assert.deepEqual(sets(shelly.calls), [{method: "Switch.Set", params: {id: 0, on: true, tag: "fallback-ended"}}]);
  assert.equal(shelly.output(), true);
  shelly.calls.length = 0;
  shelly.nodeRed("online");
  shelly.push();
  assert.deepEqual(shelly.calls, []);
});

test("a relay a person switched off stays off through a connection blip or a Node-RED restart", () => {
  const shelly = device();
  shelly.nodeRed("online");
  shelly.app(false);
  shelly.disconnect();
  shelly.reconnect();
  shelly.nodeRed("online");
  shelly.nodeRed("offline");
  shelly.nodeRed("online");
  assert.deepEqual(shelly.calls, []);
  assert.equal(shelly.output(), false);
});

test("nothing is restored when the fallback left the relay on, or a person switched it back on", () => {
  const twice = device();
  twice.nodeRed("offline");
  twice.push();
  twice.push();
  twice.nodeRed("online");
  assert.deepEqual(sets(twice.calls), [], "two presses left it on");

  const app = device();
  app.nodeRed("offline");
  app.push();
  app.app(true);
  app.app(false);
  app.nodeRed("online");
  assert.deepEqual(sets(app.calls), [], "a person switched it on, then off again");
});

test("other inputs, outputs and button events are not presses", () => {
  const shelly = device({connected: false});
  shelly.push("btn_down");
  shelly.push("btn_up");
  shelly.status({component: "input:1", id: 1, delta: {id: 1, state: true}});
  shelly.status({component: "switch:0", id: 0, delta: {id: 0, output: false}});
  shelly.status({component: "input:0", id: 0, delta: {id: 0, state: null}});
  assert.equal(toggles(shelly.calls), 0);
  shelly.flip(true);
  assert.equal(toggles(shelly.calls), 1);
});
