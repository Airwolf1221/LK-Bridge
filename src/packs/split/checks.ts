/**
 * v3 F3e (ADR 0059): `arkona_split_owner`'s checks and rebasers inside its job (registered with the engine at start).
 *
 * - **`split.source`** (the job's first check, run again by Resume): the source page is there and not archived; each
 *   approved item's blocks are either all there exactly as planned (not moved yet) or all gone with the item's own new
 *   blocks in their place (moved by this job); no block has been added to the source since the plan (coverage would no
 *   longer hold). Anything else refuses before a write, with what changed.
 * - **`split.destinations`** (after the destinations are written, BEFORE the source is touched: "verify their coverage,
 *   metadata, links, and boundaries before removing the old full definitions"): each approved item's blocks are in its
 *   destination, by their ids, with their text unchanged; each new page's Scope and Reference Type are set.
 * - **`split.verify`** (the job's last check: phase 1's verification, which phase 2 waits for): a direct re-read of the
 *   affected graph: every original block in exactly one place (interface summaries aside), the new pages' Scope and
 *   Reference Type, every remapped Dependency, and, for a source to be retired, that no remapped page still depends on
 *   it. A difference stops the job (Resume and Revert stay available), so phase 2 is never proposed on a failed split.
 *
 * The three writes inside the lock are rebasers asked every time their write runs (`rebase.always`), on the document as
 * read inside the lock, and again after a 412: the **source edit** of an item (core: changed meanwhile stops the job,
 * resumable; already done sends nothing), the **append** to an existing owner (re-applied to the page as it is now: the
 * F3d.1 rebase on conflict; already there sends nothing), and a new page's **routing line** (no routing section now:
 * that line's item is skipped and listed).
 */
import type { JobEngine } from '../../jobs/engine.js';
import type { RegisteredCheckContext, RegisteredCheckResult } from '../../jobs/internal-steps.js';
import type { RebaseContext, RebaseResult } from '../../jobs/rebase.js';
import { textKey } from '../engine/text.js';
import {
  altId,
  applyAppend,
  applyRoute,
  applySourceEdit,
  blockText,
  contentProblems,
  textPrint,
  type AppendInput,
  type ContentCheckInput,
  type ContentProblem,
  type RouteInput,
  type SourceEditInput,
} from './blocks.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const SPLIT_CHECKS = {
  source: 'split.source',
  destinations: 'split.destinations',
  verify: 'split.verify',
} as const;

export const SPLIT_REBASERS = {
  source: 'split.source',
  append: 'split.append',
  route: 'split.route',
} as const;

/** A destination's page and, when known when the plan was made, its main document. */
export interface DestRef {
  readonly resourceId: string;
  readonly documentId: string | null;
  readonly name: string;
  readonly isNew: boolean;
}

export interface SourceCheckInput {
  readonly resourceId: string;
  readonly documentId: string;
  readonly name: string;
  /** Every top-level block of the source as planned. */
  readonly known: readonly string[];
  /** Each item's edit (trimmed by the selection). */
  readonly moves: readonly SourceEditInput[];
}

export interface DestinationsCheckInput {
  readonly moves: readonly {
    readonly item: string;
    readonly dest: DestRef;
    readonly blocks: readonly { readonly id: string; readonly text: string; readonly excerpt: string }[];
  }[];
  readonly newPages: readonly {
    readonly item: string;
    readonly resourceId: string;
    readonly name: string;
    readonly property: string;
    readonly keys: readonly string[];
  }[];
}

export interface VerifyCheckInput extends ContentCheckInput {
  readonly dests: readonly (DestRef & { readonly item: string })[];
  readonly newPages: DestinationsCheckInput['newPages'];
  /** Remapped Dependencies: the page now depends on the destination (and no longer on the source unless kept). */
  readonly remaps: readonly {
    readonly item: string;
    readonly pageId: string;
    readonly name: string;
    readonly dest: string;
    readonly keepSource: boolean;
  }[];
  readonly dependencies: string;
  readonly retire: boolean;
}

// ============================================================================================ reading

/** The main page document of a page as read (`Main` of type page or blank, else the only page document). */
export function mainDocumentOf(resource: unknown): string | null {
  const docs = isObj(resource) && Array.isArray(resource.documents) ? (resource.documents as unknown[]) : [];
  const live = docs.filter(isObj).filter((d) => !d.deletedAt);
  const main =
    live.find((d) => d.name === 'Main' && (d.type === 'page' || d.type === 'blank')) ??
    (live.filter((d) => d.type === 'page').length === 1 ? live.find((d) => d.type === 'page') : undefined);
  return str(main?.id);
}

