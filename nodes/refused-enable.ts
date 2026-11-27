"use strict";

// How a node shows an enable it refused (lib/enable-input.ts): never read as
// off, but on its status until the next input, and in its log once per
// input per deploy. The reducer traces the refusal with the input's name as
// details.source and the value as details.payload.
import type {Node} from "node-red";
import {NOT_TRUE_OR_FALSE} from "../lib/enable-input";

interface Trace {
  reason: string | null;
  details: unknown;
}

// `named` gives the input's name as the warning says it, such as
// "circadian's enabled".
export function refusedEnables(node: Node, named: (source: string) => string = (source) => source) {
  const warned = new Set<string>();
  // Shows the first refusal among these traces, if any; true when there was
  // one, so the caller leaves the status as set.
  return function show(traces: Trace[]): boolean {
    const refused = traces.find(({reason}) => reason === NOT_TRUE_OR_FALSE);
    if (!refused) return false;
    const {source, payload} = refused.details as {source: string; payload: string};
    if (!warned.has(source)) {
      warned.add(source);
      node.warn(`${named(source)} takes only true or false: ${payload} was refused, and nothing changed`);
    }
    node.status({fill: "yellow", shape: "ring", text: `refused ${source} ${payload}: send true or false`});
    return true;
  };
}
