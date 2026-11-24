"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {DEFAULT_GROUP_DEADLINE_SECONDS, coverGroupMembers, transitionCoverGroup, type CoverGroupEvent, type CoverGroupState} from "../lib/cover-group";
import {numberSetting} from "../lib/settings";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";

interface CoverGroupConfig extends NodeDef {
  area?: string;
  members?: string;
  deadlineSeconds?: number | string;
}

const registerCoverGroup: NodeInitializer = (RED) => {
  function HomeCoverGroup(this: Node, config: CoverGroupConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let members: string[];
    let area: string;
    let deadlineSeconds: number;
    try {
      area = optionalArea(config);
      members = coverGroupMembers(config.members);
      deadlineSeconds = Math.max(1, numberSetting(config.deadlineSeconds, "answer deadline", DEFAULT_GROUP_DEADLINE_SECONDS));
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    const trace = {area, component: "cover-group"};
    let timer: ReturnType<typeof setTimeout> | undefined;

    function process(event: CoverGroupEvent, send: Send) {
      const result = runReducer(node, trace, (saved: Partial<CoverGroupState> | undefined, now) =>
        transitionCoverGroup(saved, event, members, now, deadlineSeconds));
      // The group's result on output 1, then one output per member, in the
      // order of Members, each with that member's request (msg.topic still
      // names it).
      const outputs = [
        result.events.length ? result.events.map((entry) => ({payload: undefined, ...entry})) : null,
        ...members.map((member) => {
          const request = result.commands.filter((command) => command.topic === member);
          return request.length ? request.map((command) => ({...command})) : null;
        })
      ];
      if (outputs.some((output) => output !== null)) send(outputs);
      node.status({
        fill: result.status.total && result.status.ready === result.status.total ? "green" : "blue",
        shape: "dot",
        text: result.status.text
      });
      // At the deadline, members that never answered count as not answering.
      clearTimeout(timer);
      timer = undefined;
      const request = result.state.request;
      if (request && !request.settled) {
        timer = setTimeout(guarded(node, () => process({kind: "tick"}, node.send.bind(node))), Math.max(0, request.deadlineAt - Date.now()));
      }
    }

    // Context survives a redeploy but timers do not: re-arm the deadline of
    // a request still open (an overdue one settles at the first tick).
    const open = (node.context().get("state") as Partial<CoverGroupState> | undefined)?.request;
    if (open && !open.settled && Number.isFinite(open.deadlineAt)) {
      timer = setTimeout(guarded(node, () => process({kind: "tick"}, node.send.bind(node))), Math.max(0, open.deadlineAt - Date.now()));
    }

    onInput(node, (msg, send) => {
      const theatre = objectField<{kind?: string; requestId?: string; status?: string; classification?: string; failure?: {reason?: string}}>(msg, "theatre");
      // A member's answer, from its cover node's second output. Anything else
      // a cover node sends (other state, its moving signal) is not a request.
      if (theatre?.kind === "target_state" && typeof theatre.requestId === "string") {
        process({kind: "member", requestId: theatre.requestId, status: String(theatre.status), classification: theatre.classification, reason: theatre.failure?.reason ?? null}, send);
        return;
      }
      if (theatre || msg.topic === "moving") {
        runReducer(node, trace, (state: Partial<CoverGroupState> | undefined) =>
          ({state, traces: [{event: "input", outcome: "ignored", reason: theatre ? "not-a-member-answer" : "moving-signal", details: {}}]}));
        return;
      }
      process({
        kind: "request",
        payload: msg.payload,
        stopIfMoving: msg.stopIfMoving === true,
        respectManual: msg.respectManual === true,
        source: typeof msg.source === "string" ? msg.source : undefined
      }, send);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(timer);
      done();
    });
  }

  RED.nodes.registerType("home-cover-group", HomeCoverGroup);
};

export = registerCoverGroup;
