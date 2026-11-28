"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {
  transitionRoom,
  movedCircadianSettings,
  targetsWithTopics,
  type RoomConfig,
  type RoomMessage,
  type RoomState,
  type RoomTarget,
  INVALID_LIGHT_VALUES,
  MOVED_TO_CIRCADIAN,
  ON_OFF_ONLY,
  REMOVED_LIGHT_UNITS
} from "../lib/room-controller";
import {isLightReading} from "../lib/light-contract";
import {publishingLifecycle} from "./publishing-lifecycle";
import {publishRoom, roomAnnouncement, roomRetainedTopics, roomStartingOutputs, roomStoppingOutputs, withoutCircadianState, type RoomPublishingConfig} from "../lib/room-publishing";
import {invalidConfig, objectField, onInput, optionalArea, runReducer, type Send} from "./adapter";
import {jsonSetting, numberSetting, optionalBooleanSetting, optionalChoiceSetting} from "../lib/settings";
import {homeAssistantSetting} from "../lib/home-assistant-setting";
import {appendTrace} from "../lib/bounded-trace";
import {brokerLink, type BrokerNode} from "./mqtt-broker-link";
import {homeAssistantDiscovery, type HomeAssistantDiscovery} from "./home-assistant-discovery";
import {ID_SCHEMES, discoveryPrefixSetting} from "../lib/ha-discovery";
import {publishingArea} from "../lib/topic-names";

interface RoomControllerConfig extends NodeDef {
  idScheme?: string | null;
  area?: string;
  // off, state or discovery; not set: from publishState and discovery,
  // which it replaced.
  homeAssistant?: string | null;
  // Node-RED's mqtt-broker node, to publish through itself.
  broker?: string;
  publishState?: boolean | string;
  discovery?: boolean | string;
  displayName?: string;
  discoveryPrefix?: string;
  targets?: string;
  initialTransitionSeconds?: number | string;
}

interface RoomControllerNode extends Node {}

type RoomStatus = ReturnType<typeof transitionRoom>["status"];

// The room's lights: an id each, and onOffOnly for one that only switches.
// Their devices are reached through their adapters.
function parseTargets(value: unknown): RoomTarget[] {
  const targets = jsonSetting(value, "targets", []);
  if (!Array.isArray(targets) || targets.some((target) => !target || typeof target !== "object" ||
    typeof (target as Record<string, unknown>).id !== "string" || (target as Record<string, unknown>).id === "")) {
    throw new Error("targets must each have an id");
  }
  if (targets.some((target) => (target as Record<string, unknown>).onOffOnly !== undefined &&
    typeof (target as Record<string, unknown>).onOffOnly !== "boolean")) {
    throw new Error("a target's onOffOnly must be true or false");
  }
  const typedTargets = (targets as Array<Record<string, unknown>>)
    .map(({id, onOffOnly}) => ({id: id as string, ...(onOffOnly === true ? {onOffOnly: true} : {})}));
  if (new Set(typedTargets.map((target) => target.id)).size !== typedTargets.length) {
    throw new Error("target ids must be unique");
  }
  return typedTargets;
}

