/**
 * The night's chain (v3 F9, ADR 0074, B5). The full snapshot (00:30) is followed, on its completion, by the audit of it
 * (the snapshot service's `afterFull` hook). Two scheduled jobs use what that chain produces but run at a clock time:
 * the block-id sweep (05:30, candidates from the latest snapshot) and the automation run (06:30, acting on the audit's
 * findings). Now that the full snapshot runs as bulk (P4, at most 30% of each tier) it can take longer, so a scheduled
 * run of either waits here until the chain of its project has finished, instead of racing it with the night before's
 * data. A manual run ("Run now") never waits.
 *
 * Bounded: after `maxWaitMs` the run is skipped (and the skip recorded with the reason), never run against a half-taken
 * snapshot; the next night's run goes as usual.
 */
import { sleep, type Clock } from '../lk/governor/clock.js';
import type { MaintenanceResult, RunTrigger } from './types.js';

/** What of a project's night chain is still under way (the full snapshot, the audit after it), or null when none is. */
export type ChainBusy = (projectId: string) => string | null;

export interface ChainWaitOptions {
  readonly clock: Clock;
  /** Ends the wait (the bridge is stopping). */
  readonly signal?: AbortSignal;
  /** How often to look again (default 30 s). */
  readonly pollMs?: number;
  /** The longest wait before the run is skipped (default 6 hours). */
  readonly maxWaitMs?: number;
}

export const CHAIN_POLL_MS = 30_000;
export const CHAIN_MAX_WAIT_MS = 6 * 3_600_000;

export type ChainOutcome =
  | { readonly go: true; readonly waitedMs: number; readonly waitedFor: string | null }
  | { readonly go: false; readonly result: MaintenanceResult };

/**
 * Waits while `busy` names something of the project's chain. A manual trigger goes at once. Returns whether to go on
 * (and how long it waited, for the summary), or the skip to record.
 */
export async function afterNightChain(
  busy: ChainBusy | undefined,
  projectId: string,
  trigger: RunTrigger,
  o: ChainWaitOptions,
): Promise<ChainOutcome> {
  if (!busy || trigger === 'manual') return { go: true, waitedMs: 0, waitedFor: null };
  const started = o.clock.now();
  const poll = o.pollMs ?? CHAIN_POLL_MS;
  const max = o.maxWaitMs ?? CHAIN_MAX_WAIT_MS;
  let waitedFor: string | null = null;
  for (;;) {
    const why = busy(projectId);
    if (why === null) return { go: true, waitedMs: o.clock.now() - started, waitedFor };
    waitedFor ??= why;
    const waited = o.clock.now() - started;
    if (waited >= max)
      return {
        go: false,
        result: {
          skipped: true,
          summary: `Skipped: ${why} after ${Math.round(waited / 60_000)} minutes of waiting; this run uses what the night's chain produces, so it waits for the next one.`,
        },
      };
    try {
      await sleep(o.clock, Math.min(poll, max - waited), o.signal);
    } catch {
      return {
        go: false,
        result: { skipped: true, summary: 'Skipped: the bridge stopped while this run waited.' },
      };
    }
  }
}

/** The run's summary with the wait in front, when there was one. */
export function withWaitNote(
  r: MaintenanceResult,
  waitedMs: number,
  waitedFor: string | null,
): MaintenanceResult {
  if (waitedFor === null || waitedMs < 1000) return r;
  return { ...r, summary: `Waited ${Math.round(waitedMs / 60_000)} min (${waitedFor}). ${r.summary}` };
}
