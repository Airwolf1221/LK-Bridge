/**
 * v3 F3d (renames), ADR 0058: what follows a rename once it is proposed (the design's sections 1 and 2, decision D3).
 *
 * - **The record** (`pack_renames`): the subject, its old and new names, the proposal and its job, the token change of a
 *   culture or race, and, once the job has ended, what is left.
 * - **The token change (D3)**: a culture's or race's token map changes in the same package, as a NEW pack version that
 *   only the owner approves. When the owner approves the rename with its token item, the bridge makes that version
 *   (the proposal hook, before the job is submitted) and the job WAITS for the owner to approve it on the Packs page;
 *   the job's own check confirms, inside its lock, that the approved version maps the new value to the new token.
 *   Left out, the token item makes no version, and the characters' tags (which depend on it) are left out with it.
 * - **What is left (verification)**: after the job, the full-text index (A1, brought up to date by the job's own change
 *   snapshot) is searched for the old name again; every occurrence still on a current page is listed with its link
 *   (the owner's omissions, what the rename does not edit, and anything written since the plan), and offered as a
 *   follow-up rename of exactly those (`arkona_rename` with `from`). Historical pages (D2) and the old name kept as an
 *   alias are not leftovers.
 */
import type { Db } from '../../db/open.js';
import type { Appraisal } from '../../appraisal/service.js';
import type { JobEngine } from '../../jobs/engine.js';
import type { PlanItem } from '../../jobs/items.js';
import type { JobView, WaitForShape } from '../../jobs/types.js';
import type { ProposalHooks } from '../../policy/proposals.js';
import type { ProposalView } from '../../policy/types.js';
import { textKey } from '../engine/text.js';
import type { Packs } from '../service.js';
import { names as namesIn, namePattern } from './text.js';
import { reviewList, type ReviewList, type ReviewOccurrence, type ReviewPart } from './review.js';
import type { SkippedItem } from '../../jobs/types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export type RenameState = 'proposed' | 'running' | 'done' | 'stopped' | 'closed';

/** A culture's or race's token change, as planned (and the pack version it became, once approved). */
export interface RenameToken {
  readonly packId: string;
  readonly map: 'culture' | 'race';
  readonly from: string;
  readonly to: string;
  readonly oldToken: string;
  readonly newToken: string;
  /** The item that carries it. */
  readonly item: string;
  /** The pack version the owner's approval made (null until then). */
  readonly version?: number | null;
}

export interface Leftover {
  readonly page: { readonly id: string; readonly name: string; readonly link: string };
  readonly where: string;
  readonly snippet: string;
  readonly au: boolean;
}

export interface LeftoverReport {
  readonly asOf: string | null;
  readonly count: number;
  readonly occurrences: readonly Leftover[];
  /** The call that proposes a rename of exactly what is left (null when nothing is). */
  readonly followUp: { readonly tool: 'arkona_rename'; readonly args: Obj } | null;
  readonly note: string;
  /**
   * ADR 0058 amendment (A): the items the job skipped because what they edit changed meanwhile, each with a before and
   * after excerpt; the owner can propose them again ("Propose these again" on the Proposals page).
   */
  readonly skipped?: {
    readonly count: number;
    readonly items: readonly SkippedItem[];
    readonly note: string;
  };
  /** ADR 0058 amendment (B, D): review only, never edited: the old name's parts on their own, custom labels. */
  readonly reviewOnly?: ReviewList;
}

/** ADR 0058 amendment (B, D): what a rename lists for review, as planned (kept with the record). */
export interface RenameReview {
  readonly parts: readonly ReviewPart[];
  readonly customLabels: readonly ReviewOccurrence[];
}

