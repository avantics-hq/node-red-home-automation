"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {wallInputStatus, type WallInputStatus} from "../lib/wall-input";
import {
  transitionMotion,
  type MotionConfig,
  type MotionInput,
  type MotionState
} from "../lib/motion-policy";
import {guarded, invalidConfig, onInput, runReducer, type Send} from "./adapter";

interface MotionPolicyConfig extends NodeDef {
  area?: string;
  onTargets?: string;
  offTargets?: string;
  defaultDelaySeconds?: number | string;
  defaultIlluminanceCutoff?: number | string;
  switchWindowMs?: number | string;
  switchFreshnessSeconds?: number | string;
}

interface MotionPolicyNode extends Node {}

type MotionStatus = ReturnType<typeof transitionMotion>["status"];


function ageText(ageMs: number | null): string {
  if (ageMs === null) return "age ?";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
  return `${Math.floor(ageMs / 3_600_000)}h`;
}

function switchStatusText(status: WallInputStatus): string {
  if (status.phase === "fresh") return `switch ${ageText(status.ageMs)}`;
  if (status.phase === "stale") return `switch stale ${ageText(status.ageMs)}`;
  if (status.phase === "unavailable") return "switch unavailable";
  return "switch baseline ?";
}
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
    let statusTimer: ReturnType<typeof setInterval> | undefined;
    const initialState = context.get("state") as (
      Partial<MotionState> & {switchStateKnown?: boolean}
    ) | undefined;
    let wallInputRelevant = initialState?.wallInput?.baselineKnown === true ||
      initialState?.switchStateKnown === true;

    let policyConfig: MotionConfig & {area: string};
    try {
      const onTargets = parseArray(config.onTargets, ["main"]);
      policyConfig = {
        area: config.area || "room",
        onTargets,
        offTargets: parseArray(config.offTargets, onTargets),
        defaultDelaySeconds: Number(config.defaultDelaySeconds ?? 120),
        defaultIlluminanceCutoff: Number(config.defaultIlluminanceCutoff ?? 10),
        switchWindowMs: Number(config.switchWindowMs ?? 500),
        switchFreshnessMs: Number(config.switchFreshnessSeconds ?? 3600) * 1000
      };
      if (!Number.isFinite(policyConfig.switchFreshnessMs) || policyConfig.switchFreshnessMs <= 0) {
        throw new Error("switch freshness must be a positive number");
      }
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    function updateStatus(status: MotionStatus) {
      if (!wallInputRelevant) {
        node.status({
          fill: status.enabled ? "green" : "grey",
          shape: "dot",
          text: (status.enabled ? "enabled" : "disabled") + " · " +
            (status.illuminance === null ? "lux ?" : status.illuminance + " lux") + " · " +
            status.delaySeconds + "s"
        });
        return;
      }
      const switchState = status.switch;
      const unhealthy = switchState.phase === "unavailable" || switchState.phase === "stale";
      const awaiting = switchState.phase === "awaiting-baseline";
      node.status({
        fill: switchState.phase === "unavailable"
          ? "red"
          : unhealthy || awaiting
            ? "yellow"
            : status.enabled ? "green" : "grey",
        shape: unhealthy || awaiting ? "ring" : "dot",
        text: (status.enabled ? "enabled" : "disabled") + " · " +
          (status.illuminance === null ? "lux ?" : status.illuminance + " lux") + " · " +
          status.delaySeconds + "s · " + switchStatusText(switchState)
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
      if (input.source === "switch" || input.source === "switch-availability") {
        wallInputRelevant = true;
      }
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
        } else if (effect.kind === "cancel-switch-timer") {
          clearTimeout(switchTimer);
          switchTimer = undefined;
        } else if (effect.kind === "schedule-switch-timer") {
          clearTimeout(switchTimer);
          switchTimer = setTimeout(guarded(node, () => {
            switchTimer = undefined;
            process({
              source: "switch-timer",
              generation: effect.generation,
              switchAt: effect.switchAt
            }, node.send.bind(node));
          }), effect.delayMs);
        } else if (effect.kind === "send") {
          send({payload: undefined, ...effect.message});
        }
      }
      updateStatus(result.status);
      return result;
    }

    process({source: "switch-startup"}, node.send.bind(node));
    // Context survives a redeploy but timers do not. switch-startup drops a
    // half-finished switch gesture by design; a pending off-timer is re-armed.
    const savedState = context.get("state") as Partial<MotionState> | undefined;
    if (typeof savedState?.offTimerDueAt === "number") {
      armOffTimer(Math.max(0, savedState.offTimerDueAt - Date.now()), Number(savedState.offTimerGeneration) || 0);
    }
    statusTimer = setInterval(() => {
      const saved = context.get("state") as Partial<MotionState> | undefined;
      updateStatus({
        enabled: saved?.areaEnabled !== false && globalContext.get("MOTION_ENABLED_STATE") !== false,
        illuminance: saved?.illuminance ?? null,
        delaySeconds: saved?.delaySeconds ?? policyConfig.defaultDelaySeconds,
        switch: wallInputStatus(saved?.wallInput, policyConfig.switchFreshnessMs)
      });
    }, Math.max(1000, Math.min(60_000, policyConfig.switchFreshnessMs)));

    onInput(node, (msg, send) => {
      process({
        source: String(msg.source ?? ""),
        payload: msg.payload,
        retain: msg.retain === true,
        baseline: msg.baseline === true,
        observedAt: msg.observedAt
      }, send);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      clearTimeout(offTimer);
      clearTimeout(switchTimer);
      clearInterval(statusTimer);
      done();
    });
  }

  RED.nodes.registerType("home-motion-lighting-policy", HomeMotionLightingPolicy);
};

export = registerMotionPolicy;
