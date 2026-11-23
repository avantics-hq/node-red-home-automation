"use strict";

import type {
  Node,
  NodeDef,
  NodeInitializer,
  NodeStatusFill,
  NodeStatusShape
} from "node-red";
import {
  transitionDisplay,
  type DisplayCommand,
  type DisplayConfig,
  type DisplayMessage,
  type DisplayState
} from "../lib/display-mode-controller";
import {DisplayTransport} from "../lib/display-transport";
import {guarded, invalidConfig, number, objectField, onInput, runReducer, type Send} from "./adapter";

interface DisplayControllerConfig extends NodeDef {
  area?: string;
  tvHost?: string;
  screenHost?: string;
  projectorMeterHost?: string;
  transportTimeoutMs?: number | string;
  screenOpenPosition?: number | string;
  screenTolerance?: number | string;
  pollMs?: number | string;
  queryTimeoutMs?: number | string;
  tvTimeoutMs?: number | string;
  screenTimeoutMs?: number | string;
  projectorWarmupMs?: number | string;
  projectorMinimumWarmupMs?: number | string;
  projectorShutdownConfirmMs?: number | string;
  projectorCooldownMs?: number | string;
  maxAttempts?: number | string;
  projectorOnWatts?: number | string;
  projectorOffWatts?: number | string;
  projectorPowerFallback?: boolean;
}

interface DisplayCredentials {
  tvPsk: string;
}

interface DisplayControllerNode extends Node<DisplayCredentials> {}

type DisplayStatus = ReturnType<typeof transitionDisplay>["status"];

const registerDisplayModeController: NodeInitializer = (RED) => {
  function HomeDisplayModeController(this: DisplayControllerNode, config: DisplayControllerConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const controllerConfig: DisplayConfig = {
      screenOpenPosition: number(config.screenOpenPosition, 82),
      screenTolerance: number(config.screenTolerance, 2),
      pollMs: number(config.pollMs, 2000),
      queryTimeoutMs: number(config.queryTimeoutMs, 5000),
      tvTimeoutMs: number(config.tvTimeoutMs, 30000),
      screenTimeoutMs: number(config.screenTimeoutMs, 65000),
      projectorWarmupMs: number(config.projectorWarmupMs, 60000),
      projectorMinimumWarmupMs: number(config.projectorMinimumWarmupMs, 15000),
      projectorShutdownConfirmMs: number(config.projectorShutdownConfirmMs, 5000),
      projectorCooldownMs: number(config.projectorCooldownMs, 120000),
      maxAttempts: number(config.maxAttempts, 2),
      projectorOnWatts: number(config.projectorOnWatts, 20),
      projectorOffWatts: number(config.projectorOffWatts, 10),
      projectorPowerFallback: config.projectorPowerFallback === true
    };

    let transport: DisplayTransport;
    try {
      transport = new DisplayTransport({
        tvHost: String(config.tvHost ?? ""),
        tvPsk: String(node.credentials?.tvPsk ?? ""),
        screenHost: String(config.screenHost ?? ""),
        projectorMeterHost: String(config.projectorMeterHost ?? ""),
        timeoutMs: number(config.transportTimeoutMs, 5000)
      });
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    function updateStatus(status: DisplayStatus) {
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

    function schedule(state: DisplayState) {
      clearTimeout(timer);
      timer = undefined;
      if (!state.pending?.nextAt) return;
      const delay = Math.max(0, state.pending.nextAt - Date.now());
      const generation = state.desired?.generation || state.generation;
      timer = setTimeout(guarded(node, () => {
        process({display: {kind: "tick", generation}}, node.send.bind(node));
      }), delay);
    }

    async function dispatch(command: DisplayCommand): Promise<void> {
      if (command.device === "projector" && command.operation === "power_toggle") {
        node.send([{
          payload: "power",
          display_command: command
        }, null]);
        return;
      }
      const result = await transport.execute(command);
      if (!closed && result) process(result, node.send.bind(node));
    }

    function process(msg: DisplayMessage, send: Send) {
      const result = runReducer(node, {area: config.area || "lounge", component: "display-mode-controller"},
        (saved: Partial<DisplayState> | undefined, now) => transitionDisplay(saved, msg, controllerConfig, now));
      const outputs = [...result.events, ...result.targetStates];
      if (outputs.length) {
        send([null, outputs.map((event) => ({payload: undefined, ...event}))]);
      }
      updateStatus(result.status);
      schedule(result.state);
      for (const command of result.commands) {
        dispatch(command).catch((error) => node.error(error));
      }
      return result;
    }

    onInput(node, (msg, send) => {
      process({
        display: objectField<DisplayMessage["display"]>(msg, "display")
      }, send);
    });

    node.on("close", (_removed: boolean, done: () => void) => {
      closed = true;
      clearTimeout(timer);
      done();
    });
  }

  RED.nodes.registerType("home-display-mode-controller", HomeDisplayModeController, {
    credentials: {tvPsk: {type: "password"}}
  });
};

export = registerDisplayModeController;
