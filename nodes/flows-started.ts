"use strict";

// One "flows:started" listener per Node-RED runtime, however many nodes wait
// for it. A listener per node passed Node.js's default limit of ten on
// RED.events, which printed a MaxListenersExceededWarning in the log once a
// flow held more than ten publishing nodes.

import type {NodeAPI} from "node-red";

type Events = NodeAPI["events"];

const callbacks = new WeakMap<Events, Set<() => void>>();

// Calls `callback` every time the flows start, until the returned function
// is called. Callbacks run in the order they were added; one added or
// removed while they run takes effect from the next start.
export function onFlowsStarted(events: Events, callback: () => void): () => void {
  let waiting = callbacks.get(events);
  if (!waiting) {
    const created = new Set<() => void>();
    waiting = created;
    callbacks.set(events, created);
    events.on("flows:started", () => {
      for (const run of [...created]) run();
    });
  }
  const own = () => callback();
  waiting.add(own);
  return () => {
    waiting.delete(own);
  };
}
