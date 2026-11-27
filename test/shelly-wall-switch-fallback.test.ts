"use strict";

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import {runInNewContext} from "node:vm";

// Runs shelly/wall-switch-fallback.js against a simulated device: the parts
// of Shelly's scripting API it uses, recording every call it makes.
const script = readFileSync(resolve(__dirname, "../../shelly/wall-switch-fallback.js"), "utf8");

type Handler = (...args: unknown[]) => void;

function device({connected = true} = {}) {
  const calls: Array<{method: string; params: Record<string, unknown>}> = [];
  const subscriptions = new Map<string, Handler>();
  const handlers: {connect?: Handler; disconnect?: Handler; status?: Handler; event?: Handler} = {};
  let isConnected = connected;
  runInNewContext(script, {
    console: {log() {}},
    Shelly: {
      // A copy in this context, so assertions compare plain objects.
      call(method: string, params: Record<string, unknown>) { calls.push({method, params: JSON.parse(JSON.stringify(params))}); },
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
    nodeRed(message: string) { subscriptions.get("node-red/status")!("node-red/status", message); },
    disconnect() { isConnected = false; handlers.disconnect!(); },
    reconnect() { isConnected = true; handlers.connect!(); },
    status(status: object) { handlers.status!(status); },
    flip(state: boolean) { handlers.status!({component: "input:0", id: 0, delta: {id: 0, state}}); },
    push(event = "single_push") { handlers.event!({component: "input:0", id: 0, info: {component: "input:0", id: 0, event}}); },
    subscribed: () => [...subscriptions.keys()]
  };
}

const toggles = (calls: Array<{method: string}>) => calls.filter(({method}) => method === "Switch.Toggle").length;

test("while Node-RED is online, presses never touch the relay", () => {
  const shelly = device();
  shelly.nodeRed("online");
  shelly.calls.length = 0;
  shelly.flip(true);
  shelly.flip(false);
  shelly.push();
  assert.deepEqual(shelly.calls, []);
});

test("with the device's MQTT connection down, each press toggles the relay", () => {
  const shelly = device();
  shelly.nodeRed("online");
  shelly.disconnect();
  shelly.calls.length = 0;
  shelly.flip(true);
  shelly.push("double_push");
  shelly.push("long_push");
  assert.equal(toggles(shelly.calls), 3);
  assert.deepEqual(shelly.calls[0], {method: "Switch.Toggle", params: {id: 0, tag: "fallback-press"}});
});

test("when Node-RED reports itself offline, each press toggles the relay", () => {
  const shelly = device();
  shelly.nodeRed("online");
  shelly.nodeRed("offline");
  shelly.flip(true);
  shelly.flip(false);
  assert.equal(toggles(shelly.calls), 2);
});

test("until Node-RED is known to be online, presses toggle the relay", () => {
  const shelly = device();
  shelly.push();
  assert.equal(toggles(shelly.calls), 1);
});

test("on recovery the relay is switched on once, and presses go back to Node-RED", () => {
  const shelly = device();
  shelly.nodeRed("online");
  shelly.disconnect();
  shelly.push();
  shelly.calls.length = 0;
  shelly.reconnect();
  assert.deepEqual(shelly.calls, [], "connected, but Node-RED not yet heard from");
  assert.deepEqual(shelly.subscribed(), ["node-red/status"], "subscribed again for the retained status");
  shelly.nodeRed("online");
  assert.deepEqual(shelly.calls, [{method: "Switch.Set", params: {id: 0, on: true, tag: "fallback-ended"}}]);
  shelly.nodeRed("online");
  shelly.push();
  assert.equal(shelly.calls.length, 1);
});

test("other inputs, outputs and button events are ignored", () => {
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
