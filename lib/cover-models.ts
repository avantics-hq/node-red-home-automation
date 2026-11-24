"use strict";

// The two kinds of cover a cover node can own, behind one shape, so the node
// treats them alike: a position cover (0 to 100) and an open/close-only
// cover. Each says how to take an event, whether the cover is moving, when
// to check on it next, and whether it takes positions.

import {coverMoving, normaliseCoverConfig, transitionCover, type CoverEvent, type CoverState} from "./cover-controller";
import {normaliseOpenCloseConfig, openCloseMoving, openCloseTargetStates, transitionOpenCloseCover, type OpenCloseEvent, type OpenCloseState} from "./open-close-cover";

export const COVER_TYPES = ["position", "open-close"] as const;
export type CoverType = typeof COVER_TYPES[number];

export interface CoverTransition {
  state: unknown;
  commands: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  traces: Array<{event: string; outcome: string; reason: string | null; details: Record<string, unknown>}>;
  status: {phase: string; moving: boolean; text: string; battery: number | null; observed: boolean};
}

export interface CoverModel {
  // Whether it takes positions and presets, not only open, close and stop.
  positions: boolean;
  transition(saved: unknown, event: unknown, now: Date): CoverTransition;
  moving(saved: unknown): boolean;
  generation(saved: unknown): number;
  // When to check on a move in progress, and for which request.
  tickAt(state: unknown): {at: number; generation: number} | null;
}

export function positionCover(settings: Record<string, unknown>): CoverModel {
  const config = normaliseCoverConfig(settings);
  return {
    positions: true,
    transition(saved, event, now) {
      const result = transitionCover(saved as Partial<CoverState> | undefined, {cover: event as CoverEvent}, config, now);
      return {
        state: result.state,
        commands: result.commands as unknown as Array<Record<string, unknown>>,
        events: result.events as unknown as Array<Record<string, unknown>>,
        traces: result.traces,
        status: {...result.status, battery: result.state.observed?.battery ?? null, observed: result.state.observed !== null}
      };
    },
    moving(saved) {
      const state = saved as Partial<CoverState> | undefined;
      return state ? coverMoving({observed: state.observed ?? null, phase: state.phase ?? "idle"}) : false;
    },
    generation: (saved) => (saved as Partial<CoverState> | undefined)?.generation ?? 0,
    tickAt(state) {
      const cover = state as CoverState;
      return cover.pending ? {at: Math.min(cover.pending.nextAt, cover.pending.deadlineAt), generation: cover.generation} : null;
    }
  };
}

export function openCloseCover(settings: Record<string, unknown>): CoverModel {
  const config = normaliseOpenCloseConfig(settings);
  return {
    positions: false,
    transition(saved, event, now) {
      const result = transitionOpenCloseCover(saved as Partial<OpenCloseState> | undefined, event as OpenCloseEvent, config, now);
      return {
        state: result.state,
        commands: result.commands as unknown as Array<Record<string, unknown>>,
        events: openCloseTargetStates(result, now) as unknown as Array<Record<string, unknown>>,
        traces: result.traces,
        status: {...result.status, battery: null, observed: result.state.reports}
      };
    },
    moving(saved) {
      const state = saved as Partial<OpenCloseState> | undefined;
      return state ? openCloseMoving({motion: state.motion ?? null, phase: state.phase ?? "idle"}) : false;
    },
    generation: (saved) => (saved as Partial<OpenCloseState> | undefined)?.generation ?? 0,
    tickAt(state) {
      const cover = state as OpenCloseState;
      return cover.pending ? {at: cover.pending.deadlineAt, generation: cover.generation} : null;
    }
  };
}
