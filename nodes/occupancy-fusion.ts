"use strict";

import type {Node, NodeDef, NodeInitializer, NodeMessage} from "node-red";
import {appendTrace} from "../lib/bounded-trace";
import {
  transitionOccupancy,
  type OccupancyConfig,
  type OccupancyInput,
  type OccupancyState
} from "../lib/occupancy-fusion";

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
    const context = node.context();
    const fusionConfig: OccupancyConfig & {area: string} = {
      area: config.area || "room",
      presenceMode: config.presenceMode === "hold" ? "hold" : "ignore"
    };

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

    node.on("input", (msg, send, done) => {
      try {
        const now = new Date();
        const saved = context.get("state") as Partial<OccupancyState> | undefined;
        const input: OccupancyInput = {
          source: String(msg.source ?? ""),
          payload: msg.payload
        };
        const result = transitionOccupancy(saved, input, fusionConfig);
        context.set("state", result.state);
        appendTrace(context, {
          area: fusionConfig.area,
          component: "occupancy-fusion"
        }, result.traces, now);
        for (const output of result.outputs) send({...output, payload: output.payload});
        updateStatus(result.status);
        done();
      } catch (error) {
        node.error(error, msg);
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  RED.nodes.registerType("home-occupancy-fusion", HomeOccupancyFusion);
};

export = registerOccupancyFusion;
