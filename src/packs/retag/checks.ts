/**
 * The retag apply's checks inside its job (v3 F3f, ADR 0060), the Standard's steps 4 and 5:
 *
 * - **`retag.policy`** (the job's first step, run again by Resume): the approved pack version and its digest are the
 *   audit run's. Otherwise the whole job stops before any write: "policy changed since the audit; audit again".
 * - **`retag.page`** (per page, before its write): a fresh read of the page. Gone or unreadable: **inaccessible**. Its
 *   classification inputs (Status, Continuity Type, Continuity, Reference Type, race, culture) changed since the audit:
 *   **held** ("audit it again"). Its tags already the proposed array: **already compliant**. Its tags not exactly the
 *   audit's current array: **conflicted**, skipped and recorded; the job carries on with the other pages. The read is
 *   kept as the page's "before" for the read-back.
 * - **`retag.tags`** (the write's rebaser, asked inside the page's lock on the read the write makes anyway): the same
 *   three answers once more, so nothing that changed between the check and the write is overwritten. It never rebases a
 *   tag array onto a newer one ("no blind whole-array replacement from an old checkpoint").
 * - **`retag.verify`** (per page, after its write): an independent read-back: the exact final array in order, and the
 *   name, aliases, parent and place, documents and sidebar exactly as before the write. CR-2026-11-R3 (fix C): a page
 *   document's body is compared by its real version (`getDocumentBlocks`, read before the write by `retag.page` and again
 *   here: one read each); any other document only by the metadata `getResource` lists (its `updatedAt` is a metadata
 *   timestamp, which LegendKeeper's governance warns may not move with the body), and the read-back says so.
 *
 * A skipped page's reason starts with its disposition (`held:`, `already compliant:`, `conflicted:`, `inaccessible:`),
 * which the service reads back from the job to record each page's outcome.
 */
import { createHash } from 'node:crypto';
import { extractSidebar } from '../../audits/model.js';
import type { JobEngine } from '../../jobs/index.js';
import type { RegisteredCheckContext, RegisteredCheckResult } from '../../jobs/internal-steps.js';
import type { RebaseContext, RebaseResult } from '../../jobs/rebase.js';
import { stableJson, type StateDifference } from '../../jobs/sidebar-state.js';
import { sidebarPiece } from '../../snapshots/canonical.js';
import type { RetagPolicy } from './engine.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);

export const RETAG_CHECKS = {
  policy: 'retag.policy',
  page: 'retag.page',
  verify: 'retag.verify',
} as const;
export const RETAG_REBASER = 'retag.tags';

/** The prefixes of a skipped page's reason, by the disposition they record. */
export const SKIP_PREFIX = {
  held: 'held: ',
  already_compliant: 'already compliant: ',
  conflicted: 'conflicted: ',
  inaccessible: 'inaccessible: ',
} as const;

export interface PolicyCheckInput {
  readonly packId: string;
  readonly runId: string;
  readonly version: number;
  readonly digest: string;
}

export interface PageCheckInput {
  readonly pageId: string;
  readonly name: string;
  readonly item: string;
  readonly current: readonly string[];
  readonly proposed: readonly string[];
  readonly propertiesName: string;
  /** The facts the verdict was computed from, by sidebar key (null: absent). */
  readonly facts: Readonly<Record<string, string | null>>;
  /**
   * CR-2026-11-R3 (R3-04): the page's parent at the audit (absent for a batch planned before this release). A page moved
   * since (archived, into an excluded area, restored elsewhere) is conflicted, never written.
   */
  readonly parentId?: string | null;
  /**
   * CR-2026-11-R3 (R3-03): the owner's classification and the pack's record of the page at the audit, as the verdict's
   * basis holds them (absent for a batch planned before this release). Changed since: held.
   */
  readonly owner?: readonly [string, string | null] | null;
  readonly packRecord?: readonly [string, string | null] | null;
}

/**
 * The write's rebaser input. CR-2026-11-R3 (R3-05): the page check's own input, so the write judges the page inside its
 * lock exactly as the check did (a batch planned before this release carries the item and the arrays only).
 */
