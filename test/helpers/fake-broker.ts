"use strict";

// A stand-in for Node-RED 5.0.10's mqtt-broker node, as nodes/mqtt-broker-link.ts
// uses it (10-mqtt.js): users get status() on connect and disconnect,
// publications while disconnected are dropped, payloads arrive as Buffers
// with the packet's retain flag. The real node is pinned by the smoke.

type Callback = (topic: string, payload: Buffer, packet: {retain?: boolean}) => void;

function matches(filter: string, topic: string): boolean {
  const want = filter.split("/");
  const got = topic.split("/");
  for (let index = 0; index < want.length; index += 1) {
    if (want[index] === "#") return true;
    if (index >= got.length) return false;
    if (want[index] !== "+" && want[index] !== got[index]) return false;
  }
  return want.length === got.length;
}

export function fakeBroker() {
  const users = new Map<string, {id: string; status(status: {text?: string}): void}>();
  const subscriptions = new Map<string, Map<string, Callback>>();
  const published: Array<{topic: string; payload: string; retain: boolean}> = [];
  const deregistered: Array<{id: string; autoDisconnect: boolean | undefined}> = [];
  const broker = {
    connected: false,
    users,
    subscriptions,
    published,
    deregistered,
    register(user: {id: string; status(status: {text?: string}): void}) {
      users.set(user.id, user);
    },
    deregister(user: {id: string}, done: () => void, autoDisconnect?: boolean) {
      deregistered.push({id: user.id, autoDisconnect});
      users.delete(user.id);
      done();
    },
    subscribe(topic: string, _options: {qos: number}, callback: Callback, ref: string) {
      if (!subscriptions.has(topic)) subscriptions.set(topic, new Map());
      subscriptions.get(topic)!.set(ref, callback);
    },
    unsubscribe(topic: string, ref: string) {
      subscriptions.get(topic)?.delete(ref);
      if (subscriptions.get(topic)?.size === 0) subscriptions.delete(topic);
    },
    publish(msg: {topic: string; payload: string; retain: boolean}, done?: () => void) {
      if (broker.connected) published.push({topic: msg.topic, payload: msg.payload, retain: msg.retain});
      done?.();
    },
    connect() {
      broker.connected = true;
      for (const user of users.values()) user.status({text: "node-red:common.status.connected"});
    },
    disconnect() {
      broker.connected = false;
      for (const user of users.values()) user.status({text: "node-red:common.status.disconnected"});
    },
    // To every subscription whose filter matches, wildcards included: "+" one
    // level, a trailing "#" any number, and the parent itself.
    deliver(topic: string, payload: string, retain = false) {
      for (const [filter, callbacks] of subscriptions) {
        if (!matches(filter, topic)) continue;
        for (const callback of callbacks.values()) callback(topic, Buffer.from(payload), {retain});
      }
    }
  };
  return broker;
}
