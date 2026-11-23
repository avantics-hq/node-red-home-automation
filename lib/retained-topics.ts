"use strict";

// Clearing retained topics a node no longer publishes. A node records the
// retained topics it publishes; at its next start, any recorded topic it no
// longer publishes, after a change of area, base topic, discovery prefix or
// targets, is cleared with an empty retained message. With no record (a new
// node, or after a restart without a persistent context store) there is
// nothing known to clear.

export interface RetainedClear {
  topic: string;
  payload: "";
  retain: true;
}

// `keepStale` keeps the stale topics in the record, to clear again next
// time: for a clear sent when the broker may not be connected yet.
export function staleRetainedTopics(
  recorded: readonly string[] | undefined,
  current: readonly string[],
  keepStale = false
): {clears: RetainedClear[]; record: string[]} {
  const publishing = new Set(current);
  const stale = [...new Set(recorded ?? [])].filter((topic) => !publishing.has(topic));
  return {
    clears: stale.map((topic) => ({topic, payload: "", retain: true})),
    record: keepStale ? [...publishing, ...stale] : [...publishing]
  };
}
