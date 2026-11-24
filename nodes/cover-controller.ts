"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  coverMoving,
  normaliseCoverConfig,
  transitionCover,
  type CoverConfig,
  type CoverEvent,
  type CoverState
} from "../lib/cover-controller";
import {coverPresets, coverRequest, type CoverPresets} from "../lib/cover-requests";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";

interface CoverControllerConfig extends NodeDef {
  area?: string;
  presets?: string;
  positionTolerance?: number | string;
  invert?: boolean | string;
  travelTimeoutMs?: number | string;
  maxAttempts?: number | string;
  pollMs?: number | string;
  settleMs?: number | string;
}

interface CoverControllerNode extends Node {}

const registerCoverController: NodeInitializer = (RED) => {
  function HomeCoverController(this: CoverControllerNode, config: CoverControllerConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requests = 0;

    let coverConfig: CoverConfig;
    let presets: CoverPresets;
    let area: string;
    try {
      area = optionalArea(config);
      coverConfig = normaliseCoverConfig(config);
      presets = coverPresets(config.presets);
    } catch (error) {
      invalidConfig(node, error);
      return;
    }
    const trace = {area, component: "cover-controller"};

    function saved(): Partial<CoverState> | undefined {
      return context.get("state") as Partial<CoverState> | undefined;
    }

    function schedule(state: CoverState) {
      clearTimeout(timer);
      timer = undefined;
      if (!state.pending) return;
      const generation = state.generation;
      const at = Math.min(state.pending.nextAt, state.pending.deadlineAt);
      timer = setTimeout(guarded(node, () => {
        process({kind: "tick", generation}, node.send.bind(node));
      }), Math.max(0, at - Date.now()));
    }

    function process(event: CoverEvent, send: Send) {
      const before = saved();
      const wasMoving = before ? coverMoving({observed: before.observed ?? null, phase: before.phase ?? "idle"}) : false;
      const result = runReducer(node, trace, (state: Partial<CoverState> | undefined, now) => transitionCover(state, {cover: event}, coverConfig, now));
      const moving = result.status.moving;
      // Device commands in a neutral shape on output 1, state and results
      // (including the theatre's target state) on output 2, and whether the
      // cover is moving on output 3, whenever that changes.
      const outputs = [
        result.commands.length ? result.commands.map((command) => ({payload: {...command}, cover_command: command})) : null,
        result.events.length ? result.events.map((entry) => ({payload: undefined, ...entry})) : null,
        moving !== wasMoving ? {topic: "moving", payload: moving} : null
      ];
      if (outputs.some((output) => output !== null)) send(outputs);
      const battery = result.state.observed?.battery;
      node.status({
        fill: result.state.phase === "failed" ? "red" : result.state.phase === "unavailable" ? "grey"
          : result.state.phase === "manual_override" ? "yellow" : moving ? "blue" : "green",
        shape: result.state.observed ? "dot" : "ring",
        text: result.status.text + (typeof battery === "number" ? ` · battery ${battery}%` : "")
      });
      schedule(result.state);
      return result;
    }

    // Context survives a redeploy but timers do not: re-observe a move in
    // flight rather than trusting the old state.
    if (saved()?.pending) {
      timer = setTimeout(guarded(node, () => {
        process({kind: "startup"}, node.send.bind(node));
      }), 0);
    }

    onInput(node, (msg, send) => {
      const cover = objectField<CoverEvent>(msg, "cover");
      if (cover) {
        process(cover, send);
        return;
      }
      requests += 1;
      const current = saved();
      const request = coverRequest(
        {payload: msg.payload, respectManual: msg.respectManual, stopIfMoving: msg.stopIfMoving, source: msg.source},
        presets,
        {requestId: `cover-${Date.now()}-${requests}`, generation: (current?.generation ?? 0) + 1},
        current ? coverMoving({observed: current.observed ?? null, phase: current.phase ?? "idle"}) : false
      );
      if ("invalid" in request) {
        runReducer(node, trace, (state: Partial<CoverState> | undefined) =>
          ({state, traces: [{event: "request", outcome: "ignored", reason: request.invalid, details: {payload: msg.payload}}]}));
        return;
      }
      process(request.intent, send);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(timer);
      done();
    });
  }

  RED.nodes.registerType("home-cover-controller", HomeCoverController);
};

export = registerCoverController;