const blocksOf = (body: unknown): Obj[] =>
  isObj(body) && Array.isArray(body.blocks) ? (body.blocks as unknown[]).filter(isObj) : [];

/** A key-value property's row values as read (`PROPERTIES`), by key. */
function rowsOf(resource: unknown, property: string): Map<string, string> {
  const out = new Map<string, string>();
  const props =
    isObj(resource) && Array.isArray(resource.properties) ? (resource.properties as unknown[]) : [];
  for (const p of props) {
    if (!isObj(p) || p.kind !== 'keyValue' || textKey(str(p.title) ?? '') !== textKey(property)) continue;
    for (const r of Array.isArray(p.rows) ? (p.rows as unknown[]) : []) {
      if (!isObj(r) || typeof r.key !== 'string') continue;
      const v = (Array.isArray(r.content) ? (r.content as unknown[]) : [])
        .map((x) =>
          isObj(x)
            ? typeof x.text === 'string'
              ? x.text
              : isObj(x.mention)
                ? (str(x.mention.text) ?? str(x.mention.resourceId) ?? '')
                : ''
            : '',
        )
        .join('')
        .trim();
      out.set(textKey(r.key), v);
    }
  }
  return out;
}

/** The pages a link collection lists (`Dependencies`), as read. */
function collectionOf(resource: unknown, title: string): string[] {
  const props =
    isObj(resource) && Array.isArray(resource.properties) ? (resource.properties as unknown[]) : [];
  for (const p of props) {
    if (!isObj(p) || textKey(str(p.title) ?? '') !== textKey(title)) continue;
    if (p.kind !== 'resourceCollection' && p.kind !== 'resourceLink') continue;
    return (Array.isArray(p.items) ? (p.items as unknown[]) : [])
      .filter(isObj)
      .map((i) => str(i.resourceId))
      .filter((x): x is string => x !== null);
  }
  return [];
}

/** A destination's main document as read now (a new page's is found from its resource). */
async function destinationDoc(
  ctx: RegisteredCheckContext,
  d: DestRef,
): Promise<{ blocks: Obj[]; resource: unknown } | { gone: string }> {
  const r = await ctx.read('getResource', { path: { resourceId: d.resourceId } });
  if (!r.exists) return { gone: `${d.name} is not there` };
  const docId = d.documentId ?? mainDocumentOf(r.body);
  if (!docId) return { gone: `${d.name} has no main page document` };
  const b = await ctx.read('getDocumentBlocks', { path: { resourceId: d.resourceId, documentId: docId } });
  if (!b.exists) return { gone: `${d.name}'s main document is not there` };
  return { blocks: blocksOf(b.body), resource: r.body };
}

const problemLine = (p: ContentProblem) =>
  `${p.problem}: “${p.text.slice(0, 80)}” (block ${p.block}) in ${p.where}`;

// ============================================================================================ the checks

/** The job's first check (see the module comment). */
export async function sourceCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as SourceCheckInput;
  const r = await ctx.read('getResource', { path: { resourceId: input.resourceId } });
  const name = str((r.body as Obj | null)?.name);
  if (!r.exists || name === null)
    return {
      differences: [],
      refusal: {
        code: 'SPLIT_SOURCE_GONE',
        message: `The page this split takes its material from (${input.name}) is gone. Nothing was written.`,
      },
    };
  if (/^\[BARC\]/.test(name))
    return {
      differences: [],
      refusal: {
        code: 'SPLIT_SOURCE_ARCHIVED',
        message: `${input.name} has been archived since the split was planned (now “${name}”). Nothing was written.`,
      },
    };
  const d = await ctx.read('getDocumentBlocks', {
    path: { resourceId: input.resourceId, documentId: input.documentId },
  });
  if (!d.exists)
    return {
      differences: [],
      refusal: {
        code: 'SPLIT_SOURCE_GONE',
        message: `${input.name}'s main document is gone. Nothing was written.`,
      },
    };
  const blocks = blocksOf(d.body);
  const problems: string[] = [];
  const states: Record<string, string> = {};
  for (const m of input.moves) {
    const o = applySourceEdit(blocks, m);
    states[m.item] = o.state === 'apply' ? 'to move' : o.state;
    if (o.state === 'changed') problems.push(`${m.where}: ${o.why}`);
  }
  const ours = new Set([
    ...input.known,
    ...input.moves.flatMap((m) => m.inserts.flatMap((g) => g.blocks.map((b) => str(b.id) ?? ''))),
  ]);
  const added = blocks.filter((b) => !ours.has(str(b.id) ?? ''));
  if (added.length > 0)
    problems.push(
      `${added.length} block${added.length === 1 ? ' was' : 's were'} added to ${input.name} since the plan (“${blockText(added[0]!).slice(0, 80)}”): the destination map no longer covers every block`,
    );
  if (problems.length > 0)
    return {
      differences: [],
      refusal: {
        code: 'SPLIT_SOURCE_CHANGED',
        message: `${input.name} changed since the split was planned, so it cannot be split as the owner approved it: ${problems.join('; ')}. Nothing more was written; plan the split again from the page as it is (Resume continues once it is as planned).`,
        details: { problems },
      },
    };
  return { differences: [], observed: { items: states }, version: str((d.body as Obj | null)?.version) };
}

