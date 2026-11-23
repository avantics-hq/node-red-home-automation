"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  normaliseStateContractConfig,
  transitionTheatreStateContract,
  type TheatreStateContractConfig,
  type TheatreStateContractMessage,
  type TheatreStateContractState
} from "../lib/theatre-state-contract";
import {invalidConfig, objectField, onInput, runReducer, type Send} from "./adapter";

interface TheatreStateContractNodeConfig extends NodeDef {
  area?: string;
  displayName?: string;
  baseTopic?: string;
  discoveryPrefix?: string;
  activities?: string;
  sloWindowSize?: number | string;
  sloMinimumSamples?: number | string;
  sloLatencyBudgetMs?: number | string;
  sloSuccessObjectivePct?: number | string;
}

interface TheatreStateContractNode extends Node {}

const registerTheatreStateContract: NodeInitializer = (RED) => {
  function HomeTheatreStateContract(this: TheatreStateContractNode, config: TheatreStateContractNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;

    let controllerConfig: TheatreStateContractConfig;
    try {
      const activities: unknown = JSON.parse(config.activities || "[]");
      controllerConfig = normaliseStateContractConfig({
        area: config.area || "lounge",
        displayName: config.displayName || config.area || "Lounge",
        baseTopic: config.baseTopic || `home/${config.area || "lounge"}/theatre`,
        discoveryPrefix: config.discoveryPrefix || "homeassistant",
        activities: Array.isArray(activities) ? activities.map(String) : [],
        slo: {
          windowSize: Number(config.sloWindowSize ?? 20),
          minimumSamples: Number(config.sloMinimumSamples ?? 5),
          latencyBudgetMs: Number(config.sloLatencyBudgetMs ?? 60000),
          successObjectivePct: Number(config.sloSuccessObjectivePct ?? 95)
        }
      });
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    function process(msg: TheatreStateContractMessage, send: Send) {
      const result = runReducer(node, {area: controllerConfig.area, component: "theatre-state-contract"},
        (saved: Partial<TheatreStateContractState> | undefined, now) =>
          transitionTheatreStateContract(saved, msg, controllerConfig, now));
      if (result.requests.length) {
        send([
          result.requests.map((request) => ({payload: undefined, ...request})),
          null
        ]);
      }
      if (result.publications.length) {
        send([null, result.publications.map((entry) => ({...entry}))]);
      }
      node.status({
        fill: result.status.phase === "published" ? "green" : result.status.phase === "requested" ? "blue" : "grey",
        shape: result.status.phase === "idle" ? "ring" : "dot",
        text: result.status.text
      });
      return result;
    }

    onInput(node, (msg, send) => {
      process({
        topic: typeof msg.topic === "string" ? msg.topic : undefined,
        payload: msg.payload,
        retain: msg.retain === true,
        theatre: objectField<TheatreStateContractMessage["theatre"]>(msg, "theatre"),
        theatreStateContract: objectField<TheatreStateContractMessage["theatreStateContract"]>(msg, "theatreStateContract")
      }, send);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      done();
    });
  }

  RED.nodes.registerType("home-theatre-state-contract", HomeTheatreStateContract);
};

export = registerTheatreStateContract;
