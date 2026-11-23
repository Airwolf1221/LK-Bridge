/**
 * `arkona_identity_reconcile`'s service (v3 F5c, ADR 0069, H6): it records each submitted call (a job or a proposal),
 * follows its job, and when the job ends works out every item's outcome from the job's own steps (done and verified,
 * partly done, skipped, failed, not run, excluded), runs the consistency check for each character it touched (free:
 * the snapshots) and keeps its new or still-open findings as the item's follow-ups.
 */
import type { Db } from '../../db/open.js';
import { EXPECT_STEP, VERIFY_STEP } from '../../jobs/internal-steps.js';
import { TERMINAL_JOB_STATUSES, type JobView, type SkippedItem } from '../../jobs/types.js';
import type { ProposalView } from '../../policy/types.js';
import { IDENTITY_CHECKS } from './checks.js';
import {
  IdentityRecords,
  type IdentityRecord,
  type ItemOutcome,
  type ItemStatus,
  type PlannedItem,
} from './store.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const IDENTITY_TOOL = 'arkona_identity_reconcile';
const ROW_OPS = new Set(['createPropertyRow', 'updatePropertyRow', 'deletePropertyRow', 'updateProperty']);

export interface IdentityStepRecord {
  readonly stepNo: number;
  readonly opId: string;
  readonly status: string;
  readonly options: { readonly items?: readonly string[] };
  readonly params: { readonly body?: unknown };
  readonly result: unknown;
}

export interface IdentityDeps {
  readonly db: Db;
  readonly engine: {
    readonly events: { on(e: 'job', f: (e: { type: string; job: JobView }) => void): () => void };
    readonly queries: { getJob(projectId: string, jobId: string): JobView | undefined };
    stepRecords(projectId: string, jobId: string): readonly IdentityStepRecord[] | undefined;
    stepResults(
      projectId: string,
      jobId: string,
    ): readonly { stepNo: number; status: string; error: unknown }[] | undefined;
    skippedItems(projectId: string, jobId: string): SkippedItem[];
  };
  readonly proposals: {
    addHooks(h: { afterSubmit?(ctx: { readonly proposal: ProposalView; readonly jobId: string }): void }): () => void;
  };
  /** The consistency findings of one character (its identity page), free; null when the check cannot run. */
  readonly consistency?: (projectId: string, identityPageId: string) => Promise<readonly Obj[] | null>;
  readonly now: () => number;
  readonly log?: { warn(o: unknown, m: string): void };
}

/** The kind of an item's step, for its outcome. */
function roleOf(s: IdentityStepRecord): 'check' | 'rowsCheck' | 'factWrite' | 'factsVerify' | 'tagWrite' | 'tagsVerify' | 'other' {
  const body = isObj(s.params?.body) ? s.params.body : {};
  if (s.opId === EXPECT_STEP) {
    const c = Array.isArray(body.checks) ? (body.checks as Obj[])[0] : undefined;
    return c?.checker === IDENTITY_CHECKS.page ? 'check' : 'rowsCheck';
  }
  if (s.opId === VERIFY_STEP) {
    const t = Array.isArray(body.targets) ? (body.targets as Obj[])[0] : undefined;
    return t?.checker === IDENTITY_CHECKS.tagsVerify ? 'tagsVerify' : t?.kind === 'sidebar' ? 'factsVerify' : 'other';
  }
  if (ROW_OPS.has(s.opId)) return 'factWrite';
  if (s.opId === 'updateResource') return 'tagWrite';
  return 'other';
}

const verificationOf = (result: unknown): string | null => {
  if (!isObj(result)) return null;
  const v = result.verification;
  return isObj(v) && typeof v.status === 'string' ? v.status : null;
};
const skippedHere = (result: unknown, item: string): SkippedItem | null => {
  if (!isObj(result) || !Array.isArray(result.skippedItems)) return null;
  return ((result.skippedItems as SkippedItem[]).find((x) => x.item === item) ?? null) as SkippedItem | null;
};
/** A step the engine did not send because its items were skipped earlier (its result names them as `items`). */
const wasSkipStub = (result: unknown) =>
  isObj(result) && typeof result.skipped === 'string' && Array.isArray(result.items);

