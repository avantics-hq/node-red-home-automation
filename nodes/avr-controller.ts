"use strict";

import type {
  Node,
  NodeDef,
  NodeInitializer,
  NodeStatusFill,
  NodeStatusShape
} from "node-red";
import {
  normaliseAvrConfig,
  transitionAvr,
  type AvrConfig,
  type AvrMessage,
  type AvrState
} from "../lib/avr-controller";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";
import {jsonSetting, optionalBooleanSetting, optionalChoiceSetting} from "../lib/settings";
import {
  avrRetainedTopics,
  avrVolumeRequest,
  avrStartingOutputs,
  avrStateOutputs,
  avrStoppingOutputs,
  type AvrPublishingConfig
} from "../lib/avr-publishing";
import {ID_SCHEMES, discoveryPrefixSetting} from "../lib/ha-discovery";
import {publishingArea} from "../lib/topic-names";
import {publishingLifecycle} from "./publishing-lifecycle";

interface AvrControllerConfig extends NodeDef {
  area?: string;
  sources?: string;
  retryMs?: number | string;
  maxAttempts?: number | string;
  minVolume?: number | string;
  maxVolume?: number | string;
  publishState?: boolean | string | null;
  discovery?: boolean | string | null;
  discoveryPrefix?: string;
  idScheme?: string | null;
}

interface AvrControllerNode extends Node {}

type AvrStatus = ReturnType<typeof transitionAvr>["status"];

function parseSources(value: unknown): unknown {
  const sources = jsonSetting(value, "sources", {});
  if (!sources || Array.isArray(sources) || typeof sources !== "object") {
    throw new Error("sources must be a JSON object");
  }
  return sources;
}

const registerAvrController: NodeInitializer = (RED) => {
  function HomeAvrController(this: AvrControllerNode, config: AvrControllerConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    let controllerConfig: AvrConfig;
    let publishing: AvrPublishingConfig;
    try {
      // The same validation the reducer applies, so a bad configuration
      // fails here at deploy rather than on every message.
      controllerConfig = normaliseAvrConfig({...config, area: optionalArea(config), sources: parseSources(config.sources)});
      // Off unless switched on, as the receiver published nothing before;
      // there are no older entities to keep, so not set names them after
      // the node.
      const publishState = optionalBooleanSetting(config.publishState, "publish state") ?? false;
      const discovery = optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? false;
      if (publishState || discovery) publishingArea(controllerConfig.area, true);
      publishing = {
        area: controllerConfig.area,
        publishState,
        discovery,
        discoveryPrefix: discoveryPrefixSetting(config.discoveryPrefix),
        nodeId: node.id,
        idScheme: optionalChoiceSetting(config.idScheme, "ID scheme", ID_SCHEMES) ?? "node",
        minVolume: controllerConfig.minVolume,
        maxVolume: controllerConfig.maxVolume
      };
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    function updateStatus(status: AvrStatus) {
      const appearances: Record<string, {fill: NodeStatusFill; shape: NodeStatusShape}> = {
        discovering: {fill: "grey", shape: "ring"},
        idle: {fill: "grey", shape: "dot"},
        transitioning: {fill: "blue", shape: "dot"},
        ready: {fill: "green", shape: "dot"},
        manual_override: {fill: "yellow", shape: "ring"},
        failed: {fill: "red", shape: "ring"}
      };
      const appearance = appearances[status.phase] ?? {fill: "grey", shape: "ring"};
      node.status({...appearance, text: status.text});
    }

    function scheduleRetry(state: AvrState) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      if (!state.pending?.deadlineAt) return;
      const delay = Math.max(0, state.pending.deadlineAt - Date.now());
      retryTimer = setTimeout(guarded(node, () => {
        process({avr: {kind: "tick"}}, node.send.bind(node));
      }), delay);
    }

    function observed() {
      return (context.get("state") as Partial<AvrState> | undefined)?.observed;
    }

    // MQTT publications go on the third output, apart from the receiver's
    // commands and the theatre's events. Available, and clear of what it no
    // longer publishes, as soon as it runs; offline as it stops; nothing
    // left behind when deleted.
    const lifecycle = publishingLifecycle(RED, node, {
      retainedTopics: () => avrRetainedTopics(publishing),
      starting: () => avrStartingOutputs(publishing, observed()),
      stopping: () => avrStoppingOutputs(publishing),
      output: 2,
      outputs: 3
    });

    function process(msg: AvrMessage, send: Send) {
      const before = observed();
      const result = runReducer(node, {area: controllerConfig.area, component: "avr-controller"},
        (saved: Partial<AvrState> | undefined, now) => transitionAvr(saved, msg, controllerConfig, now));
      const commands = result.commands.map((command) => ({
        payload: Buffer.from(command.payload, "utf8"),
        avr_command: command.avrCommand
      }));
      const outputs = [...result.events, ...result.targetStates];
      if (commands.length || outputs.length) {
        send([
          commands.length ? commands : null,
          outputs.length
            ? outputs.map((event) => ({payload: undefined, ...event}))
            : null,
          null
        ]);
      }
      // Whatever it now observes differently from before.
      lifecycle.publish(send, avrStateOutputs(publishing, result.state.observed, before ?? {}));
      updateStatus(result.status);
      scheduleRetry(result.state);
      return result;
    }

    // Context survives a redeploy but timers do not. Recover a pending
    // transition with the reducer's own startup (re-observe, never replay)
    // rather than ticking old state; a later startup from the flow repeats it.
    if ((context.get("state") as Partial<AvrState> | undefined)?.pending) {
      retryTimer = setTimeout(guarded(node, () => {
        process({avr: {kind: "startup"}}, node.send.bind(node));
      }), 0);
    }

    // Each request from the volume number gets its own ID, as the receiver
    // answers a repeated ID only once.
    let volumeRequests = 0;

    onInput(node, (msg, send) => {
      const volume = avrVolumeRequest(msg, publishing);
      if (volume && "ignored" in volume) {
        runReducer(node, {area: controllerConfig.area, component: "avr-controller"}, (saved: Partial<AvrState> | undefined) =>
          ({state: saved, traces: [{event: "volume-set", outcome: "ignored", reason: volume.ignored, details: {payload: volume.payload}}]}));
        return;
      }
      if (volume) {
        volumeRequests += 1;
        process({avr: {kind: "volume", requestId: `mqtt-volume-${Date.now()}-${volumeRequests}`, mode: "absolute", value: volume.value}}, send);
        return;
      }
      if (objectField<AvrMessage["avr"]>(msg, "avr")?.kind === "startup") {
        lifecycle.startup(send, avrStartingOutputs(publishing, observed()));
      }
      process({
        avr: objectField<AvrMessage["avr"]>(msg, "avr"),
        payload: msg.payload
      }, send);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(retryTimer);
      done();
    });
  }

  RED.nodes.registerType("home-avr-controller", HomeAvrController);
};

export = registerAvrController;
