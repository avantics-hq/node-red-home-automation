"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  normaliseMotionConfig,
  transitionMotion,
  type MotionConfig,
  type MotionInput,
  type MotionState
} from "../lib/motion-policy";
import {
  motionInbound,
  motionRetainedTopics,
  motionStartingOutputs,
  motionStateOutputs,
  motionStoppingOutputs,
  type MotionPublication,
  type MotionPublishingConfig
} from "../lib/motion-publishing";
import {ID_SCHEMES, discoveryPrefixSetting} from "../lib/ha-discovery";
import {optionalBooleanSetting, optionalChoiceSetting} from "../lib/settings";
import {publishingArea} from "../lib/topic-names";
import {guarded, invalidConfig, onInput, optionalArea, runReducer, type Send} from "./adapter";
import {publishingLifecycle} from "./publishing-lifecycle";

interface MotionPolicyConfig extends NodeDef {
  area?: string;
  onTargets?: string;
  offTargets?: string;
  defaultDelaySeconds?: number | string;
  defaultIlluminanceCutoff?: number | string;
  publishState?: boolean | string | null;
  discovery?: boolean | string | null;
  discoveryPrefix?: string;
  idScheme?: string | null;
}

interface MotionPolicyNode extends Node {}

type MotionStatus = ReturnType<typeof transitionMotion>["status"];


const registerMotionPolicy: NodeInitializer = (RED) => {
  function HomeMotionLightingPolicy(this: MotionPolicyNode, config: MotionPolicyConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    const globalContext = context.global;
    let offTimer: ReturnType<typeof setTimeout> | undefined;

    let policyConfig: MotionConfig & {area: string};
    let publishing: MotionPublishingConfig;
    try {
      const area = optionalArea(config);
      policyConfig = {area, ...normaliseMotionConfig(config)};
      // Off unless switched on, as motion published nothing before; there are
      // no older entities to keep, so not set names them after the node.
      const publishState = optionalBooleanSetting(config.publishState, "publish state") ?? false;
      const discovery = optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? false;
      if (publishState || discovery) publishingArea(area, true);
      publishing = {
        area,
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

    function updateStatus(status: MotionStatus) {
      node.status({
        fill: status.enabled ? "green" : "grey",
        shape: "dot",
        text: (status.enabled ? "enabled" : "disabled") + " · " +
          (status.illuminance === null ? "lux ?" : status.illuminance + " lux") + " · " +
          status.delaySeconds + "s"
      });
    }

    function armOffTimer(delayMs: number, generation: number) {
      clearTimeout(offTimer);
      offTimer = setTimeout(guarded(node, () => {
        offTimer = undefined;
        process({source: "off-timer", generation}, node.send.bind(node));
      }), delayMs);
    }

    // MQTT publications go on the second output, away from the lighting
    // intents the room controller reads on the first.
    function publish(send: Send, publications: MotionPublication[]) {
      if (publications.length) send([null, publications.map((entry) => ({...entry}))]);
    }

    function savedPolicyState() {
      const saved = context.get("state") as Partial<MotionState> | undefined;
      return {areaEnabled: saved?.areaEnabled !== false, delaySeconds: saved?.delaySeconds ?? policyConfig.defaultDelaySeconds};
    }

    // Available, and clear of what it no longer publishes, as soon as it
    // runs; offline as it stops; nothing left behind when deleted.
    const lifecycle = publishingLifecycle(RED, node, {
      retainedTopics: () => motionRetainedTopics(publishing),
      starting: () => motionStartingOutputs(publishing, savedPolicyState()),
      stopping: () => motionStoppingOutputs(publishing),
      output: 1,
      outputs: 2
    });

    function process(input: MotionInput, send: Send, inboundTraces: ReturnType<typeof motionInbound> = null) {
      const globalEnabled = globalContext.get("MOTION_ENABLED_STATE") !== false;
      const result = runReducer(node, {area: policyConfig.area, component: "motion-policy"},
        (saved: Partial<MotionState> | undefined, now) => {
          const decided = transitionMotion(saved, input, policyConfig, globalEnabled, now.getTime());
          return {...decided, traces: [...(inboundTraces?.traces ?? []), ...decided.traces]};
        });
      if (input.source === "global-enabled") {
        globalContext.set("MOTION_ENABLED_STATE", result.globalEnabled);
      }

      for (const effect of result.effects) {
        if (effect.kind === "cancel-off-timer") {
          clearTimeout(offTimer);
          offTimer = undefined;
        } else if (effect.kind === "schedule-off-timer") {
          armOffTimer(effect.delayMs, effect.generation);
        } else if (effect.kind === "send") {
          send([{payload: undefined, ...effect.message}, null]);
        }
      }
      if (input.source === "area-enabled" || input.source === "delay") publish(send, motionStateOutputs(publishing, result.state));
      updateStatus(result.status);
      return result;
    }

    // Context survives a redeploy but timers do not: a pending off-timer is
    // re-armed.
    const savedState = context.get("state") as Partial<MotionState> | undefined;
    if (typeof savedState?.offTimerDueAt === "number") {
      armOffTimer(Math.max(0, savedState.offTimerDueAt - Date.now()), Number(savedState.offTimerGeneration) || 0);
    }
    onInput(node, (msg, send) => {
      if (msg.source === "startup") {
        lifecycle.startup(send, motionStartingOutputs(publishing, savedPolicyState()));
        return;
      }
      const inbound = motionInbound(msg, publishing);
      process(inbound?.input ?? {source: String(msg.source ?? ""), payload: msg.payload}, send, inbound);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(offTimer);
      done();
    });
  }

  RED.nodes.registerType("home-motion-lighting-policy", HomeMotionLightingPolicy);
};

export = registerMotionPolicy;