export interface TagsRebaseInput extends Partial<Omit<PageCheckInput, 'item' | 'current' | 'proposed'>> {
  readonly item: string;
  readonly current: readonly string[];
  readonly proposed: readonly string[];
}

export interface VerifyInput {
  readonly pageId: string;
  readonly name: string;
  readonly proposed: readonly string[];
  /** The expect check's label, whose observation is the page's "before". */
  readonly beforeLabel: string;
}

/**
 * CR-2026-11-R3 (fix C): each live page document's body version, read now (`getDocumentBlocks`, one read each): the
 * version LegendKeeper answers, else a hash of the blocks. `unreadable` when the read fails: never taken as unchanged.
 * Other documents (board, map, timeline, blank) are not read: they are compared by their metadata only.
 */
export async function bodyVersions(ctx: RegisteredCheckContext, pageId: string, res: Obj): Promise<Obj> {
  const out: Obj = {};
  const docs = (Array.isArray(res.documents) ? (res.documents as unknown[]) : []).filter(isObj);
  for (const d of docs) {
    if (d.type !== 'page' || (d.deletedAt ?? null) !== null || typeof d.id !== 'string') continue;
    try {
      const r = await ctx.read('getDocumentBlocks', { path: { resourceId: pageId, documentId: d.id } });
      if (!r.exists || !isObj(r.body)) {
        out[d.id] = 'gone';
        continue;
      }
      const v = r.body.version;
      out[d.id] =
        typeof v === 'string' || typeof v === 'number'
          ? `version ${String(v)}`
          : `blocks ${createHash('sha1')
              .update(stableJson(r.body.blocks ?? null))
              .digest('hex')}`;
    } catch (e) {
      const status = (e as { lk?: { status?: number } } | null)?.lk?.status;
      const code = (e as { code?: unknown } | null)?.code;
      if (status === 403 || status === 404 || code === 'FORBIDDEN' || code === 'NOT_FOUND')
        out[d.id] = 'unreadable';
      else throw e; // a budget or restart wait: the check is parked and runs again, never judged on a failed read
    }
  }
  return out;
}

/** What the read-back compares besides the tags: everything a tags write must leave as it was. */
export function fingerprint(res: Obj, bodies?: Obj): Obj {
  const docs = (Array.isArray(res.documents) ? (res.documents as unknown[]) : []).filter(isObj).map((d) => ({
    id: d.id ?? null,
    name: d.name ?? null,
    type: d.type ?? null,
    rank: d.rank ?? null,
    isHidden: d.isHidden ?? null,
    deletedAt: d.deletedAt ?? null,
    updatedAt: d.updatedAt ?? null,
  }));
  return {
    name: res.name ?? null,
    aliases: list(res.aliases),
    parentId: res.parentId ?? null,
    rank: res.rank ?? null,
    isHidden: res.isHidden ?? null,
    isLocked: res.isLocked ?? null,
    documents: docs,
    ...(bodies ? { bodies } : {}),
    sidebar: createHash('sha1')
      .update(stableJson(res.properties ?? []))
      .digest('hex'),
  };
}

/** CR-2026-11-R3 (R3-03): a classification as the verdict's basis records it (`[primary, specialist]`), or null. */
export type RecordPrint = readonly [string, string | null] | null;

export interface RetagCheckDeps {
  /**
   * The current approved policy of a pack for a project (null: none approved, or not current). CR-2026-11-R3 (R3-08):
   * its digest covers the project's lifecycle settings too (status tags, fields, the Reference Type row).
   */
  readonly policy: (packId: string, projectId: string) => RetagPolicy | null;
  /**
   * CR-2026-11-R3 (R3-03): the owner's classification and the pack's record of a page now (the bridge's own tables,
   * no LegendKeeper read). Absent: not compared.
   */
  readonly records?: (projectId: string, pageId: string) => { owner: RecordPrint; packRecord: RecordPrint };
  /** Each governance source's version read now (one read each): the policy's sources must still be these. */
  readonly governance?: (packId: string) => Promise<{
    readonly sources: readonly {
      readonly key: string;
      readonly name: string;
      readonly current: string | null;
    }[];
  }>;
}

