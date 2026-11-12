/**
 * Waiting for parked and queued writes in the sandbox scripts (the owner's sandbox run of 12 November 2026).
 *
 * A sandbox file shares the test project's budget (120 writes a minute) with whatever else runs. A write the governor
 * parks for budget (`waiting_budget`) or queues behind the pacing (`queued`) has NOT failed: it runs by itself. These
 * helpers wait for it (at most `maxWaits` × `waitMs`, 10 minutes by default) and never send it again; a read refused
 * for budget is made again once the budget allows. The smoke, assumptions and images scripts use them for every write,
 * their clean-up included, so nothing they create is left behind because a write was parked.
 */
import { BudgetExhaustedError, type JobEngine, type JobView, type RunOptions } from '../../src/jobs/index.js';

export interface WaitOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  /** How many `engine.wait` rounds a parked or queued job gets (default 24). */
  readonly maxWaits?: number;
  /** One round (default 25 s). */
  readonly waitMs?: number;
  /** Retries of a read refused for budget (default 5). */
  readonly budgetRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until a job ends; returns it when it succeeded, throws when it failed, was cancelled, or never ended. */
export async function waitForJob(
  engine: JobEngine,
  projectId: string,
  jobId: string,
  what: string,
  o: WaitOptions = {},
): Promise<JobView> {
  const rounds = o.maxWaits ?? 24;
  let job: JobView | undefined;
  for (let i = 0; i < rounds; i++) {
    job = await engine.wait(projectId, jobId, o.waitMs ?? 25_000);
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(`${what} ${job.status}: ${job.lastError?.message ?? ''}`);
    }
  }
  throw new Error(`${what} did not complete: still ${job?.status ?? 'unknown'} (job ${jobId})`);
}

/**
 * Runs one operation and settles it: a read refused for budget is made again when the budget allows; a write parked
 * or queued is waited for (never sent again). Returns the operation's result.
 */
export async function runSettled(
  t: { readonly engine: JobEngine; readonly projectId: string },
  op: string,
  params: Parameters<JobEngine['run']>[1],
  opts: RunOptions,
  o: WaitOptions = {},
): Promise<unknown> {
  const sleep = o.sleep ?? defaultSleep;
  let r: Awaited<ReturnType<JobEngine['run']>> | undefined;
  for (let i = 0; !r; i++) {
    try {
      r = await t.engine.run(op, params, opts);
    } catch (e) {
      if (!(e instanceof BudgetExhaustedError) || i >= (o.budgetRetries ?? 5)) throw e;
      await sleep(Math.max(1000, e.retryAtMs - Date.now()));
    }
  }
  if (r.status === 'succeeded') return r.result;
  if ((r.status === 'waiting_budget' || r.status === 'queued') && r.jobId) {
    await waitForJob(t.engine, t.projectId, r.jobId, op, o);
    return t.engine.stepResults(t.projectId, r.jobId)?.[0]?.value;
  }
  throw new Error(`${op} did not complete: ${r.status}`);
}
