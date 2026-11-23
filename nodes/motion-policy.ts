"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  transitionMotion,
  type MotionConfig,
  type MotionInput,
  type MotionState
} from "../lib/motion-policy";
import {guarded, invalidConfig, onInput, runReducer, type Send} from "./adapter";
import {numberSetting} from "../lib/settings";

interface MotionPolicyConfig extends NodeDef {
  area?: string;
  onTargets?: string;
  offTargets?: string;
  defaultDelaySeconds?: number | string;
  defaultIlluminanceCutoff?: number | string;
}

interface MotionPolicyNode extends Node {}

type MotionStatus = ReturnType<typeof transitionMotion>["status"];


function parseArray(value: string | undefined, fallback: string[]): string[] {
  const parsed: unknown = JSON.parse(value || JSON.stringify(fallback));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("targets must be a JSON array of strings");
  }
  return parsed as string[];
}

const registerMotionPolicy: NodeInitializer = (RED) => {
  function HomeMotionLightingPolicy(this: MotionPolicyNode, config: MotionPolicyConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    const globalContext = context.global;
    let offTimer: ReturnType<typeof setTimeout> | undefined;

    let policyConfig: MotionConfig & {area: string};
    try {
      const onTargets = parseArray(config.onTargets, ["main"]);
      policyConfig = {
        area: config.area || "room",
        onTargets,
        offTargets: parseArray(config.offTargets, onTargets),
        defaultDelaySeconds: numberSetting(config.defaultDelaySeconds, "vacancy delay", 120),
        defaultIlluminanceCutoff: numberSetting(config.defaultIlluminanceCutoff, "illuminance cutoff", 10)
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

    function process(input: MotionInput, send: Send) {
      const globalEnabled = globalContext.get("MOTION_ENABLED_STATE") !== false;
      const result = runReducer(node, {area: policyConfig.area, component: "motion-policy"},
        (saved: Partial<MotionState> | undefined, now) =>
          transitionMotion(saved, input, policyConfig, globalEnabled, now.getTime()));
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
          send({payload: undefined, ...effect.message});
        }
      }
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
      process({source: String(msg.source ?? ""), payload: msg.payload}, send);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(offTimer);
      done();
    });
  }

  RED.nodes.registerType("home-motion-lighting-policy", HomeMotionLightingPolicy);
};

export = registerMotionPolicy;
