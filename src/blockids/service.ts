/**
 * The block-id sweep (v3 F3.5, ADR 0056): `assign-block-ids-sweep`, a narrow, explicitly approved automation that gives
 * legacy page documents block ids, one `assignBlockIds` per document, a few documents a night. Its six-point statement
 * (scope, prerequisites, transformation, verification, concurrency, stop conditions) is in ./statement.ts.
 *
 * A run, per project:
 *
 * 1. Refuses (skipped, saying why) without a sandbox PASS for this bridge version or the owner's override, and while an
 *    unacknowledged verification failure stands.
 * 2. Checks first any document an earlier run left `unverified` (its write's outcome was not known), against the
 *    journalled pre-image.
 * 3. Takes the candidates from the snapshot overlay (no request), in tree order, leaving out those it already did since
 *    the snapshot that shows them, and works on at most N (`max_per_run`, default 20). Before each document it stops when
 *    the project is read-only, writes are paused, the bridge is draining or the P3 budget says wait.
 * 4. For each: reads the document (P3) as its pre-image; skips it if it has meanwhile gained ids; otherwise submits ONE
 *    engine job (P3, the system principal, origin `maintenance`, the page and document locks, Last Major Revision
 *    `skip`):
 *    - `bridge.expect` (checker `blockids.expect`): inside the lock the document must be exactly the version (and the
 *      content) read. LegendKeeper takes no If-Match on `assignBlockIds`, so this is the bridge's own compare-and-swap;
 *      a moved document is a conflict, nothing is sent, and the document is retried next run.
 *    - `assignBlockIds`, its journal entry holding the whole document (version and blocks) as the pre-image.
 *    - `bridge.verify` (checker `blockids.verify`): the document read back and compared with the pre-image, block ids
 *      aside (./detect.ts). A failure stops the sweep: the stop is recorded (document, differences, journal entry) and the
 *      job disabled, whether or not a run is still waiting for the job.
 *
 * The jobs are the system principal's, so they never reach the Review page and the rails do not apply; the canon guard
 * lets them through by the narrow exception in ./guard.ts. Every job shows on the Jobs page (origin `maintenance`).
 */
import type { JobEngine, JobOrigin, JobView, StepSpec } from '../jobs/index.js';
import {
  BudgetExhaustedError,
  DrainingError,
  LkOperationError,
  ReadOnlyError,
  SYSTEM_PRINCIPAL,
  TERMINAL_JOB_STATUSES,
} from '../jobs/index.js';
import { EXPECT_STEP, VERIFY_STEP, type DocumentChecker } from '../jobs/internal-steps.js';
import { blocksHash } from '../pages/blockwise.js';
import { scanCandidates, type Candidate, type CandidateScan, type SnapshotOverlay } from './candidates.js';
import { isLegacy, legacyProblems, verifyAssigned, type BlockIdDifference } from './detect.js';
import { AUTOMATION_STATEMENT, SWEEP_JOB_ID } from './statement.js';
import {
  BlockIdStore,
  type DocRecord,
  type SandboxCheckRecord,
  type StopRecord,
  type SweepState,
} from './store.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The checkers the sweep's jobs name (registered by `attach`). */
export const EXPECT_CHECK = 'blockids.expect';
export const VERIFY_CHECK = 'blockids.verify';

/** The step numbers of a sweep job: the check, the write, the verify. */
const WRITE_STEP = 2;

/** Reads and writes one document costs: the pre-image, the read in the lock, the read back, one more for the change
 * snapshot taken at the job's end (about; the dry run says so). */
export const READS_PER_DOCUMENT = 4;

export interface BlockIdSweepDeps {
  readonly db: BlockIdStore['db'];
  readonly engine: Pick<
    JobEngine,
    'internalRead' | 'submit' | 'events' | 'queries' | 'registerChecker' | 'controls'
  >;
  readonly projects: {
    activeIds(): readonly string[];
    nameOf(id: string): string;
    anyClient(id: string): { governor: { estimate: JobEngineGovernorEstimate } } | undefined;
  };
  readonly overlay: SnapshotOverlay;
  /** The running bridge's version (the sandbox PASS must be for it). */
  readonly version: string;
  readonly now: () => number;
  readonly audit?: (
    actor: string,
    action: string,
    target: string | null,
    before?: unknown,
    after?: unknown,
  ) => void;
  readonly log?: { warn(o: Record<string, unknown>, m: string): void };
  /** Test seam: whether the P3 budget says wait now (default: the project's governor estimate). */
  readonly budgetWaits?: (projectId: string) => boolean;
}

