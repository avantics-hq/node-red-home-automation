"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  transitionOccupancy,
  type OccupancyConfig,
  type OccupancyInput,
  type OccupancyState
} from "../lib/occupancy-fusion";
import {
  occupancyRetainedTopics,
  occupancyStartingOutputs,
  occupancyStateOutputs,
  occupancyStoppingOutputs,
  type OccupancyPublishingConfig
} from "../lib/occupancy-publishing";
import {ID_SCHEMES, discoveryPrefixSetting} from "../lib/ha-discovery";
import {optionalBooleanSetting, optionalChoiceSetting, textSetting} from "../lib/settings";
import {publishingArea} from "../lib/topic-names";
import {invalidConfig, onInput, optionalArea, runReducer} from "./adapter";
import {publishesState} from "../lib/publishing-node";
import {publishingLifecycle} from "./publishing-lifecycle";

interface OccupancyFusionConfig extends NodeDef {
  area?: string;
  presenceMode?: "hold" | "none";
  publishState?: boolean | string | null;
  discovery?: boolean | string | null;
  discoveryPrefix?: string;
  idScheme?: string | null;
}

type OccupancyStatus = ReturnType<typeof transitionOccupancy>["status"];

interface OccupancyFusionNode extends Node {}

const registerOccupancyFusion: NodeInitializer = (RED) => {
  function HomeOccupancyFusion(this: OccupancyFusionNode, config: OccupancyFusionConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let fusionConfig: OccupancyConfig & {area: string};
    let publishing: OccupancyPublishingConfig;
    try {
      // The editor offers "none" (PIR only) and "hold" (PIR plus presence).
      const presence = textSetting(config.presenceMode, "presence sensor", "none");
      if (presence !== "none" && presence !== "hold") throw new Error("presence sensor must be none or hold");
      const area = optionalArea(config);
      fusionConfig = {area, presenceMode: presence === "hold" ? "hold" : "ignore"};
      // Off unless switched on, as occupancy published nothing before; there
      // are no older entities to keep, so not set names them after the node.
      const publishState = optionalBooleanSetting(config.publishState, "publish state") ?? false;
      const discovery = optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? false;
      if (publishState || discovery) publishingArea(area, true);
      publishing = {
        area,
        publishState,
        discovery,
        discoveryPrefix: discoveryPrefixSetting(config.discoveryPrefix),
        nodeId: node.id,
        idScheme: optionalChoiceSetting(config.idScheme, "ID scheme", ID_SCHEMES) ?? "node"
      };
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    function updateStatus(status: OccupancyStatus) {
      const details = [status.occupied ? "occupied" : "vacant"];
      if (status.motion !== null) details.push("pir " + (status.motion ? "on" : "off"));
      if (status.presence !== null) details.push("presence " + (status.presence ? "on" : "off"));
      node.status({
        fill: status.occupied ? "green" : "grey",
        shape: "dot",
        text: details.join(" · ")
      });
    }

    function occupied(): boolean {
      return (node.context().get("state") as Partial<OccupancyState> | undefined)?.occupied === true;
    }

    // MQTT publications go on the second output, away from the occupancy
    // events the motion policy reads on the first. Available, and clear of
    // what it no longer publishes, as soon as it runs; offline as it stops;
    // nothing left behind when deleted.
    const lifecycle = publishingLifecycle(RED, node, {
      retainedTopics: () => occupancyRetainedTopics(publishing),
      possible: {owner: publishing, topics: () => publishesState(publishing) ? occupancyRetainedTopics({...publishing, publishState: true, discovery: true}) : []},
      starting: () => occupancyStartingOutputs(publishing, occupied()),
      stopping: () => occupancyStoppingOutputs(publishing),
      output: 1,
      outputs: 2
    });

    onInput(node, (msg, send) => {
      if (msg.source === "startup") {
        lifecycle.startup(send, occupancyStartingOutputs(publishing, occupied()));
        return;
      }
      const input: OccupancyInput = {
        source: String(msg.source ?? ""),
        payload: msg.payload
      };
      const result = runReducer(node, {area: fusionConfig.area, component: "occupancy-fusion"},
        (saved: Partial<OccupancyState> | undefined) => transitionOccupancy(saved, input, fusionConfig));
      for (const output of result.outputs) {
        send([{...output, payload: output.payload}, null]);
        lifecycle.publish(send, occupancyStateOutputs(publishing, output.payload.occupied));
      }
      updateStatus(result.status);
    });

  }

  RED.nodes.registerType("home-occupancy-fusion", HomeOccupancyFusion);
};

export = registerOccupancyFusion;
