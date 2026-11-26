"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {normaliseShellyCoverConfig, transitionShellyCover, type ShellyCoverConfig, type ShellyCoverState} from "../lib/shelly-cover";
import {invalidConfig, onInput, runReducer} from "./adapter";

interface ShellyCoverNodeConfig extends NodeDef {
  topicPrefix?: string;
  channel?: number | string;
}

const registerShellyCover: NodeInitializer = (RED) => {
  function HomeShellyCover(this: Node, config: ShellyCoverNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let device: ShellyCoverConfig;
    try {
      device = normaliseShellyCoverConfig(config);
    } catch (error) {
      invalidConfig(node, error);
      return;
    }
    const trace = {area: "", component: "shelly-cover"};
    node.status({fill: "grey", shape: "ring", text: "waiting for the device"});

    onInput(node, (msg, send) => {
      const result = runReducer(node, trace, (saved: Partial<ShellyCoverState> | undefined, now) =>
        transitionShellyCover(saved, msg, device, now));
      // MQTT publications for the device on output 1, for an MQTT out node;
      // readings for the cover controller on output 2.
      const outputs = [
        result.publications.length ? result.publications.map((publication) => ({...publication})) : null,
        result.readings.length ? result.readings.map((reading) => ({payload: undefined, ...reading})) : null
      ];
      if (outputs.some((output) => output !== null)) send(outputs);
      node.status({fill: result.status.calibrated ? "green" : "yellow", shape: "dot", text: result.status.text});
    });
  }

  RED.nodes.registerType("home-shelly-cover", HomeShellyCover);
};

export = registerShellyCover;