type JobEngineGovernorEstimate = (input: {
  reads?: number;
  writes?: number;
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  ops?: Readonly<Record<string, number>>;
}) => {
  readonly wallClockMs: number;
  readonly tightestTier: string;
  readonly fitsToday: boolean;
  readonly tiers: readonly { readonly timeMs: number }[];
  readonly operationTiers: readonly { readonly timeMs: number }[];
};

/** Prerequisite 2: a sandbox PASS for this version, or the owner's override. */
export interface Prerequisite {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly version: string;
  readonly pass: SandboxCheckRecord | null;
  readonly override: { readonly at: number; readonly by: string } | null;
  /** The newest sandbox verdicts of any version (the card lists them). */
  readonly recent: readonly SandboxCheckRecord[];
}

export interface PlannedDocument extends Candidate {
  /** `unverified`: a document whose earlier write's outcome is not known (checked first); `candidate` otherwise. */
  readonly why: 'unverified' | 'candidate';
  /** Retried after an edit moved it (the last run skipped it). */
  readonly retry: boolean;
}

export interface DryRun {
  readonly project: string;
  readonly projectId: string;
  readonly writesNothing: true;
  readonly snapshot: CandidateScan['snapshot'];
  readonly candidates: number;
  readonly remaining: number;
  readonly maxPerRun: number;
  readonly next: readonly PlannedDocument[];
  readonly estimate: {
    readonly reads: number;
    readonly writes: number;
    readonly wallClockMs: number | null;
    readonly tightestTier: string | null;
    readonly fitsToday: boolean | null;
    readonly note: string;
  };
  readonly prerequisite: Prerequisite;
  readonly stopped: boolean;
}

/** The longest the card waits for a project's candidates before answering from the last scan. */
const CARD_WAIT_MS = 250;

export interface ProjectCard {
  readonly project: string;
  readonly projectId: string;
  readonly snapshot: CandidateScan['snapshot'];
  /** Candidates the latest snapshot shows (null: not counted yet; see `counting`). */
  readonly candidates: number | null;
  /** Of those, still to do (less what the sweep did since that snapshot). */
  readonly remaining: number | null;
  /** The latest snapshot's candidates are still being read (in the background); the numbers are the last scan's. */
  readonly counting?: true;
  readonly unreadable: number;
  readonly counts: Readonly<Record<DocRecord['status'], number>>;
}

export interface SweepCard {
  readonly jobId: typeof SWEEP_JOB_ID;
  readonly statement: typeof AUTOMATION_STATEMENT;
  readonly prerequisite: Prerequisite;
  readonly maxPerRun: number;
  readonly stop: SweepState['stop'];
  readonly projects: readonly ProjectCard[];
}

/** What the maintenance job's run answers (src/maintenance/types.ts `MaintenanceResult`). */
export interface SweepRunResult {
  readonly summary: string;
  readonly changed?: boolean;
  readonly skipped?: boolean;
}

export class BlockIdSweepError extends Error {
  override readonly name = 'BlockIdSweepError';
  constructor(
    readonly code: 'NOT_OWNER' | 'INVALID_INPUT' | 'VERIFICATION_FAILED',
    message: string,
  ) {
    super(message);
  }
}

/** One document's outcome inside a run. */
type DocOutcome =
  | { readonly kind: 'done' | 'already' | 'moved' | 'gone' | 'error' }
  | { readonly kind: 'stop'; readonly why: string }
  | { readonly kind: 'failed'; readonly why: string };

const ORIGIN: JobOrigin = {
  kind: 'maintenance',
  client: 'maintenance',
  tool: SWEEP_JOB_ID,
  detail: 'Assign block IDs sweep',
  principal: SYSTEM_PRINCIPAL,
};

export class BlockIdSweep {
  readonly store: BlockIdStore;
  private readonly onStopFns = new Set<(s: StopRecord) => void>();
  private readonly scans = new Map<string, { stamp: string; scan: Promise<CandidateScan> }>();
  /** The last scan that finished, per project (the card shows it while a newer one is still being read). */
  private readonly lastScans = new Map<string, CandidateScan>();

  constructor(private readonly d: BlockIdSweepDeps) {
    this.store = new BlockIdStore(d.db, d.now);
  }

  /** Registers the two checkers the sweep's jobs name. Returns a detach. */
  attach(): () => void {
    const offs = [
      this.d.engine.registerChecker(EXPECT_CHECK, this.expectChecker),
      this.d.engine.registerChecker(VERIFY_CHECK, this.verifyChecker),
    ];
    return () => offs.forEach((f) => f());
  }

  /** Told when a verification failure stops the sweep (the maintenance layer disables the job). */
  onStop(fn: (s: StopRecord) => void): () => void {
    this.onStopFns.add(fn);
    return () => this.onStopFns.delete(fn);
  }

