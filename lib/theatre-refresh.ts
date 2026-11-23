"use strict";

// When the theatre refreshes each target. A confirmed target is refreshed at
// half its freshness window, so a settled activity stays fresh; an
// unanswered refresh is re-sent a bounded number of times, then the target is
// reported as not responding, and it is still asked once per freshness
// window so it recovers when it answers again. Pure: it plans, the
// controller sends.

import {TARGETS, type TheatreTarget} from "./theatre-profiles";
import {REFRESH_ATTEMPTS, type RefreshPending} from "./theatre-state";

export type RefreshAction =
  | {target: TheatreTarget; kind: "send"}
  | {target: TheatreTarget; kind: "retry"; attempt: number}
  | {target: TheatreTarget; kind: "re-ask"}
  | {target: TheatreTarget; kind: "give-up"};

export function planRefreshes(
  pending: Record<TheatreTarget, RefreshPending | null>,
  lastObserved: (target: TheatreTarget) => number | null,
  hasRequest: boolean,
  freshnessMs: number,
  nowMs: number
): {pending: Record<TheatreTarget, RefreshPending | null>; actions: RefreshAction[]} {
  const intervalMs = freshnessMs / 2;
  const next = {...pending};
  const actions: RefreshAction[] = [];
  for (const target of TARGETS) {
    const entry = pending[target];
    if (entry) {
      if (entry.exhausted) {
        if (nowMs - entry.sentAt >= freshnessMs) {
          next[target] = {...entry, sentAt: nowMs};
          actions.push({target, kind: "re-ask"});
        }
        continue;
      }
      if (nowMs - entry.sentAt < intervalMs) continue;
      if (entry.attempts < REFRESH_ATTEMPTS) {
        next[target] = {sentAt: nowMs, attempts: entry.attempts + 1, exhausted: false};
        actions.push({target, kind: "retry", attempt: entry.attempts + 1});
      } else {
        next[target] = {...entry, exhausted: true, sentAt: nowMs};
        actions.push({target, kind: "give-up"});
      }
      continue;
    }
    const observedAt = lastObserved(target);
    if (hasRequest && observedAt !== null && nowMs - observedAt >= intervalMs) {
      next[target] = {sentAt: nowMs, attempts: 1, exhausted: false};
      actions.push({target, kind: "send"});
    }
  }
  return {pending: next, actions};
}
