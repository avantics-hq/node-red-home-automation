"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {normaliseZ2mCoverConfig, transitionZ2mCover, z2mCoverTopics, type Z2mCoverConfig, type Z2mCoverState} from "../lib/z2m-cover";
import {invalidConfig, onInput, runReducer, type InputMessage, type Send} from "./adapter";
import {deviceBroker, deviceSide} from "./device-side";
import type {BrokerNode} from "./mqtt-broker-link";

interface Z2mCoverNodeConfig extends NodeDef {
  baseTopic?: string;
  friendlyName?: string;
  // Node-RED's mqtt-broker node, to subscribe and publish itself.
  broker?: string;
}

const registerZ2mCover: NodeInitializer = (RED) => {
  function HomeZ2mCover(this: Node, config: Z2mCoverNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let device: Z2mCoverConfig;
    let broker: BrokerNode | null;
    try {
      device = normaliseZ2mCoverConfig(config);
      broker = deviceBroker(RED, config.broker);
    } catch (error) {
      invalidConfig(node, error);
      return;
    }
    const trace = {area: "", component: "z2m-cover"};
    node.status({fill: "grey", shape: "ring", text: "waiting for the device"});

    // Exactly its own topics: a friendly name can contain "/", so <name>/#
    // would take in other devices' too.
    const topics = z2mCoverTopics(device);
    const side = deviceSide(node, broker, topics.device, [topics.device, topics.availability], trace, (msg, send) => handle(msg, send));

    function handle(msg: InputMessage, send: Send) {
      const result = runReducer(node, trace, (saved: Partial<Z2mCoverState> | undefined, now) =>
        transitionZ2mCover(saved, msg, device, now));
      // MQTT publications for the device: to the broker, or on output 1 for
      // an MQTT out node; readings for the cover controller on output 2.
      const outputs = [
        side.publish(result.publications),
        result.readings.length ? result.readings.map((reading) => ({payload: undefined, ...reading})) : null
      ];
      if (outputs.some((output) => output !== null)) send(outputs);
      const last = result.readings.at(-1)?.cover;
      if (last?.kind === "availability") {
        node.status({fill: last.online ? "green" : "grey", shape: last.online ? "dot" : "ring", text: last.online ? "online" : "offline"});
      } else if (last) {
        const where = last.position !== undefined ? `${last.position}%` : last.state ?? "position unknown";
        node.status({fill: "green", shape: "dot", text: last.motion && last.motion !== "stopped" ? `${last.motion} · ${where}` : where});
      }
    }
    onInput(node, (msg, send) => {
      // With a broker, its device's messages come from the broker: an MQTT
      // in or a Status node still wired in changes nothing.
      if (!side.fromBroker(msg)) handle(msg, send);
    });
  }

  RED.nodes.registerType("home-z2m-cover", HomeZ2mCover);
};

export = registerZ2mCover;
