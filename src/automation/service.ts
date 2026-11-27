/**
 * v3 F5b (ADR 0068; the owner-approved design docs/design/F5-orchestration.md, H5): automatic actions for audits,
 * switched on one finding code at a time.
 *
 * - **Settings** (`setMode`): per project and code, `off` (the default), `propose` or `apply`; the owner's alone (the
 *   route; ADR 0081: no fresh code); each change journalled with the owner principal, its date and the governance
 *   write it caused. Agents can neither read-modify nor suggest them.
 * - **The governance record**: switching a code to Propose or Apply writes its paragraph into Repository Automation's
 *   "Approved Narrow Automations", after the block-id sweep's paragraph (src/automation/governance.ts); switching it off
 *   amends the paragraph. Each write is a block-by-block job (journalled, on the Review page, Revertible), and the pack's
 *   approval of Repository Automation is carried over it (`packs.carryApproval`) once the document reads exactly as
 *   planned, so the pack does not drift and fail closed. Reverting the paragraph switches the code off.
 * - **The engine** (`run`): after the nightly audit (the maintenance job `automation-run`) and on demand ("Run
 *   automation now"), each enabled code in the registry's fixed order. Every finding re-checked live
 *   (FIX_STALE is skipped and recorded); Propose makes ONE proposal per code per run, an item per page; Apply submits one
 *   job per page as the Automation principal at P3, and reads every page back. The caps, the stop conditions and the
 *   brakes are the design's; see ADR 0068.
 */
import type { BackgroundRunner } from '../background.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';
import type { Appraisal } from '../appraisal/service.js';
import type { AppraisalFinding } from '../appraisal/types.js';
import type { Audits } from '../audits/service.js';
import type { Finding } from '../audits/types.js';
import { mintClientId } from '../jobs/ids.js';
import {
  AUTOMATION_PRINCIPAL,
  SYSTEM_PRINCIPAL,
  TERMINAL_JOB_STATUSES,
  type JobEngine,
  type JobOrigin,
  type JobView,
  type StepSpec,
  type SubmitRequest,
} from '../jobs/index.js';
import { VERIFY_STEP } from '../jobs/internal-steps.js';
import { mapStepRefs, type PlanItem } from '../jobs/items.js';
import { compareStoredBlocks } from '../jobs/verify-blocks.js';
import { stableJson } from '../jobs/sidebar-state.js';
import { loggedTask, type TaskLogger } from '../maintenance/task-log.js';
import type { Packs } from '../packs/service.js';
import type { RetagService } from '../packs/retag/service.js';
import { planBlockwise } from '../pages/blockwise.js';
import { blockwiseJob, validateBlockOp } from '../pages/blockwise-job.js';
import { REVERT_TOOL } from '../review/revert-plan.js';
import type { ReviewService } from '../review/service.js';
import {
  inspect,
  longDate,
  MODE_WORDS,
  paragraphText,
  planParagraph,
  type ParagraphProblem,
} from './governance.js';
import { ELIGIBLE, entryOf, PROPOSE_ONLY, SWITCHABLE, type CodeEntry } from './registry.js';
import type { Chronology, ChronologyFix } from '../chronology/index.js';
import { AutomationStore, type ItemOutcome, type ItemRow, type Mode, type RunRow } from './store.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const PACK_ID = 'arkona';
/** Three skips in a row for the same reason pause the code. */
export const SKIP_STREAK_PAUSE = 3;
/** The tool of every automation job's origin (the policy gate lets only these act as the Automation principal). */
export const GOVERNANCE_TOOL = 'automation.governance';

export class AutomationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Obj = {},
  ) {
    super(message);
    this.name = 'AutomationError';
  }
}

export interface AutomationDeps {
  /** v3 F6a.1: the runtime's background work: follow-ups this service starts are tracked there. */
  readonly background?: Pick<BackgroundRunner, 'track'> & { readonly signal?: AbortSignal };
  readonly db: Db;
  readonly engine: Pick<JobEngine, 'submit' | 'internalRead' | 'queries' | 'events' | 'stepRecords' | 'wait'>;
  readonly packs: Pick<Packs, 'get' | 'approvedRules' | 'attachment' | 'governance' | 'carryApproval'>;
  readonly audits: Pick<Audits, 'store' | 'proposeFix'>;
  readonly appraisal: Pick<Appraisal, 'appraiseOwner' | 'visualHygiene' | 'proposeFix' | 'reader'>;
  readonly retag: Pick<
    RetagService,
    'audit' | 'correctionBatches' | 'planApply' | 'submitApply' | 'store' | 'onJob'
  >;
  readonly review: Pick<ReviewService, 'store'>;
  /**
   * v3 F10 (ADR 0078): the chronology (its newest check's findings and its repairs). Without it the chronology codes
   * do nothing, saying why.
   */
  readonly chronology?: Pick<Chronology, 'store' | 'readiness' | 'repair'>;
  readonly projects: {
    anyClient(id: string):
      | {
          governor: {
            estimate(w: { reads: number; writes: number; priority: 'P3' }): {
              tiers: readonly { tier: string; windowMs: number; timeMs: number }[];
              operationTiers: readonly { tier: string; group: string; windowMs: number; timeMs: number }[];
            };
          };
        }
      | undefined;
  };
  readonly projectName: (projectId: string) => string | null;
  readonly audit: (actor: string, action: string, target: string, before: unknown, after: unknown) => void;
  readonly now: () => number;
  readonly log?: TaskLogger & { warn(o: unknown, m: string): void };
  /**
   * v3 F6d (ADR 0082): told of each page a batch code submitted (its job, or the proposal it is an item of), so the
   * rename engine's record (and its review list) follows the automation's renames as it follows arkona_rename's.
   */
  readonly afterBatch?: (projectId: string, req: Obj, ids: { jobId?: string; proposalId?: string }) => void;
  /** Test seam: the P3 budget's wait now, or null (default: the project's governor estimate). */
  readonly budgetWaits?: (projectId: string) => BudgetWait | null;
  /** v3 F5b.1: the live settings (default: the defaults). Read on each use, so a change applies to the next check. */
  readonly settings?: () => AutomationSettings;
  /** Test seam: an abortable sleep (default: a timer that the abort signal ends at once). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** How long one job may take to settle before the run stops waiting for it (default 10 minutes). */
  readonly settleMs?: number;
}

/** v3 F5b.1 (ADR 0068 amendment 1): the settings the automation reads on each use. */
export interface AutomationSettings {
  /** AUTOMATION_CAP_PER_CODE. */
  readonly capPerCode: number;
  /** AUTOMATION_CAP_PER_RUN. */
  readonly capPerRun: number;
  /** AUTOMATION_BUDGET_MAX_WAIT_SECONDS. */
  readonly budgetMaxWaitSeconds: number;
  /** AUTOMATION_RUN_MAX_MINUTES. */
  readonly runMaxMinutes: number;
}

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  capPerCode: 25,
  capPerRun: 100,
  budgetMaxWaitSeconds: 600,
  runMaxMinutes: 120,
};

/** The P3 budget's wait before the next page: the longest tier's, named; `day` when a day tier is among the causes. */
export interface BudgetWait {
  readonly ms: number;
  /** The tier that decides it (the day tier when `day`). */
  readonly tier: string;
  /** Plain words for it: "minute tier", "day tier", "assets operation tier". */
  readonly label: string;
  readonly day: boolean;
}

/** What a run is doing while it pauses (the Automation page: "pausing for budget (minute tier, 30 s)"). */
export interface Pausing {
  readonly label: string;
  readonly seconds: number;
  readonly since: number;
}

