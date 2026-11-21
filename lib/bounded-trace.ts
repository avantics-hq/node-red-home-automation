"use strict";

export const TRACE_SCHEMA = 1;
export const DEFAULT_TRACE_LIMIT = 200;

export interface TraceContext {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface TraceMetadata {
  area: string;
  component: string;
  limit?: number;
}

export interface TraceInput {
  at?: string;
  event: string;
  outcome: string;
  reason?: string | null;
  details?: Record<string, unknown>;
}

export interface TraceRecord {
  schema: number;
  sequence: number;
  at: string;
  area: string;
  component: string;
  event: string;
  outcome: string;
  reason: string | null;
  details: Record<string, unknown>;
}

export function appendTrace(
  context: TraceContext,
  metadata: TraceMetadata,
  entries: TraceInput[],
  now: Date | string | number = new Date()
): TraceRecord[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const limit = Number.isInteger(metadata.limit) && (metadata.limit ?? 0) > 0
    ? metadata.limit!
    : DEFAULT_TRACE_LIMIT;
  const savedHistory = context.get("trace");
  const history: TraceRecord[] = Array.isArray(savedHistory) ? savedHistory : [];
  let sequence = Number(context.get("traceSequence")) || 0;
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const appended = entries.map((entry): TraceRecord => {
    sequence += 1;
    return {
      schema: TRACE_SCHEMA,
      sequence,
      at: entry.at || at,
      area: metadata.area,
      component: metadata.component,
      event: entry.event,
      outcome: entry.outcome,
      reason: entry.reason ?? null,
      details: entry.details || {}
    };
  });

  history.push(...appended);
  context.set("trace", history.slice(-limit));
  context.set("traceSequence", sequence);
  return appended;
}
