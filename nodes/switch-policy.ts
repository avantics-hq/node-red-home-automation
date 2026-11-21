"use strict";

import type {Node, NodeDef, NodeInitializer, NodeMessage} from "node-red";
import {appendTrace} from "../lib/bounded-trace";
import {
  transitionSwitchPolicy,
  type SwitchPolicyConfig,
  type SwitchPolicyInput,
  type SwitchPolicyState
} from "../lib/switch-policy";

interface SwitchLightingPolicyConfig extends NodeDef {
  area?: string;
  targets?: string;
  switchWindowMs?: number | string;
}

interface SwitchLightingPolicyNode extends Node {}
type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;

function parseTargets(value: string | undefined): string[] {
  const parsed: unknown = JSON.parse(value || "[\"main\"]");
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string")) {
    throw new Error("targets must be a non-empty JSON array of strings");
  }
  return parsed as string[];
}

const registerSwitchPolicy: NodeInitializer = (RED) => {
  function HomeSwitchLightingPolicy(this: SwitchLightingPolicyNode, config: SwitchLightingPolicyConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let timer: ReturnType<typeof setTimeout> | undefined;

    let policyConfig: SwitchPolicyConfig & {area: string};
    try {
      policyConfig = {
        area: config.area || "room",
        targets: parseTargets(config.targets),
        switchWindowMs: Number(config.switchWindowMs ?? 500)
      };
      if (!Number.isFinite(policyConfig.switchWindowMs) || policyConfig.switchWindowMs < 0) {
        throw new Error("switch window must be a non-negative number");
      }
    } catch (error) {
      node.status({fill: "red", shape: "ring", text: "invalid configuration"});
      node.error(error);
      return;
    }

    function process(input: SwitchPolicyInput, send: Send) {
      const now = new Date();
      const saved = context.get("state") as Partial<SwitchPolicyState> | undefined;
      const result = transitionSwitchPolicy(saved, input, policyConfig, now.getTime());
      context.set("state", result.state);
      appendTrace(context, {
        area: policyConfig.area,
        component: "switch-policy"
      }, result.traces, now);

      for (const effect of result.effects) {
        if (effect.kind === "cancel-switch-timer") {
          clearTimeout(timer);
          timer = undefined;
        } else if (effect.kind === "schedule-switch-timer") {
          clearTimeout(timer);
          timer = setTimeout(() => {
            timer = undefined;
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
        } else {
          send({payload: undefined, ...effect.message});
        }
      }
      node.status({
        fill: "green",
        shape: "dot",
        text: `ready · ${policyConfig.switchWindowMs}ms`
      });
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
      clearTimeout(timer);
      done();
    });
  }

  RED.nodes.registerType("home-switch-lighting-policy", HomeSwitchLightingPolicy);
};

export = registerSwitchPolicy;
