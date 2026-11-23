/**
 * v3 F5c (ADR 0069, H8): the workstream label in force for one MCP tool call. The tool layer runs every write tool's
 * handler inside a frame holding the label (the call's own `workstream` argument, else its connection's default), and
 * `mcpOrigin` puts it on the engine origin, so the job, the proposal and the journal entries record it without every
 * tool passing it along.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface WorkstreamFrame {
  /** The label in force (null: none). */
  readonly label: string | null;
  /** Where it came from: the call's own argument, or the connection's default (`bridge_workstream`). */
  readonly source: 'argument' | 'default' | null;
}

const als = new AsyncLocalStorage<WorkstreamFrame>();

/** Runs `fn` with `frame` as the call's workstream. */
export function withWorkstream<T>(frame: WorkstreamFrame, fn: () => T): T {
  return als.run(frame, fn);
}

/** The label in force for the current tool call (null: none, or not inside a tool call). */
export function currentWorkstream(): string | null {
  return als.getStore()?.label ?? null;
}

/** The whole frame of the current tool call (undefined: not inside one). */
export function currentFrame(): WorkstreamFrame | undefined {
  return als.getStore();
}

/** The most characters a label may have. */
export const WORKSTREAM_MAX = 80;

/** A label as stored: trimmed, inner whitespace collapsed; null when nothing is left. */
export function normaliseWorkstream(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.normalize('NFC').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t.slice(0, WORKSTREAM_MAX);
}
