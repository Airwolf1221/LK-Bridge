/**
 * `arkona_working_digest` (v3 F3c, ADR 0054; the design's A4): what is in progress, read-only and free.
 *
 * - every **Working page** (`[BWRK]`), with its Status, Scope, Last Major Revision, when the snapshots first saw it and
 *   when they last saw it change;
 * - every **pending or conflicted proposal**;
 * - **approved but not promoted**: Working sets whose package (a pack tool's proposal) was approved and executed, whose
 *   pages are still `[BWRK]`;
 * - **declared contradictions**: Working pages whose Unresolved Material says "contradict", "conflict" or "supersede".
 *
 * Age is shown, never judged (decision D3: "Age alone is a review signal"): there is no "stale" threshold. Ordered by the
 * most recent change; `since` keeps only what changed (or was proposed) in that window.
 */
import type { LkBlock } from '../markdown/index.js';
import { sectionsOf, textKey } from '../packs/engine/text.js';
import type { ProposalDetail } from '../policy/proposals.js';
import type { ProposalState, ProposalView } from '../policy/types.js';
import type { SnapshotDb } from '../snapshots/db.js';
import { deepText } from './extract.js';
import type { Draft } from './owner.js';
import type { PageReader } from './reader.js';

type Obj = Record<string, unknown>;

export interface DigestContext {
  readonly projectId: string;
  readonly reader: PageReader;
  readonly index: Pick<SnapshotDb, 'pageHistory'>;
  readonly proposals: {
    list(f: { project: string; state?: readonly ProposalState[]; limit?: number }): ProposalView[];
    detail(id: string): ProposalDetail | undefined;
  };
  /** The pack tools whose executed proposals made Working sets (`arkona_create_character`…). */
  readonly packTools: ReadonlySet<string>;
  readonly unresolvedHeading: string;
  readonly statusRow: string;
  readonly scopeRow: string;
  readonly lmrRow: string;
  readonly now: number;
  /** Only what changed (or was proposed) at or after this time; null: everything. */
  readonly since: number | null;
}

export const CONTRADICTION = /\b(contradict\w*|conflict\w*|supersed\w*)\b/i;

const ago = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};
const iso = (t: number) => new Date(t).toISOString();

/** When the snapshots first held a page, and when one of its pieces last changed (the history's own rows). */
export function historyOf(
  index: DigestContext['index'],
  projectId: string,
  pageId: string,
): { firstSeen: number | null; lastChange: number | null } {
  const rows = index.pageHistory(projectId, pageId, { limit: 2000 });
  if (rows.length === 0) return { firstSeen: null, lastChange: null };
  // Newest first. A piece "changes" at the newest row whose hash differs from the next older row of the same piece.
  const byPiece = new Map<string, { sha: string | null; takenAt: number }[]>();
  for (const r of rows) {
    const k = `${r.piece}:${r.ref}`;
    const l = byPiece.get(k) ?? [];
    l.push({ sha: r.sha256, takenAt: r.takenAt });
    byPiece.set(k, l);
  }
  let lastChange: number | null = null;
  for (const list of byPiece.values()) {
    // The current hash's first row: the oldest of the newest run of equal hashes.
    let i = 0;
    while (i + 1 < list.length && list[i + 1]!.sha === list[0]!.sha) i++;
    const at = list[i]!.takenAt;
    if (lastChange === null || at > lastChange) lastChange = at;
  }
  const firstSeen = Math.min(...rows.map((r) => r.takenAt));
  return { firstSeen, lastChange };
}