/** After the destinations are written, before the source is touched (see the module comment). */
export async function destinationsCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as DestinationsCheckInput;
  const problems: string[] = [];
  const docs = new Map<string, { blocks: Obj[]; resource: unknown } | { gone: string }>();
  const docOf = async (d: DestRef) => {
    let x = docs.get(d.resourceId);
    if (!x) {
      x = await destinationDoc(ctx, d);
      docs.set(d.resourceId, x);
    }
    return x;
  };
  for (const m of input.moves) {
    const x = await docOf(m.dest);
    if ('gone' in x) {
      problems.push(x.gone);
      continue;
    }
    const byId = new Map(x.blocks.map((b) => [str(b.id) ?? '', b]));
    for (const b of m.blocks) {
      const found = byId.get(b.id) ?? byId.get(altId(m.item, b.id));
      if (!found) problems.push(`${m.dest.name} lacks “${b.excerpt}” (block ${b.id})`);
      else if (textPrint(found) !== b.text)
        problems.push(`${m.dest.name} holds “${b.excerpt}” changed (block ${b.id}): not verbatim`);
    }
  }
  for (const p of input.newPages) {
    const r = await ctx.read('getResource', { path: { resourceId: p.resourceId } });
    if (!r.exists) {
      problems.push(`${p.name} was not made`);
      continue;
    }
    const rows = rowsOf(r.body, p.property);
    for (const k of p.keys) if ((rows.get(textKey(k)) ?? '') === '') problems.push(`${p.name} has no ${k}`);
  }
  if (problems.length > 0)
    return {
      differences: [],
      refusal: {
        code: 'SPLIT_DESTINATIONS_UNVERIFIED',
        message: `The new and extended owners do not hold what the split moves into them (${problems.slice(0, 8).join('; ')}${problems.length > 8 ? `; and ${problems.length - 8} more` : ''}). The source was NOT touched: nothing has left it. Fix the destinations and Resume, or Revert.`,
        details: { problems },
      },
    };
  return { differences: [], observed: { destinations: input.moves.length, newPages: input.newPages.length } };
}

/** Phase 1's verification (see the module comment). */
export async function verifyCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as VerifyCheckInput;
  const problems: string[] = [];
  const docs = new Map<string, { name: string; blocks: Obj[] }>();
  const src = await ctx.read('getDocumentBlocks', {
    path: { resourceId: input.source.resourceId, documentId: input.source.documentId },
  });
  if (!src.exists) problems.push(`${input.source.name}'s main document is gone`);
  else docs.set(input.source.resourceId, { name: input.source.name, blocks: blocksOf(src.body) });
  for (const d of input.dests) {
    if (docs.has(d.resourceId)) continue;
    const x = await destinationDoc(ctx, d);
    if ('gone' in x) problems.push(x.gone);
    else docs.set(d.resourceId, { name: d.name, blocks: x.blocks });
  }
  const content = contentProblems(input, docs);
  problems.push(...content.map(problemLine));
  for (const p of input.newPages) {
    const r = await ctx.read('getResource', { path: { resourceId: p.resourceId } });
    if (!r.exists) {
      problems.push(`${p.name} is not there`);
      continue;
    }
    const rows = rowsOf(r.body, p.property);
    for (const k of p.keys) if ((rows.get(textKey(k)) ?? '') === '') problems.push(`${p.name} has no ${k}`);
  }
  for (const m of input.remaps) {
    const r = await ctx.read('getResource', { path: { resourceId: m.pageId } });
    if (!r.exists) {
      problems.push(`${m.name} (a remapped Dependency) is gone`);
      continue;
    }
    const deps = collectionOf(r.body, input.dependencies);
    if (!deps.includes(m.dest))
      problems.push(`${m.name} does not list its new owner in its ${input.dependencies}`);
    if (!m.keepSource && deps.includes(input.source.resourceId))
      problems.push(`${m.name} still lists ${input.source.name} in its ${input.dependencies}`);
  }
  if (problems.length > 0)
    return {
      differences: [],
      refusal: {
        code: 'SPLIT_VERIFY_FAILED',
        message: `Phase 1 of the split did not verify (${problems.slice(0, 8).join('; ')}${problems.length > 8 ? `; and ${problems.length - 8} more` : ''}). It stops here: nothing is retired. Resume once it is put right, or Revert.`,
        details: { problems, content },
      },
    };
  return {
    differences: [],
    observed: {
      verified: true,
      original: input.original.length,
      moved: input.moves.reduce((n, m) => n + m.blocks.length, 0),
      documents: docs.size,
      remaps: input.remaps.length,
    },
  };
}

