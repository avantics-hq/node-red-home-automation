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
  type OccupancyPublication,
  type OccupancyPublishingConfig
} from "../lib/occupancy-publishing";
import {ID_SCHEMES, discoveryPrefixSetting} from "../lib/ha-discovery";
import {retainedClears} from "../lib/retained-topics";
import {optionalBooleanSetting, optionalChoiceSetting, textSetting} from "../lib/settings";
import {publishingArea} from "../lib/topic-names";
import {
  allRetainedTopics,
  clearStaleRetained,
  invalidConfig,
  onInput,
  optionalArea,
  runReducer,
  wasDeleted,
  whenFlowsStarted
} from "./adapter";

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

    // MQTT publications go on the second output, away from the occupancy
    // events the motion policy reads on the first.
    function publish(send: (msg: unknown) => void, publications: OccupancyPublication[]) {
      if (publications.length) send([null, publications.map((entry) => ({...entry}))]);
    }

    function occupied(): boolean {
      return (node.context().get("state") as Partial<OccupancyState> | undefined)?.occupied === true;
    }

    // Once the flows have started, and again at a startup message: clear
    // what the node no longer publishes, then announce it.
    whenFlowsStarted(RED, node, () => {
      publish((msg) => node.send(msg as never), [
        ...clearStaleRetained(node, occupancyRetainedTopics(publishing), "flows-started"),
        ...occupancyStartingOutputs(publishing, occupied())
      ]);
    });

    onInput(node, (msg, send) => {
      if (msg.source === "startup") {
        publish(send as (msg: unknown) => void, [
          ...clearStaleRetained(node, occupancyRetainedTopics(publishing)),
          ...occupancyStartingOutputs(publishing, occupied())
        ]);
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
        publish(send as (msg: unknown) => void, occupancyStateOutputs(publishing, output.payload.occupied));
      }
      updateStatus(result.status);
    });

    node.on("close", (removed: boolean, done: () => void) => {
      // Reaches the broker only if the MQTT out node is still running, as in
      // a deploy of modified nodes or flows (see the README). A deleted node
      // removes its entity and retained state instead.
      publish((msg) => node.send(msg as never), wasDeleted(RED, node, removed)
        ? retainedClears(allRetainedTopics(node, occupancyRetainedTopics(publishing))) as OccupancyPublication[]
        : occupancyStoppingOutputs(publishing));
      done();
    });
  }

  RED.nodes.registerType("home-occupancy-fusion", HomeOccupancyFusion);
};

export = registerOccupancyFusion;
