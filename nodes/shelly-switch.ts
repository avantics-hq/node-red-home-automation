"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  CONFIG_TIMEOUT_MS,
  normaliseShellySwitchConfig,
  transitionShellySwitch,
  type ShellySwitchConfig,
  type ShellySwitchMessage,
  type ShellySwitchState
} from "../lib/shelly-switch";
import {guarded, invalidConfig, onInput, runReducer, whenFlowsStarted, type InputMessage, type Send} from "./adapter";
import {deviceBroker, deviceSide} from "./device-side";
import type {BrokerNode} from "./mqtt-broker-link";

interface ShellySwitchNodeConfig extends NodeDef {
  topicPrefix?: string;
  channel?: number | string;
  mode?: string;
  target?: string;
  // Node-RED's mqtt-broker node, to subscribe and publish itself.
  broker?: string;
}

const registerShellySwitch: NodeInitializer = (RED) => {
  function HomeShellySwitch(this: Node, config: ShellySwitchNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let device: ShellySwitchConfig;
    let broker: BrokerNode | null;
    try {
      device = normaliseShellySwitchConfig(config);
      broker = deviceBroker(RED, config.broker);
    } catch (error) {
      invalidConfig(node, error);
      return;
    }
    const trace = {area: "", component: "shelly-switch"};
    let timer: ReturnType<typeof setTimeout> | undefined;
    // With a broker, it reads the device's configuration each time it
    // connects; without one, once the flows have started (and at a Status
    // node's "connected").
    // Its prefix is one device: everything under it.
    const side = deviceSide(node, broker, device.topicPrefix, [device.topicPrefix + "/#"], trace, (msg, send) => process(msg as ShellySwitchMessage, send),
      () => process({shellySwitch: {kind: "startup"}}, node.send.bind(node)));

    function process(msg: ShellySwitchMessage, send: Send) {
      const result = runReducer(node, trace, (saved: Partial<ShellySwitchState> | undefined, now) => {
        const decided = transitionShellySwitch(saved, msg, device, now);
        // Another light's command: nothing to keep or trace, and the result
        // still says it was ignored.
        return decided.ignored ? {...decided, state: (saved ?? decided.state) as ShellySwitchState, traces: []} : decided;
      });
      // Another light's command: nothing to keep, send or show.
      if (result.ignored) return;
      // MQTT publications for the device: to the broker, or on output 1 for
      // an MQTT out node;
      // readings on output 2: for the switch lighting policy when detached,
      // the relay's state otherwise; with a Target, the light's readings for
      // the room on output 3.
      const outputs = [
        side.publish(result.publications),
        result.readings.length ? result.readings.map((reading) => ({payload: undefined, ...reading})) : null,
        result.lightReadings.length ? result.lightReadings.map((reading) => ({payload: undefined, light: reading})) : null
      ];
      if (outputs.some((output) => output !== null)) send(outputs);
      node.status({fill: result.status.fill, shape: result.status.fill === "green" ? "dot" : "ring", text: result.status.text});
      // A configuration request not answered in time is taken as unreadable.
      if (result.state.requestedAt !== null && result.state.setupStatus === "reading") {
        clearTimeout(timer);
        timer = setTimeout(guarded(node, () => process({shellySwitch: {kind: "tick"}}, node.send.bind(node))),
          Math.max(0, result.state.requestedAt + CONFIG_TIMEOUT_MS - Date.now()));
      }
    }

    node.status({fill: "grey", shape: "ring", text: "reading the device's configuration"});
    // Once the flows have started, so the MQTT out node is there to send through.
    if (!side.broker) whenFlowsStarted(RED, node, () => process({shellySwitch: {kind: "startup"}}, node.send.bind(node)));
    onInput(node, (msg, send) => {
      // With a broker, its device's messages come from the broker: an MQTT
      // in or a Status node still wired in changes nothing.
      if (!side.fromBroker(msg)) process(msg as ShellySwitchMessage, send);
    }, side.broker ? undefined : {message: {shellySwitch: {kind: "startup"}}, trace: trace});
    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(timer);
      done();
    });
  }

  RED.nodes.registerType("home-shelly-switch", HomeShellySwitch);
};

export = registerShellySwitch;