const DAY_MS = 86_400_000;
const sleepFor = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
/** "42 s", "5 min", "2 h". */
export const fmtWait = (ms: number): string => {
  const s = Math.ceil(ms / 1000);
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.ceil(s / 60)} min`;
  return `${Math.round(s / 360) / 10} h`;
};
/** The old wording of a governance paragraph's caps (v3 F5b), amended once to the new (F5b.1). */
const OLD_CAPS_WORDING = /at most \d+ pages a run for this code and \d+ for every code together/;

/** One code as the dashboard shows it. */
export interface CodeView {
  readonly code: string;
  readonly name: string;
  readonly example: string;
  readonly transformation: string;
  readonly source: CodeEntry['source'];
  readonly mode: Mode;
  /** v3 F7: the modes the owner can choose (a proposal-only code: Off or Propose). */
  readonly modes: readonly Mode[];
  readonly paused: { readonly at: number; readonly reason: string } | null;
  readonly stopped: { readonly at: number; readonly reason: string } | null;
  readonly governancePending: string | null;
  readonly lastRun: { readonly runId: string; readonly at: number } | null;
  readonly recent: readonly ItemRow[];
  readonly changes: readonly {
    readonly from: Mode;
    readonly to: Mode;
    readonly principal: string;
    readonly at: number;
    readonly reason: string | null;
    readonly governanceJobId: string | null;
    readonly governanceState: string;
  }[];
}

export interface GovernanceView {
  readonly ok: boolean;
  readonly code: string | null;
  readonly message: string;
  readonly problems: readonly ParagraphProblem[];
}

interface GovSource {
  readonly key: string;
  readonly name: string;
  readonly resourceId: string;
  readonly documentId: string;
  readonly section: string;
  readonly sweepMarker: string;
}

/** A finding the engine will act on, planned live. */
interface Candidate {
  readonly pageId: string;
  readonly pageName: string;
  /** Plans the fix with a fresh live read: the job request, or a skip. */
  readonly plan: () => Promise<Planned>;
}

type Planned =
  | {
      readonly ok: true;
      readonly req: Obj;
      readonly pre: Obj;
      readonly expect: Expectation;
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/** What the read-back must show: the target, what it read before, and what the transformation sets. */
interface Expectation {
  readonly target: 'resource' | 'document' | 'asset';
  readonly resourceId: string | null;
  readonly documentId: string | null;
  readonly assetId: string | null;
  /** The document as planned (document codes). */
  readonly blocks: unknown[] | null;
  /** The fields the write sets, as planned (`name`, `tags`). */
  readonly fields: Obj;
}

type CodeOutcome =
  | { readonly kind: 'done'; readonly attempted: number; readonly capped?: boolean }
  | { readonly kind: 'stopRun'; readonly why: string; readonly attempted: number };

const CAPTURED = 'automation:captured';
/** CR-2026-11-R3 (R3-64): a turn of the event loop. */
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
/** The refusals of the guards and the gate (never bypassed: the code pauses). */
/**
 * v3 F10 (ADR 0078): the chronology's refusals that leave a finding to the owner's judgement (recorded as `guarded`,
 * never a skip that pauses the code): an ambiguous pairing (the Chronology page offers the choices), a date the engine
 * cannot read, a KCY or style a partial or qualified date does not decide, an order that is not strict.
 */
const CHRONOLOGY_JUDGEMENTS = new Set([
  'PAIRING_AMBIGUOUS',
  'EVENT_AMBIGUOUS',
  'ROW_AMBIGUOUS',
  'EVENT_TAKEN',
  'ROW_HAS_EVENT',
  'ROW_DATE_UNREADABLE',
  'KCY_NOT_DETERMINED',
  'STYLE_NOT_DETERMINED',
  'KCY_WRONG',
  'ORDER_NOT_STRICT',
  'SHAPE_CHANGE_UNCONFIRMED',
]);

const GUARD_CODES = new Set([
  'POLICY_DENIED',
  'CANONICAL_APPROVAL_REQUIRED',
  'WRITE_GUARD_REFUSED',
  'LIFECYCLE_REFUSED',
]);
const VOLATILE = new Set(['updatedAt', 'createdAt', 'version', 'etag', 'lastEditedAt']);

/** A value with the volatile fields (timestamps, versions) taken out at every depth. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const k of Object.keys(v).sort()) if (!VOLATILE.has(k)) out[k] = stable(v[k]);
  return out;
}

const hasUnsupported = (blocks: unknown): boolean =>
  Array.isArray(blocks) &&
  blocks.some(
    (b) =>
      isObj(b) && (b.kind === 'unsupported' || (Array.isArray(b.children) && hasUnsupported(b.children))),
  );

const errCode = (e: unknown): string =>
  typeof (e as { code?: unknown } | null)?.code === 'string' ? String((e as { code: string }).code) : 'ERROR';
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class AutomationService {
  readonly store: AutomationStore;
  private stopping = false;
  private abort = new AbortController();
  /** Per project, the run in progress: when it started, what it paused for, and what it is pausing for now. */
  private readonly runInfo = new Map<
    string,
    { startedAt: number; pauses: string[]; pausing: Pausing | null }
  >();
  private readonly running = new Map<string, Promise<RunRow>>();
  private offs: (() => void)[] = [];
  /** Whether each recent governance write had the pack's approval carried over it (false: the pack now drifts). */
  private readonly carried = new Map<string, boolean>();

  constructor(private readonly d: AutomationDeps) {
    this.store = new AutomationStore(d.db, d.now);
  }

  /** Follows Reverts of governance writes (a reverted paragraph switches its code off). Returns a detach. */
  start(): () => void {
    this.stopping = false;
    this.abort = new AbortController();
    const off = this.d.engine.events.on('job', (e: { type: string; job: JobView }) => {
      if (e.job.status !== 'succeeded' || e.job.origin.tool !== REVERT_TOOL) return;
      // v3 F6a.1: tracked by the runtime's background work (a stop waits for it before the database closes).
      const followUp = this.afterRevert(e.job).catch((err: unknown) =>
        this.d.log?.warn(
          { err, jobId: e.job.id },
          'automation: a revert of a governance write was not followed',
        ),
      );
      void (this.d.background
        ? this.d.background.track('automation: following a revert of a governance write', followUp)
        : followUp);
    });
    this.offs.push(off);
    return () => this.detach();
  }

  detach(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** SIGTERM (CR-2026-11-R3, fix A): every run stops at its next step boundary; waits (bounded) for them. */
  async stop(ms = 10_000): Promise<void> {
    this.stopping = true;
    this.abort.abort(); // a run pausing for budget wakes at once
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.running.values()]),
      new Promise((r) => {
        timer = setTimeout(r, ms);
      }),
    ]);
    clearTimeout(timer);
  }

  // ============================================================================================ reading

  private settings(): AutomationSettings {
    return this.d.settings?.() ?? DEFAULT_AUTOMATION_SETTINGS;
  }

  /** v3 F5b.1: the caps are settings (AUTOMATION_CAP_PER_CODE, AUTOMATION_CAP_PER_RUN), read on each use. */
  caps(): { perCode: number; perRun: number } {
    const s = this.settings();
    return { perCode: s.capPerCode, perRun: s.capPerRun };
  }

  /** What the project's run is pausing for now, or null (the Automation page). */
  pausing(projectId: string): Pausing | null {
    return this.runInfo.get(projectId)?.pausing ?? null;
  }

  /** Every eligible code with its setting and what it did last (the Automation page). */
  codes(projectId: string): CodeView[] {
    return SWITCHABLE.map((e) => {
      const s = this.store.setting(projectId, e.code);
      const recent = this.store.codeItems(projectId, e.code, 20);
      return {
        code: e.code,
        name: e.name,
        example: e.example,
        transformation: e.transformation,
        source: e.source,
        mode: this.modeOf(projectId, e),
        // v3 F7 (ADR 0070): a proposal-only code is Off or Propose, never Apply.
        modes:
          e.automatable === 'propose' && e.applyDirect !== true
            ? (['off', 'propose'] as Mode[])
            : (['off', 'propose', 'apply'] as Mode[]),
        paused: s?.pausedAt ? { at: s.pausedAt, reason: s.pausedReason ?? '' } : null,
        stopped: s?.stoppedAt ? { at: s.stoppedAt, reason: s.stoppedReason ?? '' } : null,
        governancePending: s?.governancePending ?? null,
        lastRun: recent[0] ? { runId: recent[0].runId, at: recent[0].at } : null,
        recent,
        changes: this.store.changes(projectId, e.code, 20).map((c) => ({
          from: c.from,
          to: c.to,
          principal: c.principal,
          at: c.at,
          reason: c.reason,
          governanceJobId: c.governanceJobId,
          governanceState: c.governanceState,
        })),
      };
    });
  }

  /**
   * v3 F10 (ADR 0078, C5): the Chronology page's view of the automation: when it last ran, each chronology code's mode,
   * and what its chronology codes did (newest first): the rows and events synced, proposed or left for the owner.
   */
  chronologyView(projectId: string, limit = 50) {
    const codes = PROPOSE_ONLY.filter((e) => e.source === 'chronology');
    return {
      lastRun: this.store.runs(projectId, { limit: 1 })[0] ?? null,
      lastChronologyRun:
        this.store.runs(projectId, { limit: 50 }).find((r) => r.trigger === 'chronology') ?? null,
      paused: this.store.global().paused,
      codes: codes.map((e) => ({ code: e.code, name: e.name, mode: this.modeOf(projectId, e) })),
      items: this.store.itemsOfCodes(
        projectId,
        codes.map((e) => e.code),
        limit,
      ),
    };
  }

  /** The codes that run now in a project (bridge_info tells agents, so they do not duplicate the work). */
  automated(
    projectId: string,
  ): { code: string; name: string; mode: Exclude<Mode, 'off'>; paused: boolean }[] {
    const all = this.store.global().paused;
    return SWITCHABLE.map((e) => ({
      e,
      s: this.store.setting(projectId, e.code),
      mode: this.modeOf(projectId, e),
    }))
      .filter((x) => x.mode !== 'off')
      .map((x) => ({
        code: x.e.code,
        name: x.e.name,
        mode: x.mode as Exclude<Mode, 'off'>,
        paused: all || (x.s?.pausedAt ?? null) !== null,
      }));
  }

  /**
   * A code's mode: its setting, else its default (v3 F7: the art layout's proposal-only codes default to Propose: their
   * every fix is a proposal the owner approves; the others to Off).
   */
  modeOf(projectId: string, e: CodeEntry): Mode {
    return this.store.setting(projectId, e.code)?.mode ?? e.defaultMode ?? 'off';
  }

  /** What automation did since `since` (the Overview's overnight tile): counts per code, with the jobs and proposals. */
  overnight(projectId: string, since: number) {
    const runs = this.store.runs(projectId, { since, limit: 20 });
    const byCode = new Map<
      string,
      { code: string; name: string; counts: Record<ItemOutcome, number>; jobs: string[]; proposals: string[] }
    >();
    for (const r of runs)
      for (const i of this.store.items(r.id)) {
        let c = byCode.get(i.code);
        if (!c) {
          c = {
            code: i.code,
            name: entryOf(i.code)?.name ?? i.code,
            counts: { applied: 0, proposed: 0, skipped: 0, guarded: 0, failed: 0, stopped: 0 },
            jobs: [],
            proposals: [],
          };
          byCode.set(i.code, c);
        }
        c.counts[i.outcome]++;
        if (i.jobId && i.outcome === 'applied' && !c.jobs.includes(i.jobId)) c.jobs.push(i.jobId);
        if (i.proposalId && !c.proposals.includes(i.proposalId)) c.proposals.push(i.proposalId);
      }
    return {
      since,
      runs: runs.map((r) => ({ id: r.id, state: r.state, startedAt: r.startedAt, summary: r.summary })),
      codes: [...byCode.values()],
      paused: this.store.global().paused,
    };
  }

  // ============================================================================================ governance

  private source(projectId: string): GovSource {
    const pack = this.d.packs.get(PACK_ID);
    const rules = this.d.packs.approvedRules(PACK_ID);
    const a = rules?.automation;
    if (!pack || !this.d.packs.attachment(PACK_ID, projectId) || !a)
      throw new AutomationError(
        'AUTOMATION_UNAVAILABLE',
        'Automation needs the Arkona pack attached to this project and approved in a version that records approved narrow automations (arkona-…-f5b): approve it on the Packs page.',
      );
    const src = pack.governance.find((g) => g.key === a.source);
    const here = this.d.projectName(projectId);
    if (
      !src ||
      src.resourceId === '' ||
      src.documentId === '' ||
      here === null ||
      here.toLowerCase() !== src.project.toLowerCase()
    )
      throw new AutomationError(
        'SOURCE_ELSEWHERE',
        `Repository Automation (${src?.name ?? a.source}) is not a page of this project, so its approvals cannot be recorded from here.`,
      );
    return {
      key: src.key,
      name: src.name,
      resourceId: src.resourceId,
      documentId: src.documentId,
      section: a.section,
      sweepMarker: a.sweepMarker,
    };
  }

  private async readDoc(
    projectId: string,
    src: GovSource,
    priority: 'P1' | 'P3',
  ): Promise<{ version: string; blocks: unknown[] }> {
    const r = (await this.d.engine.internalRead(
      projectId,
      'getDocumentBlocks',
      { path: { resourceId: src.resourceId, documentId: src.documentId } },
      { priority },
    )) as { version?: unknown; blocks?: unknown } | null;
    if (!r || typeof r.version !== 'string' || !Array.isArray(r.blocks))
      throw new AutomationError('GOVERNANCE_UNREADABLE', 'Repository Automation could not be read.');
    return { version: r.version, blocks: r.blocks as unknown[] };
  }

  /**
   * Whether the governance lets automation run: the pack approved and current (every source as approved, Repository
   * Automation included: drift fails closed), and every bridge-managed paragraph exactly as the bridge left it. Reads
   * each governance source once.
   */
  async governanceState(projectId: string, priority: 'P1' | 'P3' = 'P1'): Promise<GovernanceView> {
    let src: GovSource;
    try {
      src = this.source(projectId);
    } catch (e) {
      return { ok: false, code: errCode(e), message: errMessage(e), problems: [] };
    }
    const g = await this.d.packs.governance(PACK_ID);
    if (g.state !== 'current')
      return {
        ok: false,
        code: 'GOVERNANCE_DRIFT',
        message: `No automation runs until the pack is approved again: ${g.message}`,
        problems: [],
      };
    let doc: { version: string; blocks: unknown[] };
    try {
      doc = await this.readDoc(projectId, src, priority);
    } catch (e) {
      return { ok: false, code: errCode(e), message: errMessage(e), problems: [] };
    }
    const seen = inspect(doc.blocks, this.store.paragraphs(projectId), {
      heading: src.section,
      sweepMarker: src.sweepMarker,
    });
    if (!seen.found)
      return {
        ok: false,
        code: 'GOVERNANCE_SECTION_MISSING',
        message: `Repository Automation has no single section “${src.section}”.`,
        problems: [],
      };
    if (seen.problems.length > 0)
      return {
        ok: false,
        code: 'GOVERNANCE_EDITED',
        message: `A bridge-managed paragraph of “${src.section}” was changed outside the bridge (${seen.problems
          .map((p) => `${p.code}: ${p.state}`)
          .join(
            '; ',
          )}). No automation runs until the owner sets it right: changing the code’s setting rewrites its paragraph.`,
        problems: seen.problems,
      };
    return { ok: true, code: null, message: 'Repository Automation is as approved.', problems: [] };
  }

  /**
   * Writes (or amends) a code's paragraph: ONE block-by-block job of the bridge's, the document checked inside the lock,
   * If-Match from it, verified; the pack's approval carried over it; on the Review page and Revertible (an amendment
   * that switches a code off is not: switch the code on again instead). Returns the job, or throws.
   */
  private async writeParagraph(
    projectId: string,
    e: CodeEntry,
    o: {
      readonly kind: 'enable' | 'amend' | 'disable';
      readonly changes: Parameters<typeof paragraphText>[1];
      readonly by: 'owner' | 'automation';
      readonly changeId: number | null;
    },
  ): Promise<string> {
    const src = this.source(projectId);
    const doc = await this.readDoc(projectId, src, 'P1');
    const text = paragraphText(e, o.changes);
    const recorded = this.store.paragraph(projectId, e.code);
    const plan = planParagraph(doc.blocks, {
      code: e.code,
      text,
      heading: src.section,
      sweepMarker: src.sweepMarker,
      recorded,
      newId: () => mintClientId(),
    });
    if (!plan.ok) throw new AutomationError(plan.code, `${plan.reason}. Nothing was changed.`);
    const before = doc.blocks.filter(isObj);
    const bw = planBlockwise(before, plan.planned, {
      validate: (op) => validateBlockOp(src.resourceId, src.documentId, op),
    });
    if (!bw.ok)
      throw new AutomationError('GOVERNANCE_NOT_EDITABLE', `${bw.refusal.message} Nothing was changed.`);
    const page = { id: src.resourceId, name: src.name };
    const job = blockwiseJob({
      resourceId: src.resourceId,
      documentId: src.documentId,
      before,
      after: plan.planned,
      ops: bw.ops,
      journalOperation: {
        tool: GOVERNANCE_TOOL,
        page,
        code: e.code,
        section: src.section,
        before: plan.previousText?.slice(0, 4000) ?? null,
        after: text.slice(0, 4000),
      },
    });
    const title =
      o.kind === 'disable'
        ? `Repository Automation: record that “${e.name}” (${e.code}) is switched off`
        : `Repository Automation: record the owner’s approval of “${e.name}” (${e.code}), ${MODE_WORDS[o.changes[0]?.to ?? 'off']}`;
    const r = (await this.d.engine.submit({
      kind: 'batch_ops',
      project: projectId,
      steps: job.steps,
      onError: 'stop',
      priority: 'P1',
      origin: {
        kind: 'ui',
        client: o.by,
        tool: GOVERNANCE_TOOL,
        detail: `code:${e.code}`,
        principal: SYSTEM_PRINCIPAL,
      },
      title: title.slice(0, 300),
      internal: true,
      holdLock: { resourceId: src.resourceId },
      holdDocuments: [src.documentId],
      lastMajorRevision: 'skip',
    })) as { jobId?: string; status: string };
    if (typeof r.jobId !== 'string')
      throw new AutomationError('GOVERNANCE_NOT_WRITTEN', 'The governance write was not accepted as a job.');
    const jobId = r.jobId;
    this.store.recordGovernanceJob({
      jobId,
      projectId,
      code: e.code,
      kind: o.kind,
      changeId: o.changeId,
      resourceId: src.resourceId,
      documentId: src.documentId,
      blockId: plan.blockId,
      beforeVersion: doc.version,
      beforeBlocks: before,
      plannedBlocks: plan.planned,
      previousText: plan.previousText,
      text,
    });
    // The Review page lists it (the owner's own governance write, as Revert expects one).
    this.d.review.store.record({
      jobId,
      projectId,
      principalId: o.by,
      profile: o.by,
      tool: GOVERNANCE_TOOL,
      createdAt: this.d.now(),
    });
    const done = await this.settle(projectId, jobId, 60_000);
    if (done.status !== 'succeeded')
      throw new AutomationError(
        'GOVERNANCE_WRITE_FAILED',
        `The governance write (job ${jobId}) ended ${done.status}${done.lastError ? `: ${done.lastError.message}` : ''}. Nothing else was changed.`,
        { jobId },
      );
    this.store.setParagraph({
      projectId,
      code: e.code,
      resourceId: src.resourceId,
      documentId: src.documentId,
      blockId: plan.blockId,
      text,
      jobId,
    });
    const carried = await this.carry(
      projectId,
      src,
      { version: doc.version, blocks: doc.blocks },
      plan.planned,
      `the bridge-managed paragraph of ${e.code} (job ${jobId})`,
    );
    this.carried.set(jobId, carried);
    if (this.carried.size > 100) this.carried.delete(this.carried.keys().next().value!);
    return jobId;
  }

  /**
   * The pack's approval of Repository Automation carried over the bridge's own write: only when the document now reads
   * exactly as planned (nothing but the bridge's paragraph changed) and the approval recorded the version written over.
   */
  private async carry(
    projectId: string,
    src: GovSource,
    before: { readonly version: string; readonly blocks: readonly unknown[] },
    planned: readonly unknown[],
    reason: string,
  ): Promise<boolean> {
    const now = await this.readDoc(projectId, src, 'P1');
    const cmp = compareStoredBlocks(planned, now.blocks);
    if (!cmp.ok) {
      this.d.log?.warn(
        { project: projectId, differences: cmp.differences.slice(0, 5) },
        'automation: Repository Automation does not read as planned after the bridge’s write; its approval is not carried (drift)',
      );
      return false;
    }
    const ok = this.d.packs.carryApproval(PACK_ID, src.key, {
      before,
      section: src.section,
      after: { version: now.version, blocks: now.blocks },
      actor: 'system',
      reason,
    });
    if (ok) await this.d.packs.governance(PACK_ID).catch(() => undefined);
    return ok;
  }

  /** A Revert of a governance write succeeded: the code is switched off, and the approval carried over the revert. */
  private async afterRevert(revertJob: JobView): Promise<void> {
    const row = this.d.db
      .prepare(`SELECT job_id FROM job_reverts WHERE project_id = ? AND revert_job_id = ? LIMIT 1`)
      .get(revertJob.projectId, revertJob.id) as { job_id: string } | undefined;
    if (!row) return;
    const g = this.store.governanceJob(revertJob.projectId, row.job_id);
    if (!g) return;
    const projectId = g.projectId;
    const e = entryOf(g.code);
    if (!e) return;
    const was = this.store.mode(projectId, g.code);
    this.store.setMode(projectId, g.code, 'off', 'owner', {
      stopped: 'its governance paragraph was reverted',
    });
    const changeId = this.store.recordChange({
      projectId,
      code: g.code,
      from: was,
      to: 'off',
      principal: 'owner',
      reason: `the governance write (job ${g.jobId}) was reverted (job ${revertJob.id})`,
      governanceJobId: revertJob.id,
      governanceState: 'written',
    });
    // The paragraph is now what it was before the reverted write: none (an approval reverted) or its earlier text.
    if (g.previousText === null) this.store.removeParagraph(projectId, g.code);
    else
      this.store.setParagraph({
        projectId,
        code: g.code,
        resourceId: g.resourceId,
        documentId: g.documentId,
        blockId: g.blockId,
        text: g.previousText,
        jobId: revertJob.id,
      });
    this.d.audit(
      'owner',
      'automation.set_mode',
      `${projectId}:${g.code}`,
      { mode: was },
      {
        mode: 'off',
        via: 'revert',
        change: changeId,
        revertJob: revertJob.id,
      },
    );
    try {
      const src = this.source(projectId);
      const after = await this.readDoc(projectId, src, 'P1');
      const cmp = compareStoredBlocks(g.beforeBlocks, after.blocks);
      if (cmp.ok) {
        // The approval was carried to the version the reverted write made; carry it over the revert in turn.
        const approved = this.d.packs.get(PACK_ID)?.approved?.sources.find((s) => s.key === src.key)?.version;
        if (approved)
          // Before the revert the page read as the reverted write left it (Revert writes only then): the content the
          // approval was carried to.
          this.d.packs.carryApproval(PACK_ID, src.key, {
            before: { version: approved, blocks: g.plannedBlocks },
            section: src.section,
            after: { version: after.version, blocks: after.blocks },
            actor: 'system',
            reason: `the revert (job ${revertJob.id}) of the bridge-managed paragraph of ${g.code}`,
          });
        await this.d.packs.governance(PACK_ID).catch(() => undefined);
      }
      // An earlier text that still says the code runs is amended to say it is off.
      if (g.previousText !== null && !/Setting: Off/.test(g.previousText))
        await this.writeParagraph(projectId, e, {
          kind: 'disable',
          changes: this.store.changes(projectId, g.code),
          by: 'owner',
          changeId,
        });
    } catch (err) {
      this.store.setGovernancePending(projectId, g.code, `amend after revert: ${errMessage(err)}`);
    }
  }

  /**
   * Revert's refusal of a governance amendment that records a code switched off (the way back is switching it on
   * again, which writes the approval anew); null for any other job.
   */
  revertRefusal(projectId: string, jobId: string): { code: string; message: string } | null {
    const g = this.store.governanceJob(projectId, jobId);
    if (!g || g.kind !== 'disable') return null;
    return {
      code: 'GOVERNANCE_OFF_RECORD',
      message: `Job ${jobId} recorded in Repository Automation that ${g.code} is switched off; reverting it would make the governance say it runs while it does not. To switch it on again, use the Automation page.`,
    };
  }

  /** Whether a job is one of the automation's governance writes. */
  isGovernanceJob(projectId: string, jobId: string): boolean {
    return this.store.governanceJob(projectId, jobId) !== null;
  }

  // ============================================================================================ settings

  /**
   * The owner changes a code's setting. Switching to Propose or Apply needs the pack
   * current and Repository Automation as approved, and writes the code's paragraph FIRST: nothing is switched on unless
   * the governance says so. Switching off records the setting first (a brake), then amends the paragraph; an amendment
   * that fails is tried again before the next run. Journalled with the owner principal, the date and the governance job.
   */
  async setMode(
    actor: string,
    projectId: string,
    code: string,
    mode: Mode,
  ): Promise<{
    mode: Mode;
    changed: boolean;
    governanceJobId: string | null;
    governance: string;
    /**
     * Whether the pack's approval was carried over the governance write: false when anything else on Repository
     * Automation changed meanwhile (the pack then drifts and no automation runs until the owner approves it again).
     */
    approvalCarried?: boolean;
  }> {
    if (actor !== 'owner')
      throw new AutomationError('NOT_OWNER', 'Only the owner changes an automation setting; agents cannot.');
    const e = entryOf(code);
    if (!e || (e.automatable !== 'mechanical' && e.automatable !== 'propose'))
      throw new AutomationError(
        'NOT_ELIGIBLE',
        `${code} is not an automatable code: only codes whose fix the bridge fully determines can be switched on.`,
      );
    if (e.automatable === 'propose' && e.applyDirect !== true && mode === 'apply')
      throw new AutomationError(
        'PROPOSE_ONLY',
        `${code} is proposal-only: each of its fixes moves, renames or deletes assets, which is always a proposal for the owner. Choose Off or Propose.`,
      );
    const was = this.modeOf(projectId, e);
    const s = this.store.setting(projectId, code);
    if (was === mode && !s?.pausedAt && !s?.governancePending)
      return { mode, changed: false, governanceJobId: null, governance: 'unchanged' };
    const at = this.d.now();
    const pending = [
      {
        id: Number.MAX_SAFE_INTEGER,
        projectId,
        code,
        from: was,
        to: mode,
        principal: 'owner',
        at,
        reason: null,
        governanceJobId: null,
        governanceState: 'pending' as const,
      },
      ...this.store.changes(projectId, code),
    ];
    if (mode === 'off') {
      this.store.setMode(projectId, code, 'off', 'owner');
      const changeId = this.store.recordChange({
        projectId,
        code,
        from: was,
        to: 'off',
        principal: 'owner',
        at,
        reason: null,
        governanceJobId: null,
        governanceState: 'pending',
      });
      this.d.audit(
        actor,
        'automation.set_mode',
        `${projectId}:${code}`,
        { mode: was },
        { mode, change: changeId },
      );
      try {
        const jobId = await this.writeParagraph(projectId, e, {
          kind: 'disable',
          changes: this.store.changes(projectId, code),
          by: 'owner',
          changeId,
        });
        this.store.setChangeGovernance(changeId, jobId, 'written');
        this.store.setGovernancePending(projectId, code, null);
        return {
          mode,
          changed: true,
          governanceJobId: jobId,
          governance: 'written',
          approvalCarried: this.carried.get(jobId) ?? false,
        };
      } catch (err) {
        this.store.setChangeGovernance(changeId, null, 'failed');
        this.store.setGovernancePending(projectId, code, `record “off”: ${errMessage(err)}`);
        return { mode, changed: true, governanceJobId: null, governance: `failed: ${errMessage(err)}` };
      }
    }
    const gov = await this.governanceState(projectId);
    if (!gov.ok) throw new AutomationError(gov.code ?? 'GOVERNANCE_DRIFT', gov.message);
    const jobId = await this.writeParagraph(projectId, e, {
      kind: was === 'off' ? 'enable' : 'amend',
      changes: pending,
      by: 'owner',
      changeId: null,
    });
    this.store.setMode(projectId, code, mode, 'owner');
    this.store.setGovernancePending(projectId, code, null);
    const changeId = this.store.recordChange({
      projectId,
      code,
      from: was,
      to: mode,
      principal: 'owner',
      at,
      reason: null,
      governanceJobId: jobId,
      governanceState: 'written',
    });
    this.d.db
      .prepare('UPDATE automation_governance_jobs SET change_id = ? WHERE job_id = ?')
      .run(changeId, jobId);
    this.d.audit(
      actor,
      'automation.set_mode',
      `${projectId}:${code}`,
      { mode: was },
      { mode, change: changeId, governanceJob: jobId },
    );
    return {
      mode,
      changed: true,
      governanceJobId: jobId,
      governance: 'written',
      approvalCarried: this.carried.get(jobId) ?? false,
    };
  }

  /** The owner resumes a paused code (it releases a brake). */
  resume(actor: string, projectId: string, code: string): void {
    if (actor !== 'owner') throw new AutomationError('NOT_OWNER', 'Only the owner resumes automation.');
    const s = this.store.setting(projectId, code);
    if (!s?.pausedAt) throw new AutomationError('NOT_PAUSED', `${code} is not paused.`);
    this.store.resume(projectId, code);
    this.d.audit(
      actor,
      'automation.resume',
      `${projectId}:${code}`,
      { paused: s.pausedReason },
      { paused: null },
    );
  }

  /** "Pause all automation": one click (a brake); resuming releases it. */
  setGlobalPause(actor: string, paused: boolean): void {
    if (actor !== 'owner')
      throw new AutomationError('NOT_OWNER', 'Only the owner pauses or resumes automation.');
    const was = this.store.global().paused;
    this.store.setGlobalPause(paused, actor);
    this.d.audit(
      actor,
      paused ? 'automation.pause_all' : 'automation.resume_all',
      '*',
      { paused: was },
      { paused },
    );
  }

  /** The engine switches a code off on a stop condition: the setting first, then the governance amendment. */
  private async stopCode(projectId: string, e: CodeEntry, reason: string): Promise<void> {
    const was = this.store.mode(projectId, e.code);
    this.store.setMode(projectId, e.code, 'off', 'automation', { stopped: reason });
    const changeId = this.store.recordChange({
      projectId,
      code: e.code,
      from: was,
      to: 'off',
      principal: 'automation',
      reason,
      governanceJobId: null,
      governanceState: 'pending',
    });
    this.d.audit(
      'system',
      'automation.stopped',
      `${projectId}:${e.code}`,
      { mode: was },
      { mode: 'off', reason },
    );
    try {
      const jobId = await this.writeParagraph(projectId, e, {
        kind: 'disable',
        changes: this.store.changes(projectId, e.code),
        by: 'automation',
        changeId,
      });
      this.store.setChangeGovernance(changeId, jobId, 'written');
    } catch (err) {
      this.store.setChangeGovernance(changeId, null, 'failed');
      this.store.setGovernancePending(projectId, e.code, `record “off”: ${errMessage(err)}`);
    }
  }

  /** Amendments owed (an "off" whose write failed) are tried again. */
  private async catchUpGovernance(projectId: string): Promise<void> {
    await this.amendCapsWording(projectId);
    for (const s of this.store.settings(projectId)) {
      if (!s.governancePending) continue;
      const e = entryOf(s.code);
      if (!e) continue;
      try {
        await this.writeParagraph(projectId, e, {
          kind: s.mode === 'off' ? 'disable' : 'amend',
          changes: this.store.changes(projectId, s.code),
          by: 'automation',
          changeId: null,
        });
        this.store.setGovernancePending(projectId, s.code, null);
      } catch (err) {
        this.store.setGovernancePending(
          projectId,
          s.code,
          `${s.governancePending} (again: ${errMessage(err)})`,
        );
      }
    }
  }

  /**
   * v3 F5b.1 (ADR 0068 amendment 1): a paragraph that still states the caps in numbers is amended ONCE, through the
   * ordinary paragraph path (a block-by-block job, the pack's approval carried over it), to "within the automation caps
   * set on the Settings page". Only while Repository Automation reads as approved (an edited paragraph is the owner's
   * to set right first); a failure is recorded as the code's pending governance and tried again.
   */
  private async amendCapsWording(projectId: string): Promise<void> {
    const old = this.store.paragraphs(projectId).filter((p) => OLD_CAPS_WORDING.test(p.text));
    if (old.length === 0) return;
    const gov = await this.governanceState(projectId, 'P3');
    if (!gov.ok) return;
    for (const p of old) {
      const e = entryOf(p.code);
      if (!e) continue;
      try {
        await this.writeParagraph(projectId, e, {
          kind: 'amend',
          changes: this.store.changes(projectId, p.code),
          by: 'automation',
          changeId: null,
        });
      } catch (err) {
        this.store.setGovernancePending(projectId, p.code, `caps wording: ${errMessage(err)}`);
        return; // the document moved on: the next run reads it afresh
      }
    }
  }

  // ============================================================================================ the run

  /** Why automation must not run in this project now, or null. */
  private blocked(projectId: string): string | null {
    if (this.stopping) return 'the bridge is stopping';
    if (this.store.global().paused) return 'Pause all automation is on';
    const c = this.d.engine.queries.controls(projectId);
    if (c.readOnly) return c.project?.readOnly ? 'the project is read-only' : 'read-only mode is on';
    if (c.writesPaused) return 'writes are paused';
    if (c.draining) return 'the bridge is draining';
    return null;
  }

  /** The P3 budget's wait before the next page (6 reads, 2 writes), or null when nothing waits. */
  private budgetWaits(projectId: string): BudgetWait | null {
    if (this.d.budgetWaits) return this.d.budgetWaits(projectId);
    const g = this.d.projects.anyClient(projectId)?.governor;
    if (!g) return { ms: DAY_MS, tier: 'none', label: 'budget (no client for the project)', day: false };
    const e = g.estimate({ reads: 6, writes: 2, priority: 'P3' });
    const label = (t: { tier: string }, group?: string): string =>
      group !== undefined
        ? `${group} operation tier`
        : t.tier.endsWith('-min')
          ? 'minute tier'
          : t.tier.endsWith('-hour')
            ? 'hour tier'
            : t.tier.endsWith('-day')
              ? 'day tier'
              : `${t.tier} tier`;
    const all = [
      ...e.tiers.map((t) => ({ ...t, label: label(t), day: t.tier === 'key-day' || t.windowMs >= DAY_MS })),
      ...e.operationTiers.map((t) => ({ ...t, label: label(t, t.group), day: t.windowMs >= DAY_MS })),
    ].filter((t) => t.timeMs > 0);
    if (all.length === 0) return null;
    const longest = (xs: typeof all) => xs.reduce((a, b) => (b.timeMs > a.timeMs ? b : a));
    const top = longest(all);
    const day = all.filter((t) => t.day);
    const cause = day.length > 0 ? longest(day) : top;
    return { ms: top.timeMs, tier: cause.tier, label: cause.label, day: day.length > 0 };
  }

  private sleep(ms: number): Promise<void> {
    const signal = this.d.background?.signal
      ? AbortSignal.any([this.abort.signal, this.d.background.signal])
      : this.abort.signal;
    return (this.d.sleep ?? sleepFor)(ms, signal);
  }

  private ceilingReached(projectId: string): boolean {
    const info = this.runInfo.get(projectId);
    return !!info && this.d.now() - info.startedAt >= this.settings().runMaxMinutes * 60_000;
  }

  /** Notes a pause in the run's log and its summary: "paused 42 s for the minute tier". */
  private notePause(projectId: string, runId: string, what: string, ms: number): void {
    const note = `paused ${fmtWait(ms)} for ${what}`;
    this.runInfo.get(projectId)?.pauses.push(note);
    this.d.log?.info({ project: projectId, run: runId, pausedMs: ms }, `automation: ${note}`);
  }

  /**
   * v3 F5b.1 (ADR 0068 amendment 1): the budget before a page. A wait no longer than AUTOMATION_BUDGET_MAX_WAIT_SECONDS
   * is slept through (abortable: a stop ends it at once) and the check made again, so the run carries on with the same
   * page; a longer wait, a wait on the day tier (or its maintenance floor), the run's time limit or a stop ends the run.
   * Returns null to go on, else why the run stops (recorded as an item for the page when there is one).
   */
  private async awaitBudget(
    projectId: string,
    runId: string,
    e: CodeEntry,
    c: { pageId: string | null; pageName: string | null } | null,
  ): Promise<{ why: string } | null> {
    const stop = (code: string, why: string): { why: string } => {
      if (c) this.item(projectId, runId, e.code, c, 'stopped', { reasonCode: code, reason: why });
      return { why };
    };
    let slept = false;
    for (;;) {
      if (slept) {
        const why = this.blocked(projectId);
        if (why) return stop('STOPPED', why);
      }
      if (this.ceilingReached(projectId)) return stop('TIME_LIMIT', 'the run’s time limit was reached');
      const w = this.budgetWaits(projectId);
      if (!w) return null;
      const max = this.settings().budgetMaxWaitSeconds;
      if (w.day)
        return stop(
          'BUDGET',
          `the ${w.label} says wait ${fmtWait(w.ms)} (the day tier, with its maintenance floor RESERVE_DAY_FLOOR_MAINTENANCE, is never slept through)`,
        );
      if (w.ms > max * 1000)
        return stop(
          'BUDGET',
          `the ${w.label} says wait ${fmtWait(w.ms)}, longer than the ${max} s a run pauses for (AUTOMATION_BUDGET_MAX_WAIT_SECONDS)`,
        );
      const info = this.runInfo.get(projectId);
      const started = this.d.now();
      if (info) info.pausing = { label: w.label, seconds: Math.ceil(w.ms / 1000), since: started };
      try {
        await this.sleep(Math.max(w.ms, 50));
      } finally {
        if (info) info.pausing = null;
      }
      this.notePause(projectId, runId, `the ${w.label}`, w.ms);
      slept = true;
    }
  }

  /**
   * An Apply job waiting for budget: waited for, up to AUTOMATION_BUDGET_MAX_WAIT_SECONDS (abortable), then settled.
   * `why` is set when the run must stop (the job is still waiting past the limit, the time limit, or a stop).
   */
  private async awaitJob(
    projectId: string,
    runId: string,
    job: JobView,
  ): Promise<{ job: JobView; why: string | null }> {
    const max = this.settings().budgetMaxWaitSeconds * 1000;
    const started = this.d.now();
    const info = this.runInfo.get(projectId);
    let j = job;
    try {
      while (j.status === 'waiting_budget') {
        const why = this.blocked(projectId);
        if (why) return { job: j, why };
        if (this.ceilingReached(projectId)) return { job: j, why: 'the run’s time limit was reached' };
        const waited = this.d.now() - started;
        if (waited >= max)
          return {
            job: j,
            why: `the job ${j.id} is still waiting for budget after ${fmtWait(waited)} (AUTOMATION_BUDGET_MAX_WAIT_SECONDS)`,
          };
        if (info)
          info.pausing = {
            label: 'a job waiting for budget',
            seconds: Math.ceil((max - waited) / 1000),
            since: started,
          };
        await this.sleep(Math.min(1_000, max - waited));
        j = (this.d.engine.queries.getJob(projectId, j.id) as JobView | undefined) ?? j;
      }
    } finally {
      if (info) info.pausing = null;
    }
    const waited = this.d.now() - started;
    if (waited > 0) this.notePause(projectId, runId, 'a job waiting for budget', waited);
    return { job: await this.settle(projectId, j.id, this.d.settleMs ?? 600_000), why: null };
  }

  /** One run in a project (the nightly job, or "Run automation now"). A run already in progress is joined. */
  run(
    projectId: string,
    trigger: 'nightly' | 'manual' | 'chronology',
    o: {
      /**
       * The sandbox check's seam (bridge code and tests only, never a route): only these pages (or assets) are acted
       * on, whatever else the findings name.
       */
      readonly onlyPages?: ReadonlySet<string>;
      /** v3 F10 (ADR 0078, C3): only these codes run (the chronology's, straight after its check). */
      readonly codes?: ReadonlySet<string>;
    } = {},
  ): Promise<RunRow> {
    const busy = this.running.get(projectId);
    if (busy) return busy;
    const p = loggedTask(this.d.log, 'automation:run', { project: projectId, trigger }, () =>
      this.runOnce(projectId, trigger, o.onlyPages ?? null, o.codes ?? null),
    ).finally(() => this.running.delete(projectId));
    this.running.set(projectId, p);
    return p;
  }

  /**
   * v3 F10 (ADR 0078, C3): the chronology's codes (C1 and C2) on the findings of the check that just finished, at once,
   * within the caps, as the nightly run does (every stop condition, the governance state and the pauses alike).
   */
  runChronology(
    projectId: string,
    o: {
      /** C5: the workstream of the table edit that caused the check, per age (its repairs are attributed to it). */
      readonly workstreamOf?: (age: string) => string | null;
    } = {},
  ): Promise<RunRow> {
    if (o.workstreamOf) this.chronologyWorkstreams.set(projectId, o.workstreamOf);
    return this.run(projectId, 'chronology', {
      codes: new Set(PROPOSE_ONLY.filter((e) => e.source === 'chronology').map((e) => e.code)),
    }).finally(() => {
      if (this.chronologyWorkstreams.get(projectId) === o.workstreamOf)
        this.chronologyWorkstreams.delete(projectId);
    });
  }

  /** v3 F10 (C5): per project, the workstream of the edit behind a run of the chronology codes (set by that run). */
  private readonly chronologyWorkstreams = new Map<string, (age: string) => string | null>();

  private async runOnce(
    projectId: string,
    trigger: string,
    only: ReadonlySet<string> | null,
    codes: ReadonlySet<string> | null = null,
  ): Promise<RunRow> {
    const runId = `aut_${randomBytes(8).toString('hex')}`;
    this.store.startRun(runId, projectId, trigger);
    const info = { startedAt: this.d.now(), pauses: [] as string[], pausing: null as Pausing | null };
    this.runInfo.set(projectId, info);
    const finish = (state: RunRow['state'], summary: string, stop: string | null): RunRow => {
      this.runInfo.delete(projectId);
      this.store.finishRun(
        runId,
        state,
        info.pauses.length > 0 ? `${summary} (${info.pauses.join('; ')}.)` : summary,
        stop,
      );
      return this.store.run(runId)!;
    };
    try {
      const why = this.blocked(projectId);
      if (why) return finish('skipped', `Skipped: ${why}.`, why);
      const enabled = [...ELIGIBLE, ...PROPOSE_ONLY].filter((e) => {
        if (codes && !codes.has(e.code)) return false;
        const s = this.store.setting(projectId, e.code);
        return this.modeOf(projectId, e) !== 'off' && (s?.pausedAt ?? null) === null;
      });
      await this.catchUpGovernance(projectId);
      if (enabled.length === 0)
        return finish('skipped', 'Skipped: no code is switched on (or every one is paused).', null);
      const gov = await this.governanceState(projectId, 'P3');
      if (!gov.ok) return finish('skipped', `Skipped: ${gov.message}`, gov.code);
      const caps = this.caps();
      let left = caps.perRun;
      const ctx = new RunContext(only);
      const done: string[] = [];
      for (const e of enabled) {
        if (left <= 0)
          return finish(
            'stopped',
            `${done.join('; ') || 'nothing done'}. The cap of ${caps.perRun} pages a run was reached; the rest waits for the next run.`,
            'cap',
          );
        const mode = this.modeOf(projectId, e);
        if (mode === 'off') continue;
        if (this.ceilingReached(projectId))
          return finish(
            'stopped',
            `${done.join('; ') || 'nothing done'}. Stopped: the run’s time limit was reached; the rest waits for the next run.`,
            'the run’s time limit was reached',
          );
        const out = await this.runCode(projectId, runId, e, mode, Math.min(caps.perCode, left), ctx);
        left -= out.attempted;
        const capped = out.kind === 'done' && out.capped === true;
        done.push(
          `${e.code}: ${out.attempted} page${out.attempted === 1 ? '' : 's'}${capped ? ` (its cap reached; the rest next run)` : ''}`,
        );
        if (out.kind === 'stopRun')
          return finish(
            'stopped',
            `${done.join('; ')}. Stopped: ${out.why}; the rest waits for the next run.`,
            out.why,
          );
        if (capped && left <= 0)
          return finish(
            'stopped',
            `${done.join('; ')}. The cap of ${caps.perRun} pages a run was reached; the rest waits for the next run.`,
            'cap',
          );
      }
      return finish('succeeded', done.join('; ') || 'Nothing to do.', null);
    } catch (e) {
      return finish('failed', `The run failed: ${errMessage(e)}`, errCode(e));
    }
  }

  private item(
    projectId: string,
    runId: string,
    code: string,
    c: { pageId: string | null; pageName: string | null },
    outcome: ItemOutcome,
    o: { reasonCode?: string; reason?: string; jobId?: string; proposalId?: string } = {},
  ): void {
    this.store.addItem({
      runId,
      projectId,
      code,
      pageId: c.pageId,
      pageName: c.pageName,
      outcome,
      reasonCode: o.reasonCode ?? null,
      reason: o.reason ?? null,
      jobId: o.jobId ?? null,
      proposalId: o.proposalId ?? null,
    });
  }

  /** A skip: recorded; three in a row for the same reason pause the code. Returns true when it paused. */
  private skipped(
    projectId: string,
    runId: string,
    e: CodeEntry,
    c: Candidate,
    code: string,
    reason: string,
  ): boolean {
    // A page already as the fix would leave it (another write, or an earlier item of this run, did it) is recorded
    // and is not a skip for the streak: there was nothing to do, not something the code could not do.
    if (code === 'NOTHING_TO_DO') {
      this.item(projectId, runId, e.code, c, 'skipped', { reasonCode: 'ALREADY_DONE', reason });
      return false;
    }
    this.item(projectId, runId, e.code, c, 'skipped', { reasonCode: code, reason });
    const streak = this.store.skip(projectId, e.code, code);
    if (streak >= SKIP_STREAK_PAUSE) {
      this.store.pause(
        projectId,
        e.code,
        `${SKIP_STREAK_PAUSE} findings skipped in a row for the same reason (${code}: ${reason}): paused for the owner’s review`,
      );
      this.d.audit('system', 'automation.paused', `${projectId}:${e.code}`, null, { reason: code });
      return true;
    }
    return false;
  }

  private origin(e: CodeEntry): JobOrigin {
    return {
      kind: 'maintenance',
      client: 'automation',
      tool: `automation.${e.code}`,
      detail: e.name,
      principal: AUTOMATION_PRINCIPAL,
    };
  }

  private async runCode(
    projectId: string,
    runId: string,
    e: CodeEntry,
    mode: Exclude<Mode, 'off'>,
    cap: number,
    ctx: RunContext,
  ): Promise<CodeOutcome> {
    if (e.source === 'retag') return this.runRetag(projectId, runId, e, mode, cap, ctx);
    if (e.source === 'chronology') return this.runChronologyCode(projectId, runId, e, cap, mode);
    if (e.automatable === 'propose' && e.batch !== true)
      return this.runProposals(projectId, runId, e, cap, mode);
    let candidates: Candidate[];
    try {
      candidates = (await this.candidates(projectId, e, ctx)).filter((c) => ctx.allows(c.pageId));
      if (e.batch === true) {
        // v3 F6d (ADR 0082): a page an earlier run proposed (the owner decides it once) or applied is not taken again.
        const done = new Set(
          this.store
            .codeItems(projectId, e.code, 5000)
            .filter((i) => i.proposalId !== null || (i.outcome === 'applied' && i.jobId !== null))
            .map((i) => i.pageId),
        );
        candidates = candidates.filter((c) => !done.has(c.pageId));
      }
    } catch (err) {
      this.item(projectId, runId, e.code, { pageId: null, pageName: null }, 'skipped', {
        reasonCode: errCode(err),
        reason: `the findings could not be gathered: ${errMessage(err)}`,
      });
      return { kind: 'done', attempted: 0 };
    }
    let attempted = 0;
    const proposals: { c: Candidate; planned: Extract<Planned, { ok: true }> }[] = [];
    let capped = false;
    for (const c of candidates) {
      if (attempted >= cap) {
        capped = true;
        break;
      }
      const why = this.blocked(projectId);
      if (why) return { kind: 'stopRun', why, attempted };
      const paced = await this.awaitBudget(projectId, runId, e, c);
      if (paced) return { kind: 'stopRun', why: paced.why, attempted };
      attempted++;
      await yieldToLoop(); // R3-64: the owner's and the agents' requests are answered between pages
      let planned: Planned;
      try {
        planned = await c.plan();
      } catch (err) {
        const code = errCode(err);
        if (code === 'BUDGET_EXHAUSTED')
          return { kind: 'stopRun', why: 'the P3 budget says wait', attempted };
        planned = { ok: false, code, reason: errMessage(err) };
      }
      if (!planned.ok) {
        if (this.skipped(projectId, runId, e, c, planned.code, planned.reason))
          return { kind: 'done', attempted };
        continue;
      }
      if (mode === 'propose') {
        proposals.push({ c, planned });
        continue;
      }
      const r =
        e.batch === true
          ? await this.applyBatchOne(projectId, runId, e, c, planned)
          : await this.applyOne(projectId, runId, e, c, planned);
      if (r === 'stopCode') return { kind: 'done', attempted };
      if (typeof r === 'object') return { kind: 'stopRun', why: r.why, attempted };
    }
    if (mode === 'propose' && proposals.length > 0) await this.proposeAll(projectId, runId, e, proposals);
    return { kind: 'done', attempted, capped };
  }

  /**
   * v3 F7 (ADR 0070, G7): a proposal-only code: each open finding with a fix becomes its OWN proposal through the
   * audit's "Propose a fix" (which reads its targets live first), as the Automation principal. A finding already
   * proposed by an earlier run is not proposed again (the owner decides it once).
   */
  private async runProposals(
    projectId: string,
    runId: string,
    e: CodeEntry,
    cap: number,
    mode: Exclude<Mode, 'off'> = 'propose',
  ): Promise<CodeOutcome> {
    const list = this.d.audits.store
      .list(projectId, { code: [e.code], state: 'open', limit: 5000 })
      .findings.filter((f) => f.fix !== null)
      .sort((a, b) => a.id - b.id);
    const done = new Set(
      this.store
        .codeItems(projectId, e.code, 5000)
        .filter(
          (i) =>
            (i.proposalId !== null || (i.outcome === 'applied' && i.jobId !== null)) && i.pageId !== null,
        )
        .map((i) => i.pageId!),
    );
    // v3 F7.1 (ADR 0072): a code whose fix may run as a job once the owner switches it to Apply (`applyDirect`).
    const direct = mode === 'apply' && e.applyDirect === true;
    let attempted = 0;
    let capped = false;
    for (const f of list) {
      const key = `finding:${f.fingerprint}`;
      if (done.has(key)) continue;
      if (attempted >= cap) {
        capped = true;
        break;
      }
      const why = this.blocked(projectId);
      if (why) return { kind: 'stopRun', why, attempted };
      attempted++;
      await yieldToLoop();
      const c: Candidate = {
        pageId: key,
        pageName: f.message.slice(0, 200),
        plan: () =>
          Promise.resolve({ ok: false, code: 'PROPOSE_ONLY', reason: 'proposed through the audit' }),
      };
      try {
        const r = await this.d.audits.proposeFix('automation', projectId, f.id, {
          origin: this.origin(e),
          ...(direct ? { direct: true } : {}),
        });
        if (r.status === 'proposal_captured')
          this.item(projectId, runId, e.code, c, 'proposed', {
            proposalId: r.proposalId,
            // Apply: a guard (the canon guard, for an Authoritative page's rename) made it a proposal, as always.
            ...(direct
              ? { reasonCode: 'GUARDED', reason: 'a guard made it a proposal (canon is the owner’s)' }
              : {}),
          });
        else if (r.status === 'job_submitted') {
          const job = await this.settle(projectId, r.jobId, this.d.settleMs ?? 600_000);
          if (job?.status === 'succeeded')
            this.item(projectId, runId, e.code, c, 'applied', { jobId: r.jobId });
          else {
            await this.fail(
              projectId,
              runId,
              e,
              c,
              'JOB_FAILED',
              `the job ${r.jobId} ended ${job?.status ?? 'unknown'}`,
            );
            return { kind: 'done', attempted };
          }
        } else
          this.item(projectId, runId, e.code, c, 'skipped', {
            reasonCode: 'NOTHING_TO_DO',
            reason: r.message,
          });
      } catch (err) {
        if (this.skipped(projectId, runId, e, c, errCode(err), errMessage(err)))
          return { kind: 'done', attempted };
      }
    }
    return { kind: 'done', attempted, capped };
  }

  /**
   * v3 F10 (ADR 0078, C1 and C2): a chronology code. Its findings are the chronology check's own, from its newest
   * successful run (the table is the authority: never repaired from its timeline). Each finding's fix is planned live
   * by the chronology module and becomes ONE proposal (Propose), or a job (Apply) unless the plan names a guard (then
   * a proposal with the reason). A finding a run already proposed or applied is not acted on again. Refusals that leave
   * the finding to the owner (an ambiguous pairing, a date the engine cannot read, an order that is not strict, a
   * partial date's KCY) are recorded as `guarded` and never pause the code; a row the owner marked table-only is
   * skipped.
   */
  private async runChronologyCode(
    projectId: string,
    runId: string,
    e: CodeEntry,
    cap: number,
    mode: Exclude<Mode, 'off'>,
  ): Promise<CodeOutcome> {
    const chron = this.d.chronology;
    const spec = e.chronology!;
    const none = (reason: string): CodeOutcome => {
      this.item(projectId, runId, e.code, { pageId: null, pageName: null }, 'skipped', {
        reasonCode: 'NO_CHRONOLOGY',
        reason,
      });
      return { kind: 'done', attempted: 0 };
    };
    if (!chron) return none('the chronology is not running on this bridge');
    const ready = chron.readiness(projectId);
    if (!ready.ok) return { kind: 'done', attempted: 0 }; // no confirmed chronology: nothing to do, nothing to say
    const last = chron.store.lastCheck(projectId);
    if (!last || last.state !== 'succeeded') return { kind: 'done', attempted: 0 };
    // One fix per target: a row, an event, or (a count, an order) the age.
    const seen = new Set<string>();
    const todo: { key: string; name: string; fix: ChronologyFix }[] = [];
    for (const f of last.findings) {
      if (f.kind !== spec.kind) continue;
      const d = f.detail ?? {};
      const rowId = typeof d.rowId === 'string' ? d.rowId : null;
      const eventId = typeof d.eventId === 'string' ? d.eventId : null;
      let fix: ChronologyFix | null = null;
      let target: string | null = null;
      if (spec.fix === 'sync' && rowId) {
        fix = { age: f.age, rowId };
        target = `row:${rowId}`;
      } else if ((spec.fix === 'kcy' || spec.fix === 'style') && rowId) {
        fix = { kind: spec.fix, age: f.age, rowId };
        target = `row:${rowId}`;
      } else if (spec.fix === 'uri' && eventId) {
        fix = { kind: 'uri', age: f.age, eventId };
        target = `event:${eventId}`;
      } else if (spec.fix === 'count' && typeof d.main === 'string') {
        fix = { kind: 'count', age: f.age };
        target = 'age';
      } else if (spec.fix === 'order') {
        fix = { kind: 'order', age: f.age };
        target = 'age';
      }
      if (!fix || !target) continue;
      // The finding's own words for what it is (its dates, cells and counts): a changed row or event is a new finding.
      const key = `chronology:${f.age}:${spec.kind}:${target}:${createHash('sha256').update(f.message).digest('hex').slice(0, 16)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      todo.push({ key, name: `${f.age}: ${f.message}`.slice(0, 200), fix });
    }
    const done = new Set(
      this.store
        .codeItems(projectId, e.code, 5000)
        .filter(
          (i) =>
            (i.proposalId !== null || (i.outcome === 'applied' && i.jobId !== null)) && i.pageId !== null,
        )
        .map((i) => i.pageId!),
    );
    let attempted = 0;
    let capped = false;
    for (const t of todo) {
      if (done.has(t.key)) continue;
      if (attempted >= cap) {
        capped = true;
        break;
      }
      const why = this.blocked(projectId);
      if (why) return { kind: 'stopRun', why, attempted };
      const paced = await this.awaitBudget(projectId, runId, e, { pageId: t.key, pageName: t.name });
      if (paced) return { kind: 'stopRun', why: paced.why, attempted };
      attempted++;
      await yieldToLoop();
      const c: Candidate = {
        pageId: t.key,
        pageName: t.name,
        plan: () => Promise.resolve({ ok: false, code: 'CHRONOLOGY', reason: 'planned by the chronology' }),
      };
      try {
        // C5: a repair caused by a table edit with a workstream is in that workstream (bridge_workstream_report).
        const ws = this.chronologyWorkstreams.get(projectId)?.(t.fix.age) ?? null;
        const origin = ws ? { ...this.origin(e), workstream: ws } : this.origin(e);
        const r = await chron.repair('automation', projectId, t.fix, { mode, origin });
        if (r.status === 'proposal_captured')
          this.item(projectId, runId, e.code, c, 'proposed', {
            proposalId: r.proposalId,
            ...(r.guard
              ? { reasonCode: r.guard.code, reason: `proposed, not applied: ${r.guard.reason}` }
              : {}),
          });
        else if (r.status === 'job_submitted') {
          let job = await this.settle(projectId, r.jobId, this.d.settleMs ?? 600_000);
          if (job.status === 'waiting_budget') {
            const w = await this.awaitJob(projectId, runId, job);
            job = w.job;
            if (w.why) {
              this.item(projectId, runId, e.code, c, 'stopped', {
                reasonCode: 'BUDGET',
                reason: w.why,
                jobId: r.jobId,
              });
              return { kind: 'stopRun', why: w.why, attempted };
            }
          }
          if (job.status === 'succeeded')
            this.item(projectId, runId, e.code, c, 'applied', { jobId: r.jobId });
          else {
            await this.fail(
              projectId,
              runId,
              e,
              c,
              'JOB_FAILED',
              `the job ${r.jobId} ended ${job.status}`,
              r.jobId,
            );
            return { kind: 'done', attempted };
          }
        } else if (this.skipped(projectId, runId, e, c, 'NOTHING_TO_DO', r.message))
          return { kind: 'done', attempted };
      } catch (err) {
        const code = errCode(err);
        if (code === 'BUDGET_EXHAUSTED')
          return { kind: 'stopRun', why: 'the P3 budget says wait', attempted };
        if (code === 'ROW_TABLE_ONLY')
          this.item(projectId, runId, e.code, c, 'skipped', {
            reasonCode: 'TABLE_ONLY',
            reason: errMessage(err),
          });
        else if (CHRONOLOGY_JUDGEMENTS.has(code))
          this.item(projectId, runId, e.code, c, 'guarded', {
            reasonCode: code,
            reason: `left for the owner: ${errMessage(err)}`,
          });
        else if (this.skipped(projectId, runId, e, c, code, errMessage(err)))
          return { kind: 'done', attempted };
      }
    }
    return { kind: 'done', attempted, capped };
  }

  // ---------------------------------------------------------------------------------------------- findings

  private async candidates(projectId: string, e: CodeEntry, ctx: RunContext): Promise<Candidate[]> {
    const { reader } = await this.d.appraisal.reader(projectId);
    const inScope = (id: string | null | undefined): boolean => {
      if (!id) return false;
      if (!reader.page(id)) return false;
      const area = reader.labels(id).area;
      return area === null || area === e.area;
    };
    const read = (op: string, params: Obj) =>
      this.d.engine.internalRead(projectId, op, params, { priority: 'P3', notFoundIsAnswer: true });
    if (e.source === 'audit') {
      // v3 F6d (ADR 0082): a batch code takes its findings in the check's run order (primary category, then name).
      const order = (f: Finding): number =>
        e.batch === true && typeof f.evidence.order === 'number' ? f.evidence.order : 0;
      const list = this.d.audits.store
        .list(projectId, { code: [e.code], state: 'open', limit: 5000 })
        .findings.filter((f) => f.fix !== null && inScope(f.pageId))
        .sort(
          (a, b) => order(a) - order(b) || (a.pageName ?? '').localeCompare(b.pageName ?? '') || a.id - b.id,
        );
      const seen = new Set<string>();
      return list
        .filter((f) => {
          if (seen.has(f.pageId!)) return false;
          seen.add(f.pageId!);
          return true;
        })
        .map((f) => ({
          pageId: f.pageId!,
          pageName: f.pageName ?? f.pageId!,
          plan: () => this.planAudit(projectId, e, f, read),
        }));
    }
    const findings = await ctx.appraisal(this, projectId, e);
    const seen = new Set<string>();
    const target = (f: AppraisalFinding): { id: string; name: string } | null => {
      if (e.target === 'asset') {
        const asset = isObj(f.details.asset) ? f.details.asset : {};
        const id = typeof f.fix?.args.assetId === 'string' ? f.fix.args.assetId : null;
        return id ? { id, name: typeof asset.name === 'string' ? asset.name : id } : null;
      }
      return f.page && inScope(f.page.id) ? { id: f.page.id, name: f.page.name } : null;
    };
    return findings
      .filter((f) => f.check === e.code && f.followUp.kind === 'fix' && f.fix)
      .map((f) => ({ f, t: target(f) }))
      .filter((x): x is { f: AppraisalFinding; t: { id: string; name: string } } => x.t !== null)
      .sort((a, b) => a.t.name.localeCompare(b.t.name) || a.f.id.localeCompare(b.f.id))
      .filter((x) => {
        if (seen.has(x.t.id)) return false;
        seen.add(x.t.id);
        return true;
      })
      .map((x) => ({
        pageId: x.t.id,
        pageName: x.t.name,
        plan: () => this.planAppraisal(projectId, e, x.f, read),
      }));
  }

  /** The appraisal's findings for a run (each tool run once per run, free: the snapshots). */
  async appraisalFindings(projectId: string, e: CodeEntry): Promise<readonly AppraisalFinding[]> {
    const report =
      e.target === 'asset'
        ? await this.d.appraisal.visualHygiene({ projectId, actor: 'automation', scope: { all: true } })
        : await this.d.appraisal.appraiseOwner({ projectId, actor: 'automation', scope: { all: true } });
    return report.findings;
  }

  /** The pre-image of a target, read live at P3 (null: gone). */
  private async preImage(
    projectId: string,
    e: CodeEntry,
    ids: { resourceId: string | null; documentId: string | null; assetId: string | null },
    read: (op: string, params: Obj) => Promise<unknown>,
  ): Promise<Obj | null> {
    if (e.target === 'asset') {
      const a = await read('getAsset', { path: { assetId: ids.assetId } });
      return isObj(a) ? a : null;
    }
    const res = await read('getResource', { path: { resourceId: ids.resourceId } });
    if (!isObj(res)) return null;
    if (e.target !== 'document' || !ids.documentId) return { resource: res };
    const doc = await read('getDocumentBlocks', {
      path: { resourceId: ids.resourceId, documentId: ids.documentId },
    });
    return { resource: res, document: isObj(doc) ? doc : null };
  }

  private capture(): { submit: (req: Obj) => Promise<Obj>; taken: () => Obj | null } {
    let taken: Obj | null = null;
    return {
      submit: (req: Obj) => {
        taken = req;
        return Promise.resolve({ status: 'proposal_captured', proposalId: CAPTURED });
      },
      taken: () => taken,
    };
  }

  private async planAudit(
    projectId: string,
    e: CodeEntry,
    f: Finding,
    read: (op: string, params: Obj) => Promise<unknown>,
  ): Promise<Planned> {
    const documentId = typeof f.fix?.args.documentId === 'string' ? f.fix.args.documentId : f.documentId;
    const ids = { resourceId: f.pageId, documentId: documentId ?? null, assetId: null };
    const pre = await this.preImage(projectId, e, ids, read);
    if (!pre) return { ok: false, code: 'FIX_STALE', reason: 'the page is gone' };
    if (e.target === 'document' && hasUnsupported((pre.document as Obj | null)?.blocks))
      return {
        ok: false,
        code: 'UNSUPPORTED_BLOCKS',
        reason: 'the document holds unsupported blocks, which automation never touches',
      };
    const cap = this.capture();
    try {
      const r = await this.d.audits.proposeFix('automation', projectId, f.id, {
        origin: this.origin(e),
        engine: {
          internalRead: (p, op, params) => this.d.engine.internalRead(p, op, params, { priority: 'P3' }),
          submit: cap.submit,
        },
      });
      if (r.status !== 'proposal_captured')
        return { ok: false, code: 'NOTHING_TO_DO', reason: 'message' in r ? r.message : 'not planned' };
    } catch (err) {
      return { ok: false, code: errCode(err), reason: errMessage(err) };
    }
    return this.planned(e, cap.taken(), pre, ids);
  }

  private async planAppraisal(
    projectId: string,
    e: CodeEntry,
    f: AppraisalFinding,
    read: (op: string, params: Obj) => Promise<unknown>,
  ): Promise<Planned> {
    const documentId =
      typeof f.fix?.args.documentId === 'string' ? f.fix.args.documentId : (f.documentId ?? null);
    const ids =
      e.target === 'asset'
        ? {
            resourceId: null,
            documentId: null,
            assetId: typeof f.fix?.args.assetId === 'string' ? f.fix.args.assetId : '',
          }
        : { resourceId: f.page?.id ?? null, documentId, assetId: null };
    const pre = await this.preImage(projectId, e, ids, read);
    if (!pre) return { ok: false, code: 'FIX_STALE', reason: 'the target is gone' };
    if (e.target === 'document' && hasUnsupported((pre.document as Obj | null)?.blocks))
      return {
        ok: false,
        code: 'UNSUPPORTED_BLOCKS',
        reason: 'the document holds unsupported blocks, which automation never touches',
      };
    const cap = this.capture();
    try {
      const r = await this.d.appraisal.proposeFix({
        projectId,
        findingId: f.id,
        actor: 'automation',
        origin: this.origin(e),
        read: (op, params) => read(op, params),
        forceProposal: true,
        submit: cap.submit,
      });
      if (r.status === 'nothing_to_do') return { ok: false, code: 'NOTHING_TO_DO', reason: r.message };
    } catch (err) {
      return { ok: false, code: errCode(err), reason: errMessage(err) };
    }
    const req = cap.taken();
    const op = isObj(req?.proposal) && isObj(req.proposal.operation) ? req.proposal.operation : {};
    // A dash in a subject's name renames the subject on this page alone: a rename, never automatic.
    if (typeof op.plainRename === 'string')
      return {
        ok: false,
        code: 'NOT_MECHANICAL',
        reason: `a rename of a subject (${op.plainRename}); left to the owner`,
      };
    return this.planned(e, req, pre, ids);
  }

  /** The captured request with what its read-back must show. */
  private planned(
    e: CodeEntry,
    req: Obj | null,
    pre: Obj,
    ids: { resourceId: string | null; documentId: string | null; assetId: string | null },
  ): Planned {
    if (!req || !Array.isArray(req.steps))
      return { ok: false, code: 'NOT_PLANNED', reason: 'the fix planned no job' };
    const steps = req.steps as StepSpec[];
    const fields: Obj = {};
    let blocks: unknown[] | null = null;
    let documentId = ids.documentId;
    for (const s of steps) {
      const body = isObj(s.params?.body) ? s.params.body : null;
      if ((s.op === 'updateResource' || s.op === 'updateAsset') && body) {
        if (typeof body.name === 'string') fields.name = body.name;
        if (Array.isArray(body.tags)) fields.tags = body.tags;
      }
      if (s.op === 'replaceDocumentBlocks' && body && Array.isArray(body.blocks)) {
        blocks = body.blocks as unknown[];
        documentId = ((s.params?.path as Obj | undefined)?.documentId as string) ?? documentId;
      }
      if (s.op === VERIFY_STEP && body && Array.isArray(body.targets))
        for (const t of body.targets as Obj[])
          if (t.kind === 'blocks' && Array.isArray(t.blocks)) {
            blocks = t.blocks as unknown[];
            if (typeof t.documentId === 'string') documentId = t.documentId;
          }
    }
    if (e.target === 'document' && !blocks)
      return {
        ok: false,
        code: 'NOT_VERIFIABLE',
        reason: 'the planned document could not be read from the fix',
      };
    return {
      ok: true,
      req,
      pre,
      expect: {
        target: e.target!,
        resourceId: ids.resourceId,
        documentId,
        assetId: ids.assetId,
        blocks,
        fields,
      },
    };
  }

  // ---------------------------------------------------------------------------------------------- apply

  /**
   * One page applied: the captured job submitted as the Automation principal at P3 (every guard and rail judging it),
   * settled, and read back. `ok`, `stopCode` (the code was switched off or paused), or a reason to end the run.
   */
  private async applyOne(
    projectId: string,
    runId: string,
    e: CodeEntry,
    c: Candidate,
    p: Extract<Planned, { ok: true }>,
  ): Promise<'ok' | 'skip' | 'stopCode' | { why: string }> {
    const { forceProposal: _f, ...rest } = p.req;
    void _f;
    let r: Obj;
    try {
      r = (await this.d.engine.submit({
        ...rest,
        priority: 'P3',
        origin: this.origin(e),
        title: `Automation (${e.name}): ${typeof p.req.title === 'string' ? p.req.title : c.pageName}`.slice(
          0,
          300,
        ),
      } as unknown as SubmitRequest)) as unknown as Obj;
    } catch (err) {
      const why = this.blocked(projectId);
      if (why) return { why };
      // A guard (the lifecycle guard, the canon guard, the policy gate) refusing the change: never bypassed. It is
      // offered to the owner as an ordinary proposal where the guards allow one, and the code pauses for review.
      if (GUARD_CODES.has(errCode(err))) return this.guarded(projectId, runId, e, c, rest, errMessage(err));
      await this.fail(projectId, runId, e, c, 'UNEXPECTED_ERROR', `the job was refused: ${errMessage(err)}`);
      return 'stopCode';
    }
    if (typeof r.proposalId === 'string') {
      const because =
        typeof r.proposedBecause === 'string'
          ? r.proposedBecause
          : isObj(r.canonical)
            ? `the canon guard: ${String(r.canonical.reason)}`
            : 'a guard made it a proposal';
      this.item(projectId, runId, e.code, c, 'guarded', {
        reasonCode: 'GUARDED',
        reason: because,
        proposalId: r.proposalId,
      });
      this.store.pause(
        projectId,
        e.code,
        `a guard caught a change (${because}); it became proposal ${r.proposalId}. Paused for the owner’s review: the code was not as mechanical as assumed`,
      );
      this.d.audit('system', 'automation.paused', `${projectId}:${e.code}`, null, {
        reason: 'GUARDED',
        proposalId: r.proposalId,
      });
      return 'stopCode';
    }
    const jobId = String(r.jobId);
    const job = await this.settle(projectId, jobId, this.d.settleMs ?? 600_000);
    return this.judgeJob(projectId, runId, e, c, job, p.expect, p.pre);
  }

  /**
   * v3 F6d (ADR 0082; F12's division): a batch code's Apply of one page: the captured job submitted as the Automation
   * principal at P3, never forced into a proposal. A guard that makes it the owner's canonical proposal (an Authoritative
   * page's rename) is recorded as guarded and the run goes on; a guard's refusal is a skip; otherwise the job is settled
   * and read back as every Apply is.
   */
  private async applyBatchOne(
    projectId: string,
    runId: string,
    e: CodeEntry,
    c: Candidate,
    p: Extract<Planned, { ok: true }>,
  ): Promise<'ok' | 'skip' | 'stopCode' | { why: string }> {
    const { forceProposal: _f, ...rest } = p.req;
    void _f;
    let r: Obj;
    try {
      r = (await this.d.engine.submit({
        ...rest,
        priority: 'P3',
        origin: this.origin(e),
        title: `Automation (${e.name}): ${typeof p.req.title === 'string' ? p.req.title : c.pageName}`.slice(
          0,
          300,
        ),
      } as unknown as SubmitRequest)) as unknown as Obj;
    } catch (err) {
      const why = this.blocked(projectId);
      if (why) return { why };
      if (GUARD_CODES.has(errCode(err))) {
        if (this.skipped(projectId, runId, e, c, errCode(err), `a guard refused it: ${errMessage(err)}`))
          return 'stopCode';
        return 'skip';
      }
      await this.fail(projectId, runId, e, c, 'UNEXPECTED_ERROR', `the job was refused: ${errMessage(err)}`);
      return 'stopCode';
    }
    if (typeof r.proposalId === 'string') {
      const because =
        typeof r.proposedBecause === 'string'
          ? r.proposedBecause
          : isObj(r.canonical)
            ? `the canon guard: ${String(r.canonical.reason)}`
            : 'a guard made it a proposal';
      this.item(projectId, runId, e.code, c, 'guarded', {
        reasonCode: 'GUARDED',
        reason: because.slice(0, 1500),
        proposalId: r.proposalId,
      });
      this.tellBatch(projectId, p.req, { proposalId: r.proposalId });
      return 'ok';
    }
    const jobId = String(r.jobId);
    this.tellBatch(projectId, p.req, { jobId });
    const job = await this.settle(projectId, jobId, this.d.settleMs ?? 600_000);
    return this.judgeJob(projectId, runId, e, c, job, p.expect, p.pre);
  }

  private tellBatch(projectId: string, req: Obj, ids: { jobId?: string; proposalId?: string }): void {
    try {
      this.d.afterBatch?.(projectId, req, ids);
    } catch (err) {
      this.d.log?.warn({ err, projectId }, 'a batch code’s submission could not be recorded');
    }
  }

  /** A change a guard refused: an ordinary proposal where the guards allow one; the code paused either way. */
  private async guarded(
    projectId: string,
    runId: string,
    e: CodeEntry,
    c: Candidate,
    req: Obj,
    refusal: string,
  ): Promise<'stopCode'> {
    let proposalId: string | undefined;
    try {
      const r = (await this.d.engine.submit({
        ...req,
        priority: 'P3',
        origin: this.origin(e),
        forceProposal: true,
      } as unknown as SubmitRequest)) as unknown as Obj;
      if (typeof r.proposalId === 'string') proposalId = r.proposalId;
    } catch {
      // Refused as a proposal too: the owner does it with the right tool (the refusal says which).
    }
    const because = `a guard refused it: ${refusal}`.slice(0, 1500);
    this.item(projectId, runId, e.code, c, 'guarded', {
      reasonCode: 'GUARDED',
      reason: because,
      ...(proposalId ? { proposalId } : {}),
    });
    this.store.pause(
      projectId,
      e.code,
      `${because}${proposalId ? `; it became proposal ${proposalId}` : ''}. Paused for the owner’s review: the code was not as mechanical as assumed`,
    );
    this.d.audit('system', 'automation.paused', `${projectId}:${e.code}`, null, {
      reason: 'GUARDED',
      ...(proposalId ? { proposalId } : {}),
    });
    return 'stopCode';
  }

  private async judgeJob(
    projectId: string,
    runId: string,
    e: CodeEntry,
    c: Candidate,
    submitted: JobView,
    expect: Expectation,
    pre: Obj,
  ): Promise<'ok' | 'skip' | 'stopCode' | { why: string }> {
    let job = submitted;
    let budgetWhy: string | null = null;
    if (job.status === 'waiting_budget') {
      // v3 F5b.1: waited for (up to AUTOMATION_BUDGET_MAX_WAIT_SECONDS), not a reason to stop the run.
      const w = await this.awaitJob(projectId, runId, job);
      job = w.job;
      budgetWhy = w.why;
    }
    if (!TERMINAL_JOB_STATUSES.has(job.status)) {
      this.item(projectId, runId, e.code, c, 'stopped', {
        reasonCode: job.status === 'waiting_budget' ? 'BUDGET' : 'NOT_FINISHED',
        reason: `the job is ${job.status}; it finishes by itself and is judged on the Review page`,
        jobId: job.id,
      });
      return {
        why:
          budgetWhy ??
          (job.status === 'waiting_budget' ? 'the P3 budget says wait' : `a job is ${job.status}`),
      };
    }
    const unknown = this.d.engine.queries
      .journalLookup(projectId, { jobId: job.id, limit: 100 })
      .some((j) => (j as { outcome?: string }).outcome === 'unknown');
    if (unknown) {
      await this.fail(
        projectId,
        runId,
        e,
        c,
        'UNKNOWN_OUTCOME',
        'a write’s outcome is unknown (it is being reconciled)',
        job.id,
      );
      return 'stopCode';
    }
    if (job.status === 'cancelled') {
      this.item(projectId, runId, e.code, c, 'stopped', {
        reasonCode: 'CANCELLED',
        reason: 'the job was cancelled',
        jobId: job.id,
      });
      return { why: 'a job was cancelled' };
    }
    if (job.status === 'failed') {
      const err = job.lastError;
      const step = (this.d.engine.stepRecords(projectId, job.id) ?? []).find((s) => s.stepNo === err?.stepNo);
      const verifyStep =
        step?.opId === VERIFY_STEP || step?.opId === 'retag.verify' || err?.code === 'VERIFY_MISMATCH';
      if (verifyStep) {
        await this.fail(
          projectId,
          runId,
          e,
          c,
          'VERIFICATION_FAILED',
          `the job’s read-back differs from the plan: ${err?.message ?? ''}`,
          job.id,
        );
        return 'stopCode';
      }
      if (err?.code === 'UNCERTAIN_OUTCOME') {
        await this.fail(projectId, runId, e, c, 'UNKNOWN_OUTCOME', err.message, job.id);
        return 'stopCode';
      }
      if (err?.code === 'VERSION_CONFLICT') {
        if (
          this.skipped(
            projectId,
            runId,
            e,
            c,
            'FIX_STALE',
            `changed between the fresh read and the write: ${err.message}`,
          )
        )
          return 'stopCode';
        return 'skip';
      }
      await this.fail(
        projectId,
        runId,
        e,
        c,
        'UNEXPECTED_ERROR',
        `${err?.code ?? 'error'}: ${err?.message ?? 'the job failed'}`,
        job.id,
      );
      return 'stopCode';
    }
    // Succeeded: the automation's own read-back, against the read before it.
    const diff = await this.verify(projectId, e, expect, pre);
    if (diff.length > 0) {
      await this.fail(
        projectId,
        runId,
        e,
        c,
        'VERIFICATION_FAILED',
        `read back: ${diff.slice(0, 5).join('; ')}`,
        job.id,
      );
      return 'stopCode';
    }
    this.item(projectId, runId, e.code, c, 'applied', {
      jobId: job.id,
      reason: 'written, read back and verified',
    });
    this.store.clearSkips(projectId, e.code);
    return 'ok';
  }

  private async fail(
    projectId: string,
    runId: string,
    e: CodeEntry,
    c: Candidate,
    code: string,
    reason: string,
    jobId?: string,
  ): Promise<void> {
    this.item(projectId, runId, e.code, c, 'failed', {
      reasonCode: code,
      reason,
      ...(jobId ? { jobId } : {}),
    });
    await this.stopCode(projectId, e, `${code} on “${c.pageName}”: ${reason}`.slice(0, 1000));
  }

  /** The read-back: the differences from "identical apart from the change" (empty: verified). */
  private async verify(projectId: string, e: CodeEntry, x: Expectation, pre: Obj): Promise<string[]> {
    const read = (op: string, params: Obj) =>
      this.d.engine.internalRead(projectId, op, params, { priority: 'P3', notFoundIsAnswer: true });
    const out: string[] = [];
    const allowed = new Set(e.changes ?? []);
    const compare = (before: Obj, after: Obj) => {
      const b = stable(before) as Obj;
      const a = stable(after) as Obj;
      for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
        if (stableJson(b[k]) === stableJson(a[k])) continue;
        if (!allowed.has(k)) out.push(`${k} changed`);
      }
      for (const [k, v] of Object.entries(x.fields))
        if (stableJson(a[k]) !== stableJson(v)) out.push(`${k} is ${stableJson(a[k])}, not ${stableJson(v)}`);
      if (allowed.has('properties') && stableJson(b.properties) !== stableJson(a.properties)) {
        const bp = Array.isArray(b.properties) ? (b.properties as Obj[]) : [];
        const ap = Array.isArray(a.properties) ? (a.properties as Obj[]) : [];
        const changed = new Set(
          [...bp, ...ap]
            .map((p) => String(p.id))
            .filter(
              (id) => stableJson(bp.find((p) => p.id === id)) !== stableJson(ap.find((p) => p.id === id)),
            ),
        );
        if (changed.size > 1) out.push(`${changed.size} sidebar properties changed`);
      }
    };
    try {
      if (x.target === 'asset') {
        const after = await read('getAsset', { path: { assetId: x.assetId } });
        if (!isObj(after)) return ['the asset is gone'];
        compare(pre, after);
        return out;
      }
      const res = await read('getResource', { path: { resourceId: x.resourceId } });
      if (!isObj(res)) return ['the page is gone'];
      const resBefore = (pre.resource as Obj) ?? {};
      if (x.target === 'document') {
        // The document is compared block by block below; its own entry in the page's document list may move.
        const strip = (r: Obj) => ({ ...r, documents: undefined });
        compare(strip(resBefore), strip(res));
        const doc = await read('getDocumentBlocks', {
          path: { resourceId: x.resourceId, documentId: x.documentId },
        });
        if (!isObj(doc) || !Array.isArray(doc.blocks)) return [...out, 'the document is gone'];
        const cmp = compareStoredBlocks(x.blocks, doc.blocks);
        if (!cmp.ok) out.push(...cmp.differences.slice(0, 5).map((d) => `the document differs at ${d.path}`));
      } else compare(resBefore, res);
    } catch (err) {
      return [`it could not be read back (${errMessage(err)})`];
    }
    return out;
  }

  /** Waits for a job to settle: terminal, waiting for budget, paused, or parked by a restart. */
  private async settle(projectId: string, jobId: string, ms: number): Promise<JobView> {
    const end = this.d.now() + ms;
    for (;;) {
      const j = this.d.engine.queries.getJob(projectId, jobId) as JobView | undefined;
      if (!j) throw new AutomationError('JOB_NOT_FOUND', `job ${jobId} is gone`);
      if (
        TERMINAL_JOB_STATUSES.has(j.status) ||
        j.status === 'waiting_budget' ||
        j.status === 'paused' ||
        (j.status === 'queued' && this.d.engine.queries.controls(projectId).draining) ||
        this.d.now() >= end
      )
        return j;
      await this.d.engine.wait(projectId, jobId, 1_000).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------------------------- propose

  /** ONE proposal for the code: each page an item, the owner approving the lot or some of it. */
  private async proposeAll(
    projectId: string,
    runId: string,
    e: CodeEntry,
    list: readonly { c: Candidate; planned: Extract<Planned, { ok: true }> }[],
  ): Promise<void> {
    const steps: StepSpec[] = [];
    const items: PlanItem[] = [];
    const operations: Obj[] = [];
    const prefetched: Obj[] = [];
    const resources: string[] = [];
    const documents: string[] = [];
    const lifecyclePages: { id: string; to: null }[] = [];
    let lifecycleTool: string | null = null;
    for (const { c, planned } of list) {
      const req = planned.req;
      const item = `page:${c.pageId}`;
      const base = steps.length;
      for (const s of req.steps as StepSpec[])
        steps.push({ ...mapStepRefs(s, (n) => n + base), items: [item] });
      items.push({
        id: item,
        kind: e.code,
        group: e.name,
        label: (typeof req.title === 'string' ? req.title : c.pageName).slice(0, 300),
        page: { id: c.pageId, name: c.pageName },
        dependsOn: [],
        selected: true,
      });
      const prop = isObj(req.proposal) ? req.proposal : {};
      if (Array.isArray(prop.operations)) operations.push(...(prop.operations as Obj[]));
      if (Array.isArray(prop.prefetched)) prefetched.push(...(prop.prefetched as Obj[]));
      if (isObj(req.holdLock) && typeof req.holdLock.resourceId === 'string')
        resources.push(req.holdLock.resourceId);
      if (Array.isArray(req.holdDocuments)) documents.push(...(req.holdDocuments as string[]));
      if (isObj(req.lifecycle)) {
        lifecycleTool = String(req.lifecycle.tool);
        for (const pg of (req.lifecycle.pages as { id: string }[]) ?? [])
          lifecyclePages.push({ id: pg.id, to: null });
      }
    }
    const res = [...new Set(resources)];
    const docs = [...new Set(documents)];
    const title = `Automation (${e.name}): ${list.length} page${list.length === 1 ? '' : 's'}`;
    let r: Obj;
    try {
      r = (await this.d.engine.submit({
        kind: 'batch_ops',
        project: projectId,
        steps,
        onError: 'stop',
        priority: 'P3',
        origin: this.origin(e),
        title,
        internal: true,
        forceProposal: true,
        ...(res.length > 0 ? { holdLock: { resourceId: res[0]! } } : {}),
        ...(res.length > 1 || (res.length > 0 && docs.length > 0)
          ? { holdMore: { resources: res.slice(1) } }
          : {}),
        ...(docs.length > 0 ? { holdDocuments: docs } : {}),
        ...(lifecycleTool
          ? { lifecycle: { tool: lifecycleTool, canonical: false, pages: lifecyclePages } }
          : {}),
        proposal: {
          summary: title,
          items,
          operation: { tool: `automation.${e.code}`, code: e.code, pages: list.map((x) => x.c.pageId) },
          operations,
          ...(prefetched.length > 0 ? { prefetched } : {}),
        },
      } as unknown as SubmitRequest)) as unknown as Obj;
    } catch (err) {
      for (const { c } of list)
        this.item(projectId, runId, e.code, c, 'skipped', {
          reasonCode: errCode(err),
          reason: `not proposed: ${errMessage(err)}`,
        });
      return;
    }
    const proposalId = typeof r.proposalId === 'string' ? r.proposalId : undefined;
    for (const { c } of list)
      this.item(projectId, runId, e.code, c, 'proposed', { ...(proposalId ? { proposalId } : {}) });
    if (proposalId && e.batch === true)
      for (const { planned } of list) this.tellBatch(projectId, planned.req, { proposalId });
    this.store.clearSkips(projectId, e.code);
    // v3 F6d: a batch code's renames of Authoritative pages are canon by their nature (the owner approves them as such).
    if (proposalId && e.batch !== true && (isObj(r.canonical) || typeof r.proposedBecause === 'string')) {
      this.store.pause(
        projectId,
        e.code,
        `a guard caught a change in proposal ${proposalId} (${typeof r.proposedBecause === 'string' ? r.proposedBecause : 'canonical'}): paused for the owner’s review`,
      );
    }
  }

  // ---------------------------------------------------------------------------------------------- retag

  private async runRetag(
    projectId: string,
    runId: string,
    e: CodeEntry,
    mode: Exclude<Mode, 'off'>,
    cap: number,
    ctx: RunContext,
  ): Promise<CodeOutcome> {
    let audit;
    try {
      audit = await this.d.retag.audit({ projectId, actor: 'automation', scope: { all: true } });
    } catch (err) {
      this.item(projectId, runId, e.code, { pageId: null, pageName: null }, 'skipped', {
        reasonCode: errCode(err),
        reason: `the retag audit could not run: ${errMessage(err)}`,
      });
      return { kind: 'done', attempted: 0 };
    }
    const { reader } = await this.d.appraisal.reader(projectId);
    const ids = this.d.retag
      .correctionBatches(projectId, audit.run.id)
      .flat()
      .filter((id) => reader.page(id) !== null && reader.labels(id).area === null && ctx.allows(id));
    const name = (id: string) => audit.verdicts.find((v) => v.pageId === id)?.name ?? id;
    const origin = this.origin(e);
    if (mode === 'propose') {
      const pages = ids.slice(0, Math.min(cap, this.d.packs.approvedRules(PACK_ID)?.retag?.batchSize ?? 25));
      if (pages.length === 0) return { kind: 'done', attempted: 0 };
      const paced = await this.awaitBudget(projectId, runId, e, null);
      if (paced) return { kind: 'stopRun', why: paced.why, attempted: 0 };
      try {
        const plan = this.d.retag.planApply({ projectId, runId: audit.run.id, pageIds: pages });
        const sub = await this.d.retag.submitApply(plan, {
          projectId,
          origin,
          actor: 'automation',
          priority: 'P3',
          mode: 'propose',
        });
        for (const id of pages)
          this.item(projectId, runId, e.code, { pageId: id, pageName: name(id) }, 'proposed', {
            ...(sub.proposalId ? { proposalId: sub.proposalId } : {}),
          });
      } catch (err) {
        for (const id of pages)
          this.item(projectId, runId, e.code, { pageId: id, pageName: name(id) }, 'skipped', {
            reasonCode: errCode(err),
            reason: errMessage(err),
          });
      }
      return { kind: 'done', attempted: pages.length, capped: ids.length > pages.length };
    }
    let attempted = 0;
    let capped = false;
    for (const id of ids) {
      if (attempted >= cap) {
        capped = true;
        break;
      }
      const why = this.blocked(projectId);
      if (why) return { kind: 'stopRun', why, attempted };
      const paced = await this.awaitBudget(projectId, runId, e, { pageId: id, pageName: name(id) });
      if (paced) return { kind: 'stopRun', why: paced.why, attempted };
      attempted++;
      await yieldToLoop(); // R3-64: the owner's and the agents' requests are answered between pages
      const c: Candidate = {
        pageId: id,
        pageName: name(id),
        plan: () => Promise.reject(new Error('unused')),
      };
      const pre = await this.d.engine.internalRead(
        projectId,
        'getResource',
        { path: { resourceId: id } },
        { priority: 'P3', notFoundIsAnswer: true },
      );
      if (!isObj(pre)) {
        if (this.skipped(projectId, runId, e, c, 'FIX_STALE', 'the page is gone'))
          return { kind: 'done', attempted };
        continue;
      }
      let sub;
      let plan;
      try {
        plan = this.d.retag.planApply({ projectId, runId: audit.run.id, pageIds: [id] });
        sub = await this.d.retag.submitApply(plan, {
          projectId,
          origin,
          actor: 'automation',
          priority: 'P3',
          mode: 'direct',
        });
      } catch (err) {
        if (this.skipped(projectId, runId, e, c, errCode(err), errMessage(err)))
          return { kind: 'done', attempted };
        continue;
      }
      if (sub.proposalId) {
        this.item(projectId, runId, e.code, c, 'guarded', {
          reasonCode: 'GUARDED',
          reason: 'a guard made it a proposal',
          proposalId: sub.proposalId,
        });
        this.store.pause(
          projectId,
          e.code,
          `a guard caught a change; it became proposal ${sub.proposalId}. Paused for the owner’s review`,
        );
        return { kind: 'done', attempted };
      }
      const job = await this.settle(projectId, sub.jobId!, this.d.settleMs ?? 600_000);
      if (TERMINAL_JOB_STATUSES.has(job.status) && !this.d.retag.store.batch(sub.batch.id)?.dispositions)
        this.d.retag.onJob(job);
      const disp = this.d.retag.store.batch(sub.batch.id)?.dispositions?.[id];
      if (job.status === 'succeeded' && disp && disp.outcome !== 'applied') {
        const code =
          disp.outcome === 'conflicted' || disp.outcome === 'already_compliant'
            ? 'FIX_STALE'
            : disp.outcome.toUpperCase();
        if (this.skipped(projectId, runId, e, c, code, `${disp.outcome}: ${disp.reason}`))
          return { kind: 'done', attempted };
        continue;
      }
      if (job.status === 'succeeded' && disp?.verified === false) {
        await this.fail(
          projectId,
          runId,
          e,
          c,
          'VERIFICATION_FAILED',
          `the retag read-back: ${(disp.differences ?? []).join('; ') || disp.reason}`,
          job.id,
        );
        return { kind: 'done', attempted };
      }
      const proposed = plan.pages[0]?.proposed ?? [];
      const r = await this.judgeJob(
        projectId,
        runId,
        e,
        c,
        job,
        {
          target: 'resource',
          resourceId: id,
          documentId: null,
          assetId: null,
          blocks: null,
          fields: { tags: [...proposed] },
        },
        { resource: pre },
      );
      if (r === 'stopCode') return { kind: 'done', attempted };
      if (typeof r === 'object') return { kind: 'stopRun', why: r.why, attempted };
    }
    return { kind: 'done', attempted, capped };
  }
}

/** What one run reads once and shares between its codes (the appraisal's reports). */
class RunContext {
  private readonly reports = new Map<string, Promise<readonly AppraisalFinding[]>>();
  constructor(private readonly only: ReadonlySet<string> | null = null) {}
  allows(id: string): boolean {
    return this.only === null || this.only.has(id);
  }
  appraisal(s: AutomationService, projectId: string, e: CodeEntry): Promise<readonly AppraisalFinding[]> {
    const key = e.target === 'asset' ? 'visual' : 'owner';
    let p = this.reports.get(key);
    if (!p) {
      p = s.appraisalFindings(projectId, e);
      this.reports.set(key, p);
    }
    return p;
  }
}

export { longDate };