export async function workingDigest(ctx: DigestContext): Promise<{ drafts: Draft[]; inspected: Obj }> {
  const drafts: Draft[] = [];
  const working: { draft: Draft; at: number }[] = [];
  const pages = ctx.reader.all().filter((p) => p.kind === 'bwrk');
  for (const page of pages) {
    const p = await ctx.reader.load(page.id);
    const facts = p?.sidebar?.facts;
    const fact = (k: string) => facts?.get(k.trim().toLowerCase())?.text ?? null;
    const h = historyOf(ctx.index, ctx.projectId, page.id);
    const lastChange = h.lastChange ?? page.sourceTakenAt;
    if (ctx.since !== null && lastChange < ctx.since) continue;
    const parent = page.parentId ? ctx.reader.page(page.parentId) : null;
    working.push({
      at: lastChange,
      draft: {
        check: 'working_page',
        pageId: page.id,
        message: `${page.rawName}: Working; last changed ${ago(ctx.now - lastChange)} ago${h.firstSeen !== null ? `, in the snapshots since ${iso(h.firstSeen).slice(0, 10)}` : ''}.`,
        details: {
          status: fact(ctx.statusRow),
          scope: fact(ctx.scopeRow),
          lastMajorRevision: fact(ctx.lmrRow),
          lastChange: iso(lastChange),
          lastChangeAge: ago(ctx.now - lastChange),
          firstSeen: h.firstSeen !== null ? iso(h.firstSeen) : null,
          age: h.firstSeen !== null ? ago(ctx.now - h.firstSeen) : null,
          ageFrom: 'the oldest snapshot that holds it (snapshots are kept 30 days, then weekly for 8 weeks)',
          set:
            parent && parent.kind === 'index' && parent.rawName !== ''
              ? { id: parent.id, name: parent.rawName }
              : null,
        },
      },
    });
    // A declared contradiction in its Unresolved Material.
    if (p?.body) {
      const secs = sectionsOf(p.body.blocks as unknown as LkBlock[]);
      const at = secs.findIndex((s) => s.heading && textKey(s.title) === textKey(ctx.unresolvedHeading));
      if (at >= 0) {
        const level = secs[at]!.level;
        const lines: string[] = [];
        for (let i = at; i < secs.length; i++) {
          const s = secs[i]!;
          if (i > at && s.heading && s.level <= level) break;
          if (i > at && s.heading) lines.push(s.title);
          for (const b of s.blocks) {
            const t = deepText(b).trim();
            if (t) lines.push(t);
          }
        }
        const said = lines.filter((l) => CONTRADICTION.test(l));
        if (said.length > 0)
          drafts.push({
            check: 'declared_contradiction',
            pageId: page.id,
            documentId: p.body.documentId,
            message: `${page.rawName} declares in its ${ctx.unresolvedHeading}: “${said[0]!.slice(0, 200)}”${said.length > 1 ? ` (and ${said.length - 1} more)` : ''}.`,
            details: {
              lines: said.slice(0, 10).map((l) => l.slice(0, 500)),
              words: [
                ...new Set(said.flatMap((l) => l.match(CONTRADICTION) ?? []).map((w) => w.toLowerCase())),
              ],
            },
          });
      }
    }
  }
  working.sort((a, b) => b.at - a.at);
  drafts.unshift(...working.map((w) => w.draft));

  // Pending and conflicted proposals, newest first.
  const open = ctx.proposals.list({ project: ctx.projectId, state: ['pending', 'conflicted'], limit: 500 });
  for (const p of open) {
    if (ctx.since !== null && Math.max(p.createdAt, p.updatedAt) < ctx.since) continue;
    drafts.push({
      check: 'proposal_open',
      pageId: null,
      key: p.id,
      message: `${p.state === 'conflicted' ? 'Conflicted' : 'Pending'}: ${p.title} (${ago(ctx.now - p.createdAt)} old).`,
      details: {
        proposalId: p.id,
        state: p.state,
        title: p.title,
        summary: p.summary,
        createdAt: iso(p.createdAt),
        age: ago(ctx.now - p.createdAt),
        by: p.principalLabel,
        pages: p.pages.slice(0, 20),
        ...(p.conflict ? { conflict: p.conflict } : {}),
        ...(p.requiresCanonicalApproval ? { canonical: true } : {}),
      },
    });
  }

  // Approved but not promoted: a pack's executed proposal whose created pages are still [BWRK].
  const executed = ctx.proposals.list({ project: ctx.projectId, state: ['executed'], limit: 500 });
  let packages = 0;
  for (const p of executed) {
    const tool = typeof p.operation?.tool === 'string' ? p.operation.tool : '';
    if (!ctx.packTools.has(tool)) continue;
    if (ctx.since !== null && (p.finishedAt ?? p.updatedAt) < ctx.since) continue;
    packages++;
    const d = ctx.proposals.detail(p.id);
    const created = new Set<string>();
    for (const op of d?.ops ?? []) {
      const body = (op.params as { body?: Obj } | null)?.body ?? {};
      if (
        (op.op === 'createResourceFromTemplate' || op.op === 'createResource') &&
        typeof body.id === 'string'
      )
        created.add(body.id);
    }
    const still = [...created]
      .map((id) => ctx.reader.page(id))
      .filter((x): x is NonNullable<typeof x> => x !== null && x.kind === 'bwrk');
    if (still.length === 0) continue;
    drafts.push({
      check: 'approved_not_promoted',
      pageId: still[0]!.id,
      key: p.id,
      message: `${p.title}: approved ${ago(ctx.now - (p.decidedAt ?? p.updatedAt))} ago; ${still.length} of its page${still.length === 1 ? ' is' : 's are'} still [BWRK].`,
      details: {
        proposalId: p.id,
        tool,
        approvedAt: p.decidedAt !== null ? iso(p.decidedAt) : null,
        age: ago(ctx.now - (p.decidedAt ?? p.updatedAt)),
        pages: still.map((x) => ({ id: x.id, name: x.rawName })),
      },
    });
  }
  return {
    drafts,
    inspected: {
      workingPages: pages.length,
      openProposals: open.length,
      executedPackages: packages,
      since: ctx.since !== null ? iso(ctx.since) : null,
    },
  };
}