  // ============================================================================================ prerequisites

  prerequisite(): Prerequisite {
    const pass = this.store.passFor(this.d.version);
    const override = this.store.state().override;
    const ok = pass !== null || override !== null;
    return {
      ok,
      reason: ok
        ? null
        : `the sandbox check has no recorded PASS for bridge version ${this.d.version}, and the override is not set`,
      version: this.d.version,
      pass,
      override,
      recent: this.store.latestChecks(5),
    };
  }

  /** Why the job cannot be enabled now, or null (the maintenance registry asks before enabling it). */
  canEnable(): string | null {
    const p = this.prerequisite();
    return p.ok
      ? null
      : `The block-id sweep cannot be enabled: ${p.reason}. Run the sandbox check (docs/runbook-deploy.md) or set the override.`;
  }

  /** The owner enabled the job: a standing stop is acknowledged (it stays on record, no longer in red). */
  enabled(): void {
    const s = this.store.state().stop;
    if (s && s.acknowledgedAt === null) {
      this.store.acknowledgeStop();
      this.d.audit?.(
        'owner',
        'blockids.stop_acknowledged',
        SWEEP_JOB_ID,
        { stoppedAt: s.at, page: s.page },
        null,
      );
    }
  }

  /** The owner's override of the sandbox check (the route asks for re-authentication first). Audited. */
  setOverride(actor: 'owner', on: boolean): Prerequisite {
    if (actor !== 'owner') throw new BlockIdSweepError('NOT_OWNER', 'Only the owner can do this');
    const before = this.store.state().override;
    this.store.setOverride(on, actor);
    this.d.audit?.(
      'owner',
      'blockids.override',
      SWEEP_JOB_ID,
      { override: before !== null },
      { override: on, version: this.d.version },
    );
    return this.prerequisite();
  }

