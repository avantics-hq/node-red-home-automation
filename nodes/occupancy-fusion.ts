"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  transitionOccupancy,
  type OccupancyConfig,
  type OccupancyInput,
  type OccupancyState
} from "../lib/occupancy-fusion";
import {invalidConfig, onInput, optionalArea, runReducer} from "./adapter";
import {textSetting} from "../lib/settings";

interface OccupancyFusionConfig extends NodeDef {
  area?: string;
  presenceMode?: "hold" | "none";
}

type OccupancyStatus = ReturnType<typeof transitionOccupancy>["status"];

interface OccupancyFusionNode extends Node {}

const registerOccupancyFusion: NodeInitializer = (RED) => {
  function HomeOccupancyFusion(this: OccupancyFusionNode, config: OccupancyFusionConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let fusionConfig: OccupancyConfig & {area: string};
    try {
      // The editor offers "none" (PIR only) and "hold" (PIR plus presence).
      const presence = textSetting(config.presenceMode, "presence sensor", "none");
      if (presence !== "none" && presence !== "hold") throw new Error("presence sensor must be none or hold");
      fusionConfig = {area: optionalArea(config), presenceMode: presence === "hold" ? "hold" : "ignore"};
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

    onInput(node, (msg, send) => {
      const input: OccupancyInput = {
        source: String(msg.source ?? ""),
        payload: msg.payload
      };
      const result = runReducer(node, {area: fusionConfig.area, component: "occupancy-fusion"},
        (saved: Partial<OccupancyState> | undefined) => transitionOccupancy(saved, input, fusionConfig));
      for (const output of result.outputs) send({...output, payload: output.payload});
      updateStatus(result.status);
    });
  }

  RED.nodes.registerType("home-occupancy-fusion", HomeOccupancyFusion);
};

export = registerOccupancyFusion;
