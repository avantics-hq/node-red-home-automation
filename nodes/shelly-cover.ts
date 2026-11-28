"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {normaliseShellyCoverConfig, transitionShellyCover, type ShellyCoverConfig, type ShellyCoverState} from "../lib/shelly-cover";
import {invalidConfig, onInput, runReducer, type InputMessage, type Send} from "./adapter";
import {deviceBroker, deviceSide} from "./device-side";
import type {BrokerNode} from "./mqtt-broker-link";

interface ShellyCoverNodeConfig extends NodeDef {
  topicPrefix?: string;
  channel?: number | string;
  // Node-RED's mqtt-broker node, to subscribe and publish itself.
  broker?: string;
}

const registerShellyCover: NodeInitializer = (RED) => {
  function HomeShellyCover(this: Node, config: ShellyCoverNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let device: ShellyCoverConfig;
    let broker: BrokerNode | null;
    try {
      device = normaliseShellyCoverConfig(config);
      broker = deviceBroker(RED, config.broker);
    } catch (error) {
      invalidConfig(node, error);
      return;
    }
    const trace = {area: "", component: "shelly-cover"};
    node.status({fill: "grey", shape: "ring", text: "waiting for the device"});

    const side = deviceSide(node, broker, device.topicPrefix, trace, (msg, send) => handle(msg, send));

    function handle(msg: InputMessage, send: Send) {
      const result = runReducer(node, trace, (saved: Partial<ShellyCoverState> | undefined, now) =>
        transitionShellyCover(saved, msg, device, now));
      // MQTT publications for the device: to the broker, or on output 1 for
      // an MQTT out node; readings for the cover controller on output 2.
      const outputs = [
        side.publish(result.publications),
        result.readings.length ? result.readings.map((reading) => ({payload: undefined, ...reading})) : null
      ];
      if (outputs.some((output) => output !== null)) send(outputs);
      node.status({fill: result.status.calibrated ? "green" : "yellow", shape: "dot", text: result.status.text});
    }
    onInput(node, (msg, send) => {
      // With a broker, its device's messages come from the broker: an MQTT
      // in or a Status node still wired in changes nothing.
      if (!side.fromBroker(msg)) handle(msg, send);
    });
  }

  RED.nodes.registerType("home-shelly-cover", HomeShellyCover);
};

export = registerShellyCover;
