"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {coverGroupMembers, transitionCoverGroup, type CoverGroupEvent, type CoverGroupState} from "../lib/cover-group";
import {invalidConfig, objectField, onInput, optionalArea, runReducer} from "./adapter";

interface CoverGroupConfig extends NodeDef {
  area?: string;
  members?: string;
}

const registerCoverGroup: NodeInitializer = (RED) => {
  function HomeCoverGroup(this: Node, config: CoverGroupConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let members: string[];
    let area: string;
    try {
      area = optionalArea(config);
      members = coverGroupMembers(config.members);
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    onInput(node, (msg, send) => {
      // A member's result, from its cover node's second output; anything
      // else is a request for the whole group.
      const theatre = objectField<{kind?: string; requestId?: string; status?: string; classification?: string; failure?: {reason?: string}}>(msg, "theatre");
      const event: CoverGroupEvent = theatre?.kind === "target_state" && typeof theatre.requestId === "string"
        ? {kind: "member", requestId: theatre.requestId, status: String(theatre.status), classification: theatre.classification, reason: theatre.failure?.reason ?? null}
        : {
          kind: "request",
          payload: msg.payload,
          stopIfMoving: msg.stopIfMoving === true,
          respectManual: msg.respectManual === true,
          source: typeof msg.source === "string" ? msg.source : undefined
        };
      const result = runReducer(node, {area, component: "cover-group"}, (saved: Partial<CoverGroupState> | undefined, now) =>
        transitionCoverGroup(saved, event, members, now));
      // One request per member on output 1, with msg.topic naming the member
      // for a switch node; the group's result on output 2.
      const outputs = [
        result.commands.length ? result.commands.map((command) => ({...command})) : null,
        result.events.length ? result.events.map((entry) => ({payload: undefined, ...entry})) : null
      ];
      if (outputs.some((output) => output !== null)) send(outputs);
      node.status({
        fill: result.status.total && result.status.ready === result.status.total ? "green" : "blue",
        shape: "dot",
        text: result.status.text
      });
    });
  }

  RED.nodes.registerType("home-cover-group", HomeCoverGroup);
};

export = registerCoverGroup;
