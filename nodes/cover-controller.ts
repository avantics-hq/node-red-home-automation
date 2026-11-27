"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {COVER_TYPES, openCloseCover, positionCover, type CoverModel} from "../lib/cover-models";
import {
  coverInbound,
  coverRetainedTopics,
  coverStartingOutputs,
  coverStateOutputs,
  coverStoppingOutputs,
  type CoverPublishingConfig
} from "../lib/cover-publishing";
import {coverPresets, coverRequest, type CoverPresets} from "../lib/cover-requests";
import {ID_SCHEMES, discoveryPrefixSetting} from "../lib/ha-discovery";
import {publishesState} from "../lib/publishing-node";
import {optionalBooleanSetting, optionalChoiceSetting, textSetting} from "../lib/settings";
import {targetStateEvent} from "../lib/target-state";
import {REQUEST_ID, areaId, publishingArea} from "../lib/topic-names";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, type InputMessage, type Send} from "./adapter";
import {publishingLifecycle} from "./publishing-lifecycle";

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
  topicName?: string;
  publishState?: boolean | string | null;
  discovery?: boolean | string | null;
  discoveryPrefix?: string;
  idScheme?: string | null;
}

interface CoverControllerNode extends Node {}

// The cover's name in its topics, which it needs while it publishes.
function coverTopicName(value: unknown): string {
  const name = textSetting(value, "name in topics");
  if (!areaId(name)) throw new Error("name in topics must contain a letter or digit");
  return name;
}

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
    let publishing: CoverPublishingConfig;
    try {
      area = optionalArea(config);
      // Not set: a position cover, as every cover node was before the type.
      const type = optionalChoiceSetting(config.coverType, "cover type", COVER_TYPES) ?? "position";
      model = type === "open-close" ? openCloseCover(config as unknown as Record<string, unknown>) : positionCover(config as unknown as Record<string, unknown>);
      presets = coverPresets(config.presets);
      // Off unless switched on, as the cover published nothing before; not
      // set names its entity after the node.
      const publishState = optionalBooleanSetting(config.publishState, "publish state") ?? false;
      const discovery = optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? false;
      if (publishState || discovery) publishingArea(area, true);
      publishing = {
        area,
        // No default: two covers in a room must not share topics.
        name: publishState || discovery ? coverTopicName(config.topicName) : "",
        positions: model.positions,
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

    // MQTT publications on output 4, apart from the cover's own outputs:
    // available and clear of what it no longer publishes as soon as it runs,
    // offline as it stops, nothing left behind when deleted.
    const lifecycle = publishingLifecycle(RED, node, {
      retainedTopics: () => coverRetainedTopics(publishing),
      possible: {owner: publishing, topics: () => publishesState(publishing) ? coverRetainedTopics({...publishing, discovery: true}) : []},
      starting: () => coverStartingOutputs(publishing, model.view(saved())),
      stopping: () => coverStoppingOutputs(publishing),
      output: 3,
      outputs: 4
    });

    function process(event: unknown, send: Send) {
      const wasMoving = model.moving(saved());
      const viewBefore = JSON.stringify(model.view(saved()));
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
      // What Home Assistant shows, whenever it changes.
      const view = model.view(result.state);
      if (JSON.stringify(view) !== viewBefore) lifecycle.publish(send, coverStateOutputs(publishing, view));
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
        if (cover.kind === "startup") lifecycle.startup(send, coverStartingOutputs(publishing, model.view(saved())));
        process(cover, send);
        return;
      }
      // Home Assistant's open, close, stop and set position, on the cover's
      // own set topics, are requests like any other.
      const inbound = coverInbound(msg, publishing);
      if (inbound && inbound.request === null) {
        runReducer(node, trace, (state: unknown) => ({state, traces: inbound.traces}));
        return;
      }
      handleRequest(inbound ? {payload: inbound.request, source: "home-assistant"} as InputMessage : msg, send);
    }, {cover: {kind: "startup"}});

    function handleRequest(msg: InputMessage, send: Send) {
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
    }

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
