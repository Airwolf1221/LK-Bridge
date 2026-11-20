/**
 * The retag service (v3 F3f, ADR 0060): the Controlled Native Tagging Standard's workflows, "dry-run preview, read-only
 * policy audit, separately approved guarded apply, and resumable reconciliation".
 *
 * - **Audit** (`arkona_retag_audit`, the Tagging page's Audit tab): free, from the snapshot overlay (the appraisal's);
 *   `live` re-reads the pages concerned (one read each). Every page gets the engine's verdict (src/packs/retag/engine.ts):
 *   its resource ID, current array, proposed array, a rationale per slot, the policy version and digest, and its
 *   disposition. A run is stored, so an apply names it.
 * - **Apply** (`arkona_retag_apply`): only deterministic corrections of a stored run, at most `retag.batchSize` pages,
 *   each an item of ONE proposal (always a proposal by the pack's switch). Its job compares the policy first, then per
 *   page: a fresh read (conflicted, held, already compliant or inaccessible pages are skipped and recorded), the write
 *   inside the page's lock (re-checked there), and an independent read-back. Last Major Revision is never set (tags are
 *   excluded, ADR 0051). Resume and Revert work as for any approved package (ADR 0058, ADR 0055).
 * - **Owner classification** (the Holds tab): the owner's choice of category for an "uncertain category" hold, stored
 *   and used by every later audit; re-authenticated and audited by the dashboard. Agents only suggest.
 * - **Reconciliation**: a named record across batches; resuming it audits what remains afresh and proposes the next
 *   batch. A page whose inputs changed in the snapshots since its verdict is stale, never current truth.
 */
import type { Db } from '../../db/open.js';
import type { RetagAuditHook } from '../../audits/context.js';
import { extractResource } from '../../audits/model.js';
import type { Appraisal } from '../../appraisal/service.js';
import type { LiveRead } from '../../appraisal/reader.js';
import { EXPECT_STEP, VERIFY_STEP } from '../../jobs/internal-steps.js';
import { stateHash } from '../../jobs/sidebar-state.js';
import type { JobEngine, JobOrigin, JobView, StepSpec } from '../../jobs/index.js';
import type { PlanItem } from '../../jobs/items.js';
import { lifecycleFrom } from '../../lifecycle/settings.js';
import type { ProjectSettings } from '../../projects/settings.js';
import type { ProposalView } from '../../policy/types.js';
import { treeSettingsFrom } from '../../tree/classify.js';
import type { Packs } from '../service.js';
import { textKey } from '../engine/text.js';
import type { Pack, PackRules } from '../types.js';
import { RETAG_CHECKS, RETAG_REBASER, SKIP_PREFIX, type PageCheckInput, type VerifyInput } from './checks.js';
import {
  categoryFromTags,
  inputsHashOf,
  policyOf,
  retagPage,
  vocabularyOf,
  type Disposition,
  type RetagContext,
  type RetagPolicy,
  type RetagVerdict,
} from './engine.js';
import {
  newId,
  RetagStore,
  type Batch,
  type BatchDisposition,
  type Outcome,
  type Reconciliation,
  type RetagRun,
  type RunCounts,
} from './store.js';

type Obj = Record<string, unknown>;
/**
 * CR-2026-11-R3 (fix C), and X6 (the owner's sandbox run: `updatedAt` does not move on a content edit): a page's
 * disposition when its read-back found nothing different, saying exactly what was compared. A page document's body by
 * its real version, a board's, map's or timeline's by its content, each read before and after the write.
 */
export const READ_BACK_VERIFIED =
  'written and read back: the tags exactly as proposed; name, aliases, parentage and sidebar unchanged; each page ' +
  "document's body at the same version as before the write; each board, map and timeline document's content " +
  'unchanged';

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const RETAG_PACK = 'arkona';
export const APPLY_TOOL = 'arkona_retag_apply';
export const AUDIT_TOOL = 'arkona_retag_audit';
/** The most pages `live: true` re-reads in one audit (one read each). */
export const MAX_LIVE_PAGES = 50;
/** The most pages one audit verdicts (a whole-repository run of Arkona is about 1,500). */
export const MAX_AUDIT_PAGES = 5000;

export class RetagError extends Error {
  override readonly name = 'RetagError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export interface RetagDeps {
  readonly db: Db;
  readonly packs: Pick<
    Packs,
    'get' | 'attachment' | 'lifecycleRules' | 'strictToolMode' | 'governance' | 'store'
  >;
  readonly appraisal: Pick<Appraisal, 'reader' | 'freshness'>;
  /** The template the bridge recorded for a page (the tree's), or null. */
  readonly templateOf: (projectId: string, pageId: string) => string | null;
  readonly engine: Pick<JobEngine, 'submit' | 'stepRecords' | 'events' | 'queries'>;
  readonly proposals: {
    addHooks(h: {
      afterSubmit?(ctx: { readonly proposal: ProposalView; readonly jobId: string }): void;
      refuseRepropose?(original: ProposalView): string | null;
    }): () => void;
    get(id: string): ProposalView | undefined;
  };
  readonly projectSettings: (projectId: string) => Readonly<ProjectSettings>;
  readonly audit: (
    actor: string,
    action: string,
    target: string | null,
    before?: unknown,
    after?: unknown,
  ) => void;
  readonly now: () => number;
  readonly log?: { warn(o: unknown, m: string): void };
}

/** What an audit covers. */
export interface AuditScope {
  readonly pageId?: string;
  readonly underId?: string;
  readonly all?: boolean;
  readonly pageIds?: readonly string[];
}

export interface AuditResult {
  readonly run: RetagRun;
  readonly verdicts: readonly RetagVerdict[];
}