/** Every item's outcome from the job's steps (pure, for the tests too). */
export function outcomesOf(
  plan: readonly PlannedItem[],
  steps: readonly IdentityStepRecord[],
  errors: ReadonlyMap<number, unknown>,
  jobStatus: string,
): ItemOutcome[] {
  return plan.map((p): ItemOutcome => {
    const base = { item: p.item, character: p.character, page: p.page ? { id: p.page.id, name: p.page.name } : null };
    if (p.status === 'refused')
      return { ...base, status: 'refused', reason: `${p.refusal?.code ?? 'REFUSED'}: ${p.refusal?.message ?? ''}` };
    if (p.status === 'no_change')
      return {
        ...base,
        status: 'done',
        reason: 'nothing to change: the page already holds these facts and tags',
        facts: { written: false, verified: null },
        tags: { status: p.tags?.status ?? 'off' },
      };
    const mine = steps.filter((s) => (s.options.items ?? []).includes(p.item));
    if (mine.length === 0)
      return { ...base, status: 'excluded', reason: 'left out by the owner when the proposal was approved' };
    const by = (r: ReturnType<typeof roleOf>) => mine.filter((s) => roleOf(s) === r);
    const failed = mine.find((s) => s.status === 'failed' || s.status === 'uncertain');
    const tagsPlan = p.tags?.status ?? 'off';
    const tagHeld = tagsPlan === 'held';
    // Where an item was skipped (changed meanwhile), and by which step.
    let skip: { s: IdentityStepRecord; x: SkippedItem } | null = null;
    for (const s of mine) {
      const x = skippedHere(s.result, p.item);
      if (x && !wasSkipStub(s.result)) {
        skip = { s, x };
        break;
      }
    }
    const factWrites = by('factWrite');
    const written = factWrites.filter((s) => s.status === 'succeeded' && !wasSkipStub(s.result) && !skippedHere(s.result, p.item));
    const fv = by('factsVerify')[0];
    const factsVerified = fv && fv.status === 'succeeded' && !wasSkipStub(fv.result) ? verificationOf(fv.result) === 'verified' : null;
    const tw = by('tagWrite')[0];
    const tv = by('tagsVerify')[0];
    const tagsVerified = tv && tv.status === 'succeeded' && !wasSkipStub(tv.result) ? verificationOf(tv.result) === 'verified' : null;
    const facts = {
      written: written.length > 0,
      verified: factWrites.length === 0 ? null : factsVerified,
    };
    if (failed) {
      const e = errors.get(failed.stepNo) as { code?: unknown; message?: unknown } | null | undefined;
      const unknown = failed.status === 'uncertain';
      return {
        ...base,
        status: 'failed',
        reason: unknown
          ? 'a write’s outcome is unknown (the bridge reconciles it); the rest of this character was not run'
          : `${typeof e?.code === 'string' ? `${e.code}: ` : ''}${typeof e?.message === 'string' ? e.message : 'a step failed'}; the rest of this character was not run (Resume runs it again)`,
        facts,
        tags: { status: tw?.status === 'succeeded' ? 'written' : 'not_written' },
      };
    }
    if (mine.some((s) => s.status === 'pending' || s.status === 'running' || s.status === 'cancelled'))
      return {
        ...base,
        status: 'not_run',
        reason: TERMINAL_JOB_STATUSES.has(jobStatus as JobView['status'])
          ? 'the job stopped before this character was finished (Resume continues it)'
          : 'the job has not reached it yet',
        facts,
      };
    if (skip) {
      const role = roleOf(skip.s);
      if (role === 'check' || (role === 'factWrite' && written.length === 0))
        return { ...base, status: 'skipped', reason: skip.x.reason, facts: { written: false, verified: null } };
      if (role === 'factWrite')
        return {
          ...base,
          status: 'partly_done',
          reason: `some facts were written, then: ${skip.x.reason}`,
          facts,
          tags: { status: 'not_written' },
        };
      // The tags: the facts are written and read back; the tags were not written.
      return {
        ...base,
        status: facts.verified === false ? 'failed' : 'partly_done',
        reason: facts.verified === false ? 'the facts were written but their read-back differs' : `facts written; tags not written: ${skip.x.reason}`,
        facts,
        tags: { status: skip.x.reason.startsWith('held') ? 'held' : 'skipped', reason: skip.x.reason },
      };
    }
    if (facts.verified === false)
      return { ...base, status: 'failed', reason: 'the facts were written but their read-back differs', facts };
    if (tw) {
      const unchanged = isObj(tw.result) && tw.result.unchanged === true;
      if (tagsVerified === false)
        return {
          ...base,
          status: 'failed',
          reason: 'the tags were written but their read-back differs',
          facts,
          tags: { status: 'written', verified: false },
        };
      return {
        ...base,
        status: 'done',
        facts,
        tags: { status: unchanged ? 'already_correct' : 'written', verified: tagsVerified },
      };
    }
    if (tagHeld)
      return {
        ...base,
        status: 'partly_done',
        reason: `facts written; tags held: ${p.tags?.reason ?? 'the owner decides'}`,
        facts,
        tags: { status: 'held', ...(p.tags?.reason ? { reason: p.tags.reason } : {}) },
      };
    return {
      ...base,
      status: 'done',
      facts,
      tags: { status: tagsPlan, ...(p.tags?.reason ? { reason: p.tags.reason } : {}) },
    };
  });
}

