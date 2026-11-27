"use strict";

import type {Node, NodeDef, NodeInitializer} from "node-red";
import {scheduledLighting} from "../lib/circadian";
import {createCircadianState, styleMessage, transitionCircadian, type CircadianConfig, type CircadianEvent, type CircadianState} from "../lib/circadian-policy";
import {
  ANNOUNCE_DELAY_MS,
  circadianAnnouncement,
  circadianInbound,
  circadianRetainedTopics,
  circadianStartingOutputs,
  circadianStateOutputs,
  circadianStoppingOutputs,
  type CircadianPublishingConfig
} from "../lib/circadian-publishing";
import {resolveSchedule} from "../lib/circadian-schedule";
import {discoveryPrefixSetting} from "../lib/ha-discovery";
import type {LightLevels} from "../lib/light-styling";
import {publishesState} from "../lib/publishing-node";
import {booleanSetting, numberSetting, optionalBooleanSetting, textSetting} from "../lib/settings";
import {publishingArea} from "../lib/topic-names";
import {guarded, invalidConfig, objectField, onInput, optionalArea, runReducer, wasDeleted, whenFlowsStarted, type Send} from "./adapter";
import {publishingLifecycle} from "./publishing-lifecycle";
import {refusedEnables} from "./refused-enable";
import {referencedSchedule} from "./shared-schedule";

interface CircadianPolicyConfig extends NodeDef {
  area?: string;
  // The house schedule it follows, a config node's ID; "" or absent: none.
  houseSchedule?: string | null;
  wakeTime?: string;
  bedTime?: string;
  maxBrightnessPct?: number | string;
  maxColorTempKelvin?: number | string;
  sleepBrightnessPct?: number | string;
  sleepColorTempKelvin?: number | string;
  refreshTransitionSeconds?: number | string;
  refreshSeconds?: number | string;
  initialSleep?: boolean | string;
  publishState?: boolean | string | null;
  discovery?: boolean | string | null;
  discoveryPrefix?: string;
  idScheme?: string | null;
}

