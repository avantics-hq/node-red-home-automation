"use strict";

import type {
  Node,
  NodeDef,
  NodeInitializer,
  NodeStatusFill,
  NodeStatusShape
} from "node-red";
import {
  REMOVED_VOLUME_VALUE,
  createAvrState,
  normaliseAvrConfig,
  transitionAvr,
  type AvrConfig,
  type AvrMessage,
  type AvrState
} from "../lib/avr-controller";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, type Send, type InputMessage} from "./adapter";
import {jsonSetting, optionalBooleanSetting, optionalChoiceSetting} from "../lib/settings";
import {
  avrRetainedTopics,
  VOLUME_SET_SETTLE_MS,
  avrVolumeRequest,
  avrStartingOutputs,
  avrStateOutputs,
  avrStoppingOutputs,
  receiverTopic,
  type AvrPublishingConfig
} from "../lib/avr-publishing";
import {ID_SCHEMES, discoveryPrefixSetting} from "../lib/ha-discovery";
import {publishingArea} from "../lib/topic-names";
import {publishesState} from "../lib/publishing-node";
import {brokerSetting, publishingSide} from "./publishing-side";
import type {BrokerNode} from "./mqtt-broker-link";
import {publishingChoice} from "../lib/home-assistant-setting";

interface AvrControllerConfig extends NodeDef {
  area?: string;
  sources?: string;
  retryMs?: number | string;
  maxAttempts?: number | string;
  minVolumeDb?: number | string;
  maxVolumeDb?: number | string;
  // Before 5.0, in the receiver's own 0-98, removed in 6.0: present without
  // the dB ones, an invalid configuration.
  minVolume?: number | string;
  maxVolume?: number | string;
  // Publish: off, state or discovery; not set: from publishState and
  // discovery, which it replaced.
  homeAssistant?: string | null;
  // Node-RED's mqtt-broker node, to publish and read its set topic itself.
  broker?: string;
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
    let broker: BrokerNode | null;
    try {
      // The same validation the reducer applies, so a bad configuration
      // fails here at deploy rather than on every message.
      controllerConfig = normaliseAvrConfig({...config, area: optionalArea(config), sources: parseSources(config.sources)});
      // Off unless switched on, as the receiver published nothing before;
      // there are no older entities to keep, so not set names them after
      // the node.
      const publish = publishingChoice(config, {publishState: false, discovery: false});
      if (publish.needsArea) publishingArea(controllerConfig.area, true);
      broker = brokerSetting(RED, config.broker, publish.publishState);
      publishing = {
        area: controllerConfig.area,
        publishState: publish.publishState,
        discovery: publish.discovery,
        discoveryPrefix: discoveryPrefixSetting(config.discoveryPrefix),
        nodeId: node.id,
        idScheme: optionalChoiceSetting(config.idScheme, "ID scheme", ID_SCHEMES) ?? "node",
        minVolumeDb: controllerConfig.minVolumeDb,
        maxVolumeDb: controllerConfig.maxVolumeDb
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

    // As the reducer restores it, so a state saved before 5.0 is published in dB.
    function observed() {
      const saved = context.get("state") as Partial<AvrState> | undefined;
      return saved ? createAvrState(controllerConfig, saved).observed : undefined;
    }

    // MQTT publications go on the third output, apart from the receiver's
    // commands and the theatre's events. Available, and clear of what it no
    // longer publishes, as soon as it runs; offline as it stops; nothing
    // left behind when deleted.
    const trace = {area: controllerConfig.area, component: "avr-controller"};
    const lifecycle = publishingSide(RED, node, broker, {
      retainedTopics: () => avrRetainedTopics(publishing),
      possible: {owner: publishing, topics: () => publishesState(publishing) ? avrRetainedTopics({...publishing, publishState: true, discovery: true}) : []},
      starting: () => avrStartingOutputs(publishing, observed()),
      stopping: () => avrStoppingOutputs(publishing),
      output: 2,
      outputs: 3,
      startupMessage: {avr: {kind: "startup"}},
      statusTopic: publishing.discovery ? publishing.discoveryPrefix + "/status" : null,
      setTopics: publishesState(publishing) ? [receiverTopic(publishing.area, "volume/set")] : []
    }, trace, (msg, send) => handle(msg, send));

    let warnedRemovedVolume = false;
    function process(msg: AvrMessage, send: Send) {
      const before = observed();
      const result = runReducer(node, {area: controllerConfig.area, component: "avr-controller"},
        (saved: Partial<AvrState> | undefined, now) => transitionAvr(saved, msg, controllerConfig, now));
      const commands = result.commands.map((command) => ({
        payload: Buffer.from(command.payload, "utf8"),
        avr_command: command.avrCommand
      }));
      // Once per deploy, so a flow still sending the receiver's own units is
      // told without filling the log.
      if (!warnedRemovedVolume && result.events.some(({avr}) => avr.kind === "volume_rejected" && avr.reason === REMOVED_VOLUME_VALUE)) {
        warnedRemovedVolume = true;
        node.warn("volume requests with value in the receiver's own 0-98 were removed in 6.0 and are rejected: " +
          "send valueDb (dB, where the receiver's 80 is 0 dB) instead");
      }
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

    // A pending transition is here only if the node's context survived its
    // stop, which needs a configured context store (see the README); timers
    // never survive. Recover it with the reducer's own startup (re-observe,
    // never replay) rather than ticking old state; a later startup from the
    // flow repeats it.
    if ((context.get("state") as Partial<AvrState> | undefined)?.pending) {
      retryTimer = setTimeout(guarded(node, () => {
        process({avr: {kind: "startup"}}, node.send.bind(node));
      }), 0);
    }

    // Each request from the volume number gets its own ID, as the receiver
    // answers a repeated ID only once. Sets arriving in a burst are settled
    // to the last one first.
    let volumeRequests = 0;
    let volumeSetTimer: ReturnType<typeof setTimeout> | undefined;

    function requestVolume(valueDb: number) {
      volumeRequests += 1;
      process({avr: {kind: "volume", requestId: `mqtt-volume-${Date.now()}-${volumeRequests}`, mode: "absolute", valueDb}}, node.send.bind(node));
    }

    function handle(msg: InputMessage, send: Send) {
      const volume = avrVolumeRequest(msg, publishing);
      if (volume && "ignored" in volume) {
        runReducer(node, {area: controllerConfig.area, component: "avr-controller"}, (saved: Partial<AvrState> | undefined) =>
          ({state: saved, traces: [{event: "volume-set", outcome: "ignored", reason: volume.ignored, details: {payload: volume.payload}}]}));
        return;
      }
      if (volume) {
        clearTimeout(volumeSetTimer);
        volumeSetTimer = setTimeout(guarded(node, () => {
          volumeSetTimer = undefined;
          requestVolume(volume.valueDb);
        }), VOLUME_SET_SETTLE_MS);
        return;
      }
      if (objectField<AvrMessage["avr"]>(msg, "avr")?.kind === "startup") {
        lifecycle.startup(send, avrStartingOutputs(publishing, observed()));
      }
      process({
        avr: objectField<AvrMessage["avr"]>(msg, "avr"),
        payload: msg.payload
      }, send);
    }
    onInput(node, (msg, send) => {
      // With a broker, its set topic comes from the broker: an MQTT in or a
      // Status node still wired in changes nothing.
      if (!lifecycle.fromBroker(msg)) handle(msg, send);
    }, lifecycle.startupOption({avr: {kind: "startup"}}));

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(retryTimer);
      clearTimeout(volumeSetTimer);
      done();
    });
  }

  RED.nodes.registerType("home-avr-controller", HomeAvrController);
};

export = registerAvrController;
