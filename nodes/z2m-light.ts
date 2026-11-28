"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {normaliseZ2mLightConfig, transitionZ2mLight, z2mLightTopics, type Z2mLightConfig, type Z2mLightState} from "../lib/z2m-light-adapter";
import {invalidConfig, onInput, runReducer, type InputMessage, type Send} from "./adapter";
import {deviceBroker, deviceSide} from "./device-side";
import type {BrokerNode} from "./mqtt-broker-link";

interface Z2mLightNodeConfig extends NodeDef {
  target?: string;
  baseTopic?: string;
  friendlyName?: string;
  group?: boolean | string;
  // Node-RED's mqtt-broker node, to subscribe and publish itself.
  broker?: string;
}

const registerZ2mLight: NodeInitializer = (RED) => {
  function HomeZ2mLight(this: Node, config: Z2mLightNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let light: Z2mLightConfig;
    let broker: BrokerNode | null;
    try {
      light = normaliseZ2mLightConfig(config);
      broker = deviceBroker(RED, config.broker);
    } catch (error) {
      invalidConfig(node, error);
      return;
    }
    const trace = {area: "", component: "z2m-light"};
    node.status({fill: "grey", shape: "ring", text: light.group ? "group · waiting for its state" : "waiting for the device"});

    // Exactly its own topics: a friendly name can contain "/", so <name>/#
    // would take in other devices' too.
    const topics = z2mLightTopics(light);
    const side = deviceSide(node, broker, topics.device, [topics.device, topics.set, ...(light.group ? [] : [topics.availability])],
      trace, (msg, send) => handle(msg, send));

    function handle(msg: InputMessage, send: Send) {
      const result = runReducer(node, trace, (saved: Partial<Z2mLightState> | undefined, now) => {
        const decided = transitionZ2mLight(saved, msg, light, now);
        // Another light's command: nothing to keep or trace, and the result
        // still says it was ignored.
        return decided.ignored ? {...decided, state: saved ?? decided.state, traces: []} : decided;
      }) as ReturnType<typeof transitionZ2mLight>;
      if (result.ignored) return;
      // MQTT publications for the device: to the broker, or on output 1 for
      // an MQTT out node; readings for the room controller on output 2.
      const outputs = [
        side.publish(result.publications),
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
    }
    onInput(node, (msg, send) => {
      // With a broker, its device's messages come from the broker: an MQTT
      // in or a Status node still wired in changes nothing.
      if (!side.fromBroker(msg)) handle(msg, send);
    });
  }

  RED.nodes.registerType("home-z2m-light", HomeZ2mLight);
};

export = registerZ2mLight;
