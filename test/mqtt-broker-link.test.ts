"use strict";

import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import type {Node, NodeAPI} from "node-red";
import {homeAssistantDiscovery} from "../nodes/home-assistant-discovery";
import {brokerLink, type BrokerMessage} from "../nodes/mqtt-broker-link";
import {fakeBroker} from "./helpers/fake-broker";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the link registers a proxy, not the node, and calls back on every connect, reconnects included", async () => {
  const broker = fakeBroker();
  const link = brokerLink(broker, "room-1");
  assert.deepEqual([...broker.users.keys()], ["room-1-home-automation"], "its own id, so the broker's status never reaches the node");
  let connects = 0;
  link.onConnected(() => { connects += 1; });
  assert.equal(link.connected(), false);
  broker.connect();
  broker.disconnect();
  broker.connect();
  assert.equal(connects, 2);
  assert.equal(link.connected(), true);
  // A callback added while connected runs soon, as the broker won't call again.
  let late = 0;
  link.onConnected(() => { late += 1; });
  await tick();
  assert.equal(late, 1);
});

test("the link publishes text, never queues, and hands subscriptions over decoded, with retain", () => {
  const broker = fakeBroker();
  const link = brokerLink(broker, "n");
  link.publish("home/a/state", "ON", {retain: true});
  assert.deepEqual(broker.published, [], "dropped while disconnected, as the broker node does");
  broker.connect();
  link.publish("home/a/state", "OFF", {retain: true});
  assert.deepEqual(broker.published, [{topic: "home/a/state", payload: "OFF", retain: true}]);
  const seen: BrokerMessage[] = [];
  link.subscribe("home/a/set", (message) => seen.push(message));
  broker.deliver("home/a/set", "ON");
  broker.deliver("home/a/set", "OFF", true);
  assert.deepEqual(seen, [{topic: "home/a/set", payload: "ON", retain: false}, {topic: "home/a/set", payload: "OFF", retain: true}]);
});

test("closing the link unsubscribes and deregisters, passing removed on, and nothing more arrives", () => {
  const broker = fakeBroker();
  const link = brokerLink(broker, "n");
  let calls = 0;
  link.onConnected(() => { calls += 1; });
  link.subscribe("home/a/set", () => { calls += 1; });
  let done = false;
  link.close(true, () => { done = true; });
  assert.equal(done, true);
  assert.deepEqual(broker.deregistered, [{id: "n-home-automation", autoDisconnect: true}]);
  assert.equal(broker.subscriptions.size, 0);
  broker.connect();
  assert.equal(calls, 0);
});

// The parts of a Node-RED node and runtime the discovery module uses.
function fakeNode(listed = true) {
  const values = new Map<string, unknown>();
  const emitter = new EventEmitter();
  const node = {id: "room-1", on: emitter.on.bind(emitter), emit: emitter.emit.bind(emitter),
    context: () => ({get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value)})};
  const RED = {nodes: {eachNode: (visit: (entry: {id: string}) => void) => { if (listed) visit({id: "room-1"}); }}};
  return {node: node as unknown as Node, RED: RED as unknown as NodeAPI, emitter, values};
}
const close = (emitter: EventEmitter, removed: boolean) => new Promise<void>((resolve) => emitter.emit("close", removed, resolve));

function discovery(broker: ReturnType<typeof fakeBroker>, listed = true, onSet?: (message: BrokerMessage) => void) {
  const fake = fakeNode(listed);
  let state = "OFF";
  let retained = ["ha/switch/x/config", "home/a/availability", "home/a/state"];
  const module = homeAssistantDiscovery(fake.RED, fake.node, brokerLink(broker, "room-1"), {
    retainedTopics: () => retained,
    announcement: () => [
      {topic: "ha/switch/x/config", payload: {name: "x"}, retain: true},
      {topic: "home/a/availability", payload: "online", retain: true},
      {topic: "home/a/state", payload: state, retain: true}
    ],
    stopping: () => [{topic: "home/a/availability", payload: "offline", retain: true}],
    statusTopic: "ha/status",
    setTopics: ["home/a/set"],
    onSet
  }, {area: "a", component: "test"});
  return {module, fake, setState: (next: string) => { state = next; }, setRetained: (next: string[]) => { retained = next; }};
}

test("discovery: everything announced on every connect and when Home Assistant comes back, with the current state", () => {
  const broker = fakeBroker();
  const {setState} = discovery(broker);
  broker.connect();
  assert.deepEqual(broker.published.map(({topic, payload}) => [topic, payload]),
    [["ha/switch/x/config", "{\"name\":\"x\"}"], ["home/a/availability", "online"], ["home/a/state", "OFF"]]);
  broker.published.length = 0;
  setState("ON");
  broker.disconnect();
  broker.connect();
  assert.deepEqual(broker.published.map(({topic, payload}) => [topic, payload]).at(-1), ["home/a/state", "ON"], "a reconnect announces what is current");
  broker.published.length = 0;
  broker.deliver("ha/status", "offline");
  assert.deepEqual(broker.published, []);
  broker.deliver("ha/status", "online");
  assert.equal(broker.published.length, 3, "Home Assistant's birth message");
});

test("discovery: only the advertised set topics are read, and a retained set message never is", () => {
  const broker = fakeBroker();
  const sets: BrokerMessage[] = [];
  const {fake} = discovery(broker, true, (message) => sets.push(message));
  assert.deepEqual([...broker.subscriptions.keys()].sort(), ["ha/status", "home/a/set"], "exactly these: no wildcard");
  broker.deliver("home/a/set", "ON", true);
  broker.deliver("home/a/set", "ON");
  assert.deepEqual(sets.map(({payload, retain}) => [payload, retain]), [["ON", false]]);
  const traced = (fake.values.get("trace") as Array<{reason: string}>).map(({reason}) => reason);
  assert.ok(traced.includes("retained-message"));
});

test("discovery: offline as the node stops; everything cleared when it is deleted; what it no longer publishes cleared on connect", async () => {
  const broker = fakeBroker();
  broker.connect();
  const stopped = discovery(broker);
  await tick();
  broker.published.length = 0;
  await close(stopped.fake.emitter, false);
  assert.deepEqual(broker.published.map(({topic, payload}) => [topic, payload]), [["home/a/availability", "offline"]]);

  const deleted = discovery(broker, false);
  await tick();
  broker.published.length = 0;
  await close(deleted.fake.emitter, true);
  assert.deepEqual(broker.published.map(({topic, payload}) => [topic, payload]).sort(),
    [["ha/switch/x/config", ""], ["home/a/availability", ""], ["home/a/state", ""]]);

  // Its state topic gone from its settings: cleared at the next connect.
  const second = fakeBroker();
  const renamed = discovery(second);
  second.connect();
  renamed.setRetained(["ha/switch/x/config", "home/a/availability"]);
  second.published.length = 0;
  second.disconnect();
  second.connect();
  assert.deepEqual(second.published[0], {topic: "home/a/state", payload: "", retain: true});
});
