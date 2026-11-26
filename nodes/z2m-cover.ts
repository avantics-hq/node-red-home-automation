"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {normaliseZ2mCoverConfig, transitionZ2mCover, type Z2mCoverConfig, type Z2mCoverState} from "../lib/z2m-cover";
import {invalidConfig, onInput, runReducer} from "./adapter";

interface Z2mCoverNodeConfig extends NodeDef {
  baseTopic?: string;
  friendlyName?: string;
}

const registerZ2mCover: NodeInitializer = (RED) => {
  function HomeZ2mCover(this: Node, config: Z2mCoverNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let device: Z2mCoverConfig;
    try {
      device = normaliseZ2mCoverConfig(config);
    } catch (error) {
      invalidConfig(node, error);
      return;
    }
    const trace = {area: "", component: "z2m-cover"};
    node.status({fill: "grey", shape: "ring", text: "waiting for the device"});

    onInput(node, (msg, send) => {
      const result = runReducer(node, trace, (saved: Partial<Z2mCoverState> | undefined, now) =>
        transitionZ2mCover(saved, msg, device, now));
      // MQTT publications for the device on output 1, for an MQTT out node;
      // readings for the cover controller on output 2.
      const outputs = [
        result.publications.length ? result.publications.map((publication) => ({...publication})) : null,
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
    });
  }

  RED.nodes.registerType("home-z2m-cover", HomeZ2mCover);
};

export = registerZ2mCover;
