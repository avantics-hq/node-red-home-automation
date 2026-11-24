"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {resolveSchedule, type DaySchedule} from "../lib/circadian-schedule";
import {ID_SCHEMES, discoveryPrefixSetting} from "../lib/ha-discovery";
import {houseScheduleInUse, transitionHouseSchedule, type HouseScheduleEvent, type HouseScheduleState} from "../lib/house-schedule";
import {
  houseInbound,
  houseRetainedTopics,
  houseStartingOutputs,
  houseStateOutputs,
  houseStoppingOutputs,
  type HouseSchedulePublishingConfig
} from "../lib/house-schedule-publishing";
import {optionalBooleanSetting, optionalChoiceSetting, textSetting} from "../lib/settings";
import {publishingArea} from "../lib/topic-names";
import {objectField, onEveryFlowsStarted, onInput, invalidConfig, runReducer, type Send} from "./adapter";
import {publishesState} from "../lib/publishing-node";
import {publishingLifecycle} from "./publishing-lifecycle";

interface HouseScheduleConfig extends NodeDef {
  houseName?: string;
  wakeTime?: string;
  bedTime?: string;
  publishState?: boolean | string | null;
  discovery?: boolean | string | null;
  discoveryPrefix?: string;
  idScheme?: string | null;
}

const registerHouseSchedule: NodeInitializer = (RED) => {
  function HomeHouseSchedule(this: Node, config: HouseScheduleConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let setting: DaySchedule;
    let publishing: HouseSchedulePublishingConfig;
    try {
      setting = resolveSchedule(textSetting(config.wakeTime, "wake time", "07:00"), textSetting(config.bedTime, "bed time", "23:00"));
      // Off unless switched on; it names its topics home/<name>/...
      const name = textSetting(config.houseName, "name in topics", "house");
      const publishState = optionalBooleanSetting(config.publishState, "publish state") ?? false;
      const discovery = optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? false;
      publishingArea(name, publishState || discovery);
      publishing = {
        area: name,
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
    const trace = {area: publishing.area, component: "house-schedule"};

    function schedule(): DaySchedule {
      return houseScheduleInUse(node.context().get("state") as Partial<HouseScheduleState> | undefined, setting);
    }

    // The schedule for the rooms on output 1; MQTT publications on output 2.
    const lifecycle = publishingLifecycle(RED, node, {
      retainedTopics: () => houseRetainedTopics(publishing),
      possible: {owner: publishing, topics: () => publishesState(publishing) ? houseRetainedTopics({...publishing, publishState: true, discovery: true}) : []},
      starting: () => houseStartingOutputs(publishing, schedule()),
      stopping: () => houseStoppingOutputs(publishing),
      output: 1,
      outputs: 2
    });

    function process(event: HouseScheduleEvent, send: Send, inboundTraces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = []) {
      const result = runReducer(node, trace, (saved: Partial<HouseScheduleState> | undefined) => {
        const decided = transitionHouseSchedule(saved, event, setting);
        return {...decided, traces: [...inboundTraces, ...decided.traces]};
      });
      if (result.outputs.length) send([result.outputs.map((message) => ({...message})), null]);
      if (event.kind === "schedule" && result.outputs.length) lifecycle.publish(send, houseStateOutputs(publishing, result.state.schedule));
      node.status({fill: "green", shape: "dot", text: result.status.text});
    }

    // Rooms realign whenever the flows start: after every deploy, including
    // one that only adds or changes a room, and every restart.
    onEveryFlowsStarted(RED, node, () => process({kind: "announce"}, node.send.bind(node)));

    onInput(node, (msg, send) => {
      const lighting = objectField<{kind?: string; wakeTime?: unknown; bedTime?: unknown}>(msg, "lighting");
      if (lighting?.kind === "startup" || msg.source === "startup") {
        lifecycle.startup(send, houseStartingOutputs(publishing, schedule()));
        process({kind: "announce"}, send);
        return;
      }
      if (lighting?.kind === "schedule") {
        process({kind: "schedule", wakeTime: lighting.wakeTime, bedTime: lighting.bedTime}, send);
        return;
      }
      const inbound = houseInbound(msg, publishing);
      if (inbound?.event) {
        process(inbound.event, send);
      } else if (inbound) {
        runReducer(node, trace, (state: Partial<HouseScheduleState> | undefined) => ({state, traces: inbound.traces}));
      }
    });
  }

  RED.nodes.registerType("home-house-schedule", HomeHouseSchedule);
};

export = registerHouseSchedule;
