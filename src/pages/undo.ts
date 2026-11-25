/**
 * The undo of a block-by-block page write that stopped part-way (v2 E4, ADR 0046 decision 1).
 *
 * A block-by-block write is not atomic: a write refused or lost after the first has been made leaves the page half
 * changed. The job's own record says exactly what it did: its check step holds the document as planned (`before`), and
 * each write step its operation and outcome. When such a job ends failed or cancelled with at least one write made (or
 * possibly made), the undo:
 *
 * 1. works out the states the page can be in now: `before` with every succeeded write applied, and also with the one
 *    write whose outcome is unknown (CR-07's `uncertain`), if any;
 * 2. reads the document live and compares it with those states, by content. **Only when it is exactly one of them** (so
 *    nothing else has changed the page since) does it go on; otherwise nothing is undone and the stop is reported with
 *    the journal entries (an outside edit is never reverted);
 * 3. plans the block-by-block write from the page as it is back to `before` (`planBlockwise`) and submits it as ONE job
 *    of the system principal at P1: the same in-lock check (the page must still be as just read), chained If-Match and a
 *    verify of the whole document against `before`. The journal keeps every write's pre-image, as for any write.
 *
 * An undo is never undone: if it stops too, the error says so and the owner restores from the journal or a snapshot.
 * It runs once per job (the tool that waited for the job and the job listener share one attempt).
 */
import type { BackgroundRunner } from '../background.js';
import { SYSTEM_PRINCIPAL, type JobEngine, type JobOrigin, type JobView } from '../jobs/index.js';
import { EXPECT_STEP } from '../jobs/internal-steps.js';
import {
  applyBlockOps,
  BLOCKWISE_CHECK,
  blocksHash,
  planBlockwise,
  stepOp,
  withoutVersions,
  type BlockOp,
  type BlockwiseCheckInput,
} from './blockwise.js';
import { blockwiseJob, validateBlockOp } from './blockwise-job.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const ORIGIN: JobOrigin = {
  kind: 'ui',
  client: 'bridge',
  tool: 'pages.blockwise_undo',
  principal: SYSTEM_PRINCIPAL,
};

export type UndoOutcome =
  | { readonly status: 'not_blockwise' | 'nothing_written' | 'is_undo' }
  | { readonly status: 'submitted'; readonly undoJobId: string }
  | { readonly status: 'nothing_to_undo'; readonly message: string }
  | { readonly status: 'stale'; readonly message: string }
  | { readonly status: 'failed'; readonly message: string };

export interface BlockwiseUndoDeps {
  /** v3 F6a.1: the runtime's background work: follow-ups this service starts are tracked there. */
  readonly background?: Pick<BackgroundRunner, 'track'>;
  readonly engine: Pick<JobEngine, 'stepPlans' | 'internalRead' | 'submit' | 'events' | 'queries'>;
  readonly log?: { warn(obj: unknown, msg: string): void };
}

interface Located {
  readonly resourceId: string;
  readonly documentId: string;
  readonly input: BlockwiseCheckInput;
}

/**
 * The block-by-block documents of a job: each `bridge.expect` check with the `pages.blockwise` checker (a write_page job
 * has one, as its first step; a restore job may have several, after its sidebar steps). Empty when the job has none.
 */
function locate(plans: readonly { opId: string; params: Obj }[]): Located[] {
  const out: Located[] = [];
  for (const p of plans) {
    if (p.opId !== EXPECT_STEP) continue;
    const checks = isObj(p.params.body) ? (p.params.body as { checks?: unknown }).checks : undefined;
    for (const c of Array.isArray(checks) ? checks : []) {
      if (!isObj(c) || c.checker !== BLOCKWISE_CHECK || c.kind !== 'document') continue;
      const input = c.input as BlockwiseCheckInput | undefined;
      if (
        !input ||
        !Array.isArray(input.before) ||
        typeof c.resourceId !== 'string' ||
        typeof c.documentId !== 'string'
      )
        continue;
      out.push({ resourceId: c.resourceId, documentId: c.documentId, input });
    }
  }
  return out;
}

export class BlockwiseUndo {
  private readonly attempts = new Map<string, Promise<UndoOutcome>>();
  private off: (() => void) | undefined;

  constructor(private readonly d: BlockwiseUndoDeps) {}

  /** Listens for block-by-block jobs that stop part-way. Returns a detach. */
  start(): () => void {
    this.off = this.d.engine.events.on('job', (e: { job: JobView }) => {
      if (e.job.status !== 'failed' && e.job.status !== 'cancelled') return;
      // v3 F6a.1: tracked by the runtime's background work (a stop waits for it before the database closes).
      const followUp = this.consider(e.job).catch((err: unknown) =>
        this.d.log?.warn({ err, jobId: e.job.id }, 'block-by-block undo could not run'),
      );
      void (this.d.background ? this.d.background.track('block-by-block undo', followUp) : followUp);
    });
    return () => this.stop();
  }

  stop(): void {
    this.off?.();
    this.off = undefined;
  }