// ============================================================================================ the rebasers

/** An item's source edit, on the source as it is now (core: changed meanwhile stops the job). */
export function rebaseSource(ctx: RebaseContext): RebaseResult {
  const input = ctx.input as SourceEditInput;
  if (!ctx.current.exists)
    return {
      kind: 'skip',
      skipped: [{ item: input.item, reason: 'the source document is gone', where: input.where }],
    };
  const o = applySourceEdit(blocksOf(ctx.current.body), input);
  if (o.state === 'done') return { kind: 'unchanged', note: { done: input.item } };
  if (o.state === 'changed')
    return {
      kind: 'skip',
      skipped: [{ item: input.item, reason: o.why, before: o.before, after: o.after, where: input.where }],
    };
  return {
    kind: 'retry',
    params: { ...ctx.params, body: { blocks: o.blocks } },
    note: { edited: input.item },
  };
}

/** An existing owner's append, on the page as it is now (the F3d.1 rebase: the same blocks under the same heading). */
export function rebaseAppend(ctx: RebaseContext): RebaseResult {
  const input = ctx.input as AppendInput;
  if (!ctx.current.exists)
    return {
      kind: 'skip',
      skipped: [{ item: input.item, reason: 'the owner page’s document is gone', where: input.where }],
    };
  const o = applyAppend(blocksOf(ctx.current.body), input);
  if (o.state === 'done') return { kind: 'unchanged', note: { done: input.item } };
  return {
    kind: 'retry',
    params: { ...ctx.params, body: { blocks: o.blocks } },
    note: {
      appended: input.blocks.length,
      ...(o.madeHeading ? { madeHeading: input.under } : {}),
      ...(Object.keys(o.renamed).length > 0 ? { idsReplaced: o.renamed } : {}),
    },
  };
}

/** A new page's routing line, in its index as it is now. */
export function rebaseRoute(ctx: RebaseContext): RebaseResult {
  const input = ctx.input as RouteInput;
  if (!ctx.current.exists)
    return {
      kind: 'skip',
      skipped: [{ item: input.item, reason: 'the index document is gone', where: input.where }],
    };
  const o = applyRoute(blocksOf(ctx.current.body), input);
  if (o.state === 'done') return { kind: 'unchanged', note: { done: input.item } };
  if (o.state === 'missing')
    return { kind: 'skip', skipped: [{ item: input.item, reason: o.why, where: input.where }] };
  return { kind: 'retry', params: { ...ctx.params, body: { blocks: o.blocks } } };
}

export function registerSplitChecks(
  engine: Pick<JobEngine, 'registerAsyncChecker' | 'registerRebaser'>,
): () => void {
  const off = [
    engine.registerAsyncChecker(SPLIT_CHECKS.source, sourceCheck),
    engine.registerAsyncChecker(SPLIT_CHECKS.destinations, destinationsCheck),
    engine.registerAsyncChecker(SPLIT_CHECKS.verify, verifyCheck),
    engine.registerRebaser(SPLIT_REBASERS.source, rebaseSource),
    engine.registerRebaser(SPLIT_REBASERS.append, rebaseAppend),
    engine.registerRebaser(SPLIT_REBASERS.route, rebaseRoute),
  ];
  return () => {
    for (const f of off) f();
  };
}
