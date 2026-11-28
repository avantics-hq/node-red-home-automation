"use strict";

// The house schedule's MQTT and Home Assistant side, as a flow node beside
// the shared schedule it references: its times as retained state, time
// entities, and the set topics Home Assistant changes them by.

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {ID_SCHEMES, discoveryPrefixSetting} from "../lib/ha-discovery";
import type {SharedSchedule} from "../lib/house-schedule";
import {
  houseCommandTopic,
  houseInbound,
  houseRetainedTopics,
  houseStartingOutputs,
  houseStateOutputs,
  houseStoppingOutputs,
  type HouseSchedulePublishingConfig
} from "../lib/house-schedule-publishing";
import {optionalBooleanSetting, optionalChoiceSetting} from "../lib/settings";
import {publishingArea} from "../lib/topic-names";
import {guarded, invalidConfig, objectField, onInput, runReducer, type InputMessage, type Send} from "./adapter";
import {brokerSetting, publishingSide} from "./publishing-side";
import type {BrokerNode} from "./mqtt-broker-link";
import {HOME_ASSISTANT_CHOICES} from "../lib/home-assistant-setting";
import {referencedSchedule} from "./shared-schedule";

interface HouseScheduleMqttConfig extends NodeDef {
  // Publish: state or discovery; not set: from discovery, which it replaced.
  homeAssistant?: string | null;
  // Node-RED's mqtt-broker node, to publish and read its set topics itself.
  broker?: string;
  schedule?: string;
  discovery?: boolean | string | null;
  discoveryPrefix?: string;
  idScheme?: string | null;
}

const registerHouseScheduleMqtt: NodeInitializer = (RED) => {
  function HomeHouseScheduleMqtt(this: Node, config: HouseScheduleMqttConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    let house: SharedSchedule;
    let publishing: HouseSchedulePublishingConfig;
    let broker: BrokerNode | null;
    try {
      const choice = optionalChoiceSetting(config.homeAssistant, "Publish", HOME_ASSISTANT_CHOICES);
      const referenced = referencedSchedule(RED, config.schedule);
      if (!referenced.schedule) throw new Error(referenced.missing ? "the house schedule is missing" : "no house schedule");
      house = referenced.schedule;
      publishing = {
        area: publishingArea(house.name, true),
        // Publishing is what this node is for; discovery is off unless
        // switched on. Publish (MQTT state, or MQTT state and Home Assistant
        // discovery) replaced the discovery setting; not set: from it.
        publishState: true,
        discovery: choice ? choice === "discovery" : optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? false,
        discoveryPrefix: discoveryPrefixSetting(config.discoveryPrefix),
        // Named after the schedule, not this node, so a replacement node
        // keeps the same entities.
        nodeId: config.schedule,
        idScheme: optionalChoiceSetting(config.idScheme, "ID scheme", ID_SCHEMES) ?? "node"
      };
      broker = brokerSetting(RED, config.broker, true);
    } catch (error) {
      invalidConfig(node, error);
      return;
    }
    const trace = {area: publishing.area, component: "house-schedule-mqtt"};

    function showTimes() {
      const {wakeTime, bedTime} = house.schedule();
      node.status({fill: "green", shape: "dot", text: `wake ${wakeTime} · bed ${bedTime}`});
    }

    const lifecycle = publishingSide(RED, node, broker, {
      retainedTopics: () => houseRetainedTopics(publishing),
      // Its own entities, named after the schedule, cleared when discovery is
      // switched off, with or without a record (see ownDiscoveryTopics).
      possible: {owner: publishing, topics: () => houseRetainedTopics({...publishing, discovery: true})},
      starting: () => houseStartingOutputs(publishing, house.schedule()),
      stopping: () => houseStoppingOutputs(publishing),
      output: 0,
      outputs: 1,
      statusTopic: publishing.discovery ? publishing.discoveryPrefix + "/status" : null,
      setTopics: [houseCommandTopic(publishing.area, "wake-time"), houseCommandTopic(publishing.area, "bed-time")]
    }, trace, (msg, send) => handle(msg, send));

    const unsubscribe = house.subscribe(guarded(node, () => {
      lifecycle.publish(node.send.bind(node), houseStateOutputs(publishing, house.schedule()));
      showTimes();
    }));
    node.on("close", unsubscribe);
    showTimes();

    function handle(msg: InputMessage, send: Send) {
      const lighting = objectField<{kind?: string; wakeTime?: unknown; bedTime?: unknown}>(msg, "lighting");
      if (lighting?.kind === "startup" || msg.source === "startup") {
        lifecycle.startup(send, houseStartingOutputs(publishing, house.schedule()));
        return;
      }
      if (lighting?.kind === "schedule") {
        house.change({kind: "schedule", wakeTime: lighting.wakeTime, bedTime: lighting.bedTime});
        return;
      }
      const inbound = houseInbound(msg, publishing);
      if (inbound?.event) {
        house.change(inbound.event, inbound.traces);
      } else if (inbound) {
        runReducer(node, trace, (state: unknown) => ({state, traces: inbound.traces}));
      }
    }
    onInput(node, (msg, send) => {
      // With a broker, its set topics come from the broker: an MQTT in or a
      // Status node still wired in changes nothing.
      if (!lifecycle.fromBroker(msg)) handle(msg, send);
    }, lifecycle.startupOption({lighting: {kind: "startup"}}));
  }

  RED.nodes.registerType("home-house-schedule-mqtt", HomeHouseScheduleMqtt);
};

export = registerHouseScheduleMqtt;
