"use strict";

// A publishing node's MQTT side, either way it is set up:
// - with a Broker (Node-RED's mqtt-broker node), it publishes and reads its
//   set topics itself (home-assistant-discovery.ts over mqtt-broker-link.ts):
//   its publication output is quiet, and what it now reads from the broker
//   (a Status node's message, an MQTT in still wired on a set topic) is
//   ignored with a trace, so nothing is doubled;
// - without one, as before 6.2: publications on its output, from the flows
//   start and its startup message (publishing-lifecycle.ts).
// The node calls startup and publish the same either way.

import type {Node, NodeAPI} from "node-red";
import {appendTrace, type TraceMetadata} from "../lib/bounded-trace";
import {objectField, type InputMessage, type Send} from "./adapter";
import {homeAssistantDiscovery} from "./home-assistant-discovery";
import {brokerLink, type BrokerNode} from "./mqtt-broker-link";
import {publishingLifecycle, type PublishingLifecycle, type PublishingNode} from "./publishing-lifecycle";

export interface PublishingSideParts extends PublishingNode {
  // Home Assistant's status topic while it announces entities, else null.
  statusTopic: string | null;
  // The topics it reads requests on (its set topics).
  setTopics: string[];
}

export interface PublishingSide extends PublishingLifecycle {
  broker: boolean;
  // Whether a message is one it now gets from the broker itself, ignored
  // with a trace; always false without a broker.
  fromBroker(msg: InputMessage): boolean;
  // onInput's startup option: none with a broker, which announces on each
  // connect instead of a Status node's.
  startupOption(message: Record<string, unknown>): {message: Record<string, unknown>; trace: TraceMetadata} | undefined;
}

// The Broker setting: the mqtt-broker node, or null without one (as before
// 6.2). Only read while the node publishes.
export function brokerSetting(RED: NodeAPI, value: unknown, publishing: boolean): BrokerNode | null {
  const id = typeof value === "string" ? value.trim() : "";
  if (!publishing || !id) return null;
  const broker = RED.nodes.getNode(id) as unknown as BrokerNode | null;
  if (!broker) throw new Error("its MQTT broker node isn't in the flows: choose one, or set Publish to Don't publish");
  return broker;
}

export function publishingSide(
  RED: NodeAPI,
  node: Node,
  broker: BrokerNode | null,
  parts: PublishingSideParts,
  trace: TraceMetadata,
  // A message on one of its set topics, from the broker, for the node's own
  // input handling as if from an MQTT in node.
  onSet: (msg: InputMessage, send: Send) => void
): PublishingSide {
  if (!broker) {
    const lifecycle = publishingLifecycle(RED, node, parts);
    return {
      ...lifecycle,
      broker: false,
      fromBroker: () => false,
      startupOption: (message) => ({message, trace})
    };
  }
  const homeAssistant = homeAssistantDiscovery(RED, node, brokerLink(broker, node.id, (error) => node.error(error)), {
    retainedTopics: parts.retainedTopics,
    possible: parts.possible,
    announcement: parts.starting,
    stopping: parts.stopping,
    statusTopic: parts.statusTopic,
    setTopics: parts.setTopics,
    onSet: (message) => onSet({topic: message.topic, payload: message.payload, retain: false} as InputMessage, node.send.bind(node))
  }, trace);
  return {
    broker: true,
    startup(_send, announce = []) {
      homeAssistant.publish(announce);
    },
    publish(_send, publications) {
      homeAssistant.publish(publications);
    },
    fromBroker(msg) {
      const status = objectField<{source?: unknown; text?: unknown}>(msg, "status");
      const statusNode = Boolean(status && status.source && typeof status.source === "object");
      const setTopic = typeof msg.topic === "string" && parts.setTopics.includes(msg.topic);
      if (!statusNode && !setTopic) return false;
      appendTrace(node.context(), trace, [{event: "input", outcome: "ignored", reason: "has-broker",
        details: statusNode ? {status: String(status!.text ?? "")} : {topic: msg.topic}}]);
      return true;
    },
    startupOption: () => undefined
  };
}