/** One apply batch as planned: its steps, items and pages, before it is submitted. */
export interface ApplyPlan {
  readonly runId: string;
  readonly policy: RetagPolicy;
  readonly pages: readonly {
    pageId: string;
    name: string;
    current: string[];
    proposed: string[];
    afterHash: string;
  }[];
  readonly steps: StepSpec[];
  readonly labels: string[];
  readonly items: PlanItem[];
  readonly title: string;
  readonly mode: 'propose' | 'scope';
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** A skipped item's reason, as the outcome it records. */
function outcomeOf(reason: string): Outcome {
  if (reason.startsWith(SKIP_PREFIX.held)) return 'held';
  if (reason.startsWith(SKIP_PREFIX.already_compliant)) return 'already_compliant';
  if (reason.startsWith(SKIP_PREFIX.inaccessible)) return 'inaccessible';
  return 'conflicted';
}

const itemOf = (pageId: string) => `page:${pageId}`;

export class RetagService {
  readonly store: RetagStore;
  private offs: (() => void)[] = [];

  constructor(private readonly d: RetagDeps) {
    this.store = new RetagStore(d.db, d.now);
  }

  start(): () => void {
    this.offs.push(
      this.d.proposals.addHooks({
        afterSubmit: (ctx) => {
          try {
            const b = this.store.batchByProposal(ctx.proposal.id);
            if (b) this.store.updateBatch(b.id, { jobId: ctx.jobId, state: 'running' });
          } catch (err) {
            this.d.log?.warn({ err }, 'a retag batch could not follow its proposal');
          }
        },
        // CR-2026-11-R3 (R3-15, F6 of the retag pass): the pages left out of a batch are applied from a fresh audit,
        // never re-proposed from the old one (an untracked job: no dispositions, not busy, not revertible).
        refuseRepropose: (original) =>
          this.store.batchByProposal(original.id)
            ? 'The pages left out of a retag batch are not proposed again from the old audit (its verdicts may be stale ' +
              'by now): ask the agent to run arkona_retag_audit again and apply them from the new run.'
            : null,
      }),
      this.d.engine.events.on('job', (e: { type: string; job: JobView }) => {
        try {
          this.onJob(e.job);
        } catch (err) {
          this.d.log?.warn({ err, jobId: e.job.id }, 'a retag batch could not record its job');
        }
      }),
    );
    return () => this.stop();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  // ============================================================================================ the policy

  /** The pack, its approved rules and the policy, or why the retag cannot run here (fails closed). */
  policyFor(projectId: string): { pack: Pack; rules: PackRules; policy: RetagPolicy } {
    const pack = this.d.packs.get(RETAG_PACK);
    if (!pack || !this.d.packs.attachment(RETAG_PACK, projectId))
      throw new RetagError(
        'PACK_NOT_ATTACHED',
        'The Arkona pack is not attached to this project, so the retag tools do not apply here.',
      );
    if (!pack.approved)
      throw new RetagError(
        'PACK_NOT_CURRENT',
        'No version of the Arkona pack is approved yet: approve it on the Packs page.',
      );
    if (pack.drift)
      throw new RetagError(
        'PACK_NOT_CURRENT',
        `A governance source changed since the owner approved the pack (${pack.drift.changed.map((c) => c.name).join(', ')}): nothing is computed until the owner approves again (Packs page).`,
      );
    const rules =
      pack.approved.version === pack.version
        ? pack.rules
        : this.d.packs.store.rulesAt(pack.id, pack.approved.version);
    if (!rules?.retag)
      throw new RetagError(
        'RETAG_UNAVAILABLE',
        'The approved Arkona pack version has no retag rules: the owner approves the version that adds them (arkona-…-f3f) on the Packs page.',
      );
    return {
      pack,
      rules,
      policy: policyOf(pack, rules, pack.approved, this.settingsPrint(projectId, pack, rules)),
    };
  }

  /**
   * The current approved policy of a pack for a project (null: none, or not current), for the job's policy check.
   * CR-2026-11-R3 (R3-08): its digest covers the project's lifecycle settings, as the audit's did.
   */
  currentPolicy(packId: string, projectId?: string): RetagPolicy | null {
    const pack = this.d.packs.get(packId);
    if (!pack?.approved || pack.drift) return null;
    const rules =
      pack.approved.version === pack.version
        ? pack.rules
        : this.d.packs.store.rulesAt(pack.id, pack.approved.version);
    if (!rules?.retag) return null;
    return policyOf(
      pack,
      rules,
      pack.approved,
      projectId === undefined ? undefined : this.settingsPrint(projectId, pack, rules),
    );
  }

  /**
   * CR-2026-11-R3 (R3-08): what of the project's own settings a verdict depends on (the status values and tags, the
   * lifecycle fields, the Reference Type row, the AU tag). A change to any of them makes every stored run's policy
   * "changed since the audit".
   */
  private settingsPrint(projectId: string, pack: Pack, rules: PackRules): Readonly<Record<string, unknown>> {
    const c = this.context(projectId, rules, pack);
    return {
      lifecycle: c.lifecycle,
      referenceTypeRow: c.referenceTypeRow,
      au: c.tagRules.au?.tag ?? null,
    };
  }

  /** CR-2026-11-R3 (R3-03): the owner's classification and the pack's record of a page now, as a verdict's basis holds them. */
  recordsOf(
    projectId: string,
    pageId: string,
  ): { owner: readonly [string, string | null] | null; packRecord: readonly [string, string | null] | null } {
    const owner = this.store.classification(projectId, pageId);
    const record = this.store.pageRecord(projectId, pageId);
    return {
      owner: owner ? [owner.primary, owner.specialist] : null,
      packRecord: record ? [record.primary, record.specialist] : null,
    };
  }

  private context(projectId: string, rules: PackRules, pack: Pack): RetagContext {
    const settings = this.d.projectSettings(projectId);
    const lc = lifecycleFrom(settings);
    return {
      rules,
      lifecycle: { status: lc.status, tags: lc.tags, fields: lc.fields },
      tagRules: this.d.packs.lifecycleRules(projectId),
      referenceTypeRow: treeSettingsFrom(settings).referenceTypeRow,
      governanceIds: new Set(pack.governance.map((g) => g.resourceId)),
    };
  }

  /** The closed list: each primary category and its specialists (for the owner's classification and the docs). */
  closedList(projectId: string): { primary: string; specialists: string[]; kind: 'character' | 'owner' }[] {
    const { rules } = this.policyFor(projectId);
    return [...vocabularyOf(rules).primaries.values()].map((p) => ({
      primary: p.tag,
      specialists: [...p.specialists],
      kind: p.kind === 'type' ? ('character' as const) : ('owner' as const),
    }));
  }

  // ============================================================================================ the audit

  /**
   * The engine's verdicts over the snapshot overlay (free), or over live reads of the pages concerned (`live`: one read
   * each, at most {@link MAX_LIVE_PAGES}). Stored as a run; with `reconciliationId`, laid over that reconciliation.
   */
  async audit(o: {
    readonly projectId: string;
    readonly actor: string;
    readonly scope: AuditScope;
    readonly live?: LiveRead;
    readonly reconciliationId?: string | null;
  }): Promise<AuditResult> {
    const { pack, rules, policy } = this.policyFor(o.projectId);
    const ctx = this.context(o.projectId, rules, pack);
    const { reader, state } = await this.d.appraisal.reader(o.projectId);
    let ids: string[];
    if (o.scope.pageIds) ids = [...new Set(o.scope.pageIds)];
    else if (o.scope.pageId) ids = [o.scope.pageId];
    else if (o.scope.underId)
      ids = [o.scope.underId, ...reader.descendants(o.scope.underId).map((p) => p.id)];
    else ids = reader.all().map((p) => p.id);
    ids = ids.filter((id) => reader.page(id) !== null || o.live !== undefined);
    if (ids.length > MAX_AUDIT_PAGES)
      throw new RetagError('SCOPE_TOO_LARGE', `${ids.length} pages: at most ${MAX_AUDIT_PAGES} per audit.`);
    let reads = 0;
    if (o.live) {
      if (ids.length > MAX_LIVE_PAGES)
        throw new RetagError(
          'LIVE_TOO_MANY',
          `live: true re-reads each page (one read each): at most ${MAX_LIVE_PAGES}; this scope has ${ids.length}. Narrow it, or leave live out (the snapshots, free).`,
        );
      for (const id of ids) {
        const r = await reader.readLive(id, o.live, this.d.now(), { body: false });
        reads += 1;
        void r;
      }
    }
    const verdicts: RetagVerdict[] = [];
    for (const id of ids) {
      const lp = await reader.load(id);
      const op = reader.page(id);
      if (!lp || !op) continue;
      if (lp.page.kind === 'root') continue;
      if (!lp.resource || !lp.sidebar) {
        verdicts.push({
          pageId: id,
          name: op.rawName,
          scope: 'excluded',
          excluded: {
            code: 'not_in_snapshots',
            reason: `its ${lp.resource ? 'sidebar' : 'resource'} could not be read from the snapshots (blocked, never guessed)`,
          },
          current: [],
          proposed: [],
          slots: [],
          holds: [],
          exceptions: [],
          removals: [],
          classification: null,
          disposition: null,
          inputsHash: '',
          basis: {},
          inputs: {},
        });
        continue;
      }
      const owner = this.store.classification(o.projectId, id);
      const record = this.store.pageRecord(o.projectId, id);
      verdicts.push(
        retagPage(
          {
            id,
            rawName: lp.page.rawName,
            kind: lp.page.kind,
            tags: extractResource(lp.resource).tags,
            facts: lp.sidebar.facts,
            lifecycle: lp.labels.lifecycle,
            ancestors: lp.path.names.slice(0, -1),
            area: lp.labels.area,
            templateId: this.d.templateOf(o.projectId, id),
            // CR-2026-11-R3 (R3-04): where it was audited; the apply compares it.
            parentId: lp.page.parentId ?? null,
            packRecord: record
              ? {
                  primary: record.primary,
                  specialist: record.specialist,
                  detail: `${record.tool}, ${record.type} ${record.role}`,
                }
              : null,
            owner: owner
              ? {
                  primary: owner.primary,
                  specialist: owner.specialist,
                  detail: `the owner, ${new Date(owner.at).toISOString().slice(0, 10)}: ${owner.reason}`,
                }
              : null,
          },
          ctx,
        ),
      );
    }
    const count = (d: Disposition) => verdicts.filter((v) => v.disposition === d).length;
    const counts: RunCounts = {
      pages: verdicts.length,
      compliant: count('compliant'),
      correction: count('correction'),
      hold: count('hold'),
      exception: count('exception'),
      lifecycleOnly: verdicts.filter((v) => v.scope === 'lifecycle').length,
      lifecycleProblems: verdicts.filter((v) => v.scope === 'lifecycle' && v.lifecycleCheck?.ok === false)
        .length,
      excluded: verdicts.filter((v) => v.scope === 'excluded').length,
    };
    const fresh = this.d.appraisal.freshness(o.projectId, state);
    const run = this.store.saveRun(
      {
        id: newId('rtg'),
        projectId: o.projectId,
        packId: pack.id,
        policy,
        scope: {
          ...(o.scope.pageId ? { page: o.scope.pageId } : {}),
          ...(o.scope.underId ? { under: o.scope.underId } : {}),
          ...(o.scope.all ? { all: true } : {}),
          ...(o.scope.pageIds ? { pages: o.scope.pageIds.length } : {}),
          ...(o.live ? { live: true } : {}),
        },
        source: {
          snapshots: fresh,
          ...(o.live ? { live: { reads, at: new Date(this.d.now()).toISOString() } } : {}),
        },
        counts,
        reconciliationId: o.reconciliationId ?? null,
        actor: o.actor,
      },
      verdicts,
    );
    if (o.reconciliationId) this.store.absorbRun(o.reconciliationId, run.id, verdicts);
    return { run, verdicts };
  }

  // ============================================================================================ the apply

  /**
   * Plans one batch from a stored run: only its deterministic corrections, at most `retag.batchSize`, none already in an
   * open batch, under the policy the run was made with (else `RETAG_POLICY_CHANGED`: audit again).
   */
  planApply(o: {
    readonly projectId: string;
    readonly runId: string;
    readonly pageIds: readonly string[];
  }): ApplyPlan {
    const { rules, policy, pack } = this.policyFor(o.projectId);
    const run = this.store.run(o.runId);
    if (!run || run.projectId !== o.projectId)
      throw new RetagError(
        'RUN_NOT_FOUND',
        `No retag audit run ${o.runId} in this project: run arkona_retag_audit first.`,
      );
    if (run.policy.digest !== policy.digest || run.policy.version !== policy.version)
      throw new RetagError(
        'RETAG_POLICY_CHANGED',
        `policy changed since the audit; audit again (run ${run.id} used pack version ${run.policy.version}, the approved version is ${policy.version}${run.policy.version === policy.version ? ' with other rules or governance' : ''}).`,
        {
          audited: { version: run.policy.version, digest: run.policy.digest },
          now: { version: policy.version, digest: policy.digest },
        },
      );
    const max = rules.retag!.batchSize;
    const ids = [...new Set(o.pageIds)];
    if (ids.length === 0)
      throw new RetagError('INVALID_PARAMS', 'Name at least one page of the run (its pageId).');
    if (ids.length > max)
      throw new RetagError(
        'RETAG_BATCH_TOO_LARGE',
        `${ids.length} pages: a batch takes at most ${max} (the pack's retag.batchSize). Propose the rest as the next batch.`,
        { max },
      );
    const verdicts = this.store.verdicts(run.id, { pageIds: ids });
    const missing = ids.filter((id) => !verdicts.some((v) => v.pageId === id));
    if (missing.length > 0)
      throw new RetagError('PAGE_NOT_IN_RUN', `Not in run ${run.id}: ${missing.join(', ')}.`, { missing });
    const notDeterministic = verdicts.filter((v) => v.disposition !== 'correction');
    if (notDeterministic.length > 0)
      throw new RetagError(
        'RETAG_NOT_DETERMINISTIC',
        `Only deterministic corrections can be applied; ${notDeterministic
          .map((v) => `${v.name} is ${v.disposition ?? v.scope}`)
          .join(
            '; ',
          )}. Holds go to the owner (classification on the Tagging page), exceptions are the owner's judgement.`,
        {
          pages: notDeterministic.map((v) => ({
            pageId: v.pageId,
            disposition: v.disposition,
            scope: v.scope,
          })),
        },
      );
    // CR-2026-11-R3 (R3-03): a verdict computed from a classification (or a pack record) the owner has changed since is
    // stale: the page is refused here (audit again), and the job's check holds it if it changes after the proposal.
    const printOf = (x: unknown): readonly [string, string | null] | null =>
      Array.isArray(x) && typeof x[0] === 'string' ? [x[0], typeof x[1] === 'string' ? x[1] : null] : null;
    const samePrint = (
      a: readonly [string, string | null] | null,
      b: readonly [string, string | null] | null,
    ) => (a === null ? b === null : b !== null && a[0] === b[0] && a[1] === b[1]);
    const stale = verdicts.filter((v) => {
      const now = this.recordsOf(o.projectId, v.pageId);
      return (
        !samePrint(printOf(v.basis.owner), now.owner) ||
        !samePrint(printOf(v.basis.packRecord), now.packRecord)
      );
    });
    if (stale.length > 0)
      throw new RetagError(
        'RETAG_STALE',
        `The owner's classification (or the pack's record) of ${stale.map((v) => v.name).join(', ')} changed since audit ${run.id}: audit again, then apply from the new run.`,
        { pages: stale.map((v) => v.pageId) },
      );
    const busy = new Map<string, string>();
    for (const b of this.store.openBatches(o.projectId)) {
      const state = this.syncBatch(b);
      if (state !== 'proposed' && state !== 'running') continue;
      for (const p of b.pages) busy.set(p.pageId, b.id);
    }
    const inBatch = ids.filter((id) => busy.has(id));
    if (inBatch.length > 0)
      throw new RetagError(
        'RETAG_PAGE_IN_BATCH',
        `Already in an open batch: ${inBatch.map((id) => `${id} (${busy.get(id)})`).join(', ')}.`,
        { pages: inBatch },
      );
    const settings = this.d.projectSettings(o.projectId);
    const propertiesName = treeSettingsFrom(settings).propertiesName;
    const steps: StepSpec[] = [];
    const labels: string[] = [];
    const items: PlanItem[] = [];
    steps.push({
      op: EXPECT_STEP,
      params: {
        body: {
          checks: [
            {
              label: 'retag policy',
              kind: 'registered',
              checker: RETAG_CHECKS.policy,
              input: { packId: pack.id, runId: run.id, version: policy.version, digest: policy.digest },
            },
          ],
        },
      },
    });
    labels.push(
      `the policy is still the audit's (pack version ${policy.version}, digest ${policy.digest.slice(0, 12)}), its governance re-read`,
    );
    const pages: ApplyPlan['pages'][number][] = [];
    for (const v of verdicts) {
      const item = itemOf(v.pageId);
      const factKeys = Object.entries(v.inputs).filter(
        ([k]) => !['Subject', 'Scope', 'Inheritance'].includes(k),
      );
      const expectAt = steps.length + 1;
      const checkLabel = `page ${v.pageId}`;
      const pageInput: PageCheckInput = {
        pageId: v.pageId,
        name: v.name,
        item,
        current: v.current,
        proposed: v.proposed,
        propertiesName,
        facts: Object.fromEntries(factKeys),
        // CR-2026-11-R3 (R3-03, R3-04): where the page was and how it was classified when audited.
        ...(v.parentId !== undefined ? { parentId: v.parentId } : {}),
        owner: printOf(v.basis.owner),
        packRecord: printOf(v.basis.packRecord),
      };
      steps.push({
        op: EXPECT_STEP,
        params: {
          body: {
            checks: [{ label: checkLabel, kind: 'registered', checker: RETAG_CHECKS.page, input: pageInput }],
          },
        },
        items: [item],
      });
      labels.push(
        `${v.name}: a fresh read (tags exactly ${v.current.join(', ') || '(none)'}; facts as audited)`,
      );
      steps.push({
        op: 'updateResource',
        params: { path: { resourceId: v.pageId }, body: { tags: [...v.proposed] } },
        expectCurrent: {
          state: 'resource',
          hash: stateHash({ name: v.name, tags: v.current }),
          label: v.name,
        },
        judgedInLock: true,
        deferTreeReread: true,
        items: [item],
        rebase: {
          rebaser: RETAG_REBASER,
          // CR-2026-11-R3 (R3-05): the check's whole input, so the write judges the page inside its lock as the check did.
          input: pageInput,
          always: true,
        },
        journalOperation: {
          tool: APPLY_TOOL,
          page: { id: v.pageId, name: v.name },
          write: 'tags',
          from: v.current,
          to: v.proposed,
          run: run.id,
        },
      });
      labels.push(`${v.name}: tags ${v.current.join(', ') || '(none)'} → ${v.proposed.join(', ')}`);
      const verify: VerifyInput = {
        pageId: v.pageId,
        name: v.name,
        proposed: v.proposed,
        beforeLabel: checkLabel,
      };
      steps.push({
        op: VERIFY_STEP,
        params: {
          body: {
            targets: [
              {
                kind: 'registered',
                label: `${v.name}: read-back`,
                checker: RETAG_CHECKS.verify,
                resourceId: v.pageId,
                input: verify,
                inputFrom: [{ step: expectAt, as: 'before' }],
              },
            ],
          },
        },
        items: [item],
      });
      labels.push(
        `${v.name}: read back (the array in order; name, aliases, parentage and sidebar unchanged; each page ` +
          "document's body at the same version; each board, map and timeline document's content unchanged)",
      );
      items.push({
        id: item,
        kind: 'retag_page',
        group: 'Tags (deterministic corrections)',
        label: `${v.name}: ${v.current.join(', ') || '(none)'} → ${v.proposed.join(', ')}`,
        page: { id: v.pageId, name: v.name },
        diff: {
          before: v.current.join(', '),
          after: v.proposed.join(', '),
          changes: v.slots
            .filter((s) => s.tag !== null || s.held)
            .map((s) => ({ what: s.slot, before: null, after: `${s.tag ?? '(omitted)'}: ${s.source}` })),
        },
        dependsOn: [],
        selected: true,
      });
      pages.push({
        pageId: v.pageId,
        name: v.name,
        current: [...v.current],
        proposed: [...v.proposed],
        afterHash: inputsHashOf(v.basis, v.proposed),
      });
    }
    return {
      runId: run.id,
      policy,
      pages,
      steps,
      labels,
      items,
      title: `Retag ${pages.length} page${pages.length === 1 ? '' : 's'} (deterministic corrections of audit ${run.id})`,
      mode: this.d.packs.strictToolMode(pack.id, APPLY_TOOL),
    };
  }

  /** Submits a planned batch (a proposal by the pack's switch) and records it. */
  async submitApply(
    plan: ApplyPlan,
    o: {
      readonly projectId: string;
      readonly origin: JobOrigin;
      readonly actor: string;
      readonly reconciliationId?: string | null;
    },
  ): Promise<{ batch: Batch; proposalId: string | null; jobId: string | null; summary: string | null }> {
    const r = await this.d.engine.submit({
      kind: 'batch_ops',
      project: o.projectId,
      steps: plan.steps,
      onError: 'stop',
      priority: 'P1',
      origin: o.origin,
      title: plan.title.slice(0, 300),
      internal: true,
      ...(plan.mode === 'propose' ? { forceProposal: true } : {}),
      // ADR 0051: tags are excluded from Last Major Revision; a retag never dates a page.
      lastMajorRevision: 'skip',
      resumable: { kind: 'retag', recheck: [1] },
      proposal: {
        summary: plan.title,
        items: plan.items,
        operation: {
          tool: APPLY_TOOL,
          run: plan.runId,
          policy: { version: plan.policy.version, digest: plan.policy.digest, label: plan.policy.label },
          pages: plan.pages.map((p) => ({ id: p.pageId, name: p.name, from: p.current, to: p.proposed })),
        },
        operations: plan.pages.map((p) => ({
          tool: APPLY_TOOL,
          page: { id: p.pageId, name: p.name },
          pageParts: [`tags ${p.current.join(', ') || '(none)'} → ${p.proposed.join(', ')}`],
          summaryLabel: `${p.name}: tags ${p.current.join(', ') || '(none)'} → ${p.proposed.join(', ')}`,
        })),
      },
    });
    const proposalId = 'proposalId' in r ? r.proposalId : null;
    const jobId = 'jobId' in r ? r.jobId : null;
    const batch = this.store.saveBatch({
      id: newId('rtb'),
      projectId: o.projectId,
      runId: plan.runId,
      reconciliationId: o.reconciliationId ?? null,
      proposalId,
      jobId,
      pages: plan.pages,
      state: proposalId ? 'proposed' : 'running',
      createdBy: o.actor,
    });
    this.d.audit(o.actor, 'retag.propose_batch', o.projectId, null, {
      batch: batch.id,
      run: plan.runId,
      pages: plan.pages.map((p) => p.pageId),
      proposalId,
      jobId,
    });
    if (jobId) {
      const job = this.d.engine.queries.getJob(o.projectId, jobId);
      if (job && TERMINAL.has(job.status)) this.onJob(job);
    }
    return {
      batch: this.store.batch(batch.id)!,
      proposalId,
      jobId,
      summary: 'summary' in r ? (r.summary ?? null) : null,
    };
  }

  /** A batch's state brought up to date with its proposal (rejected, expired) and job. */
  syncBatch(b: Batch): Batch['state'] {
    if (b.state === 'proposed' && b.proposalId) {
      const p = this.d.proposals.get(b.proposalId);
      if (
        p &&
        (p.state === 'rejected' || p.state === 'expired' || p.state === 'failed' || p.state === 'conflicted')
      ) {
        this.store.updateBatch(b.id, { state: 'rejected' });
        return 'rejected';
      }
      if (p?.jobId && !b.jobId) this.store.updateBatch(b.id, { jobId: p.jobId, state: 'running' });
    }
    return this.store.batch(b.id)?.state ?? b.state;
  }

  /** Records each page's disposition once a batch's job ends (or stops), and lays them over its reconciliation. */
  onJob(job: JobView): void {
    if (!TERMINAL.has(job.status)) return;
    const b = this.store.batchByJob(job.projectId, job.id);
    if (!b) return;
    const steps = this.d.engine.stepRecords(job.projectId, job.id) ?? [];
    const out: Record<string, BatchDisposition> = {};
    for (const p of b.pages) {
      const item = itemOf(p.pageId);
      const mine = steps.filter((s) => (s.options.items ?? []).includes(item));
      if (mine.length === 0) continue; // left out by the owner's selection: not applied, still remaining
      const skippedReason = (() => {
        for (const s of mine) {
          const r = s.result;
          if (!isObj(r) || !Array.isArray(r.skippedItems)) continue;
          const hit = (r.skippedItems as Obj[]).find((x) => x.item === item);
          if (hit && typeof hit.reason === 'string') return hit.reason;
        }
        return null;
      })();
      if (skippedReason) {
        out[p.pageId] = { outcome: outcomeOf(skippedReason), reason: skippedReason, verified: null };
        continue;
      }
      const write = mine.find((s) => s.opId === 'updateResource');
      const verify = mine.find((s) => s.opId === VERIFY_STEP);
      if (!write || write.status !== 'succeeded') continue; // stopped before this page: still remaining
      if (isObj(write.result) && write.result.unchanged === true) {
        out[p.pageId] = {
          outcome: 'already_compliant',
          reason: 'the page already carried the proposed array',
          verified: null,
        };
        continue;
      }
      const vr =
        isObj(verify?.result) && isObj(verify.result.verification) ? verify.result.verification : null;
      const status = vr && typeof vr.status === 'string' ? vr.status : null;
      const differences = Array.isArray(vr?.differences)
        ? (vr.differences as Obj[]).map(
            (x) =>
              `${String(x.path)}: expected ${JSON.stringify(x.expected)}, found ${JSON.stringify(x.actual)}`,
          )
        : [];
      out[p.pageId] = {
        outcome: 'applied',
        // CR-2026-11-R3 (fix C), X6: what the read-back compared, said exactly (every document by its content).
        reason:
          status === 'verified'
            ? READ_BACK_VERIFIED
            : status === 'mismatch'
              ? 'written; the read-back found a difference'
              : 'written; not read back',
        verified: status === 'verified' ? true : status === null ? null : false,
        ...(differences.length > 0 ? { differences } : {}),
      };
    }
    const state: Batch['state'] = job.status === 'succeeded' ? 'done' : 'stopped';
    this.store.updateBatch(b.id, { jobId: job.id, state, dispositions: out });
    if (b.reconciliationId)
      for (const [pageId, disp] of Object.entries(out)) {
        const page = b.pages.find((x) => x.pageId === pageId) as (typeof b.pages)[number] & {
          afterHash?: string;
        };
        this.store.setOutcome(b.reconciliationId, pageId, {
          outcome: disp.outcome,
          batchId: b.id,
          ...(disp.outcome === 'applied' && page.afterHash ? { inputsHash: page.afterHash } : {}),
        });
      }
  }

  // ============================================================================================ owner classification

  /** The owner's classification of a page (C): the closed list only; stored, audited by the caller's route. */
  classify(
    actor: string,
    projectId: string,
    o: {
      readonly pageId: string;
      readonly pageName: string;
      readonly primary: string;
      readonly specialist: string | null;
      readonly reason: string;
    },
  ): void {
    if (actor !== 'owner')
      throw new RetagError('NOT_OWNER', 'Only the owner classifies a page; an agent may suggest one.');
    const { rules } = this.policyFor(projectId);
    const v = vocabularyOf(rules);
    const p = v.primaries.get(textKey(o.primary));
    if (!p)
      throw new RetagError(
        'NOT_ON_CLOSED_LIST',
        `“${o.primary}” is not a primary category of the closed list.`,
        {
          primaries: [...v.primaries.values()].map((x) => x.tag),
        },
      );
    const s =
      o.specialist === null
        ? null
        : (p.specialists.find((x) => textKey(x) === textKey(o.specialist!)) ?? undefined);
    if (s === undefined)
      throw new RetagError('NOT_ON_CLOSED_LIST', `“${o.specialist}” is not a specialist of ${p.tag}.`, {
        specialists: p.specialists,
      });
    const reason = o.reason.trim();
    if (reason === '')
      throw new RetagError('REASON_REQUIRED', 'A classification needs a reason (what the owner checked).');
    const before = this.store.classification(projectId, o.pageId);
    this.store.setClassification({
      projectId,
      pageId: o.pageId,
      pageName: o.pageName,
      primary: p.tag,
      specialist: s,
      reason: reason.slice(0, 1000),
      by: actor,
      at: this.d.now(),
    });
    this.d.audit(
      actor,
      'retag.classify',
      o.pageId,
      before ? { primary: before.primary, specialist: before.specialist } : null,
      { project: projectId, page: o.pageName, primary: p.tag, specialist: s, reason: reason.slice(0, 200) },
    );
  }

  unclassify(actor: string, projectId: string, pageId: string): boolean {
    if (actor !== 'owner') throw new RetagError('NOT_OWNER', 'Only the owner changes a classification.');
    const before = this.store.classification(projectId, pageId);
    if (!before) return false;
    this.store.clearClassification(projectId, pageId);
    this.d.audit(
      actor,
      'retag.unclassify',
      pageId,
      { primary: before.primary, specialist: before.specialist },
      null,
    );
    return true;
  }

  /** An agent's suggested classification for a hold, with its reason: kept for the owner, never used. */
  suggest(
    by: string,
    projectId: string,
    o: {
      readonly pageId: string;
      readonly primary: string;
      readonly specialist: string | null;
      readonly reason: string;
    },
  ) {
    const { rules } = this.policyFor(projectId);
    const v = vocabularyOf(rules);
    const p = v.primaries.get(textKey(o.primary));
    if (!p)
      throw new RetagError(
        'NOT_ON_CLOSED_LIST',
        `“${o.primary}” is not a primary category of the closed list.`,
      );
    if (o.specialist !== null && !p.specialists.some((x) => textKey(x) === textKey(o.specialist!)))
      throw new RetagError('NOT_ON_CLOSED_LIST', `“${o.specialist}” is not a specialist of ${p.tag}.`);
    if (o.reason.trim() === '') throw new RetagError('REASON_REQUIRED', 'A suggestion needs its reason.');
    return this.store.suggest(projectId, {
      pageId: o.pageId,
      primary: p.tag,
      specialist:
        o.specialist === null ? null : p.specialists.find((x) => textKey(x) === textKey(o.specialist!))!,
      reason: o.reason.trim().slice(0, 1000),
      by,
      at: this.d.now(),
    });
  }

  // ============================================================================================ reconciliation

  /** Starts a named reconciliation over a scope with a first audit (free), or audits an open one's scope again. */
  async reconcile(o: {
    readonly projectId: string;
    readonly actor: string;
    readonly name: string;
    readonly scope?: AuditScope;
  }): Promise<{ reconciliation: Reconciliation; result: AuditResult; created: boolean }> {
    const name = o.name.trim();
    if (!/^[\p{L}\p{N} ._-]{1,80}$/u.test(name))
      throw new RetagError(
        'INVALID_PARAMS',
        'A reconciliation name is 1 to 80 letters, digits, spaces, dots, dashes or underscores.',
      );
    let rec = this.store.reconciliationByName(o.projectId, name);
    let created = false;
    if (!rec) {
      this.policyFor(o.projectId);
      const scope = o.scope ?? { all: true };
      rec = this.store.createReconciliation({
        id: newId('rtr'),
        projectId: o.projectId,
        name,
        scope: { ...scope, ...(scope.pageIds ? { pageIds: [...scope.pageIds] } : {}) },
        createdBy: o.actor,
      });
      created = true;
      this.d.audit(o.actor, 'retag.reconcile_start', o.projectId, null, {
        reconciliation: rec.id,
        name,
        scope,
      });
    }
    const result = await this.audit({
      projectId: o.projectId,
      actor: o.actor,
      scope: rec.scope,
      reconciliationId: rec.id,
    });
    return { reconciliation: this.store.reconciliation(rec.id)!, result, created };
  }

  /**
   * Marks stale every page of a reconciliation whose inputs (facts, Reference Type, template, records, tags) the
   * snapshots now show changed since its verdict (free). Returns the pages marked.
   */
  async refreshStale(projectId: string, reconciliationId: string): Promise<string[]> {
    const rec = this.store.reconciliation(reconciliationId);
    if (!rec || rec.projectId !== projectId) return [];
    let ctx: RetagContext;
    try {
      const { pack, rules } = this.policyFor(projectId);
      ctx = this.context(projectId, rules, pack);
    } catch {
      return [];
    }
    const { reader } = await this.d.appraisal.reader(projectId);
    const stale: string[] = [];
    for (const p of this.store.reconciliationPages(reconciliationId)) {
      if (p.stale) continue;
      const lp = await reader.load(p.pageId);
      if (!lp || !lp.resource || !lp.sidebar) {
        stale.push(p.pageId);
        continue;
      }
      const owner = this.store.classification(projectId, p.pageId);
      const record = this.store.pageRecord(projectId, p.pageId);
      const v = retagPage(
        {
          id: p.pageId,
          rawName: lp.page.rawName,
          kind: lp.page.kind,
          tags: extractResource(lp.resource).tags,
          facts: lp.sidebar.facts,
          lifecycle: lp.labels.lifecycle,
          ancestors: lp.path.names.slice(0, -1),
          area: lp.labels.area,
          templateId: this.d.templateOf(projectId, p.pageId),
          packRecord: record ? { primary: record.primary, specialist: record.specialist, detail: '' } : null,
          owner: owner ? { primary: owner.primary, specialist: owner.specialist, detail: '' } : null,
        },
        ctx,
      );
      if (v.inputsHash !== p.inputsHash) stale.push(p.pageId);
    }
    this.store.markStale(reconciliationId, stale);
    return stale;
  }

  /** A reconciliation as it stands: its pages' latest verdicts and outcomes, stale ones marked, what remains. */
  async view(projectId: string, reconciliationId: string) {
    const rec = this.store.reconciliation(reconciliationId);
    if (!rec || rec.projectId !== projectId)
      throw new RetagError(
        'RECONCILIATION_NOT_FOUND',
        `No reconciliation ${reconciliationId} in this project.`,
      );
    await this.refreshStale(projectId, rec.id);
    const pages = this.store.reconciliationPages(rec.id);
    const batches = this.store.batches(projectId, { reconciliationId: rec.id });
    for (const b of batches) this.syncBatch(b);
    const busy = new Set(
      this.store
        .batches(projectId, { reconciliationId: rec.id })
        .filter((b) => b.state === 'proposed' || b.state === 'running')
        .flatMap((b) => b.pages.map((p) => p.pageId)),
    );
    const remains = (p: (typeof pages)[number]) =>
      !busy.has(p.pageId) &&
      (p.stale ||
        (p.disposition === 'correction' && p.outcome !== 'applied' && p.outcome !== 'already_compliant'));
    const count = (f: (p: (typeof pages)[number]) => boolean) => pages.filter(f).length;
    return {
      reconciliation: rec,
      counts: {
        audited: pages.length,
        compliant: count((p) => p.disposition === 'compliant' && !p.stale),
        corrections: count((p) => p.disposition === 'correction'),
        holds: count((p) => p.disposition === 'hold'),
        exceptions: count((p) => p.disposition === 'exception'),
        proposed: busy.size,
        applied: count((p) => p.outcome === 'applied'),
        alreadyCompliant: count((p) => p.outcome === 'already_compliant'),
        held: count((p) => p.outcome === 'held'),
        conflicted: count((p) => p.outcome === 'conflicted'),
        inaccessible: count((p) => p.outcome === 'inaccessible'),
        stale: count((p) => p.stale),
        remaining: count(remains),
      },
      remaining: pages.filter(remains).map((p) => p.pageId),
      pages,
      batches: this.store.batches(projectId, { reconciliationId: rec.id }),
    };
  }

  /**
   * Resumes a reconciliation: a fresh audit of what remains (free, from the snapshots), then the next batch of its
   * deterministic corrections proposed (at most `retag.batchSize`). Nothing proposed when none remain.
   */
  async resume(o: {
    readonly projectId: string;
    readonly reconciliationId: string;
    readonly actor: string;
    readonly origin: JobOrigin;
  }) {
    const v = await this.view(o.projectId, o.reconciliationId);
    if (v.reconciliation.state === 'closed')
      throw new RetagError('RECONCILIATION_CLOSED', `Reconciliation “${v.reconciliation.name}” is closed.`);
    if (v.remaining.length === 0)
      return { status: 'nothing_remaining' as const, view: v, audit: null, batch: null };
    const audit = await this.audit({
      projectId: o.projectId,
      actor: o.actor,
      scope: { pageIds: v.remaining },
      reconciliationId: v.reconciliation.id,
    });
    const max = this.policyFor(o.projectId).rules.retag!.batchSize;
    const next = audit.verdicts.filter((x) => x.disposition === 'correction').slice(0, max);
    if (next.length === 0)
      return {
        status: 'nothing_to_propose' as const,
        view: await this.view(o.projectId, o.reconciliationId),
        audit,
        batch: null,
      };
    const plan = this.planApply({
      projectId: o.projectId,
      runId: audit.run.id,
      pageIds: next.map((x) => x.pageId),
    });
    const sub = await this.submitApply(plan, {
      projectId: o.projectId,
      origin: o.origin,
      actor: o.actor,
      reconciliationId: v.reconciliation.id,
    });
    this.d.audit(o.actor, 'retag.reconcile_resume', o.projectId, null, {
      reconciliation: v.reconciliation.id,
      run: audit.run.id,
      batch: sub.batch.id,
      pages: next.length,
    });
    return {
      status: 'proposed' as const,
      view: await this.view(o.projectId, o.reconciliationId),
      audit,
      batch: sub,
      plan,
    };
  }

  // ============================================================================================ pack records

  /**
   * A pack tool's record of the pages a package makes (the retag's first evidence of their category): each page with a
   * primary category in its grammar's tags (an index has none). Recorded when the package is captured or submitted (its
   * page ids are minted then); the audit uses a record only for a page the snapshots hold, so a page the owner left
   * out was never made and its record never counts.
   */
  recordPackage(
    projectId: string,
    o: {
      readonly packId: string;
      readonly tool: string;
      readonly type: string;
      readonly rules: PackRules;
      readonly pages: readonly {
        readonly id: string;
        readonly role: string;
        readonly tags: readonly string[];
      }[];
      readonly proposalId: string | null;
      readonly jobId: string | null;
    },
  ): void {
    const v = vocabularyOf(o.rules);
    const records = o.pages.flatMap((p) => {
      const c = categoryFromTags(p.tags, v);
      if ('problem' in c) return [];
      return [
        {
          projectId,
          pageId: p.id,
          packId: o.packId,
          tool: o.tool,
          type: o.type,
          role: p.role,
          primary: c.primary,
          specialist: c.specialists.length === 1 ? c.specialists[0]! : null,
          proposalId: o.proposalId,
          jobId: o.jobId,
        },
      ];
    });
    if (records.length > 0) this.store.recordPages(records);
  }

  // ============================================================================================ the audits' hook

  /**
   * What the audits need to take their tag findings from this engine (ADR 0060): null when the project's approved pack
   * has no retag rules (the tag-definition document then applies, as before).
   */
  auditHook(projectId: string): RetagAuditHook | null {
    let p: { pack: Pack; rules: PackRules; policy: RetagPolicy };
    try {
      p = this.policyFor(projectId);
    } catch {
      return null;
    }
    return {
      context: this.context(projectId, p.rules, p.pack),
      policy: { version: p.policy.version, digest: p.policy.digest },
      packRecord: (pageId) => {
        const r = this.store.pageRecord(projectId, pageId);
        return r
          ? { primary: r.primary, specialist: r.specialist, detail: `${r.tool}, ${r.type} ${r.role}` }
          : null;
      },
      owner: (pageId) => {
        const c = this.store.classification(projectId, pageId);
        return c
          ? {
              primary: c.primary,
              specialist: c.specialist,
              detail: `the owner, ${new Date(c.at).toISOString().slice(0, 10)}: ${c.reason}`,
            }
          : null;
      },
      templateOf: (pageId) => this.d.templateOf(projectId, pageId),
    };
  }

  // ============================================================================================ revert

  /** Whether a job is a retag apply batch's (Revert applies to it although the owner approved it). */
  isApplyJob(projectId: string, jobId: string): boolean {
    return this.store.batchByJob(projectId, jobId) !== null;
  }
}