const registerRoomController: NodeInitializer = (RED) => {
  function HomeRoomLightingController(this: RoomControllerNode, config: RoomControllerConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const area = optionalArea(config);

    let controllerConfig: RoomConfig & RoomPublishingConfig;
    let broker: BrokerNode | null = null;
    try {
      // A room saved before 6.0 still has its circadian settings, which moved
      // to the circadian lighting policy: it runs only once migrated, so it
      // can't quietly lose its styling.
      // Its lights' topics moved to their light adapters likewise: one
      // migration covers both.
      const moved = movedCircadianSettings(config as unknown as Record<string, unknown>);
      const lights = targetsWithTopics(config.targets);
      if (moved.length || lights.length) {
        throw new Error("this room was saved before 6.0: " + [
          ...(moved.length ? ["circadian lighting moved to its own node (add a circadian lighting policy wired to this room, " +
            "with its " + moved.join(", ") + ")"] : []),
          ...(lights.length ? ["its lights are reached through light adapters (add one for " + lights.join(", ") +
            ": a zigbee2mqtt light, or your own on the neutral light contract, and remove their topics from Targets JSON)"] : [])
        ].join(", and ") + "; then open and save this room");
      }
      // Not set (null, or absent from a flow saved before these settings)
      // means on, so an older flow keeps publishing as before.
      const homeAssistant = homeAssistantSetting(config, {publishState: true, discovery: true});
      const publishState = homeAssistant !== "off";
      const discovery = homeAssistant === "discovery";
      // A room saved before the choice needed an area whenever either old
      // setting was on, even discovery alone, which published nothing: kept,
      // so it validates as before.
      const legacyArea = (config.homeAssistant === undefined || config.homeAssistant === null) &&
        ((optionalBooleanSetting(config.publishState, "publish state") ?? true) || (optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? true));
      // With a broker, it publishes itself; without one, through output 1,
      // as before 6.2.
      const brokerId = typeof config.broker === "string" ? config.broker.trim() : "";
      if (publishState && brokerId) {
        broker = RED.nodes.getNode(brokerId) as unknown as BrokerNode | null;
        if (!broker) throw new Error("its MQTT broker node isn't in the flows: choose one, or set Publish to Don't publish");
      }
      // Both publish under topics and IDs named after the area; otherwise the
      // area is only a label.
      if (publishState || legacyArea) publishingArea(area, true);
      controllerConfig = {
        nodeId: node.id,
        // Not set: a node saved before node IDs, which keeps its area-named
        // entities. The editor gives new nodes "node".
        idScheme: optionalChoiceSetting(config.idScheme, "ID scheme", ID_SCHEMES) ?? "area",
        area,
        displayName: config.displayName || area,
        discoveryPrefix: discoveryPrefixSetting(config.discoveryPrefix),
        publishState,
        discovery,
        targets: parseTargets(config.targets),
        initialTransitionSeconds: numberSetting(config.initialTransitionSeconds, "initial transition", 1)
      };
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    // A room saved before 6.0 recorded the circadian and sleep state topics
    // as its own. The circadian lighting policy publishes them now, so they
    // leave the record: neither this room's start nor its deletion clears
    // them.
    const recorded = node.context().get("retainedTopics");
    if (Array.isArray(recorded)) node.context().set("retainedTopics", withoutCircadianState(recorded as string[]));

    const trace = {area: controllerConfig.area, component: "room-controller"};
    // With a broker: everything announced on each connect and when Home
    // Assistant comes back, offline as it stops, nothing left behind when
    // deleted. Without one: the same through output 1, from the flows start
    // and the startup message.
    let homeAssistant: HomeAssistantDiscovery | null = null;
    let lifecycle: ReturnType<typeof publishingLifecycle> | null = null;
    if (broker) {
      homeAssistant = homeAssistantDiscovery(RED, node, brokerLink(broker, node.id, (error) => node.error(error)), {
        retainedTopics: () => roomRetainedTopics(controllerConfig),
        announcement: () => roomAnnouncement(controllerConfig, node.context().get("state") as Partial<RoomState> | undefined),
        stopping: () => roomStoppingOutputs(controllerConfig),
        statusTopic: controllerConfig.discovery ? controllerConfig.discoveryPrefix + "/status" : null,
        // Each connect runs its startup, as a Status node's "connected" did:
        // its announcement, and each light asked for a reading.
        onConnected: () => process({lighting: {kind: "startup"}}, node.send.bind(node))
      }, trace);
    } else {
      lifecycle = publishingLifecycle(RED, node, {
        retainedTopics: () => roomRetainedTopics(controllerConfig),
        starting: () => roomStartingOutputs(controllerConfig),
        stopping: () => roomStoppingOutputs(controllerConfig),
        output: 0,
        outputs: 3
      });
    }

    function updateStatus(status: RoomStatus) {
      node.status({
        fill: status.manualCount ? "yellow" : status.styled ? "green" : "grey",
        shape: "dot",
        text: (status.styled ? "styled" : "unstyled") + " · " + status.onCount + " on · " + status.manualCount + " manual" +
          (status.overriddenCount ? " · " + status.overriddenCount + " overridden" : "") +
          (status.offlineCount ? " · " + status.offlineCount + " offline" : "")
      });
    }

    // Each once per deploy, so a flow still sending them is told without
    // filling the log.
    const warnings: Array<[string, string]> = [
      [REMOVED_LIGHT_UNITS, "lighting values in brightness (1-254) or color_temp (mireds) were removed in 6.0 and are left out: " +
        "send brightnessPct (0-100) and colorTempKelvin instead"],
      [INVALID_LIGHT_VALUES, "lighting values left out: brightnessPct must be a number and colorTempKelvin a number above 0"],
      [ON_OFF_ONLY, "lighting values sent to a light marked onOffOnly are left out: it only switches on and off"],
      [MOVED_TO_CIRCADIAN, "circadian, sleep and schedule messages go to the circadian lighting policy since 6.0: this room ignores them"]
    ];
    const warned = new Set<string>();

    function process(msg: RoomMessage, send: Send) {
      const result = runReducer(node, trace,
        (saved: Partial<RoomState> | undefined, now) => publishRoom(saved, msg, controllerConfig, now));
      // With a broker, the publications go to it, and output 1 is quiet.
      if (homeAssistant) homeAssistant.publish(result.outputs);
      // Output 1: MQTT publications (control states, availability,
      // discovery). Output 2: light commands, for the lights' adapters.
      // Output 3: each light's reading passed on with its control state, for
      // activity lighting.
      const reading = isLightReading(msg.light) && msg.light.kind === "observed" &&
        controllerConfig.targets.some(({id}) => id === (msg.light as {target: string}).target) ? msg.light : null;
      const control = reading ? result.status.control[reading.target] : undefined;
      const outputs = [
        !homeAssistant && result.outputs.length ? result.outputs.map((output) => ({...output, payload: output.payload})) : null,
        result.commands.length ? result.commands.map((light) => ({payload: undefined, light})) : null,
        reading ? {payload: undefined, light: {...reading, control, manual: control === "manual"}} : null
      ];
      if (outputs.some((output) => output !== null)) send(outputs);
      for (const [reason, text] of warnings) {
        if (!warned.has(reason) && result.traces.some((entry) => entry.reason === reason)) {
          warned.add(reason);
          node.warn(text);
        }
      }
      updateStatus(result.status);
      return result;
    }

    onInput(node, (msg, send) => {
      // With a broker it announces itself on every connect: a Status node
      // still wired in, from before, changes nothing.
      const status = objectField<{source?: unknown; text?: unknown}>(msg, "status");
      if (homeAssistant && status && status.source && typeof status.source === "object") {
        appendTrace(node.context(), trace, [{event: "input", outcome: "ignored", reason: "has-broker", details: {status: String(status.text ?? "")}}]);
        return;
      }
      // The startup's own announcement comes from publishRoom.
      if (objectField<RoomMessage["lighting"]>(msg, "lighting")?.kind === "startup") lifecycle?.startup(send);
      process({
        lighting: objectField<RoomMessage["lighting"]>(msg, "lighting"),
        light: msg.light,
        topic: typeof msg.topic === "string" ? msg.topic : undefined,
        payload: msg.payload,
        retain: msg.retain === true
      }, send);
    }, broker ? undefined : {message: {lighting: {kind: "startup"}}, trace});
  }

  RED.nodes.registerType("home-room-lighting-controller", HomeRoomLightingController);
};

export = registerRoomController;
