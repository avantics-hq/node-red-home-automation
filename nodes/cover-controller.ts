"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {COVER_TYPES, openCloseCover, positionCover, type CoverModel} from "../lib/cover-models";
import {coverPresets, coverRequest, type CoverPresets} from "../lib/cover-requests";
import {optionalChoiceSetting} from "../lib/settings";
import {targetStateEvent} from "../lib/target-state";
import {REQUEST_ID} from "../lib/topic-names";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";

interface CoverControllerConfig extends NodeDef {
  area?: string;
  coverType?: string | null;
  travelMs?: number | string;
  marginMs?: number | string;
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

    let model: CoverModel;
    let presets: CoverPresets;
    let area: string;
    try {
      area = optionalArea(config);
      // Not set: a position cover, as every cover node was before the type.
      const type = optionalChoiceSetting(config.coverType, "cover type", COVER_TYPES) ?? "position";
      model = type === "open-close" ? openCloseCover(config as unknown as Record<string, unknown>) : positionCover(config as unknown as Record<string, unknown>);
      presets = coverPresets(config.presets);
    } catch (error) {
      invalidConfig(node, error);
      return;
    }
    const trace = {area, component: "cover-controller"};

    function saved(): {pending?: unknown} | undefined {
      return context.get("state") as {pending?: unknown} | undefined;
    }

    function schedule(state: unknown) {
      clearTimeout(timer);
      timer = undefined;
      const next = model.tickAt(state);
      if (!next) return;
      timer = setTimeout(guarded(node, () => {
        process({kind: "tick", generation: next.generation}, node.send.bind(node));
      }), Math.max(0, next.at - Date.now()));
    }

    function process(event: unknown, send: Send) {
      const wasMoving = model.moving(saved());
      const result = runReducer(node, trace, (state: unknown, now) => model.transition(state, event, now));
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
      const {phase, battery} = result.status;
      node.status({
        fill: phase === "failed" ? "red" : phase === "unavailable" || phase === "unconfirmed" ? "grey"
          : phase === "manual_override" ? "yellow" : moving ? "blue" : "green",
        shape: result.status.observed ? "dot" : "ring",
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
      const cover = objectField<Record<string, unknown>>(msg, "cover");
      if (cover) {
        process(cover, send);
        return;
      }
      requests += 1;
      // A cover group's own ID for its request, so it can match the answer.
      // Only msg.coverRequestId is read, in the request ID format.
      const callerId = typeof msg.coverRequestId === "string" && REQUEST_ID.test(msg.coverRequestId) ? msg.coverRequestId : null;
      const current = saved();
      const request = coverRequest(
        {payload: msg.payload, respectManual: msg.respectManual, stopIfMoving: msg.stopIfMoving, source: msg.source},
        presets,
        {requestId: callerId ?? `cover-${Date.now()}-${requests}`, generation: model.generation(current) + 1},
        model.moving(current)
      );
      const invalid = "invalid" in request ? request.invalid
        : request.intent.kind === "set_position" && !model.positions ? "position-not-supported"
        : null;
      if (invalid) {
        runReducer(node, trace, (state: unknown) =>
          ({state, traces: [{event: "request", outcome: "ignored", reason: invalid, details: {payload: msg.payload}}]}));
        // A caller waiting on this request hears why nothing happened.
        if (callerId) {
          send([null, {payload: undefined, theatre: targetStateEvent({
            target: "cover",
            requestId: callerId,
            generation: model.generation(current),
            status: "failed",
            observedAt: new Date().toISOString(),
            details: {request: msg.payload},
            failure: {reason: invalid}
          })}, null]);
        }
        return;
      }
      if ("intent" in request) process(request.intent, send);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(timer);
      // Whatever it paused shouldn't wait for a move this node no longer
      // follows. Best effort: it reaches nodes still running, as in a deploy
      // of this node alone.
      if (model.moving(saved())) node.send([null, null, {topic: "moving", payload: false}]);
      done();
    });
  }

  RED.nodes.registerType("home-cover-controller", HomeCoverController);
};

export = registerCoverController;
