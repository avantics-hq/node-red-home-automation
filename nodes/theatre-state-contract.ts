"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  normaliseStateContractConfig,
  theatreStartingPublications,
  theatreRetainedTopics,
  theatreStoppingPublications,
  transitionTheatreStateContract,
  type TheatreStateContractConfig,
  type TheatreStateContractMessage,
  type TheatreStateContractState
} from "../lib/theatre-state-contract";
import {publishingLifecycle} from "./publishing-lifecycle";
import {invalidConfig, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";
import {jsonSetting, numberSetting, optionalBooleanSetting, optionalChoiceSetting} from "../lib/settings";
import {ID_SCHEMES, discoveryPrefixSetting} from "../lib/ha-discovery";

interface TheatreStateContractNodeConfig extends NodeDef {
  idScheme?: string | null;
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
        nodeId: node.id,
        // Not set: a node saved before node IDs, which keeps its area-named
        // entities. The editor gives new nodes "node".
        idScheme: optionalChoiceSetting(config.idScheme, "ID scheme", ID_SCHEMES) ?? "area",
        area,
        // Optional, with documented meanings: an empty display name is the
        // area, and an empty base topic is home/<area>/theatre.
        displayName: config.displayName || area,
        baseTopic: config.baseTopic || "",
        // Not set (null, or absent from a flow saved before the setting)
        // means on, so an older flow keeps publishing discovery.
        discovery: optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? true,
        discoveryPrefix: discoveryPrefixSetting(config.discoveryPrefix),
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

    // Available, and clear of what it no longer publishes, as soon as it
    // runs; offline as it stops; nothing left behind when deleted.
    const lifecycle = publishingLifecycle(RED, node, {
      retainedTopics: () => theatreRetainedTopics(controllerConfig),
      possibleTopics: () => theatreRetainedTopics({...controllerConfig, discovery: true}),
      starting: () => theatreStartingPublications(controllerConfig),
      stopping: () => theatreStoppingPublications(controllerConfig),
      output: 1,
      outputs: 2
    });

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
      // The startup's own announcement comes from the contract's transition.
      if (objectField<TheatreStateContractMessage["theatreStateContract"]>(msg, "theatreStateContract")?.kind === "startup") {
        lifecycle.startup(send);
      }
      process({
        topic: typeof msg.topic === "string" ? msg.topic : undefined,
        payload: msg.payload,
        retain: msg.retain === true,
        theatre: objectField<TheatreStateContractMessage["theatre"]>(msg, "theatre"),
        theatreStateContract: objectField<TheatreStateContractMessage["theatreStateContract"]>(msg, "theatreStateContract")
      }, send);
    });

    // Available again as soon as this node runs, as after a redeploy of it
    // alone, rather than waiting for the flow's startup message.
  }

  RED.nodes.registerType("home-theatre-state-contract", HomeTheatreStateContract);
};

export = registerTheatreStateContract;
