"use strict";

// A node's Home Assistant side over its own broker link (mqtt-broker-link.ts),
// in place of an MQTT out node, a set-topic MQTT in node and a Status node.
// The node says what it publishes; this module decides when:
// - on every connect, reconnects included, and when Home Assistant comes
//   back (its birth message, "online" on <prefix>/status): it clears what
//   it no longer publishes, then announces its discovery entries,
//   availability and state, so entities come back after a broker or Home
//   Assistant restart;
// - it subscribes to exactly the set topics it advertised, so its own
//   echoes or another node's topics can never become requests, and ignores
//   a retained set message, which the broker would replay on every
//   reconnect;
// - as the node stops, offline; when it is deleted, everything it
//   published cleared. These are publishingLifecycle's rules
//   (publishing-lifecycle.ts), for a node with a broker.
// The topics and payloads stay the node's own (lib/*-publishing.ts).

import type {Node, NodeAPI} from "node-red";
import {appendTrace, type TraceMetadata} from "../lib/bounded-trace";
import {ownDiscoveryTopics, type DiscoveryOwner} from "../lib/ha-discovery";
import {retainedClears} from "../lib/retained-topics";
import {allRetainedTopics, clearStaleRetained, wasDeleted} from "./adapter";
import type {BrokerLink, BrokerMessage} from "./mqtt-broker-link";

export interface RetainedPublication {
  topic: string;
  payload: unknown;
  retain: boolean;
}

export interface HomeAssistantParts {
  // Every retained topic the node publishes with its current settings.
  retainedTopics(): string[];
  // What it could publish with its publishing switched on (see
  // publishing-lifecycle.ts).
  possible?: {owner: DiscoveryOwner; topics(): string[]};
  // What it announces on each connect: its entries (or their removal),
  // availability and current state.
  announcement(): RetainedPublication[];
  // What it publishes as it stops: its availability, offline.
  stopping(): RetainedPublication[];
  // Home Assistant's status topic while it announces entities, else null.
  statusTopic: string | null;
  // The set topics it advertised, and what a person sent on one.
  setTopics?: string[];
  onSet?(message: BrokerMessage): void;
}

export interface HomeAssistantDiscovery {
  // Any other publications, such as a state change.
  publish(publications: RetainedPublication[]): void;
}

// MQTT payloads as text: an object as JSON, as the broker node would.
function text(payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") return JSON.stringify(payload);
  return String(payload);
}

export function homeAssistantDiscovery(
  RED: NodeAPI,
  node: Node,
  link: BrokerLink,
  parts: HomeAssistantParts,
  trace: TraceMetadata
): HomeAssistantDiscovery {
  const record = (event: string, outcome: string, reason: string | null, details: Record<string, unknown> = {}) =>
    appendTrace(node.context(), trace, [{event, outcome, reason, details}]);
  function publish(publications: RetainedPublication[]) {
    for (const {topic, payload, retain} of publications) link.publish(topic, text(payload), {retain});
  }
  const possible = () => parts.possible ? ownDiscoveryTopics(parts.possible.owner, parts.possible.topics()) : [];
  function announce(reason: string) {
    publish([...clearStaleRetained(node, parts.retainedTopics(), "startup", possible()), ...parts.announcement()]);
    record("home-assistant", "announced", reason);
  }

  link.onConnected(() => announce("connected"));
  if (parts.statusTopic) {
    link.subscribe(parts.statusTopic, (message) => {
      if (message.payload.trim().toLowerCase() === "online") announce("home-assistant-online");
    });
  }
  for (const topic of parts.setTopics ?? []) {
    link.subscribe(topic, (message) => {
      // A retained set message would replay on every reconnect.
      if (message.retain) record("set", "ignored", "retained-message", {topic: message.topic});
      else parts.onSet?.(message);
    });
  }

  node.on("close", (removed: boolean, done: () => void) => {
    // Reaches the broker only while it is still connected, as in a deploy of
    // modified nodes or flows; the broker's own Close and Will messages cover
    // a full deploy, a restart and a crash.
    publish(wasDeleted(RED, node, removed)
      ? retainedClears(allRetainedTopics(node, [...parts.retainedTopics(), ...possible()]))
      : parts.stopping());
    link.close(removed, done);
  });

  return {publish};
}
