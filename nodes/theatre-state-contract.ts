"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  normaliseStateContractConfig,
  transitionTheatreStateContract,
  type TheatreStateContractConfig,
  type TheatreStateContractMessage,
  type TheatreStateContractState
} from "../lib/theatre-state-contract";
import {invalidConfig, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";
import {jsonSetting, numberSetting, optionalBooleanSetting, textSetting} from "../lib/settings";

interface TheatreStateContractNodeConfig extends NodeDef {
  area?: string;
  discovery?: boolean | string;
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
    // Needed for discovery and for the default base topic; the normaliser
    // says "area is required" when it is.
    const area = optionalArea(config);

    let controllerConfig: TheatreStateContractConfig;
    try {
      const activities = jsonSetting(config.activities, "activities", []);
      controllerConfig = normaliseStateContractConfig({
        area,
        // Optional, with documented meanings: an empty display name is the
        // area, and an empty base topic is home/<area>/theatre.
        displayName: config.displayName || area,
        baseTopic: config.baseTopic || "",
        // Not set (null, or absent from a flow saved before the setting)
        // means on, so an older flow keeps publishing discovery.
        discovery: optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? true,
        discoveryPrefix: textSetting(config.discoveryPrefix, "discovery prefix", "homeassistant"),
        activities: (Array.isArray(activities) ? activities.map(String) : activities) as string[],
        slo: {
          windowSize: numberSetting(config.sloWindowSize, "SLO window", 20),
          minimumSamples: numberSetting(config.sloMinimumSamples, "minimum samples", 5),
          latencyBudgetMs: numberSetting(config.sloLatencyBudgetMs, "latency budget", 60000),
          successObjectivePct: numberSetting(config.sloSuccessObjectivePct, "success objective", 95)
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