  /** The most documents one run works on (1 to 500). Audited. */
  setMaxPerRun(actor: 'owner', n: unknown): number {
    if (actor !== 'owner') throw new BlockIdSweepError('NOT_OWNER', 'Only the owner can do this');
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 500)
      throw new BlockIdSweepError(
        'INVALID_INPUT',
        'The most documents a run does is a whole number from 1 to 500.',
      );
    const before = this.store.state().maxPerRun;
    this.store.setMaxPerRun(n);
    this.d.audit?.('owner', 'blockids.max_per_run', SWEEP_JOB_ID, { maxPerRun: before }, { maxPerRun: n });
    return n;
  }

  // ============================================================================================ candidates

  /** The candidates of one project from the latest snapshot (cached until the overlay changes). */
  async candidates(projectId: string): Promise<CandidateScan> {
    const snap = await this.d.overlay.ensure(projectId);
    if (!snap) return { snapshot: null, candidates: [], documents: 0, unreadable: 0 };
    const hit = this.scans.get(projectId);
    if (hit && hit.stamp === snap.stamp) return hit.scan;
    const scan = scanCandidates(this.d.overlay, projectId);
    this.scans.set(projectId, { stamp: snap.stamp, scan });
    scan.then(
      (x) => this.lastScans.set(projectId, x),
      () => this.scans.delete(projectId),
    );
    return scan;
  }

  /** Candidates still to do: less those the sweep did (or found clean, or gone) after the snapshot that shows them. */
  private remaining(projectId: string, scan: CandidateScan): Candidate[] {
    const recs = new Map(this.store.docs(projectId).map((r) => [r.documentId, r]));
    return scan.candidates.filter((c) => {
      const r = recs.get(c.documentId);
      if (!r) return true;
      if (r.status === 'unverified') return false; // checked first, by its own path
      return !(['done', 'already', 'gone'].includes(r.status) && r.updatedAt >= c.seenAt);
    });
  }

  /** The documents the next run would work on, in order (unverified first). */
  private async plan(
    projectId: string,
  ): Promise<{ scan: CandidateScan; queue: PlannedDocument[]; remaining: number }> {
    const scan = await this.candidates(projectId);
    const max = this.store.state().maxPerRun;
    const byDoc = new Map(scan.candidates.map((c) => [c.documentId, c]));
    const recs = this.store.docs(projectId);
    const unverified: PlannedDocument[] = recs
      .filter((r) => r.status === 'unverified')
      .map((r) => ({
        ...(byDoc.get(r.documentId) ?? {
          resourceId: r.resourceId,
          documentId: r.documentId,
          page: r.resourceId,
          path: r.resourceId,
          document: null,
          blocks: 0,
          missing: 0,
          duplicates: 0,
          unsupported: 0,
          seenAt: 0,
        }),
        why: 'unverified' as const,
        retry: true,
      }));
    const moved = new Set(recs.filter((r) => r.status === 'moved').map((r) => r.documentId));
    const rest = this.remaining(projectId, scan);
    const queue = [
      ...unverified,
      ...rest.map((c) => ({ ...c, why: 'candidate' as const, retry: moved.has(c.documentId) })),
    ].slice(0, max);
    return { scan, queue, remaining: rest.length };
  }

  // ============================================================================================ the card and the dry run

  /**
   * The Maintenance page's card. The 25 November 2026 freeze, step 5 (ADR 0061 amendment 2): it waits at most
   * `CARD_WAIT_MS` for a project's candidates. Reading them after new snapshots means bringing the overlay up to date
   * (every change snapshot since the full one) and scanning every document of it: 3.4 s at Arkona's scale, inside the
   * request. Past the wait, the card shows the last scan that finished (`counting`: a newer one is being read) or none
   * yet, and the scan finishes in the background (cached for the next request).
   */
  async card(): Promise<SweepCard> {
    const st = this.store.state();
    const projects: ProjectCard[] = [];
    for (const projectId of this.d.projects.activeIds()) {
      let scan: CandidateScan | null;
      const reading = this.candidates(projectId);
      reading.catch(() => undefined);
      try {
        scan = await Promise.race([
          reading,
          new Promise<null>((r) => setTimeout(() => r(null), CARD_WAIT_MS).unref?.()),
        ]);
      } catch (e) {
        this.d.log?.warn({ err: e, projectId }, 'the block-id sweep could not read its candidates');
        scan = { snapshot: null, candidates: [], documents: 0, unreadable: 0 };
      }
      const counting = scan === null;
      const shown = scan ?? this.lastScans.get(projectId) ?? null;
      const counts = { done: 0, already: 0, moved: 0, unverified: 0, failed: 0, gone: 0, error: 0 };
      for (const r of this.store.docs(projectId)) counts[r.status]++;
      projects.push({
        project: this.d.projects.nameOf(projectId),
        projectId,
        snapshot: shown?.snapshot ?? null,
        candidates: shown ? shown.candidates.length : null,
        remaining: shown ? this.remaining(projectId, shown).length : null,
        unreadable: shown?.unreadable ?? 0,
        counts,
        ...(counting ? { counting: true as const } : {}),
      });
    }
    return {
      jobId: SWEEP_JOB_ID,
      statement: AUTOMATION_STATEMENT,
      prerequisite: this.prerequisite(),
      maxPerRun: st.maxPerRun,
      stop: st.stop,
      projects,
    };
  }

  /** What the next run would do in one project: documents, counts and estimated cost. Writes nothing, reads nothing. */
  async dryRun(projectId: string): Promise<DryRun> {
    const { scan, queue, remaining } = await this.plan(projectId);
    const reads = queue.length * READS_PER_DOCUMENT;
    const writes = queue.filter((q) => q.why === 'candidate').length;
    const governor = this.d.projects.anyClient(projectId)?.governor;
    const est = governor
      ? governor.estimate({
          reads,
          writes,
          priority: 'P3',
          ops: { getDocumentBlocks: reads, assignBlockIds: writes },
        })
      : null;
    const st = this.store.state();
    return {
      project: this.d.projects.nameOf(projectId),
      projectId,
      writesNothing: true,
      snapshot: scan.snapshot,
      candidates: scan.candidates.length,
      remaining,
      maxPerRun: st.maxPerRun,
      next: queue,
      estimate: {
        reads,
        writes,
        wallClockMs: est?.wallClockMs ?? null,
        tightestTier: est?.tightestTier ?? null,
        fitsToday: est?.fitsToday ?? null,
        note:
          `About ${READS_PER_DOCUMENT} reads and 1 write a document at P3 (the pre-image, the read inside the lock, the ` +
          'read back, and the change snapshot at the job’s end); a document found clean costs one read and no write.',
      },
      prerequisite: this.prerequisite(),
      stopped: st.stop !== null && st.stop.acknowledgedAt === null,
    };
  }

  // ============================================================================================ a run

  /** One run in one project (the maintenance job's `run`). A verification failure throws: the run is `failed`. */
  async run(projectId: string): Promise<SweepRunResult> {
    const pre = this.prerequisite();
    if (!pre.ok) return { skipped: true, summary: `Skipped: ${pre.reason}.` };
    const stop = this.store.state().stop;
    if (stop && stop.acknowledgedAt === null)
      return {
        skipped: true,
        summary:
          'Skipped: the sweep stopped after a verification failure (see the Maintenance page); enabling the job again acknowledges it.',
      };
    const { scan, queue } = await this.plan(projectId);
    if (!scan.snapshot && queue.length === 0)
      return {
        skipped: true,
        summary: 'Skipped: there is no full snapshot yet, so there are no candidates.',
      };
    const tally = { done: 0, already: 0, moved: 0, gone: 0, error: 0 };
    let stoppedBecause: string | null = null;
    let worked = 0;
    for (const doc of queue) {
      const why = this.mustStop(projectId);
      if (why) {
        stoppedBecause = why;
        break;
      }
      worked++;
      const r = await this.one(projectId, doc);
      if (r.kind === 'failed') {
        throw new BlockIdSweepError(
          'VERIFICATION_FAILED',
          `Verification failed on “${doc.page}” (${doc.documentId}): ${r.why}. The sweep stopped and the job was disabled; ` +
            `${this.summaryOf(tally)} before it.`,
        );
      }
      if (r.kind === 'stop') {
        stoppedBecause = r.why;
        break;
      }
      tally[r.kind]++;
    }
    const left = queue.length - worked;
    const capped =
      this.remaining(projectId, scan).length > 0 && stoppedBecause === null && worked >= queue.length;
    return {
      summary:
        `${this.summaryOf(tally)}.` +
        (stoppedBecause
          ? ` Stopped early: ${stoppedBecause}${left > 0 ? ` (${left} left for the next run)` : ''}.`
          : '') +
        (capped && queue.length >= this.store.state().maxPerRun
          ? ` The limit of ${this.store.state().maxPerRun} a run was reached; the rest follow on later runs.`
          : ''),
      changed: tally.done > 0,
    };
  }

  private summaryOf(t: {
    done: number;
    already: number;
    moved: number;
    gone: number;
    error: number;
  }): string {
    const parts = [`${t.done} ${t.done === 1 ? 'document' : 'documents'} given block ids and verified`];
    if (t.already) parts.push(`${t.already} already had them`);
    if (t.moved) parts.push(`${t.moved} edited since the read (retried next run)`);
    if (t.gone) parts.push(`${t.gone} gone`);
    if (t.error) parts.push(`${t.error} could not be done (see the run's jobs)`);
    return parts.join(', ');
  }

  /** Read-only mode, a writes pause, draining, or the P3 budget saying wait: stop before the next document. */
  private mustStop(projectId: string): string | null {
    const c = this.d.engine.queries.controls(projectId);
    if (c.readOnly) return c.project?.readOnly ? 'the project is read-only' : 'read-only mode is on';
    if (c.writesPaused) return 'writes are paused';
    if (c.draining) return 'the bridge is draining';
    if (this.budgetWaits(projectId)) return 'the P3 budget says wait';
    return null;
  }

  private budgetWaits(projectId: string): boolean {
    if (this.d.budgetWaits) return this.d.budgetWaits(projectId);
    const g = this.d.projects.anyClient(projectId)?.governor;
    if (!g) return true;
    const e = g.estimate({
      reads: READS_PER_DOCUMENT,
      writes: 1,
      priority: 'P3',
      ops: { getDocumentBlocks: READS_PER_DOCUMENT, assignBlockIds: 1 },
    });
    return e.tiers.some((t) => t.timeMs > 0) || e.operationTiers.some((t) => t.timeMs > 0);
  }

  /** Reads a document's blocks at P3: the body, `gone`, or a reason to stop. */
  private async read(
    projectId: string,
    resourceId: string,
    documentId: string,
  ): Promise<{ body: { version: string | null; blocks: unknown[] } } | { gone: true } | { stop: string }> {
    try {
      const b = await this.d.engine.internalRead(
        projectId,
        'getDocumentBlocks',
        { path: { resourceId, documentId } },
        { priority: 'P3', notFoundIsAnswer: true },
      );
      if (!isObj(b)) return { gone: true };
      return {
        body: {
          version: typeof b.version === 'string' ? b.version : null,
          blocks: Array.isArray(b.blocks) ? (b.blocks as unknown[]) : [],
        },
      };
    } catch (e) {
      if (e instanceof LkOperationError && (e.lk.status === 404 || e.lk.code === 'KIND_MISMATCH'))
        return { gone: true };
      if (e instanceof BudgetExhaustedError) return { stop: 'the P3 budget says wait' };
      return { stop: `a read was refused (${e instanceof Error ? e.message : String(e)})` };
    }
  }

  private async one(projectId: string, doc: PlannedDocument): Promise<DocOutcome> {
    const { resourceId, documentId } = doc;
    if (doc.why === 'unverified') return this.recheck(projectId, doc);
    const r = await this.read(projectId, resourceId, documentId);
    if ('stop' in r) return { kind: 'stop', why: r.stop };
    if ('gone' in r) {
      this.store.setDoc({
        projectId,
        documentId,
        resourceId,
        status: 'gone',
        detail: 'not found, or not a page',
      });
      return { kind: 'gone' };
    }
    if (!isLegacy(r.body.blocks)) {
      // The live re-read: it gained ids since the snapshot (in the app, or by another write). Nothing to do.
      this.store.setDoc({
        projectId,
        documentId,
        resourceId,
        status: 'already',
        detail: 'every block had an id',
      });
      return { kind: 'already' };
    }
    return this.write(projectId, doc, r.body);
  }

  /** The job of one document: the check in the lock, the write (journalled with its pre-image), the verify. */
  private async write(
    projectId: string,
    doc: PlannedDocument,
    pre: { version: string | null; blocks: unknown[] },
  ): Promise<DocOutcome> {
    const { resourceId, documentId } = doc;
    const steps: StepSpec[] = [
      {
        op: EXPECT_STEP,
        params: {
          body: {
            checks: [
              {
                label: 'document',
                kind: 'document',
                resourceId,
                documentId,
                checker: EXPECT_CHECK,
                input: {
                  resourceId,
                  documentId,
                  page: doc.page,
                  version: pre.version,
                  hash: blocksHash(pre.blocks),
                },
              },
            ],
          },
        },
      },
      {
        op: 'assignBlockIds',
        params: { path: { resourceId, documentId } },
        // The whole document as it was, which the check in the lock has just confirmed unchanged.
        journalPreImage: { version: pre.version, blocks: pre.blocks },
        journalOperation: {
          tool: SWEEP_JOB_ID,
          page: doc.page,
          blockIds: legacyProblems(pre.blocks).missing,
        },
      },
      {
        op: VERIFY_STEP,
        params: {
          body: {
            targets: [
              {
                kind: 'checked',
                label: 'the page',
                resourceId,
                documentId,
                checker: VERIFY_CHECK,
                input: null,
                inputFrom: { step: 1, key: 'sweep' },
              },
            ],
          },
        },
      },
    ];
    let jobId: string;
    try {
      const res = await this.d.engine.submit({
        kind: 'batch_ops',
        project: projectId,
        internal: true,
        priority: 'P3',
        origin: ORIGIN,
        title: `Maintenance: assign block ids to “${doc.page}”`,
        onError: 'stop',
        holdLock: { resourceId },
        holdDocument: { documentId },
        lastMajorRevision: 'skip',
        steps,
      });
      if (res.status === 'proposal_captured') {
        // Never expected (the system principal is not gated): stop rather than leave a proposal behind silently.
        return {
          kind: 'stop',
          why: `the request became proposal ${res.proposalId}, which the sweep never makes`,
        };
      }
      jobId = res.jobId;
    } catch (e) {
      if (e instanceof ReadOnlyError) return { kind: 'stop', why: 'read-only mode is on' };
      if (e instanceof DrainingError) return { kind: 'stop', why: 'the bridge is draining' };
      return { kind: 'stop', why: `the job was refused (${e instanceof Error ? e.message : String(e)})` };
    }
    this.store.setDoc({ projectId, documentId, resourceId, status: 'unverified', jobId, attempt: true });
    const job = await this.settle(projectId, jobId);
    const rec = this.store.doc(projectId, documentId);
    if (job.status === 'succeeded') {
      if (rec?.jobId === jobId && rec.status === 'done') return { kind: 'done' };
      if (rec?.jobId === jobId && rec.status === 'failed')
        return { kind: 'failed', why: rec.detail ?? 'the document differs from its pre-image' };
      // The verify step did not judge the document (it could not read it back): its outcome is not known.
      this.store.setDoc({
        projectId,
        documentId,
        resourceId,
        status: 'unverified',
        jobId,
        journalId: this.store.journalId(jobId, WRITE_STEP),
        detail: 'written, but it could not be read back to verify',
      });
      return {
        kind: 'stop',
        why: `the write to “${doc.page}” could not be verified (it is checked first next run)`,
      };
    }
    if (!TERMINAL_JOB_STATUSES.has(job.status)) {
      // Waiting for budget (or paused): the job finishes by itself, and its verify step still judges it.
      return {
        kind: 'stop',
        why: job.status === 'waiting_budget' ? 'the P3 budget says wait' : `a job is ${job.status}`,
      };
    }
    const err = job.lastError;
    if (err?.stepNo === 1 && err.code === 'VERSION_CONFLICT') {
      this.store.setDoc({
        projectId,
        documentId,
        resourceId,
        status: 'moved',
        jobId,
        detail: 'edited since the read: skipped, retried next run',
      });
      return { kind: 'moved' };
    }
    if (err?.stepNo === 1 || job.status === 'cancelled') {
      this.store.setDoc({
        projectId,
        documentId,
        resourceId,
        status: 'error',
        jobId,
        detail: err?.message ?? `the job was ${job.status}`,
      });
      return job.status === 'cancelled'
        ? { kind: 'stop', why: 'a job of the sweep was cancelled' }
        : { kind: 'stop', why: `the check before the write failed (${err?.message ?? 'unknown'})` };
    }
    // The write itself failed: whether it reached LegendKeeper is not known for sure. Checked first next run.
    this.store.setDoc({
      projectId,
      documentId,
      resourceId,
      status: 'unverified',
      jobId,
      journalId: this.store.journalId(jobId, WRITE_STEP),
      detail: err?.message ?? 'the write failed',
    });
    return {
      kind: 'stop',
      why:
        err?.classification === 'budget' || err?.code === 'BUDGET_EXHAUSTED'
          ? 'the governor refused the write (budget)'
          : `the write failed (${err?.message ?? 'unknown'}); the document is checked first next run`,
    };
  }

  /**
   * Waits for a job to finish, or to stop for budget or a pause: what it is then. A writes pause, read-only mode or
   * draining that begins while the job is still queued ends the wait too (the job stays queued; the run stops).
   */
  private settle(projectId: string, jobId: string): Promise<JobView> {
    const current = () => this.d.engine.queries.getJob(projectId, jobId) as JobView | undefined;
    const settled = (j: JobView | undefined) =>
      j !== undefined &&
      (TERMINAL_JOB_STATUSES.has(j.status) || j.status === 'waiting_budget' || j.status === 'paused');
    return new Promise((resolve) => {
      const offs: (() => void)[] = [];
      const finish = (j: JobView) => {
        for (const off of offs) off();
        resolve(j);
      };
      offs.push(
        this.d.engine.events.on('job', (e) => {
          if (e.job.id !== jobId) return;
          if (settled(e.job)) finish(e.job);
          // CR-2026-11-R3 (fix A): a restart parks the job (queued again, for the next start): the run stops here.
          else if (e.job.status === 'queued' && this.d.engine.queries.controls(projectId).draining)
            finish(e.job);
        }),
        this.d.engine.events.on('controls', (c) => {
          const j = current();
          if (j && j.status === 'queued' && (c.writesPaused || c.draining || c.readOnly)) finish(j);
        }),
      );
      const now = current();
      if (settled(now)) finish(now!);
    });
  }

  /**
   * A document an earlier run left `unverified`: its job still running is left alone; otherwise it is read now and
   * judged against the journalled pre-image (unchanged: the write never landed, so it is a candidate again).
   */
  private async recheck(projectId: string, doc: PlannedDocument): Promise<DocOutcome> {
    const { resourceId, documentId } = doc;
    const rec = this.store.doc(projectId, documentId);
    if (rec?.jobId) {
      const job = this.d.engine.queries.getJob(projectId, rec.jobId) as JobView | undefined;
      if (job && !TERMINAL_JOB_STATUSES.has(job.status))
        return { kind: 'stop', why: `the sweep's job ${rec.jobId} is still ${job.status}` };
      const after = this.store.doc(projectId, documentId);
      if (after && after.status !== 'unverified')
        return { kind: after.status === 'done' ? 'done' : 'already' };
    }
    const journalId = rec?.journalId ?? (rec?.jobId ? this.store.journalId(rec.jobId, WRITE_STEP) : null);
    const pre = journalId !== null ? this.store.journalPreImage(journalId) : null;
    const r = await this.read(projectId, resourceId, documentId);
    if ('stop' in r) return { kind: 'stop', why: r.stop };
    if ('gone' in r) {
      this.store.setDoc({
        projectId,
        documentId,
        resourceId,
        status: 'gone',
        detail: 'not found, or not a page',
      });
      return { kind: 'gone' };
    }
    const preBlocks = isObj(pre) && Array.isArray(pre.blocks) ? (pre.blocks as unknown[]) : null;
    if (preBlocks === null) {
      // Never journalled, so never sent: a candidate like any other.
      return isLegacy(r.body.blocks)
        ? this.write(projectId, { ...doc, why: 'candidate' }, r.body)
        : this.markAlready(projectId, doc);
    }
    if (blocksHash(preBlocks) === blocksHash(r.body.blocks)) {
      // Exactly as before the write: it never landed.
      return this.write(projectId, { ...doc, why: 'candidate' }, r.body);
    }
    const v = verifyAssigned(preBlocks, r.body.blocks);
    if (v.ok) {
      this.store.setDoc({
        projectId,
        documentId,
        resourceId,
        status: 'done',
        journalId,
        assigned: v.before.missing,
        detail: 'verified on the next run against the journalled pre-image',
      });
      return { kind: 'done' };
    }
    const why = 'the document differs from the journalled pre-image of a write whose outcome was not known';
    this.fail(projectId, doc, rec?.jobId ?? null, journalId, why, v.differences);
    return { kind: 'failed', why };
  }

  private markAlready(projectId: string, doc: PlannedDocument): DocOutcome {
    this.store.setDoc({
      projectId,
      documentId: doc.documentId,
      resourceId: doc.resourceId,
      status: 'already',
      detail: 'every block had an id',
    });
    return { kind: 'already' };
  }

  /** Records a verification failure, stops the sweep and tells the maintenance layer (which disables the job). */
  private fail(
    projectId: string,
    doc: { resourceId: string; documentId: string; page?: string | null },
    jobId: string | null,
    journalId: number | null,
    reason: string,
    differences: readonly BlockIdDifference[],
  ): void {
    this.store.setDoc({
      projectId,
      documentId: doc.documentId,
      resourceId: doc.resourceId,
      status: 'failed',
      jobId,
      journalId,
      detail: `${reason}${differences[0] ? ` (first at ${differences[0].path})` : ''}`,
    });
    const stop: StopRecord = {
      projectId,
      project: this.d.projects.nameOf(projectId),
      resourceId: doc.resourceId,
      documentId: doc.documentId,
      page: doc.page ?? null,
      jobId,
      journalId,
      reason,
      differences: differences.slice(0, 20),
    };
    this.store.recordStop(stop);
    this.d.audit?.('system', 'blockids.stopped', SWEEP_JOB_ID, null, {
      project: stop.project,
      page: stop.page,
      documentId: stop.documentId,
      jobId,
      journalId,
      reason,
    });
    for (const fn of [...this.onStopFns]) {
      try {
        fn(stop);
      } catch (e) {
        this.d.log?.warn({ err: e }, 'could not act on the block-id sweep’s stop');
      }
    }
  }

  // ============================================================================================ the checkers

  /** Inside the lock, before the write: the document must be exactly as read (version and content), and legacy. */
  private readonly expectChecker: DocumentChecker = (ctx) => {
    const input = (ctx.input ?? {}) as {
      resourceId?: string;
      documentId?: string;
      page?: string;
      version?: string | null;
      hash?: string;
    };
    const differences: BlockIdDifference[] = [];
    if (input.version != null && ctx.document.version !== input.version)
      differences.push({ path: 'version', expected: input.version, actual: ctx.document.version });
    else if (blocksHash(ctx.document.blocks) !== input.hash)
      differences.push({ path: 'document', expected: 'the document as read', actual: 'changed since' });
    if (differences.length > 0) return { differences };
    return {
      differences: [],
      bodies: {
        sweep: {
          resourceId: input.resourceId,
          documentId: input.documentId,
          page: input.page ?? null,
          version: ctx.document.version,
          blocks: ctx.document.blocks,
        },
      },
      observed: { version: ctx.document.version, ...legacyProblems(ctx.document.blocks) },
    };
  };

  /** After the write: the document read back, judged against the pre-image the check confirmed. Records the outcome. */
  private readonly verifyChecker: DocumentChecker = (ctx) => {
    const pre = ctx.input as {
      resourceId?: string;
      documentId?: string;
      page?: string | null;
      blocks?: unknown[];
    } | null;
    const resourceId = pre?.resourceId;
    const documentId = pre?.documentId;
    if (!pre || !Array.isArray(pre.blocks) || !resourceId || !documentId) {
      return {
        differences: [{ path: 'pre-image', expected: 'the check’s pre-image', actual: '(missing)' }],
      };
    }
    const journalId = this.store.journalId(ctx.jobId, WRITE_STEP);
    const v = verifyAssigned(pre.blocks, ctx.document.blocks);
    if (v.ok) {
      this.store.setDoc({
        projectId: ctx.projectId,
        documentId,
        resourceId,
        status: 'done',
        jobId: ctx.jobId,
        journalId,
        assigned: v.before.missing,
        detail: `${v.before.missing} block ids given${v.before.duplicates.length ? `, ${v.before.duplicates.length} duplicates resolved` : ''}`,
      });
      return { differences: [], observed: { verified: true } };
    }
    this.fail(
      ctx.projectId,
      { resourceId, documentId, page: pre.page ?? null },
      ctx.jobId,
      journalId,
      'the document read back differs from its pre-image, block ids aside',
      v.differences,
    );
    return { differences: [...v.differences] };
  };
}
