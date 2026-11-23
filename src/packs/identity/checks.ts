/**
 * `arkona_identity_reconcile`'s checks inside its job (v3 F5c, ADR 0069, H6). Each character is an item; every check
 * and rebaser here skips only its own item, so one character that changed meanwhile never stops the others.
 *
 * - **`identity.page`** (the item's first step): a fresh read of the identity page (`getResource`). Gone or unreadable:
 *   skipped (`inaccessible:`). Renamed since the plan, or its sidebar not at the `factsVersion` the plan was made from:
 *   skipped (`conflicted:`, nothing of the item written; read it again). The read is kept as the page's "before" for the
 *   tags' read-back.
 * - **`identity.facts`** (each fact write's rebaser, asked only on a conflict inside the lock): never rebased onto a newer
 *   sidebar: the rest of the item is skipped (`conflicted:`).
 * - **`identity.tags`** (the tag write's rebaser, asked every time inside the page's lock on the read the write makes
 *   anyway): the page still has its planned name; the approved tagging policy is still the plan's (else `held:`, the
 *   facts stay written); its tags are exactly those read when planning (written), already the planned array (nothing to
 *   send), or anything else (`conflicted:`, never written over).
 * - **`identity.tagsVerify`** (the tags' read-back): the exact array, in order, and the name, aliases, parent, place,
 *   flags and documents as read before the write (the sidebar is the facts' own read-back's).
 */
import type { JobEngine } from '../../jobs/index.js';
import type { RegisteredCheckContext, RegisteredCheckResult } from '../../jobs/internal-steps.js';
import type { RebaseContext, RebaseResult } from '../../jobs/rebase.js';
import { stableJson, type StateDifference } from '../../jobs/sidebar-state.js';
import { factsVersionFrom } from '../../facts/version.js';
import type { RetagPolicy } from '../retag/engine.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);

export const IDENTITY_CHECKS = { page: 'identity.page', tagsVerify: 'identity.tagsVerify' } as const;
export const IDENTITY_REBASERS = { facts: 'identity.facts', tags: 'identity.tags' } as const;

/** The prefixes of a skipped item's reason, by what they record. */
export const IDENTITY_SKIP = {
  inaccessible: 'inaccessible: ',
  conflicted: 'conflicted: ',
  held: 'held: ',
} as const;

export interface PageCheckInput {
  readonly pageId: string;
  readonly name: string;
  readonly item: string;
  readonly factsVersion: string;
}

export interface TagsRebaseInput {
  readonly item: string;
  readonly pageId: string;
  readonly name: string;
  readonly current: readonly string[];
  readonly proposed: readonly string[];
  readonly packId: string;
  readonly digest: string;
}

export interface TagsVerifyInput {
  readonly pageId: string;
  readonly name: string;
  readonly proposed: readonly string[];
  readonly beforeLabel: string;
}

export interface IdentityCheckDeps {
  /** The approved tagging policy now (null: none approved, or not current). */
  readonly policy: (packId: string, projectId: string) => RetagPolicy | null;
}

/** What the tags' read-back compares besides the tags (never the sidebar: the facts changed it on purpose). */
function fingerprint(res: Obj): Obj {
  const docs = (Array.isArray(res.documents) ? (res.documents as unknown[]) : []).filter(isObj).map((d) => ({
    id: d.id ?? null,
    name: d.name ?? null,
    type: d.type ?? null,
    rank: d.rank ?? null,
    isHidden: d.isHidden ?? null,
    deletedAt: d.deletedAt ?? null,
  }));
  return {
    name: res.name ?? null,
    aliases: list(res.aliases),
    parentId: res.parentId ?? null,
    rank: res.rank ?? null,
    isHidden: res.isHidden ?? null,
    isLocked: res.isLocked ?? null,
    documents: docs,
  };
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
      return { ok: false, why: `the page cannot be read (${typeof code === 'string' ? code : String(status)})` };
    throw e; // a budget or restart wait: the check is parked and runs again
  }
}

async function pageCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as PageCheckInput;
  const skip = (reason: string, before?: string | null, after?: string | null): RegisteredCheckResult => ({
    differences: [],
    skipped: [
      {
        item: input.item,
        reason,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        where: input.name,
      },
    ],
  });
  const r = await readResource(ctx, input.pageId);
  if (!r.ok) return skip(`${IDENTITY_SKIP.inaccessible}${r.why}`);
  if (typeof r.res.name === 'string' && r.res.name !== input.name)
    return skip(
      `${IDENTITY_SKIP.conflicted}renamed since it was read; nothing of this character was written (read it again)`,
      input.name,
      r.res.name,
    );
  const now = factsVersionFrom(input.pageId, r.res).version;
  if (now !== input.factsVersion)
    return skip(
      `${IDENTITY_SKIP.conflicted}FACTS_STALE: its sidebar changed since it was read (factsVersion ${input.factsVersion}, now ${now}); nothing of this character was written (read it again and redo it)`,
      input.factsVersion,
      now,
    );
  return { differences: [], observed: fingerprint(r.res) };
}

