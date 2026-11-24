"use strict";

// The house schedule: a config node, as Node-RED shares a broker between the
// nodes that use it. Rooms and the node that publishes it reference it and
// hear of every change in process; it has no wires. Node-RED starts it
// before the nodes that use it, and restarts them when it changes or goes.

import type {Node, NodeDef, NodeInitializer} from "node-red";
import type {TraceEntry} from "../lib/bounded-trace";
import {resolveSchedule, type DaySchedule} from "../lib/circadian-schedule";
import {houseScheduleInUse, transitionHouseSchedule, type HouseScheduleState, type SharedSchedule} from "../lib/house-schedule";
import {textSetting} from "../lib/settings";
import {invalidConfig, runReducer} from "./adapter";

interface HouseScheduleConfig extends NodeDef {
  wakeTime?: string;
  bedTime?: string;
}

const registerHouseSchedule: NodeInitializer = (RED) => {
  function HomeHouseSchedule(this: Node & Partial<SharedSchedule>, config: HouseScheduleConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let setting: DaySchedule;
    let name: string;
    try {
      setting = resolveSchedule(textSetting(config.wakeTime, "wake time", "07:00"), textSetting(config.bedTime, "bed time", "23:00"));
      // Also its name in topics, home/<name>/schedule/...
      name = textSetting(config.name, "name", "house");
    } catch (error) {
      invalidConfig(node, error);
      return;
    }
    const trace = {area: name, component: "house-schedule"};
    const listeners = new Set<(schedule: DaySchedule) => void>();

    const shared: SharedSchedule = {
      name,
      schedule: () => houseScheduleInUse(node.context().get("state") as Partial<HouseScheduleState> | undefined, setting),
      change(event, traces: TraceEntry[] = []) {
        const result = runReducer(node, trace, (saved: Partial<HouseScheduleState> | undefined) => {
          const decided = transitionHouseSchedule(saved, event, setting);
          return {...decided, traces: [...traces, ...decided.traces]};
        });
        if (!result.changed) return;
        for (const listener of [...listeners]) listener({...result.state.schedule});
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }
    };
    Object.assign(node, shared);

    node.on("close", () => {
      listeners.clear();
    });
  }

  RED.nodes.registerType("home-house-schedule", HomeHouseSchedule);
};

export = registerHouseSchedule;
