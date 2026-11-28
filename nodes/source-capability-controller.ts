"use strict";

import type {
  Node,
  NodeDef,
  NodeInitializer,
  NodeStatusFill,
  NodeStatusShape
} from "node-red";
import {
  normaliseConfig,
  transitionSource,
  type SourceConfig,
  type SourceMessage,
  type SourceState
} from "../lib/source-capability-controller";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";
import {jsonSetting} from "../lib/settings";

interface SourceControllerConfig extends NodeDef {
  area?: string;
  sources?: string;
  pollMs?: number | string;
  confirmationTimeoutMs?: number | string;
  maxAttempts?: number | string;
}

interface SourceControllerNode extends Node {}

type SourceStatus = ReturnType<typeof transitionSource>["status"];

const registerSourceCapabilityController: NodeInitializer = (RED) => {
  function HomeSourceCapabilityController(this: SourceControllerNode, config: SourceControllerConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let timer: ReturnType<typeof setTimeout> | undefined;

    let controllerConfig: SourceConfig;
    try {
      // Defaults and limits come from the reducer's own normalisation.
      controllerConfig = normaliseConfig({...config, sources: jsonSetting(config.sources, "sources", {})});
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    function updateStatus(status: SourceStatus) {
      const appearances: Record<string, {fill: NodeStatusFill; shape: NodeStatusShape}> = {
        idle: {fill: "grey", shape: "dot"},
        transitioning: {fill: "blue", shape: "dot"},
        confirming: {fill: "blue", shape: "ring"},
        waiting_for_source: {fill: "yellow", shape: "ring"},
        ready: {fill: "green", shape: "dot"},
        unavailable: {fill: "yellow", shape: "dot"},
        failed: {fill: "red", shape: "ring"}
      };
      const appearance = appearances[status.phase] ?? {fill: "grey", shape: "ring"};
      node.status({...appearance, text: status.text});
    }

    function schedule(state: SourceState) {
      clearTimeout(timer);
      timer = undefined;
      if (!state.pending?.nextAt) return;
      const delay = Math.max(0, state.pending.nextAt - Date.now());
      timer = setTimeout(guarded(node, () => {
        process({sourceCapability: {kind: "tick", generation: state.generation}}, node.send.bind(node));
      }), delay);
    }

    function process(msg: SourceMessage, send: Send) {
      const result = runReducer(node, {area: optionalArea(config), component: "source-capability-controller"},
        (saved: Partial<SourceState> | undefined, now) => transitionSource(saved, msg, controllerConfig, now));
      if (result.commands.length) {
        send([
          result.commands.map((sourceCommand) => ({payload: undefined, sourceCommand})),
          null
        ]);
      }
      const theatre = [...result.events, ...result.observations];
      if (theatre.length) {
        send([null, theatre.map((event) => ({payload: undefined, ...event}))]);
      }
      updateStatus(result.status);
      schedule(result.state);
      return result;
    }

    // A pending transition is here only if the node's context survived its
    // stop, which needs a configured context store (see the README); timers
    // never survive. Recover it with the reducer's own startup (re-observe,
    // never replay) rather than ticking old state; a later startup from the
    // flow repeats it.
    if ((context.get("state") as Partial<SourceState> | undefined)?.pending) {
      timer = setTimeout(guarded(node, () => {
        process({sourceCapability: {kind: "startup"}}, node.send.bind(node));
      }), 0);
    }

    onInput(node, (msg, send) => {
      process({
        sourceCapability: objectField<SourceMessage["sourceCapability"]>(msg, "sourceCapability")
      }, send);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(timer);
      done();
    });
  }

  RED.nodes.registerType("home-source-capability-controller", HomeSourceCapabilityController);
};

export = registerSourceCapabilityController;
