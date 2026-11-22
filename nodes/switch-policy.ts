"use strict";

import type {Node, NodeDef, NodeInitializer, NodeMessage} from "node-red";
import {appendTrace} from "../lib/bounded-trace";
import {wallInputStatus, type WallInputStatus} from "../lib/wall-input";
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
  switchFreshnessSeconds?: number | string;
}

interface SwitchLightingPolicyNode extends Node {}
type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;

function ageText(ageMs: number | null): string {
  if (ageMs === null) return "age ?";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
  return `${Math.floor(ageMs / 3_600_000)}h`;
}

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
    let statusTimer: ReturnType<typeof setInterval> | undefined;

    let policyConfig: SwitchPolicyConfig & {area: string};
    try {
      policyConfig = {
        area: config.area || "room",
        targets: parseTargets(config.targets),
        switchWindowMs: Number(config.switchWindowMs ?? 500),
        switchFreshnessMs: Number(config.switchFreshnessSeconds ?? 3600) * 1000
      };
      if (!Number.isFinite(policyConfig.switchWindowMs) || policyConfig.switchWindowMs < 0) {
        throw new Error("switch window must be a non-negative number");
      }
      if (!Number.isFinite(policyConfig.switchFreshnessMs) || policyConfig.switchFreshnessMs <= 0) {
        throw new Error("switch freshness must be a positive number");
      }
    } catch (error) {
      node.status({fill: "red", shape: "ring", text: "invalid configuration"});
      node.error(error);
      return;
    }

    function updateStatus(status: WallInputStatus) {
      if (status.phase === "fresh") {
        node.status({fill: "green", shape: "dot", text: `switch fresh · ${ageText(status.ageMs)}`});
      } else if (status.phase === "stale") {
        node.status({fill: "yellow", shape: "ring", text: `switch stale · ${ageText(status.ageMs)}`});
      } else if (status.phase === "unavailable") {
        node.status({fill: "red", shape: "ring", text: "switch unavailable"});
      } else {
        node.status({fill: "yellow", shape: "ring", text: "awaiting switch baseline"});
      }
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
      updateStatus(result.status);
      return result;
    }

    process({source: "switch-startup"}, node.send.bind(node));
    statusTimer = setInterval(() => {
      const saved = context.get("state") as Partial<SwitchPolicyState> | undefined;
      updateStatus(wallInputStatus(
        saved?.wallInput,
        policyConfig.switchFreshnessMs
      ));
    }, Math.max(1000, Math.min(60_000, policyConfig.switchFreshnessMs)));

    node.on("input", (msg, send, done) => {
      try {
        process({
          source: String(msg.source ?? ""),
          payload: msg.payload,
          retain: msg.retain === true,
          observedAt: msg.observedAt
        }, send);
        done();
      } catch (error) {
        node.error(error, msg);
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(timer);
      clearInterval(statusTimer);
      done();
    });
  }

  RED.nodes.registerType("home-switch-lighting-policy", HomeSwitchLightingPolicy);
};

export = registerSwitchPolicy;