  /** Considers one finished job (once per job); see the module comment. */
  consider(job: Pick<JobView, 'id' | 'projectId' | 'status'>): Promise<UndoOutcome> {
    const known = this.attempts.get(job.id);
    if (known) return known;
    const p = this.run(job);
    this.attempts.set(job.id, p);
    if (this.attempts.size > 500) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined && oldest !== job.id) this.attempts.delete(oldest);
    }
    return p;
  }

  private async run(job: Pick<JobView, 'id' | 'projectId' | 'status'>): Promise<UndoOutcome> {
    if (job.status !== 'failed' && job.status !== 'cancelled') return { status: 'nothing_written' };
    const plans = this.d.engine.stepPlans(job.projectId, job.id);
    if (!plans) return { status: 'not_blockwise' };
    const docs = locate(plans as unknown as readonly { opId: string; params: Obj }[]);
    if (docs.length === 0) return { status: 'not_blockwise' };
    if (docs.some((x) => x.input.undoOf !== undefined)) return { status: 'is_undo' };
    // Each document is undone on its own (a restore can write several block by block).
    const outcomes: UndoOutcome[] = [];
    for (const at of docs) outcomes.push(await this.undoDocument(job, plans, at));
    const submitted = outcomes.filter(
      (o): o is Extract<UndoOutcome, { status: 'submitted' }> => o.status === 'submitted',
    );
    const bad = outcomes.find((o) => o.status === 'stale' || o.status === 'failed');
    if (bad) return bad;
    if (submitted.length > 0) return submitted[0]!;
    return outcomes.find((o) => o.status === 'nothing_to_undo') ?? { status: 'nothing_written' };
  }

  private async undoDocument(
    job: Pick<JobView, 'id' | 'projectId'>,
    plans: NonNullable<ReturnType<BlockwiseUndoDeps['engine']['stepPlans']>>,
    at: Located,
  ): Promise<UndoOutcome> {
    const writes = plans
      .filter((p) => (p.params.path as Obj | undefined)?.documentId === at.documentId)
      .map((p) => ({ p, op: stepOp(p.opId, p.params as unknown as { path?: Obj; body?: unknown }) }))
      .filter((x): x is { p: (typeof plans)[number]; op: BlockOp } => x.op !== null);
    const done = writes.filter((w) => w.p.status === 'succeeded');
    const unknown = writes.find((w) => w.p.status !== 'succeeded' && w.p.maybeSent);
    if (done.length === 0 && !unknown) return { status: 'nothing_written' };

    // The states the page can be in now, if nothing else touched it.
    const states: unknown[][] = [];
    try {
      const made = applyBlockOps(
        at.input.before,
        done.map((w) => w.op),
      );
      states.push(made);
      if (unknown) {
        try {
          states.push(applyBlockOps(made, [unknown.op]));
        } catch {
          // The unknown write cannot have applied on top of the others; only the first state is possible.
        }
      }
    } catch (e) {
      return this.report(
        job,
        'failed',
        `its writes cannot be replayed on the page as planned (${String(e)})`,
      );
    }
    let live: { version?: unknown; blocks?: unknown };
    try {
      live = (await this.d.engine.internalRead(
        job.projectId,
        'getDocumentBlocks',
        { path: { resourceId: at.resourceId, documentId: at.documentId } },
        { priority: 'P1' },
      )) as { version?: unknown; blocks?: unknown };
    } catch (e) {
      return this.report(
        job,
        'failed',
        `the page could not be read (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const blocks = Array.isArray(live.blocks) ? (live.blocks as unknown[]) : null;
    if (!blocks) return this.report(job, 'failed', 'the page was read without blocks');
    const liveHash = blocksHash(blocks);
    if (liveHash === blocksHash(at.input.before)) {
      return {
        status: 'nothing_to_undo',
        message: 'The page is as it was before the write: nothing to undo.',
      };
    }
    if (!states.some((s) => blocksHash(s) === liveHash)) {
      return this.report(
        job,
        'stale',
        'the page has changed since the write stopped (or the stopped write left it otherwise than its record says), so ' +
          'nothing was undone: an undo never reverts another edit',
      );
    }
    const plan = planBlockwise(withoutVersions(blocks), at.input.before, {
      validate: (op) => validateBlockOp(at.resourceId, at.documentId, op),
    });
    if (!plan.ok) return this.report(job, 'failed', plan.refusal.message);
    if (plan.empty) return { status: 'nothing_to_undo', message: 'Nothing to undo.' };
    const { steps } = blockwiseJob({
      resourceId: at.resourceId,
      documentId: at.documentId,
      before: withoutVersions(blocks),
      after: at.input.before,
      ops: plan.ops,
      journalOperation: { tool: 'pages.blockwise_undo', undoOf: job.id },
      undoOf: job.id,
    });
    try {
      const r = await this.d.engine.submit({
        kind: 'batch_ops',
        project: job.projectId,
        steps,
        onError: 'stop',
        priority: 'P1',
        origin: ORIGIN,
        title: `Undo the part-way block-by-block write of job ${job.id}`,
        holdDocuments: [at.documentId],
        internal: true,
      });
      if (!('jobId' in r) || typeof r.jobId !== 'string')
        return this.report(job, 'failed', 'the undo was not accepted as a job');
      return { status: 'submitted', undoJobId: r.jobId };
    } catch (e) {
      return this.report(job, 'failed', e instanceof Error ? e.message : String(e));
    }
  }

  private report(
    job: Pick<JobView, 'id' | 'projectId'>,
    status: 'stale' | 'failed',
    why: string,
  ): UndoOutcome {
    const message = `The block-by-block write of job ${job.id} stopped part-way and was not undone: ${why}. Its journal entries hold every block as it was (bridge_journal_lookup with jobId ${job.id}).`;
    this.d.log?.warn({ jobId: job.id, projectId: job.projectId, status }, message);
    return { status, message };
  }
}
