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
import {clearStaleRetained, invalidConfig, whenFlowsStarted, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";
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
      if (objectField<TheatreStateContractMessage["theatreStateContract"]>(msg, "theatreStateContract")?.kind === "startup") {
        const clears = clearStaleRetained(node, theatreRetainedTopics(controllerConfig));
        if (clears.length) send([null, clears.map((clear) => ({...clear}))]);
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
    whenFlowsStarted(RED, node, () => {
      const clears = clearStaleRetained(node, theatreRetainedTopics(controllerConfig), "flows-started");
      node.send([null, [...clears, ...theatreStartingPublications(controllerConfig)].map((entry) => ({...entry}))]);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      // Reaches the broker only if the MQTT out node is still running, as in a
      // deploy of this node alone; the broker's own Close and Will messages
      // cover a full deploy, a restart and a crash (see the README).
      node.send([null, theatreStoppingPublications(controllerConfig).map((entry) => ({...entry}))]);
      done();
    });
  }

  RED.nodes.registerType("home-theatre-state-contract", HomeTheatreStateContract);
};

export = registerTheatreStateContract;
