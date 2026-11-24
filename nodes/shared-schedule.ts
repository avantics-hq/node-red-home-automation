"use strict";

import type {NodeAPI} from "node-red";
import type {SharedSchedule} from "../lib/house-schedule";

// The house schedule a node's setting references. Not set (or "", as the
// editor saves "none") means no schedule; one that is set but isn't running,
// as when it was deleted or its settings are invalid, is missing.
export function referencedSchedule(RED: NodeAPI, id: unknown): {schedule: SharedSchedule | null; missing: boolean} {
  if (typeof id !== "string" || id === "") return {schedule: null, missing: false};
  const node = RED.nodes.getNode(id) as (object & Partial<SharedSchedule>) | null;
  return typeof node?.subscribe === "function" && typeof node.schedule === "function"
    ? {schedule: node as SharedSchedule, missing: false}
    : {schedule: null, missing: true};
}