export interface RenameRecord {
  readonly id: string;
  readonly projectId: string;
  readonly packId: string;
  readonly subjectId: string;
  readonly subjectKind: string;
  readonly oldName: string;
  readonly newName: string;
  readonly proposalId: string | null;
  readonly jobId: string | null;
  readonly state: RenameState;
  readonly token: RenameToken | null;
  readonly leftovers: LeftoverReport | null;
  readonly leftoversAt: number | null;
  readonly review: RenameReview | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface Row {
  id: string;
  project_id: string;
  pack_id: string;
  subject_id: string;
  subject_kind: string;
  old_name: string;
  new_name: string;
  proposal_id: string | null;
  job_id: string | null;
  state: RenameState;
  token: string | null;
  leftovers: string | null;
  leftovers_at: number | null;
  review: string | null;
  created_at: number;
  updated_at: number;
}

const parse = <T>(s: string | null): T | null => {
  if (s === null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

const toRecord = (r: Row): RenameRecord => ({
  id: r.id,
  projectId: r.project_id,
  packId: r.pack_id,
  subjectId: r.subject_id,
  subjectKind: r.subject_kind,
  oldName: r.old_name,
  newName: r.new_name,
  proposalId: r.proposal_id,
  jobId: r.job_id,
  state: r.state,
  token: parse<RenameToken>(r.token),
  leftovers: parse<LeftoverReport>(r.leftovers),
  leftoversAt: r.leftovers_at,
  review: parse<RenameReview>(r.review ?? null),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface RenameServiceDeps {
  readonly db: Db;
  readonly engine: Pick<JobEngine, 'events' | 'setWaitForCheck' | 'poke'> &
    Partial<Pick<JobEngine, 'skippedItems'>>;
  /** ADR 0058 amendment (B): the character a page belongs to (its subject's name), for the review list. */
  readonly characterOf?: (projectId: string, pageId: string) => string | null;
  readonly packs: Pick<Packs, 'get' | 'onChange' | 'commands'>;
  readonly proposals: {
    addHooks(h: ProposalHooks): () => void;
    get(id: string): ProposalView | undefined;
  };
  /** The full-text index and the page labels (A1): what is left after the job. */
  readonly appraisal?: Pick<Appraisal, 'ensureIndex' | 'reader' | 'fullText'> | undefined;
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

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export class RenameService {
  private offs: (() => void)[] = [];

  constructor(private readonly d: RenameServiceDeps) {}

  /** Hooks into the proposals, the engine's waits and the jobs' ends. Returns a detach. */
  start(): () => void {
    this.offs.push(
      this.d.proposals.addHooks({
        beforeSubmit: (ctx) => this.beforeSubmit(ctx),
        afterSubmit: (ctx) => this.afterSubmit(ctx.proposal, ctx.jobId),
        afterRepropose: (ctx) => this.afterRepropose(ctx.original, ctx.proposalId),
      }),
      this.d.engine.setWaitForCheck((w) => this.waitMessage(w)),
      // A pack approved (or changed) may be what a waiting rename job waits for.
      this.d.packs.onChange(() => this.d.engine.poke()),
      this.d.engine.events.on('job', (e: { type: string; job: JobView }) => {
        try {
          this.onJob(e.job);
        } catch (err) {
          this.d.log?.warn({ err, jobId: e.job.id }, 'a rename could not follow its job');
        }
      }),
    );
    return () => this.stop();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  // ============================================================================================ the record

  record(r: {
    readonly id: string;
    readonly projectId: string;
    readonly packId: string;
    readonly subjectId: string;
    readonly subjectKind: string;
    readonly oldName: string;
    readonly newName: string;
    readonly proposalId: string | null;
    readonly jobId: string | null;
    readonly token: RenameToken | null;
    readonly review?: RenameReview | null;
  }): RenameRecord {
    const now = this.d.now();
    this.d.db
      .prepare(
        `INSERT INTO pack_renames (id, project_id, pack_id, subject_id, subject_kind, old_name, new_name, proposal_id,
           job_id, state, token, review, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.projectId,
        r.packId,
        r.subjectId,
        r.subjectKind,
        r.oldName,
        r.newName,
        r.proposalId,
        r.jobId,
        r.jobId ? 'running' : 'proposed',
        r.token ? JSON.stringify(r.token) : null,
        r.review ? JSON.stringify(r.review) : null,
        now,
        now,
      );
    return this.get(r.id)!;
  }

  get(id: string): RenameRecord | null {
    const r = this.d.db.prepare('SELECT * FROM pack_renames WHERE id = ?').get(id) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  byProposal(proposalId: string): RenameRecord | null {
    const r = this.d.db
      .prepare('SELECT * FROM pack_renames WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(proposalId) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  byJob(projectId: string, jobId: string): RenameRecord | null {
    const r = this.d.db
      .prepare(
        'SELECT * FROM pack_renames WHERE project_id = ? AND job_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(projectId, jobId) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  /** A rename by its id, its proposal or its job (the tool's `report`). */
  find(projectId: string, ref: string): RenameRecord | null {
    const r = this.get(ref) ?? this.byProposal(ref) ?? this.byJob(projectId, ref);
    return r && r.projectId === projectId ? r : null;
  }

  /** The renames of a subject, newest first. */
  forSubject(projectId: string, subjectId: string, limit = 20): RenameRecord[] {
    return (
      this.d.db
        .prepare(
          'SELECT * FROM pack_renames WHERE project_id = ? AND subject_id = ? ORDER BY created_at DESC LIMIT ?',
        )
        .all(projectId, subjectId, limit) as Row[]
    ).map(toRecord);
  }

  private update(id: string, f: { state?: RenameState; jobId?: string; token?: RenameToken }): void {
    const sets: string[] = ['updated_at = ?'];
    const args: unknown[] = [this.d.now()];
    if (f.state !== undefined) {
      sets.push('state = ?');
      args.push(f.state);
    }
    if (f.jobId !== undefined) {
      sets.push('job_id = ?');
      args.push(f.jobId);
    }
    if (f.token !== undefined) {
      sets.push('token = ?');
      args.push(JSON.stringify(f.token));
    }
    this.d.db.prepare(`UPDATE pack_renames SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  // ============================================================================================ the proposal

  private renameOf(proposal: ProposalView, operation: Readonly<Obj> | null): RenameRecord | null {
    if (operation?.tool !== 'arkona_rename') return null;
    return this.byProposal(proposal.id);
  }

  /** D3: the approved token change becomes a pack version, and the job waits for the owner to approve it. */
  private beforeSubmit(ctx: {
    readonly proposal: ProposalView;
    readonly operation: Readonly<Obj> | null;
    readonly items: readonly PlanItem[] | null;
    readonly approved: readonly string[] | null;
  }): { readonly waitFor?: WaitForShape } | null {
    const rec = this.renameOf(ctx.proposal, ctx.operation);
    const token =
      rec?.token ?? (isObj(ctx.operation?.token) ? (ctx.operation.token as unknown as RenameToken) : null);
    if (!rec || !token) return null;
    if (ctx.approved && !ctx.approved.includes(token.item)) return null; // left out: no version, no tags
    const pack = this.d.packs.get(token.packId);
    if (!pack)
      throw new Error(`the pack ${token.packId} is gone, so the new ${token.map} token cannot be made`);
    const map = pack.rules.tags[token.map];
    const has = Object.entries(map).some(
      ([k, v]) => textKey(k) === textKey(token.to) && v === token.newToken,
    );
    const stale = Object.keys(map).some((k) => textKey(k) === textKey(token.from));
    const reason = `the ${token.map} token map of rename ${rec.id} (${token.from} → ${token.to}, tag ${token.oldToken} → ${token.newToken})`;
    if (has && !stale) {
      // Made already (an approval undone and given again, a resumed job): wait for that version if it is not approved.
      const approved = pack.approved?.version ?? 0;
      return approved >= pack.version
        ? null
        : { waitFor: { kind: 'pack_version', packId: pack.id, version: pack.version, reason } };
    }
    if (pack.approved?.version !== pack.version)
      throw new Error(
        `the ${pack.name} pack has a version waiting for approval (version ${pack.version}); approve it (or set the pack back) on the Packs page first, then approve this rename again`,
      );
    const after = this.d.packs.commands.renameToken('owner', pack.id, {
      map: token.map,
      from: token.from,
      to: token.to,
      token: token.newToken,
      reason: `arkona_rename ${rec.id}: ${token.map} ${token.from} → ${token.to} (tag ${token.oldToken} → ${token.newToken})`,
    });
    this.update(rec.id, { token: { ...token, version: after.version } });
    this.d.audit('owner', 'rename.token_version', rec.id, null, {
      pack: pack.id,
      version: after.version,
      map: token.map,
      from: token.from,
      to: token.to,
      token: token.newToken,
      proposal: ctx.proposal.id,
    });
    return { waitFor: { kind: 'pack_version', packId: pack.id, version: after.version, reason } };
  }

  private afterSubmit(proposal: ProposalView, jobId: string): void {
    const rec = this.byProposal(proposal.id);
    if (rec) this.update(rec.id, { state: 'running', jobId });
  }

  /** "Propose these again": the new proposal is a rename of its own (the same subject and names). */
  private afterRepropose(original: ProposalView, proposalId: string): void {
    const rec = this.byProposal(original.id);
    if (!rec) return;
    const token = rec.token && rec.token.version == null ? rec.token : null;
    this.record({
      id: `${rec.id.split('~')[0]}~${proposalId.slice(-8)}`,
      projectId: rec.projectId,
      packId: rec.packId,
      subjectId: rec.subjectId,
      subjectKind: rec.subjectKind,
      oldName: rec.oldName,
      newName: rec.newName,
      proposalId,
      jobId: null,
      token,
      review: rec.review,
    });
  }

  // ============================================================================================ the job

  /** The engine's question about a waiting job: null when it may run, else what it waits for. */
  waitMessage(w: WaitForShape): string | null {
    if (w.kind !== 'pack_version') return `waits for ${w.reason || w.kind}`;
    const pack = this.d.packs.get(w.packId);
    if (!pack) return `waits for the pack ${w.packId}, which is gone: cancel this job`;
    const approved = pack.approved?.version ?? 0;
    if (approved >= w.version) return null;
    return `waits for the owner to approve version ${w.version} of the ${pack.name} pack on the Packs page (${w.reason})`;
  }

  private onJob(job: JobView): void {
    const rec = this.byJob(job.projectId, job.id);
    if (!rec) return;
    if (!TERMINAL.has(job.status)) {
      if (rec.state === 'stopped') this.update(rec.id, { state: 'running' });
      return;
    }
    this.update(rec.id, { state: job.status === 'succeeded' ? 'done' : 'stopped' });
    // What is left, once the job's change snapshot is in the index (taken as the job ended).
    void this.leftovers(rec.projectId, rec.id, { refresh: true }).catch((err: unknown) =>
      this.d.log?.warn({ err, rename: rec.id }, 'what a rename left could not be listed'),
    );
  }

  /**
   * What is left of the old name on current pages, from the full-text index (free: no LegendKeeper read). `refresh`
   * searches again (the index caught up first); otherwise the report kept at the job's end.
   */
  async leftovers(
    projectId: string,
    id: string,
    o: { readonly refresh?: boolean } = {},
  ): Promise<LeftoverReport | null> {
    const rec = this.get(id);
    if (!rec || rec.projectId !== projectId) return null;
    if (!o.refresh && rec.leftovers) return rec.leftovers;
    const a = this.d.appraisal;
    if (!a) return null;
    const { reader, state } = await a.reader(projectId);
    const hits = a.fullText.search(projectId, [{ value: rec.oldName, phrase: true }], { limit: 5000 });
    const seen = new Set<string>();
    const out: Leftover[] = [];
    for (const h of hits) {
      // The old name kept as an alias (the page's aliases, the Aliases fact) is not a leftover; nor a historical page.
      // CR-2026-11-R3 (R3-31): a page NAME holding the old name is (a page of the set added while the proposal waited,
      // a "…’s Letters" under the index): a half-renamed identity is reported, never silent.
      if (h.unit === 'alias') continue;
      if (h.unit === 'fact' && h.field && textKey(h.field) === 'aliases') continue;
      // The index ignores case: only the name as written counts; CR-2026-11-R3 (R3-40): and never the old name inside
      // the new one ("… al-Kubra" holding the old name).
      if (!namesIn(h.text.replace(namePattern(rec.newName), ' '), rec.oldName)) continue;
      let labels;
      try {
        labels = reader.labels(h.pageId);
      } catch {
        labels = null;
      }
      if (labels && (labels.area !== null || labels.lifecycle === 'Archived')) continue;
      const key = `${h.pageId}:${h.documentId ?? ''}:${h.blockId ?? ''}:${h.field ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const page = reader.page(h.pageId);
      const loaded = await reader.load(h.pageId).catch(() => null);
      const au = textKey(loaded?.sidebar?.facts.get('continuity type')?.text ?? '') === 'au';
      out.push({
        page: { id: h.pageId, name: page?.rawName ?? h.pageId, link: `lk://resources/${h.pageId}` },
        where:
          h.unit === 'fact'
            ? `the sidebar fact ${h.field ?? ''}`.trim()
            : h.unit === 'name'
              ? 'the page name'
              : h.section
                ? `under ${h.section}`
                : h.unit === 'row'
                  ? 'a table row'
                  : 'the page text',
        snippet: h.snippet,
        au,
      });
    }
    // ADR 0058 amendment (A): the items the job skipped (changed meanwhile), to propose again.
    const skippedItems = rec.jobId ? (this.d.engine.skippedItems?.(projectId, rec.jobId) ?? []) : [];
    // ADR 0058 amendment (B, D): review only, searched again (free).
    const review = rec.review
      ? reviewList(
          {
            projectId,
            search: (pid, value) => a.fullText.search(pid, [{ value, phrase: true }], { limit: 5000 }),
            labels: (pageId) => {
              try {
                return reader.labels(pageId);
              } catch {
                return null;
              }
            },
            pageName: (pageId) => reader.page(pageId)?.rawName ?? null,
            characterOf: (pageId) => this.d.characterOf?.(projectId, pageId) ?? null,
          },
          {
            subjectName: rec.newName,
            oldName: rec.oldName,
            parts: rec.review.parts,
            customLabels: rec.review.customLabels,
          },
        )
      : null;
    const report: LeftoverReport = {
      asOf: state ? new Date(state.newestTakenAt).toISOString() : null,
      count: out.length,
      occurrences: out.slice(0, 500),
      followUp:
        out.length > 0
          ? {
              tool: 'arkona_rename',
              args: { subject: rec.subjectId, newName: rec.newName, from: rec.oldName },
            }
          : null,
      note:
        out.length > 0
          ? `“${rec.oldName}” is still on ${new Set(out.map((x) => x.page.id)).size} current page(s) (as of the newest snapshot): what was left out, what the rename does not edit (tables, code, a name split by formatting), and anything written since the plan. Propose a rename of exactly these with the follow-up call; historical pages and the old name kept as an alias are not listed.`
          : `Nothing of “${rec.oldName}” is left on current pages (as of the newest snapshot); historical pages keep it (D2), and the old name stays an alias where it was kept.`,
      ...(skippedItems.length > 0
        ? {
            skipped: {
              count: skippedItems.length,
              items: skippedItems.slice(0, 200),
              note: `${skippedItems.length} item${skippedItems.length === 1 ? ' was' : 's were'} skipped when the job ran: what ${skippedItems.length === 1 ? 'it edits' : 'they edit'} changed meanwhile (each with a before and after excerpt). The owner can propose ${skippedItems.length === 1 ? 'it' : 'them'} again ("Propose these again" on the Proposals page); for a sentence that now reads differently, a follow-up rename (from) plans it afresh.`,
            },
          }
        : {}),
      ...(review && review.count > 0 ? { reviewOnly: review } : {}),
    };
    this.d.db
      .prepare('UPDATE pack_renames SET leftovers = ?, leftovers_at = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(report), this.d.now(), this.d.now(), rec.id);
    return report;
  }
}