/** One line: how many of each outcome. */
export function summaryOf(items: readonly ItemOutcome[]): string {
  const order: ItemStatus[] = ['done', 'partly_done', 'skipped', 'failed', 'not_run', 'refused', 'excluded'];
  const words: Record<ItemStatus, string> = {
    done: 'done and verified',
    partly_done: 'partly done',
    skipped: 'skipped',
    failed: 'failed',
    not_run: 'not run yet',
    refused: 'refused',
    excluded: 'left out by the owner',
  };
  const parts = order
    .map((s) => [s, items.filter((i) => i.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${words[s]}`);
  return `${items.length} character${items.length === 1 ? '' : 's'}: ${parts.join(', ') || 'none'}`;
}

export class IdentityService {
  readonly records: IdentityRecords;
  private offs: (() => void)[] = [];
  private readonly concluding = new Map<string, Promise<IdentityRecord | null>>();

  constructor(private readonly d: IdentityDeps) {
    this.records = new IdentityRecords(d.db, d.now);
  }

  start(): () => void {
    this.offs.push(
      this.d.proposals.addHooks({
        afterSubmit: (ctx) => {
          try {
            const r = this.records.byProposal(ctx.proposal.id);
            if (r) this.records.setJob(r.id, ctx.jobId);
          } catch (err) {
            this.d.log?.warn({ err }, 'an identity reconcile could not follow its proposal');
          }
        },
      }),
      this.d.engine.events.on('job', (e) => {
        if (!TERMINAL_JOB_STATUSES.has(e.job.status)) return;
        if (!this.records.byJob(e.job.projectId, e.job.id)) return;
        void this.conclude(e.job.projectId, e.job.id).catch((err: unknown) =>
          this.d.log?.warn({ err, jobId: e.job.id }, 'an identity reconcile could not record its outcome'),
        );
      }),
    );
    return () => this.stop();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /**
   * Works out and stores every item's outcome once the job has ended (idempotent; a call while one is running waits
   * for it). Returns the record, or null when the job is not a reconcile's or has not ended.
   */
  /** The record with its outcome brought up to date (a job resumed and ended again since is concluded afresh). */
  async current(rec: IdentityRecord): Promise<IdentityRecord> {
    if (!rec.jobId) return rec;
    const job = this.d.engine.queries.getJob(rec.projectId, rec.jobId);
    if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return rec;
    const stored = rec.outcome?.job as { finishedAt?: unknown } | undefined;
    if (rec.state === 'finished' && stored?.finishedAt === job.finishedAt) return rec;
    return (await this.conclude(rec.projectId, rec.jobId)) ?? rec;
  }

  conclude(projectId: string, jobId: string): Promise<IdentityRecord | null> {
    const key = `${projectId}:${jobId}`;
    const running = this.concluding.get(key);
    if (running) return running;
    const p = this.doConclude(projectId, jobId).finally(() => this.concluding.delete(key));
    this.concluding.set(key, p);
    return p;
  }

  private async doConclude(projectId: string, jobId: string): Promise<IdentityRecord | null> {
    const rec = this.records.byJob(projectId, jobId);
    if (!rec) return null;
    const job = this.d.engine.queries.getJob(projectId, jobId);
    if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return rec;
    const steps = this.d.engine.stepRecords(projectId, jobId) ?? [];
    const errors = new Map((this.d.engine.stepResults(projectId, jobId) ?? []).map((s) => [s.stepNo, s.error]));
    const items = outcomesOf(rec.plan.items, steps, errors, job.status);
    // The consistency follow-ups: each character written (free; the job's change snapshot is already taken).
    const withFollowUps: ItemOutcome[] = [];
    for (const it of items) {
      if (!it.page || !this.d.consistency || !(it.status === 'done' || it.status === 'partly_done')) {
        withFollowUps.push(it);
        continue;
      }
      try {
        const found = await this.d.consistency(projectId, it.page.id);
        withFollowUps.push(found && found.length > 0 ? { ...it, followUps: found.slice(0, 20) } : it);
      } catch (err) {
        withFollowUps.push({
          ...it,
          followUps: [{ code: 'CONSISTENCY_UNAVAILABLE', message: err instanceof Error ? err.message : String(err) }],
        });
      }
    }
    this.records.finish(rec.id, {
      items: withFollowUps,
      summary: summaryOf(withFollowUps),
      job: { id: job.id, status: job.status, finishedAt: job.finishedAt },
    });
    return this.records.get(rec.id);
  }
}
