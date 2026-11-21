"use strict";

import type {Node, NodeDef, NodeInitializer, NodeMessage} from "node-red";
import {appendTrace} from "../lib/bounded-trace";
import {
  transitionMotion,
  type MotionConfig,
  type MotionInput,
  type MotionState
} from "../lib/motion-policy";

interface MotionPolicyConfig extends NodeDef {
  area?: string;
  onTargets?: string;
  offTargets?: string;
  defaultDelaySeconds?: number | string;
  defaultIlluminanceCutoff?: number | string;
  switchWindowMs?: number | string;
}

interface MotionPolicyNode extends Node {}

type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
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
    let switchTimer: ReturnType<typeof setTimeout> | undefined;

    let policyConfig: MotionConfig & {area: string};
    try {
      const onTargets = parseArray(config.onTargets, ["main"]);
      policyConfig = {
        area: config.area || "room",
        onTargets,
        offTargets: parseArray(config.offTargets, onTargets),
        defaultDelaySeconds: Number(config.defaultDelaySeconds ?? 120),
        defaultIlluminanceCutoff: Number(config.defaultIlluminanceCutoff ?? 10),
        switchWindowMs: Number(config.switchWindowMs ?? 500)
      };
    } catch (error) {
      node.status({fill: "red", shape: "ring", text: "invalid configuration"});
      node.error(error);
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

    function process(input: MotionInput, send: Send) {
      const now = new Date();
      const globalEnabled = globalContext.get("MOTION_ENABLED_STATE") !== false;
      const saved = context.get("state") as Partial<MotionState> | undefined;
      const result = transitionMotion(saved, input, policyConfig, globalEnabled, now.getTime());
      context.set("state", result.state);
      if (input.source === "global-enabled") {
        globalContext.set("MOTION_ENABLED_STATE", result.globalEnabled);
      }
      appendTrace(context, {
        area: policyConfig.area,
        component: "motion-policy"
      }, result.traces, now);

      for (const effect of result.effects) {
        if (effect.kind === "cancel-off-timer") {
          clearTimeout(offTimer);
          offTimer = undefined;
        } else if (effect.kind === "schedule-off-timer") {
          clearTimeout(offTimer);
          offTimer = setTimeout(() => {
            offTimer = undefined;
            try {
              process({source: "off-timer", generation: effect.generation}, node.send.bind(node));
            } catch (error) {
              node.error(error);
            }
          }, effect.delayMs);
        } else if (effect.kind === "cancel-switch-timer") {
          clearTimeout(switchTimer);
          switchTimer = undefined;
        } else if (effect.kind === "schedule-switch-timer") {
          clearTimeout(switchTimer);
          switchTimer = setTimeout(() => {
            switchTimer = undefined;
            try {
              process({
                source: "switch-timer",
                generation: effect.generation,
                switchAt: effect.switchAt
              }, node.send.bind(node));
            } catch (error) {
              node.error(error);
            }
          }, effect.delayMs);
        } else if (effect.kind === "send") {
          send({payload: undefined, ...effect.message});
        }
      }
      updateStatus(result.status);
      return result;
    }

    node.on("input", (msg, send, done) => {
      try {
        process({
          source: String(msg.source ?? ""),
          payload: msg.payload,
          retain: msg.retain === true
        }, send);
        done();
      } catch (error) {
        node.error(error, msg);
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(offTimer);
      clearTimeout(switchTimer);
      done();
    });
  }

  RED.nodes.registerType("home-motion-lighting-policy", HomeMotionLightingPolicy);
};

export = registerMotionPolicy;
