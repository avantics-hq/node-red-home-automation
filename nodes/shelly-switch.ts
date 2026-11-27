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
import {guarded, invalidConfig, onInput, runReducer, whenFlowsStarted, type Send} from "./adapter";

interface ShellySwitchNodeConfig extends NodeDef {
  topicPrefix?: string;
  channel?: number | string;
  mode?: string;
}

const registerShellySwitch: NodeInitializer = (RED) => {
  function HomeShellySwitch(this: Node, config: ShellySwitchNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let device: ShellySwitchConfig;
    try {
      device = normaliseShellySwitchConfig(config);
    } catch (error) {
      invalidConfig(node, error);
      return;
    }
    const trace = {area: "", component: "shelly-switch"};
    let timer: ReturnType<typeof setTimeout> | undefined;

    function process(msg: ShellySwitchMessage, send: Send) {
      const result = runReducer(node, trace, (saved: Partial<ShellySwitchState> | undefined, now) =>
        transitionShellySwitch(saved, msg, device, now));
      // MQTT publications for the device on output 1, for an MQTT out node;
      // readings on output 2: for the switch lighting policy when detached,
      // the relay's state otherwise.
      const outputs = [
        result.publications.length ? result.publications.map((publication) => ({...publication})) : null,
        result.readings.length ? result.readings.map((reading) => ({payload: undefined, ...reading})) : null
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
    whenFlowsStarted(RED, node, () => process({shellySwitch: {kind: "startup"}}, node.send.bind(node)));
    onInput(node, (msg, send) => process(msg as ShellySwitchMessage, send), {shellySwitch: {kind: "startup"}});
    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(timer);
      done();
    });
  }

  RED.nodes.registerType("home-shelly-switch", HomeShellySwitch);
};

export = registerShellySwitch;
