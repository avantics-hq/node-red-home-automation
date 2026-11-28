"use strict";

// The one place that touches Node-RED's MQTT broker configuration node
// (mqtt-broker), so a node can publish and subscribe itself rather than
// through MQTT in and out nodes. None of this is the broker node's
// documented API, though Node-RED's own MQTT in and out nodes use exactly
// these calls (Node-RED 5.0.10, @node-red/nodes/core/network/10-mqtt.js):
// - register(user) adds the user, and connects with the first one; on every
//   connect, connecting and disconnect the broker calls user.status() with
//   "node-red:common.status.connected" and the like (:381-420, :739). So the
//   link registers a small proxy rather than its node, whose own status the
//   broker would otherwise overwrite, and turns "connected" into its
//   onConnected callbacks. A user registered while the broker is already
//   connected gets no call, so the link checks `connected` itself.
// - deregister(user, done, autoDisconnect) (:752), as MQTT in and out pass
//   it: `removed`.
// - subscribe(topic, options, callback, ref) (:987) and unsubscribe(topic,
//   ref, remove) (:1101): the callback gets (topic, payload Buffer, packet),
//   and the broker subscribes again by itself after a reconnect.
// - publish(msg, done) (:1149) drops anything sent while disconnected, with
//   no error. So the link never queues: callers announce again in
//   onConnected, and what is current is what is sent.

export const MQTT_CONNECTED = "node-red:common.status.connected";

// The parts of Node-RED's mqtt-broker node the link uses.
export interface BrokerNode {
  connected?: boolean;
  register(user: BrokerUser): void;
  deregister(user: BrokerUser, done: () => void, autoDisconnect?: boolean): void;
  subscribe(topic: string, options: {qos: number}, callback: (topic: string, payload: Buffer | string, packet?: {retain?: boolean}) => void, ref: string): void;
  unsubscribe(topic: string, ref: string, removeClientSubscription?: boolean): void;
  publish(msg: {topic: string; payload: string; qos: number; retain: boolean}, done?: (error?: unknown) => void): void;
}

interface BrokerUser {
  id: string;
  status(status: {text?: unknown}): void;
}

export interface BrokerMessage {
  topic: string;
  // As text: the broker hands over a Buffer.
  payload: string;
  retain: boolean;
}

export interface BrokerLink {
  connected(): boolean;
  // Called on every connect, reconnects included, and soon after this call
  // when the broker is connected already.
  onConnected(callback: () => void): void;
  publish(topic: string, payload: string, options?: {retain?: boolean; qos?: number}): void;
  subscribe(topic: string, callback: (message: BrokerMessage) => void): void;
  // Unsubscribes and deregisters: `removed` as Node-RED gives it to close.
  close(removed: boolean, done: () => void): void;
}

export function brokerLink(broker: BrokerNode, ownerId: string, onError: (error: unknown) => void = () => {}): BrokerLink {
  const callbacks: Array<() => void> = [];
  const topics = new Set<string>();
  const ref = ownerId + "-home-automation";
  let closed = false;
  const run = () => {
    for (const callback of callbacks) {
      try {
        callback();
      } catch (error) {
        onError(error);
      }
    }
  };
  // Stands in for the node: only status() is ever called on it.
  const proxy: BrokerUser = {
    id: ref,
    status(status) {
      if (!closed && status && status.text === MQTT_CONNECTED) run();
    }
  };
  broker.register(proxy);
  return {
    connected: () => broker.connected === true,
    onConnected(callback) {
      callbacks.push(callback);
      if (broker.connected === true) {
        setImmediate(() => {
          if (closed) return;
          try {
            callback();
          } catch (error) {
            onError(error);
          }
        });
      }
    },
    publish(topic, payload, {retain = false, qos = 0} = {}) {
      if (closed) return;
      broker.publish({topic, payload, qos, retain}, (error) => {
        if (error) onError(error);
      });
    },
    subscribe(topic, callback) {
      topics.add(topic);
      broker.subscribe(topic, {qos: 0}, (received, payload, packet) => {
        if (closed) return;
        callback({topic: received, payload: Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload ?? ""), retain: packet?.retain === true});
      }, ref);
    },
    close(removed, done) {
      closed = true;
      for (const topic of topics) broker.unsubscribe(topic, ref, removed);
      broker.deregister(proxy, done, removed);
    }
  };
}