async function readResource(
  ctx: RegisteredCheckContext,
  pageId: string,
): Promise<{ ok: true; res: Obj } | { ok: false; why: string }> {
  try {
    const r = await ctx.read('getResource', { path: { resourceId: pageId } });
    if (!r.exists || !isObj(r.body)) return { ok: false, why: 'the page is gone' };
    return { ok: true, res: r.body };
  } catch (e) {
    const status = (e as { lk?: { status?: number } } | null)?.lk?.status;
    const code = (e as { code?: unknown } | null)?.code;
    if (status === 403 || status === 404 || code === 'FORBIDDEN' || code === 'NOT_FOUND')
      return {
        ok: false,
        why: `the page cannot be read (${typeof code === 'string' ? code : String(status ?? 'unknown')})`,
      };
    throw e;
  }
}

async function policyCheck(d: RetagCheckDeps, ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = (ctx.input ?? {}) as Partial<PolicyCheckInput>;
  const now = input.packId ? d.policy(input.packId, ctx.projectId) : null;
  // The governance sources read now (the Standard: "compare policy version/digest before writing"): a source whose
  // version is not the approved one is a changed policy too, whatever the stored digest says.
  let moved: string[] = [];
  if (now && input.packId && d.governance) {
    const g = await d.governance(input.packId);
    const want = new Map(now.sources.map((x) => [x.key, x.version]));
    moved = g.sources.filter((x) => want.has(x.key) && want.get(x.key) !== x.current).map((x) => x.name);
  }
  if (moved.length > 0)
    return {
      differences: [],
      refusal: {
        code: 'RETAG_POLICY_CHANGED',
        message: `policy changed since the audit; audit again (${moved.join(', ')} changed since the owner approved the pack: the owner approves it again first). Nothing was written.`,
        details: { runId: input.runId ?? null, governance: moved },
      },
    };
  if (!now || now.version !== input.version || now.digest !== input.digest)
    return {
      differences: [],
      refusal: {
        code: 'RETAG_POLICY_CHANGED',
        message: `policy changed since the audit; audit again (audit run ${input.runId ?? '?'} used version ${input.version ?? '?'}; ${now ? `the approved version is now ${now.version}${now.version === input.version ? ' with other rules or governance' : ''}` : 'no version is approved and current now'}). Nothing was written.`,
        details: {
          runId: input.runId ?? null,
          audited: { version: input.version ?? null, digest: input.digest ?? null },
          now: now ? { version: now.version, digest: now.digest } : null,
        },
      },
    };
  return { differences: [], observed: { version: now.version, digest: now.digest } };
}

/** What the live page says about an item: write it, it is already done, or skip it with a disposition. */
type Judged =
  | { readonly kind: 'write' }
  | { readonly kind: 'already' }
  | {
      readonly kind: 'skip';
      readonly prefix: string;
      readonly reason: string;
      readonly before?: string | null;
      readonly after?: string | null;
    };

const samePrint = (a: RecordPrint | undefined, b: RecordPrint | undefined): boolean =>
  (a ?? null) === null
    ? (b ?? null) === null
    : b !== null && b !== undefined && a![0] === b[0] && a![1] === b[1];
const printText = (p: RecordPrint | undefined) => (p ? `${p[0]}${p[1] ? ` / ${p[1]}` : ''}` : '(none)');

/**
 * CR-2026-11-R3 (R3-03 to R3-05): the page as read now (in the check, or inside the write's lock) against what the audit
 * computed its verdict from. Renamed or moved since: **conflicted** (the page is no longer the one audited: archived,
 * moved into an excluded area, restored elsewhere). Its facts, or the owner's classification or the pack's record of it,
 * changed since: **held** ("audit it again"). Then the tags: already the proposed array, the audit's array (write), or
 * anything else (**conflicted**, never rebased onto the newer array). A field the input lacks (a batch planned before
 * this release) is not compared.
 */
