"use strict";

// Several covers moved as one, such as the left and right of a curtain. A
// group sends each member the same request, under its own request ID, and
// reads back each member's target state. It is ready only when every member
// confirms; once every member has settled with any not ready, it reports
// which did what, rather than claiming the whole move.

import type {TargetStatus} from "./target-state";
import {targetStateEvent, type TargetStateEvent} from "./target-state";
import {jsonSetting} from "./settings";

const MEMBER = /^[a-z][a-z0-9_-]*$/;

export function coverGroupMembers(value: unknown): string[] {
  const members = jsonSetting(value, "members", []);
  if (!Array.isArray(members) || members.length < 2) throw new Error("members must be a JSON array of at least two names");
  if (!members.every((name) => typeof name === "string" && MEMBER.test(name))) throw new Error("members must be lowercase identifiers");
  if (new Set(members).size !== members.length) throw new Error("members must be unique");
  return members as string[];
}

// What a member reported: settled once ready, failed, unavailable or held by
// a person.
type MemberOutcome = TargetStatus | "manual_override";

export interface CoverGroupState {
  request: {
    requestId: string;
    generation: number;
    payload: unknown;
    members: Record<string, {requestId: string; outcome: MemberOutcome; reason: string | null}>;
  } | null;
  generation: number;
}

export type CoverGroupEvent =
  | {kind: "request"; payload: unknown; stopIfMoving?: boolean; respectManual?: boolean; source?: string}
  | {kind: "member"; requestId: string; status: string; classification?: string; reason?: string | null};

export interface CoverGroupCommand {
  topic: string;
  payload: unknown;
  requestId: string;
  stopIfMoving?: boolean;
  respectManual?: boolean;
  source?: string;
}

const SETTLED: Record<string, true> = {ready: true, failed: true, unavailable: true, manual_override: true};

export function transitionCoverGroup(saved: Partial<CoverGroupState> | undefined, event: CoverGroupEvent, members: string[], now: Date) {
  const state: CoverGroupState = {
    request: saved?.request ? {...saved.request, members: {...saved.request.members}} : null,
    generation: Number.isInteger(saved?.generation) ? saved!.generation! : 0
  };
  const commands: CoverGroupCommand[] = [];
  const traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [];
  let changed = false;

  if (event.kind === "request") {
    state.generation += 1;
    const requestId = `group-${now.getTime()}-${state.generation}`;
    state.request = {requestId, generation: state.generation, payload: event.payload, members: {}};
    for (const member of members) {
      const memberRequestId = `${requestId}:${member}`;
      state.request.members[member] = {requestId: memberRequestId, outcome: "transitioning", reason: null};
      commands.push({
        topic: member,
        payload: event.payload,
        requestId: memberRequestId,
        ...(event.stopIfMoving === true ? {stopIfMoving: true} : {}),
        ...(event.respectManual === true ? {respectManual: true} : {}),
        ...(typeof event.source === "string" && event.source ? {source: event.source} : {})
      });
    }
    changed = true;
    traces.push({event: "request", outcome: "sent", reason: null, details: {requestId, members}});
  } else {
    const entry = state.request && Object.entries(state.request.members).find(([, member]) => member.requestId === event.requestId);
    if (!entry) {
      traces.push({event: "member", outcome: "ignored", reason: "other-request", details: {requestId: event.requestId}});
    } else {
      const [name, member] = entry;
      const outcome: MemberOutcome = event.classification === "manual_override" ? "manual_override" : event.status as TargetStatus;
      if (member.outcome !== outcome) {
        state.request!.members[name] = {...member, outcome, reason: event.reason ?? null};
        changed = true;
        traces.push({event: "member", outcome, reason: event.reason ?? null, details: {member: name}});
      }
    }
  }

  const events: Array<{theatre: TargetStateEvent<"cover", Record<string, unknown>>}> = [];
  if (state.request && changed) {
    const outcomes = Object.values(state.request.members);
    const allReady = outcomes.every(({outcome}) => outcome === "ready");
    const allSettled = outcomes.every(({outcome}) => SETTLED[outcome]);
    const status: TargetStatus = allReady ? "ready" : allSettled ? "failed" : "transitioning";
    const confirmed = Object.entries(state.request.members).filter(([, member]) => member.outcome === "ready").map(([name]) => name);
    events.push({theatre: targetStateEvent({
      target: "cover" as const,
      requestId: state.request.requestId,
      generation: state.request.generation,
      status,
      observedAt: now.toISOString(),
      details: {
        request: state.request.payload,
        members: Object.fromEntries(Object.entries(state.request.members).map(([name, member]) => [name, {status: member.outcome, reason: member.reason}])),
        confirmed
      },
      failure: status === "failed" ? {reason: confirmed.length ? "partial" : "none-confirmed", confirmed} : null
    })});
  }
  const counts = state.request ? Object.values(state.request.members) : [];
  const ready = counts.filter(({outcome}) => outcome === "ready").length;
  return {
    state,
    commands,
    events,
    traces,
    status: {text: state.request ? `${ready}/${counts.length} confirmed` : "idle", ready, total: counts.length}
  };
}
