"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {normaliseZ2mLightConfig, transitionZ2mLight, type Z2mLightConfig, type Z2mLightState} from "../lib/z2m-light-adapter";
import {invalidConfig, onInput, runReducer} from "./adapter";

interface Z2mLightNodeConfig extends NodeDef {
  target?: string;
  baseTopic?: string;
  friendlyName?: string;
  group?: boolean | string;
}

const registerZ2mLight: NodeInitializer = (RED) => {
  function HomeZ2mLight(this: Node, config: Z2mLightNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let light: Z2mLightConfig;
    try {
      light = normaliseZ2mLightConfig(config);
    } catch (error) {
      invalidConfig(node, error);
      return;
    }
    const trace = {area: "", component: "z2m-light"};
    node.status({fill: "grey", shape: "ring", text: light.group ? "group · waiting for its state" : "waiting for the device"});

    onInput(node, (msg, send) => {
      const result = runReducer(node, trace, (saved: Partial<Z2mLightState> | undefined, now) => {
        const decided = transitionZ2mLight(saved, msg, light, now);
        // Another light's command: nothing to keep or trace, and the result
        // still says it was ignored.
        return decided.ignored ? {...decided, state: saved ?? decided.state, traces: []} : decided;
      }) as ReturnType<typeof transitionZ2mLight>;
      if (result.ignored) return;
      // MQTT publications for the device on output 1, for an MQTT out node;
      // readings for the room controller on output 2.
      const outputs = [
        result.publications.length ? result.publications.map((publication) => ({...publication})) : null,
        result.readings.length ? result.readings.map((reading) => ({payload: undefined, light: reading})) : null
      ];
      if (outputs.some((output) => output !== null)) send(outputs);
      const state = result.state;
      if (state.online === false) {
        node.status({fill: "grey", shape: "ring", text: "offline"});
      } else if (state.report) {
        const values = [
          typeof state.report.brightness === "number" ? Math.round(state.report.brightness * 100 / 254) + "%" : "",
          typeof state.report.color_temp === "number" && state.report.color_temp > 0 ? Math.round(1_000_000 / state.report.color_temp) + "K" : ""
        ].filter(Boolean).join(" ");
        node.status({fill: state.report.on ? "green" : "grey", shape: "dot", text: (state.report.on ? "on" : "off") + (state.report.on && values ? " · " + values : "")});
      }
    });
  }

  RED.nodes.registerType("home-z2m-light", HomeZ2mLight);
};

export = registerZ2mLight;