function judgeLive(
  res: Obj,
  input: TagsRebaseInput,
  records: RetagCheckDeps['records'],
  projectId: string,
): Judged {
  const skip = (prefix: string, reason: string, before?: string | null, after?: string | null): Judged => ({
    kind: 'skip',
    prefix,
    reason,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  });
  if (input.name !== undefined && typeof res.name === 'string' && res.name !== input.name)
    return skip(
      SKIP_PREFIX.conflicted,
      'renamed since the audit; never written to a page that is no longer the one audited (audit it again)',
      input.name,
      res.name,
    );
  if (input.parentId !== undefined && (str(res.parentId) ?? null) !== (input.parentId ?? null))
    return skip(
      SKIP_PREFIX.conflicted,
      'moved since the audit (another parent); never written to a page that is no longer where it was audited (audit it again)',
      input.parentId ?? '(the root)',
      str(res.parentId) ?? '(the root)',
    );
  if (input.facts && input.propertiesName) {
    const side = extractSidebar(sidebarPiece(res.properties ?? []), input.propertiesName);
    const changed: string[] = [];
    for (const [key, want] of Object.entries(input.facts)) {
      const f = side.facts.get(key.normalize('NFC').trim().toLowerCase());
      const now = f ? (f.count > 1 ? `(${f.count} rows)` : f.text.trim() || null) : null;
      if ((now ?? null) !== (want ?? null)) changed.push(`${key}: ${want ?? '(none)'} → ${now ?? '(none)'}`);
    }
    if (changed.length > 0)
      return skip(
        SKIP_PREFIX.held,
        `its facts changed since the audit (${changed.join('; ')}); audit it again`,
        null,
        changed.join('; '),
      );
  }
  if (records && (input.owner !== undefined || input.packRecord !== undefined) && input.pageId) {
    const now = records(projectId, input.pageId);
    const changed: string[] = [];
    if (input.owner !== undefined && !samePrint(input.owner, now.owner))
      changed.push(`the owner's classification: ${printText(input.owner)} → ${printText(now.owner)}`);
    if (input.packRecord !== undefined && !samePrint(input.packRecord, now.packRecord))
      changed.push(`the pack's record: ${printText(input.packRecord)} → ${printText(now.packRecord)}`);
    if (changed.length > 0)
      return skip(
        SKIP_PREFIX.held,
        `its classification changed since the audit (${changed.join('; ')}); audit it again`,
        null,
        changed.join('; '),
      );
  }
  const tags = list(res.tags);
  if (same(tags, input.proposed)) return { kind: 'already' };
  if (!same(tags, input.current))
    return skip(
      SKIP_PREFIX.conflicted,
      'its tags changed since the audit; never rebased onto the newer array',
      input.current.join(', '),
      tags.join(', '),
    );
  return { kind: 'write' };
}

async function pageCheck(d: RetagCheckDeps, ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as PageCheckInput;
  const skip = (prefix: string, reason: string, before?: string | null, after?: string | null) => ({
    differences: [],
    skipped: [
      {
        item: input.item,
        reason: `${prefix}${reason}`,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        where: input.name,
      },
    ],
  });
  const r = await readResource(ctx, input.pageId);
  if (!r.ok) return skip(SKIP_PREFIX.inaccessible, r.why);
  const j = judgeLive(r.res, input, d.records, ctx.projectId);
  if (j.kind === 'skip') return skip(j.prefix, j.reason, j.before, j.after);
  if (j.kind === 'already')
    return {
      ...skip(SKIP_PREFIX.already_compliant, 'the page already carries the proposed array'),
      observed: fingerprint(r.res),
    };
  // CR-2026-11-R3 (fix C): the page documents' body versions, for the read-back (one read each).
  return { differences: [], observed: fingerprint(r.res, await bodyVersions(ctx, input.pageId, r.res)) };
}

/**
 * The write's rebaser, asked inside the page's lock on the read the write makes anyway. CR-2026-11-R3 (R3-05): it judges
 * the page exactly as the check does (`judgeLive`: name, parent, facts, classification, tags), so a change between the
 * check and the write, or while a stopped job waited for Resume (which runs the policy check again, not each page's),
 * is never written over.
 */