/** A fact write that met a changed sidebar inside its lock: never rebased onto the newer state. */
function rebaseFacts(ctx: RebaseContext): RebaseResult {
  const input = ctx.input as { item: string; name: string };
  return {
    kind: 'skip',
    skipped: [
      {
        item: input.item,
        reason: `${IDENTITY_SKIP.conflicted}its sidebar changed meanwhile (seen inside the lock); the rest of this character was not written (read it again)`,
        where: input.name,
      },
    ],
  };
}

function rebaseTags(d: IdentityCheckDeps, ctx: RebaseContext): RebaseResult {
  const input = ctx.input as TagsRebaseInput;
  const skip = (reason: string, before?: string | null, after?: string | null): RebaseResult => ({
    kind: 'skip',
    skipped: [
      {
        item: input.item,
        reason,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        where: input.name,
      },
    ],
  });
  if (!ctx.current.exists) return skip(`${IDENTITY_SKIP.inaccessible}the page is gone`);
  const page = (ctx.current.entity ?? ctx.current.body ?? {}) as Obj;
  if (typeof page.name === 'string' && page.name !== input.name)
    return skip(`${IDENTITY_SKIP.conflicted}renamed meanwhile; the tags were not written`, input.name, page.name);
  const policy = d.policy(input.packId, ctx.projectId);
  if (!policy || policy.digest !== input.digest)
    return skip(
      `${IDENTITY_SKIP.held}the tagging policy changed since the plan (${policy ? `digest ${policy.digest.slice(0, 12)}` : 'no approved policy now'}); the facts stay written, the tags were not (reconcile again)`,
      input.digest.slice(0, 12),
      policy ? policy.digest.slice(0, 12) : null,
    );
  const tags = list(page.tags);
  if (same(tags, input.proposed)) return { kind: 'unchanged' };
  if (same(tags, input.current)) return { kind: 'retry', params: ctx.params };
  return skip(
    `${IDENTITY_SKIP.conflicted}its tags changed since they were read; never written over (the facts stay written)`,
    input.current.join(', '),
    tags.join(', '),
  );
}

async function tagsVerify(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as TagsVerifyInput;
  const src = ctx.from.before;
  const before = isObj(src) && isObj(src.observed) && isObj(src.observed[input.beforeLabel])
    ? (src.observed[input.beforeLabel] as Obj)
    : null;
  const r = await readResource(ctx, input.pageId);
  if (!r.ok) return { differences: [{ path: `${input.name}: page`, expected: 'readable', actual: r.why }] };
  const diffs: StateDifference[] = [];
  const tags = list(r.res.tags);
  if (!same(tags, input.proposed))
    diffs.push({ path: `${input.name}: tags (in order)`, expected: input.proposed, actual: tags });
  if (before) {
    const after = fingerprint(r.res);
    for (const k of ['name', 'aliases', 'parentId', 'rank', 'isHidden', 'isLocked', 'documents'] as const)
      if (stableJson(after[k] ?? null) !== stableJson(before[k] ?? null))
        diffs.push({ path: `${input.name}: ${k} unchanged`, expected: before[k] ?? null, actual: after[k] ?? null });
  } else
    diffs.push({ path: `${input.name}: before`, expected: 'the page as read before the write', actual: '(not recorded)' });
  return { differences: diffs, observed: { tags } };
}

/** Registers the checks and rebasers with the engine. Returns an unregister. */
export function registerIdentityChecks(
  engine: Pick<JobEngine, 'registerAsyncChecker' | 'registerRebaser'>,
  d: IdentityCheckDeps,
): () => void {
  const off = [
    engine.registerAsyncChecker(IDENTITY_CHECKS.page, pageCheck),
    engine.registerAsyncChecker(IDENTITY_CHECKS.tagsVerify, tagsVerify),
    engine.registerRebaser(IDENTITY_REBASERS.facts, rebaseFacts),
    engine.registerRebaser(IDENTITY_REBASERS.tags, (ctx) => rebaseTags(d, ctx)),
  ];
  return () => {
    for (const f of off) f();
  };
}
