"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {normaliseWledConfig, transitionWled, wledTopics, type WledConfig, type WledState} from "../lib/wled";
import {invalidConfig, onInput, runReducer, type InputMessage, type Send} from "./adapter";
import {deviceBroker, deviceSide} from "./device-side";
import type {BrokerNode} from "./mqtt-broker-link";

interface WledNodeConfig extends NodeDef {
  deviceTopic?: string;
  // Node-RED's mqtt-broker node, to subscribe and publish itself.
  broker?: string;
}

const registerWled: NodeInitializer = (RED) => {
  function HomeWled(this: Node, config: WledNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let device: WledConfig;
    let broker: BrokerNode | null;
    try {
      device = normaliseWledConfig(config);
      // Newer than the MQTT in and out way of wiring adapters: it needs its
      // broker.
      broker = deviceBroker(RED, config.broker);
      if (!broker) throw new Error("choose its MQTT broker");
    } catch (error) {
      invalidConfig(node, error);
      return;
    }
    const trace = {area: "", component: "wled"};
    node.status({fill: "grey", shape: "ring", text: "waiting for the device"});

    // Exactly its own topics: its brightness and its availability. Its
    // device topic is where its commands go.
    const topics = wledTopics(device);
    const side = deviceSide(node, broker, topics.device, [topics.brightness, topics.status], trace, (msg, send) => handle(msg, send));

    function handle(msg: InputMessage, send: Send) {
      const result = runReducer(node, trace, (saved: Partial<WledState> | undefined, now) => transitionWled(saved, msg, device, now));
      // Its commands to WLED through the broker; readings for the
      // backlighting controller on its output.
      side.publish(result.publications);
      // One output: its messages together on it, as [[...]].
      if (result.readings.length) send([result.readings.map((reading) => ({payload: undefined, ...reading}))]);
      const state = result.state;
      if (state.online === false) node.status({fill: "grey", shape: "ring", text: "offline"});
      else if (state.power) node.status({fill: state.power === "on" ? "green" : "grey", shape: "dot", text: state.power});
    }
    onInput(node, (msg, send) => {
      // WLED's messages come from the broker: an MQTT in node wired in
      // changes nothing.
      if (!side.fromBroker(msg)) handle(msg, send);
    });
  }

  RED.nodes.registerType("home-wled", HomeWled);
};

export = registerWled;