const registerCircadianPolicy: NodeInitializer = (RED) => {
  function HomeCircadianLightingPolicy(this: Node, config: CircadianPolicyConfig) {
    RED.nodes.createNode(this, config);
    const node = this;
    const context = node.context();
    let tickTimer: ReturnType<typeof setInterval> | undefined;
    let announceTimer: ReturnType<typeof setTimeout> | undefined;

    // A schedule that is set but not running, as when it was deleted: the
    // policy keeps to its own times and says so.
    const {schedule: house, missing: houseMissing} = referencedSchedule(RED, config.houseSchedule);
    let policyConfig: CircadianConfig;
    let publishing: CircadianPublishingConfig;
    try {
      const area = optionalArea(config);
      const levels: LightLevels = {
        maxBrightnessPct: numberSetting(config.maxBrightnessPct, "daytime brightness", 100),
        maxColorTempKelvin: numberSetting(config.maxColorTempKelvin, "daytime colour temperature", 6500),
        sleepBrightnessPct: numberSetting(config.sleepBrightnessPct, "sleep brightness", 1),
        sleepColorTempKelvin: numberSetting(config.sleepColorTempKelvin, "sleep colour temperature", 2200)
      };
      const schedule = house
        ? house.schedule()
        : resolveSchedule(textSetting(config.wakeTime, "wake time", "07:00"), textSetting(config.bedTime, "bed time", "23:00"));
      policyConfig = {
        lighting: scheduledLighting(schedule, levels),
        schedule,
        timesFrom: house ? "house" : "own",
        initialSleep: booleanSetting(config.initialSleep, "initial sleep", false),
        transitionSeconds: numberSetting(config.refreshTransitionSeconds, "restyle transition", 60),
        intervalSeconds: Math.max(10, numberSetting(config.refreshSeconds, "restyle interval", 60))
      };
      // Off unless switched on; a new node, so its entities are named after
      // it.
      const publishState = optionalBooleanSetting(config.publishState, "publish state") ?? false;
      const discovery = optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? false;
      if (publishState || discovery) publishingArea(area, true);
      publishing = {
        area,
        publishState,
        discovery,
        discoveryPrefix: discoveryPrefixSetting(config.discoveryPrefix),
        nodeId: node.id,
        // Always named after the node, so its entries never share a topic
        // with the area-named ones older rooms published, which it clears.
        idScheme: "node",
        timesFrom: policyConfig.timesFrom
      };
    } catch (error) {
      invalidConfig(node, error);
      return;
    }

    function savedState(): CircadianState {
      return createCircadianState(policyConfig, context.get("state") as Partial<CircadianState> | undefined);
    }

    // Styles go to rooms on the first output; MQTT publications on the
    // second. Its discovery waits for announce() (see ANNOUNCE_DELAY_MS).
    const lifecycle = publishingLifecycle(RED, node, {
      retainedTopics: () => circadianRetainedTopics(publishing),
      possible: {owner: publishing, topics: () => publishesState(publishing) ? circadianRetainedTopics({...publishing, publishState: true, discovery: true}) : []},
      starting: () => circadianStartingOutputs(publishing, savedState()),
      stopping: () => circadianStoppingOutputs(publishing),
      output: 1,
      outputs: 2
    });

    function updateStatus(status: ReturnType<typeof transitionCircadian>["status"]) {
      const values = status.values;
      node.status(values
        ? {fill: "green", shape: "dot", text: (status.sleeping ? "sleep" : "day") + " · " +
            Math.round(values.brightnessPct) + "% " + Math.round(values.colorTempKelvin) + "K" +
            (houseMissing ? " · schedule missing: own times" : "")}
        : {fill: "grey", shape: "dot", text: "off" + (houseMissing ? " · schedule missing: own times" : "")});
    }
    const showRefused = refusedEnables(node, (source) => `${source}'s enabled`);

    function process(event: CircadianEvent, send: Send, inboundTraces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [], fromSetTopic = false) {
      const result = runReducer(node, {area: publishing.area, component: "circadian-policy"},
        (saved: Partial<CircadianState> | undefined, now) => {
          const decided = transitionCircadian(saved, event, policyConfig, now);
          return {...decided, traces: [...inboundTraces, ...decided.traces]};
        });
      if (result.style) send([{payload: undefined, lighting: result.style}, null]);
      // Published whenever it changes, and in answer to a set, so Home
      // Assistant shows what is in use.
      if (result.stateChanged || fromSetTopic) lifecycle.publish(send, circadianStateOutputs(publishing, result.state));
      updateStatus(result.status);
      showRefused(result.traces);
      return result;
    }

    function announce(send: Send) {
      lifecycle.publish(send, circadianAnnouncement(publishing));
    }

    // Once the flows have started: the house's times (this node may have
    // restarted alone), the style, and, a moment later, its discovery.
    whenFlowsStarted(RED, node, guarded(node, () => {
      const send = node.send.bind(node);
      if (house) process({kind: "schedule", ...house.schedule()}, send);
      process({kind: "tick"}, send);
      announceTimer = setTimeout(guarded(node, () => announce(node.send.bind(node))), ANNOUNCE_DELAY_MS);
    }));
    if (house) {
      node.on("close", house.subscribe(guarded(node, () => {
        process({kind: "schedule", ...house.schedule()}, node.send.bind(node));
      })));
    }

    onInput(node, (msg, send) => {
      const lighting = objectField<CircadianEvent>(msg, "lighting");
      if (lighting?.kind === "startup") {
        clearTimeout(announceTimer);
        lifecycle.startup(send, [...circadianStartingOutputs(publishing, savedState()), ...circadianAnnouncement(publishing)]);
        process({kind: "tick"}, send);
        return;
      }
      // Home Assistant's set topics become the policy's own events; a flow
      // sends the same shapes the room controller took before 6.0.
      const inbound = circadianInbound(msg, publishing);
      if (inbound) {
        process(inbound.event, send, inbound.traces, true);
      } else {
        process(lighting ?? {kind: undefined}, send);
      }
    });

    tickTimer = setInterval(guarded(node, () => process({kind: "tick"}, node.send.bind(node))), policyConfig.intervalSeconds * 1000);

    // Deleted: rooms stop styling at once rather than when the last style
    // runs out.
    node.on("close", (removed: boolean, done: () => void) => {
      clearInterval(tickTimer);
      clearTimeout(announceTimer);
      if (wasDeleted(RED, node, removed)) {
        node.send([{payload: undefined, lighting: {...styleMessage(policyConfig, savedState(), new Date()), values: null}}, null]);
      }
      done();
    });
    updateStatus(transitionCircadian(context.get("state") as Partial<CircadianState> | undefined, {kind: "tick"}, policyConfig).status);
  }

  RED.nodes.registerType("home-circadian-lighting-policy", HomeCircadianLightingPolicy);
};

export = registerCircadianPolicy;
