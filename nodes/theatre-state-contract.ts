"use strict";

import type {Node, NodeDef, NodeInitializer, NodeMessage} from "node-red";
import {appendTrace} from "../lib/bounded-trace";
import {
  normaliseStateContractConfig,
  transitionTheatreStateContract,
  type TheatreStateContractConfig,
  type TheatreStateContractMessage,
  type TheatreStateContractState
} from "../lib/theatre-state-contract";

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
type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;

const registerTheatreStateContract: NodeInitializer = (RED) => {
  function HomeTheatreStateContract(this: TheatreStateContractNode, config: TheatreStateContractNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();

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
      node.status({fill: "red", shape: "ring", text: "invalid state contract"});
      node.error(error);
      return;
    }

    function process(msg: TheatreStateContractMessage, send: Send) {
      const now = new Date();
      const saved = context.get("state") as Partial<TheatreStateContractState> | undefined;
      const result = transitionTheatreStateContract(saved, msg, controllerConfig, now);
      context.set("state", result.state);
      appendTrace(context, {
        area: controllerConfig.area,
        component: "theatre-state-contract"
      }, result.traces, now);
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

    node.on("input", (msg, send, done) => {
      try {
        process({
          topic: typeof msg.topic === "string" ? msg.topic : undefined,
          payload: msg.payload,
          retain: msg.retain === true,
          theatre: msg.theatre && typeof msg.theatre === "object"
            ? msg.theatre as TheatreStateContractMessage["theatre"]
            : undefined,
          theatreStateContract: msg.theatreStateContract && typeof msg.theatreStateContract === "object"
            ? msg.theatreStateContract as TheatreStateContractMessage["theatreStateContract"]
            : undefined
        }, send);
        done();
      } catch (error) {
        node.error(error, msg);
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      done();
    });
  }

  RED.nodes.registerType("home-theatre-state-contract", HomeTheatreStateContract);
};

export = registerTheatreStateContract;