function rebaseTags(d: RetagCheckDeps, ctx: RebaseContext): RebaseResult {
  const input = ctx.input as TagsRebaseInput;
  const page = (ctx.current.entity ?? ctx.current.body ?? {}) as Obj;
  if (!ctx.current.exists)
    return {
      kind: 'skip',
      skipped: [{ item: input.item, reason: `${SKIP_PREFIX.inaccessible}the page is gone` }],
    };
  const j = judgeLive(page, input, d.records, ctx.projectId);
  if (j.kind === 'already') return { kind: 'unchanged' };
  if (j.kind === 'write') return { kind: 'retry', params: ctx.params };
  return {
    kind: 'skip',
    skipped: [
      {
        item: input.item,
        reason: `${j.prefix}${j.reason.replace('since the audit', 'since the audit (seen inside the lock)')}`,
        ...(j.before !== undefined ? { before: j.before } : {}),
        ...(j.after !== undefined ? { after: j.after } : {}),
      },
    ],
  };
}

async function verifyCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as VerifyInput;
  const before = (() => {
    const src = ctx.from.before;
    if (!isObj(src) || !isObj(src.observed)) return null;
    const o = src.observed[input.beforeLabel];
    return isObj(o) ? o : null;
  })();
  const r = await readResource(ctx, input.pageId);
  if (!r.ok) return { differences: [{ path: `${input.name}: page`, expected: 'readable', actual: r.why }] };
  const diffs: StateDifference[] = [];
  const tags = list(r.res.tags);
  if (!same(tags, input.proposed))
    diffs.push({ path: `${input.name}: tags (in order)`, expected: input.proposed, actual: tags });
  let bodiesCompared = 0;
  if (before) {
    const after = fingerprint(r.res);
    for (const k of [
      'name',
      'aliases',
      'parentId',
      'rank',
      'isHidden',
      'isLocked',
      'documents',
      'sidebar',
    ] as const)
      if (stableJson(after[k] ?? null) !== stableJson(before[k] ?? null))
        diffs.push({
          path: `${input.name}: ${
            k === 'sidebar'
              ? 'sidebar (properties, links)'
              : k === 'parentId' || k === 'rank'
                ? 'parentage and place'
                : k === 'documents'
                  ? "documents' metadata (id, name, type, place, flags, metadata timestamp)"
                  : k
          } unchanged`,
          expected: before[k] ?? null,
          actual: after[k] ?? null,
        });
    // CR-2026-11-R3 (fix C): each page document's body by its real version, read again now. A body that could not be
    // read on either side is reported, never taken as unchanged.
    const was = isObj(before.bodies) ? before.bodies : null;
    if (was) {
      const now = await bodyVersions(ctx, input.pageId, r.res);
      for (const [docId, v] of Object.entries(was)) {
        bodiesCompared++;
        const cur = now[docId] ?? 'gone';
        if (v === 'unreadable' || cur === 'unreadable' || cur !== v)
          diffs.push({
            path: `${input.name}: document ${docId} body unchanged (by its version)`,
            expected: v,
            actual: cur,
          });
      }
    } else
      diffs.push({
        path: `${input.name}: document bodies`,
        expected: 'their versions as read before the write',
        actual: '(not recorded)',
      });
  } else
    diffs.push({
      path: `${input.name}: before`,
      expected: 'the page as read before the write',
      actual: '(not recorded)',
    });
  return { differences: diffs, observed: { tags, bodiesCompared } };
}

/** Registers the checks and the rebaser with the engine. Returns an unregister. */
export function registerRetagChecks(
  engine: Pick<JobEngine, 'registerAsyncChecker' | 'registerRebaser'>,
  d: RetagCheckDeps,
): () => void {
  const off = [
    engine.registerAsyncChecker(RETAG_CHECKS.policy, (ctx) => policyCheck(d, ctx)),
    engine.registerAsyncChecker(RETAG_CHECKS.page, (ctx) => pageCheck(d, ctx)),
    engine.registerAsyncChecker(RETAG_CHECKS.verify, verifyCheck),
    engine.registerRebaser(RETAG_REBASER, (ctx) => rebaseTags(d, ctx)),
  ];
  return () => {
    for (const f of off) f();
  };
}
