"use strict";

// What every node that publishes retained MQTT state does around its own
// work, so each adapter only says what it publishes:
// - once the flows have started: clear what it no longer publishes, then
//   announce itself;
// - at a startup message: clear again (see clearStaleRetained);
// - as it stops: go offline, or, when deleted, clear everything it published.

import type {Node, NodeAPI} from "node-red";
import {ownDiscoveryTopics, type DiscoveryOwner} from "../lib/ha-discovery";
import {retainedClears} from "../lib/retained-topics";
import {allRetainedTopics, clearStaleRetained, wasDeleted, whenFlowsStarted, type Send} from "./adapter";

interface RetainedPublication {
  topic: string;
  payload: unknown;
  retain: boolean;
}

export interface PublishingNode {
  // Every retained topic the node publishes with its current settings.
  retainedTopics(): string[];
  // What it could publish with its publishing switched on, to clear what it
  // no longer publishes without needing a record of what it published
  // before. Only the discovery topics named after this node itself are used
  // (see ownDiscoveryTopics), so the clear never touches another node's
  // topics: none under the area scheme.
  possible?: {owner: DiscoveryOwner; topics(): string[]};
  // What it publishes once the flows have started, and as it stops.
  starting(): RetainedPublication[];
  stopping(): RetainedPublication[];
  // Which of its outputs the publications go on, and how many it has.
  output: number;
  outputs: number;
}

export interface PublishingLifecycle {
  // At a startup message: the clears, then anything else to announce.
  startup(send: Send, announce?: RetainedPublication[]): void;
  // Any other publications, such as a state change, on the publishing output.
  publish(send: Send, publications: RetainedPublication[]): void;
}

export function publishingLifecycle(RED: NodeAPI, node: Node, publishing: PublishingNode): PublishingLifecycle {
  const possible = () => publishing.possible ? ownDiscoveryTopics(publishing.possible.owner, publishing.possible.topics()) : [];
  function publish(send: Send, publications: RetainedPublication[]) {
    if (!publications.length) return;
    const envelope: Array<RetainedPublication[] | null> = Array.from({length: publishing.outputs}, () => null);
    envelope[publishing.output] = publications.map((entry) => ({...entry}));
    send(envelope as Parameters<Send>[0]);
  }

  whenFlowsStarted(RED, node, () => {
    publish(node.send.bind(node), [
      ...clearStaleRetained(node, publishing.retainedTopics(), "flows-started", possible()),
      ...publishing.starting()
    ]);
  });

  // Reaches the broker only if the MQTT out node is still running, as in a
  // deploy of modified nodes or flows; the broker's own Close and Will
  // messages cover a full deploy, a restart and a crash (see the README).
  node.on("close", (removed: boolean, done: () => void) => {
    publish(node.send.bind(node), wasDeleted(RED, node, removed)
      ? retainedClears(allRetainedTopics(node, [...publishing.retainedTopics(), ...possible()]))
      : publishing.stopping());
    done();
  });

  return {
    startup(send, announce = []) {
      publish(send, [...clearStaleRetained(node, publishing.retainedTopics(), "startup", possible()), ...announce]);
    },
    publish
  };
}
