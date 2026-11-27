"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {normaliseShellySwitchConfig, transitionShellySwitch, type ShellySwitchConfig, type ShellySwitchState} from "../lib/shelly-switch";
import {invalidConfig, onInput, runReducer} from "./adapter";

interface ShellySwitchNodeConfig extends NodeDef {
  topicPrefix?: string;
  channel?: number | string;
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
    node.status({fill: "grey", shape: "ring", text: "waiting for the device"});

    onInput(node, (msg, send) => {
      const result = runReducer(node, trace, (saved: Partial<ShellySwitchState> | undefined, now) =>
        transitionShellySwitch(saved, msg, device, now));
      // MQTT publications for the device on output 1, for an MQTT out node;
      // readings for the backlighting controller on output 2; the
      // projector's power for the display controller on output 3.
      const outputs = [
        result.publications.length ? result.publications.map((publication) => ({...publication})) : null,
        result.backlighting.length ? result.backlighting.map((reading) => ({payload: undefined, ...reading})) : null,
        result.display.length ? result.display.map((reading) => ({payload: undefined, ...reading})) : null
      ];
      if (outputs.some((output) => output !== null)) send(outputs);
      node.status({fill: result.status.online ? "green" : "grey", shape: result.status.online ? "dot" : "ring", text: result.status.text});
    });
  }

  RED.nodes.registerType("home-shelly-switch", HomeShellySwitch);
};

export = registerShellySwitch;
