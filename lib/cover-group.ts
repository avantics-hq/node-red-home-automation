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

export const DEFAULT_GROUP_DEADLINE_SECONDS = 120;

export interface CoverGroupState {
  request: {
    requestId: string;
    generation: number;
    payload: unknown;
    // When members that haven't answered count as not answering (epoch ms).
    deadlineAt: number;
    // Whether the group has given its final answer.
    settled: boolean;
    members: Record<string, {requestId: string; outcome: MemberOutcome; reason: string | null}>;
  } | null;
  generation: number;
}

export type CoverGroupEvent =
  | {kind: "request"; payload: unknown; stopIfMoving?: boolean; respectManual?: boolean; source?: string}
  | {kind: "member"; requestId: string; status: string; classification?: string; reason?: string | null}
  | {kind: "tick"};

export interface CoverGroupCommand {
  topic: string;
  payload: unknown;
  // The member's own ID for this request, which the cover node answers with.
  coverRequestId: string;
  stopIfMoving?: boolean;
  respectManual?: boolean;
  source?: string;
}

const SETTLED: Record<string, true> = {ready: true, failed: true, unavailable: true, manual_override: true};

export function transitionCoverGroup(
  saved: Partial<CoverGroupState> | undefined,
  event: CoverGroupEvent,
  members: string[],
  now: Date,
  deadlineSeconds = DEFAULT_GROUP_DEADLINE_SECONDS
) {
  const state: CoverGroupState = {
    request: saved?.request ? {...saved.request, settled: saved.request.settled === true, members: {...saved.request.members}} : null,
    generation: Number.isInteger(saved?.generation) ? saved!.generation! : 0
  };
  const commands: CoverGroupCommand[] = [];
  const traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}> = [];
  let changed = false;
  const events: Array<{theatre: TargetStateEvent<"cover", Record<string, unknown>>}> = [];

  // The group's answer for its open request, from what its members did.
  function answer(supersededBy: string | null = null) {
    const request = state.request!;
    const outcomes = Object.values(request.members);
    const allReady = outcomes.every(({outcome}) => outcome === "ready");
    const allSettled = outcomes.every(({outcome}) => SETTLED[outcome]);
    const confirmed = Object.entries(request.members).filter(([, member]) => member.outcome === "ready").map(([name]) => name);
    const status: TargetStatus = supersededBy ? "failed" : allReady ? "ready" : allSettled ? "failed" : "transitioning";
    if (status !== "transitioning") request.settled = true;
    const reason = supersededBy ? "superseded" : confirmed.length ? "partial" : "none-confirmed";
    events.push({theatre: targetStateEvent({
      target: "cover" as const,
      requestId: request.requestId,
      generation: request.generation,
      status,
      observedAt: now.toISOString(),
      details: {
        request: request.payload,
        members: Object.fromEntries(Object.entries(request.members).map(([name, member]) => [name, {status: member.outcome, reason: member.reason}])),
        confirmed,
        ...(supersededBy ? {supersededBy} : {})
      },
      failure: status === "failed" ? {reason, confirmed} : null
    })});
  }

  // Members still silent at the deadline are not answering: the group
  // settles with what it has.
  if (state.request && !state.request.settled && now.getTime() >= state.request.deadlineAt) {
    for (const [name, member] of Object.entries(state.request.members)) {
      if (!SETTLED[member.outcome]) {
        state.request.members[name] = {...member, outcome: "failed", reason: "no-answer"};
        traces.push({event: "member", outcome: "failed", reason: "no-answer", details: {member: name}});
      }
    }
    changed = true;
  }

  if (event.kind === "tick") {
    // Only the deadline, above.
  } else if (event.kind === "request") {
    if (state.request && !state.request.settled && !changed) {
      // The open request gets its final answer before the new one goes out.
      answer(`group-${now.getTime()}-${state.generation + 1}`);
      traces.push({event: "request", outcome: "superseded", reason: null, details: {requestId: state.request.requestId}});
    } else if (changed && state.request) {
      answer();
      changed = false;
    }
    state.generation += 1;
    const requestId = `group-${now.getTime()}-${state.generation}`;
    state.request = {requestId, generation: state.generation, payload: event.payload, deadlineAt: now.getTime() + deadlineSeconds * 1000, settled: false, members: {}};
    for (const member of members) {
      const memberRequestId = `${requestId}:${member}`;
      state.request.members[member] = {requestId: memberRequestId, outcome: "transitioning", reason: null};
      commands.push({
        topic: member,
        payload: event.payload,
        coverRequestId: memberRequestId,
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

  if (state.request && changed) answer();
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
