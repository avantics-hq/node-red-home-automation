"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {ID_SCHEMES, discoveryPrefixSetting} from "../lib/ha-discovery";
import {publishesState} from "../lib/publishing-node";
import {normaliseSceneConfig, sceneTickAt, transitionScene, type SceneConfig, type SceneEvent, type SceneState} from "../lib/scene";
import {
  sceneInbound,
  sceneRetainedTopics,
  sceneStartingOutputs,
  sceneStateOutputs,
  sceneStoppingOutputs,
  type ScenePublishingConfig
} from "../lib/scene-publishing";
import {optionalBooleanSetting, optionalChoiceSetting, textSetting} from "../lib/settings";
import {areaId, publishingArea} from "../lib/topic-names";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, wasDeleted, whenFlowsStarted, type Send} from "./adapter";
import {publishingLifecycle} from "./publishing-lifecycle";

interface SceneNodeConfig extends NodeDef {
  lights?: string;
  safetyHours?: number | string;
  area?: string;
  publishState?: boolean | string | null;
  discovery?: boolean | string | null;
  discoveryPrefix?: string;
  idScheme?: string | null;
}

const registerScene: NodeInitializer = (RED) => {
  function HomeScene(this: Node, config: SceneNodeConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let timer: ReturnType<typeof setTimeout> | undefined;

    let scene: SceneConfig;
    let publishing: ScenePublishingConfig;
    let area: string;
    try {
      // No default: it names the scene to its rooms, motion policies and
      // Home Assistant.
      const name = textSetting(config.name, "name");
      if (!areaId(name)) throw new Error("name must contain a letter or digit");
      scene = normaliseSceneConfig({owner: "scene:" + name, lights: config.lights, safetyHours: config.safetyHours});
      area = optionalArea(config);
      const publishState = optionalBooleanSetting(config.publishState, "publish state") ?? false;
      const discovery = optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? false;
      if (publishState || discovery) publishingArea(area, true);
      publishing = {
        area,
        name,
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
    const trace = {area, component: "scene"};
    const saved = () => context.get("state") as Partial<SceneState> | undefined;
    const active = () => saved()?.active === true;

    // MQTT publications on output 3: its switch, available and clear of
    // what it no longer publishes once the flows have started, offline as
    // it stops, nothing left behind when deleted.
    const lifecycle = publishingLifecycle(RED, node, {
      retainedTopics: () => sceneRetainedTopics(publishing),
      possible: {owner: publishing, topics: () => publishesState(publishing) ? sceneRetainedTopics({...publishing, discovery: true}) : []},
      starting: () => sceneStartingOutputs(publishing, active()),
      stopping: () => sceneStoppingOutputs(publishing),
      output: 2,
      outputs: 3
    });

    function process(event: SceneEvent, send: Send) {
      const wasActive = active();
      const result = runReducer(node, trace, (state: Partial<SceneState> | undefined, now) => transitionScene(state, {scene: event}, scene, now));
      // Owner intents and releases for room controllers on output 1, owner
      // pauses for motion policies on output 2.
      if (result.lighting.length || result.motion.length) {
        send([result.lighting.length ? result.lighting : null, result.motion.length ? result.motion : null, null] as Parameters<Send>[0]);
      }
      if (result.state.active !== wasActive) lifecycle.publish(send, sceneStateOutputs(publishing, result.state.active));
      node.status(result.status as Parameters<Node["status"]>[0]);
      clearTimeout(timer);
      const at = sceneTickAt(result.state, Date.now());
      timer = at === null ? undefined : setTimeout(guarded(node, () => process({kind: "tick"}, node.send.bind(node))), Math.max(0, at - Date.now()));
    }

    // A scene on when the flows stopped is still on: renew its pause and its
    // timer, or end it if its time ran out meanwhile.
    whenFlowsStarted(RED, node, () => process({kind: "startup"}, node.send.bind(node)));

    onInput(node, (msg, send) => {
      const event = objectField<SceneEvent>(msg, "scene");
      if (event) {
        if (event.kind === "startup") lifecycle.startup(send, sceneStartingOutputs(publishing, active()));
        process(event, send);
        return;
      }
      // Home Assistant's switch, on the scene's set topic.
      const inbound = sceneInbound(msg, publishing);
      if (inbound?.kind) {
        process(inbound.kind === "end" ? {kind: "end", by: "home-assistant"} : {kind: "start"}, send);
      } else if (inbound) {
        runReducer(node, trace, (state: unknown) => ({state, traces: inbound.traces}));
      } else {
        runReducer(node, trace, (state: unknown) => ({state, traces: [{event: "input", outcome: "ignored", reason: "not-a-scene-message", details: {}}]}));
      }
    }, {message: {scene: {kind: "startup"}}, trace});

    node.on("close", (removed: boolean, done: () => void) => {
      clearTimeout(timer);
      // Deleted while on: let its lights and motion go. Best effort: it
      // reaches nodes still running, as in a deploy of modified nodes.
      if (wasDeleted(RED, node, removed) && active()) process({kind: "end", by: "deleted"}, node.send.bind(node));
      done();
    });
  }

  RED.nodes.registerType("home-scene", HomeScene);
};

export = registerScene;
