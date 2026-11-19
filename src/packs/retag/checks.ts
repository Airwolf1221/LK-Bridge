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
 *   name, aliases, parent and place, documents and sidebar exactly as before the write.
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
}

export interface TagsRebaseInput {
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

/** What the read-back compares besides the tags: everything a tags write must leave as it was. */
export function fingerprint(res: Obj): Obj {
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
    sidebar: createHash('sha1')
      .update(stableJson(res.properties ?? []))
      .digest('hex'),
  };
}

export interface RetagCheckDeps {
  /** The current approved policy of a pack (null: none approved, or not current). */
  readonly policy: (packId: string) => RetagPolicy | null;
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
  const now = input.packId ? d.policy(input.packId) : null;
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

async function pageCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
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
  const tags = list(r.res.tags);
  const side = extractSidebar(sidebarPiece(r.res.properties ?? []), input.propertiesName);
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
  if (same(tags, input.proposed))
    return {
      ...skip(SKIP_PREFIX.already_compliant, 'the page already carries the proposed array'),
      observed: fingerprint(r.res),
    };
  if (!same(tags, input.current))
    return skip(
      SKIP_PREFIX.conflicted,
      'its tags changed since the audit; never rebased onto the newer array',
      input.current.join(', '),
      tags.join(', '),
    );
  return { differences: [], observed: fingerprint(r.res) };
}

function rebaseTags(ctx: RebaseContext): RebaseResult {
  const input = ctx.input as TagsRebaseInput;
  const page = (ctx.current.entity ?? ctx.current.body ?? {}) as Obj;
  if (!ctx.current.exists)
    return {
      kind: 'skip',
      skipped: [{ item: input.item, reason: `${SKIP_PREFIX.inaccessible}the page is gone` }],
    };
  const tags = list(page.tags);
  if (same(tags, input.proposed)) return { kind: 'unchanged' };
  if (same(tags, input.current)) return { kind: 'retry', params: ctx.params };
  return {
    kind: 'skip',
    skipped: [
      {
        item: input.item,
        reason: `${SKIP_PREFIX.conflicted}its tags changed inside the lock; never rebased onto the newer array`,
        before: input.current.join(', '),
        after: tags.join(', '),
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
          path: `${input.name}: ${k === 'sidebar' ? 'sidebar (properties, links)' : k === 'parentId' || k === 'rank' ? 'parentage and place' : k} unchanged`,
          expected: before[k] ?? null,
          actual: after[k] ?? null,
        });
  } else
    diffs.push({
      path: `${input.name}: before`,
      expected: 'the page as read before the write',
      actual: '(not recorded)',
    });
  return { differences: diffs, observed: { tags } };
}

/** Registers the checks and the rebaser with the engine. Returns an unregister. */
export function registerRetagChecks(
  engine: Pick<JobEngine, 'registerAsyncChecker' | 'registerRebaser'>,
  d: RetagCheckDeps,
): () => void {
  const off = [
    engine.registerAsyncChecker(RETAG_CHECKS.policy, (ctx) => policyCheck(d, ctx)),
    engine.registerAsyncChecker(RETAG_CHECKS.page, pageCheck),
    engine.registerAsyncChecker(RETAG_CHECKS.verify, verifyCheck),
    engine.registerRebaser(RETAG_REBASER, rebaseTags),
  ];
  return () => {
    for (const f of off) f();
  };
}
