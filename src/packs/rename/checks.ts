/**
 * v3 F3d (renames), ADR 0058: the checks a rename's job makes (the design's section 1, "one job, then verification"),
 * and, since the amendment of 18 November 2026 (ADR 0058, A), the REBASERS of its writes, registered with the job engine.
 *
 * A rename takes each page's lock only for that page's own writes (not every lock for the whole job), and re-checks
 * inside that lock: what an item edits must still be exactly there. When it is, the same change is re-applied to the
 * fresh content and version; when it is not (someone edited that exact text meanwhile), the item is SKIPPED ("changed
 * meanwhile", with a before and after excerpt) and the job carries on. Core items (the subject's own page names and the
 * identity facts of its set) are never skipped: their conflict stops the job, which stays resumable.
 *
 * Checks (`bridge.expect`):
 * - `rename.subject`: the subject still has its old name (or, resumed or a follow-up, the new one); anything else and
 *   nothing runs (`SUBJECT_RENAMED`, `SUBJECT_GONE`).
 * - `rename.resource`: a page of the set is there with its old name (or the new one): core, a difference stops the job.
 * - `rename.document`: each block the rename edits, its edits re-applied to the block as it is now (`rebaseEdits`):
 *   the bodies for `bindBody`, the items done already, the items skipped.
 * - `rename.facts`: a page's facts the rename changes still hold their old value (or the new one); the rows' version
 *   for the chain. Core (the set's identity facts): a difference stops the job; otherwise the item is skipped.
 * - `rename.asset`: an asset's (or folder's) name and folder as planned, else the item is skipped.
 * - `rename.pack`: the pack version the owner APPROVED maps the new culture or race value to its new token.
 *
 * Read-backs (`bridge.verify`): `rename.document.verify` (each approved, not skipped, occurrence shows the new name in its
 * sentence), `rename.facts.verify` (each changed fact shows its new value), `rename.asset.verify`.
 *
 * Rebasers (`StepOptions.rebase`, src/jobs/rebase.ts): `rename.block` (a block's restatements and routing lines),
 * `rename.row` (a chronology row), `rename.resource` (a page name, an alias, an identity tag: CR-2026-11-R3, R3-60, with
 * the approved token map judged again inside the tag write's lock) and `rename.factRow`.
 */
import { NON_CURRENT_AREAS } from '../../appraisal/scope.js';
import { nameKey as treeNameKey } from '../../tree/classify.js';
import type { JobEngine } from '../../jobs/engine.js';
import type {
  DocumentCheckContext,
  DocumentCheckResult,
  RegisteredCheckContext,
  RegisteredCheckResult,
} from '../../jobs/internal-steps.js';
import type { RebaseContext, RebaseResult } from '../../jobs/rebase.js';
import type { StateDifference } from '../../jobs/sidebar-state.js';
import type { SkippedItem } from '../../jobs/types.js';
import type { SiblingCompare } from '../../registry/ordering.js';
import { textKey } from '../engine/text.js';
import type { Packs } from '../service.js';
import { placeInSequence, type PlaceRename, type PlaceSibling } from './place.js';
import {
  applyEdits,
  blockOccurrences,
  deepText,
  findBlock,
  fingerprint,
  occurrencesWithSentences,
  rebaseEdits,
  renameTextRuns,
  replaceName,
  writable,
  type BlockEdit,
  type PlannedEdit,
} from './text.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const RENAME_CHECKS = {
  subject: 'rename.subject',
  resource: 'rename.resource',
  document: 'rename.document',
  documentVerify: 'rename.document.verify',
  facts: 'rename.facts',
  factsVerify: 'rename.facts.verify',
  asset: 'rename.asset',
  assetVerify: 'rename.asset.verify',
  pack: 'rename.pack',
  /** CR-2026-11-R3 (R3-29): history judged again when the job runs (D2). */
  history: 'rename.history',
} as const;

/** CR-2026-11-R3 (R3-29): the pages whose restatements the rename edits, each with its items. */
export interface HistoryCheckInput {
  /** The project's `[INDEX] Archived` (null: found by its name). */
  readonly archiveIndexId: string | null;
  readonly archiveIndexName?: string;
  readonly pages: readonly {
    readonly pageId: string;
    readonly name: string;
    readonly items: readonly string[];
  }[];
}

/** What the history check needs of the repository tree (the bridge's own view, following its own writes). */
export type TreeNodeOf = (
  projectId: string,
  pageId: string,
) => {
  readonly rawName: string;
  readonly path: { readonly ids: readonly string[]; readonly names: readonly string[] };
} | null;

const AREA_NAMES = new Map(
  NON_CURRENT_AREAS.flatMap((a) => a.names.map((n) => [treeNameKey(n), a.label] as [string, string])),
);

/**
 * CR-2026-11-R3 (R3-29): D2 again when the job runs. History was decided when the plan was made; a page archived since
 * (archive_page, which the owner may accept while the rename waits), or moved under the Legacy Canon Archive or the
 * Design References, is history now: its items are skipped, never written. Judged on the repository tree (it follows
 * the bridge's own archives and moves at once; one made in the app is seen at its next sweep). No LegendKeeper read.
 */
async function historyCheck(
  tree: TreeNodeOf | undefined,
  ctx: RegisteredCheckContext,
): Promise<RegisteredCheckResult> {
  const input = ctx.input as HistoryCheckInput;
  const skipped: SkippedItem[] = [];
  const area = (ids: readonly string[], names: readonly string[]): string | null => {
    for (let i = 0; i < ids.length; i++) {
      const name = names[i] ?? '';
      if (
        input.archiveIndexId
          ? ids[i] === input.archiveIndexId
          : treeNameKey(name) === treeNameKey(input.archiveIndexName ?? '[INDEX] Archived')
      )
        return 'it has been archived since the plan';
      if (AREA_NAMES.has(treeNameKey(name)))
        return `it has been filed under the ${AREA_NAMES.get(treeNameKey(name))!} since the plan`;
    }
    return null;
  };
  for (const p of input.pages) {
    // The page as it is now (its name and parent: one read), its ancestors from the repository tree.
    const r = await ctx.read('getResource', { path: { resourceId: p.pageId } });
    let why: string | null = null;
    if (!r.exists) why = 'its page is gone';
    else {
      const res = r.body as { name?: unknown; parentId?: unknown } | null;
      const name = typeof res?.name === 'string' ? res.name : '';
      if (/^\s*\[\s*barc\s*\]/i.test(name.normalize('NFKC'))) why = 'it has been archived since the plan';
      else if (typeof res?.parentId === 'string') {
        const parent = tree?.(ctx.projectId, res.parentId) ?? null;
        if (parent) why = area(parent.path.ids, parent.path.names);
      }
    }
    if (why)
      for (const item of p.items)
        skipped.push({
          item,
          reason: `changed meanwhile: ${why} (D2: history keeps its record)`,
          where: p.name,
        });
  }
  return { differences: [], ...(skipped.length > 0 ? { skipped } : {}) };
}

export const RENAME_REBASERS = {
  block: 'rename.block',
  row: 'rename.row',
  resource: 'rename.resource',
  factRow: 'rename.factRow',
  /** CR-2026-11-R3 (R3-33): an asset's or folder's name, judged inside the write's lock. */
  asset: 'rename.asset',
  /** CR-2026-11-R3 (R3-34): a linked timeline event's name, judged inside the write's lock. */
  event: 'rename.event',
  /** CR-2026-11-R3 (R3-36): a page's re-placing move, judged inside the move's lock. */
  place: 'rename.place',
} as const;

/**
 * CR-2026-11-R3 (R3-33): an asset (or folder) renamed: on the asset as read inside the write's lock, its old name and
 * planned folder (write), the new name already (nothing to send), or anything else: skipped, never overwritten (an
 * asset renamed or moved in the app after the job's lock-free first check).
 */
function rebaseAsset(ctx: RebaseContext): RebaseResult {
  const input = ctx.input as { names: [string, string]; folderId: string | null; item: string };
  const a = (ctx.current.entity ?? ctx.current.body ?? null) as Obj | null;
  const skip = (why: string): RebaseResult => ({
    kind: 'skip',
    skipped: [{ item: input.item, reason: `changed meanwhile: ${why}`, before: input.names[0], after: null }],
  });
  if (!ctx.current.exists || !a) return skip('the asset is gone');
  const name = str(a.name) ?? '';
  const folder = str(a.folderId) ?? str(a.parentId);
  if (input.folderId !== undefined && folder !== input.folderId)
    return skip('it was moved to another folder');
  if (name === input.names[1]) return { kind: 'unchanged' };
  if (name !== input.names[0]) return skip(`it is called “${name}” now`);
  return { kind: 'retry', params: ctx.params };
}

/**
 * CR-2026-11-R3 (R3-34): a linked event renamed with its row: on the event as read inside the write's lock, the name
 * planned (write), the new one already (nothing to send), or anything else: skipped, never overwritten.
 */
function rebaseEvent(ctx: RebaseContext): RebaseResult {
  const input = ctx.input as { before: string; after: string; item: string };
  const e = (ctx.current.entity ?? ctx.current.body ?? null) as Obj | null;
  if (!ctx.current.exists || !e)
    return {
      kind: 'skip',
      skipped: [
        {
          item: input.item,
          reason: 'changed meanwhile: the event is gone',
          before: input.before,
          after: null,
        },
      ],
    };
  const name = str(e.name) ?? '';
  if (name === input.after) return { kind: 'unchanged' };
  if (name !== input.before)
    return {
      kind: 'skip',
      skipped: [
        {
          item: input.item,
          reason: `changed meanwhile: the event is called “${name}” now`,
          before: input.before,
          after: name,
        },
      ],
    };
  return { kind: 'retry', params: ctx.params };
}

/** A parent's own sibling order (v3 F4c, ADR 0065: Narratives'), as the registry gives it; null: the ordinary rule. */
export type OrderFor = (projectId: string, parentId: string) => SiblingCompare | null;

/**
 * CR-2026-11-R3 (R3-36): a page's re-placing move after its rename: when the page is no longer under the parent the
 * plan placed it in (the owner moved it), it is left where it is: never moved back. Its rename stands.
 *
 * CR-2026-11-R3 (R3-56): a page renamed beside others of the same parent (`siblings` and `renames` in the input) has
 * its place worked out here, when the job runs: the parent's children as planned, the approved renames among them
 * (the item filter keeps only those) replayed in the job's order up to this page (src/packs/rename/place.ts). It is
 * moved beside the sibling its new name belongs next to among the names written by then, or not at all when that is
 * where it stands; never anchored on a name the owner left out as if it were written.
 */
function rebasePlace(ctx: RebaseContext, orderFor?: OrderFor): RebaseResult {
  const input = ctx.input as {
    parentId: string;
    pageId?: string;
    siblings?: PlaceSibling[];
    renames?: PlaceRename[];
  };
  const r = (ctx.current.entity ?? ctx.current.body ?? null) as Obj | null;
  if (!ctx.current.exists || !r) return { kind: 'unchanged', note: { placement: 'the page is gone' } };
  if ((str(r.parentId) ?? null) !== input.parentId)
    return {
      kind: 'unchanged',
      note: { placement: 'moved by someone else since the plan: left where it is' },
    };
  if (input.pageId && Array.isArray(input.siblings) && Array.isArray(input.renames)) {
    // A page's place depends only on the renames replayed before it (the later ones come after it).
    const placed = placeInSequence(
      input.siblings,
      input.renames,
      orderFor?.(ctx.projectId, input.parentId) ?? undefined,
    ).get(input.pageId);
    if (!placed?.moves)
      return {
        kind: 'unchanged',
        note: { placement: 'already in its place among the names written: not moved' },
      };
    const body = isObj(ctx.params.body) ? ctx.params.body : {};
    const { after: _a, before: _b, ...rest } = body;
    return {
      kind: 'retry',
      params: { ...ctx.params, body: { ...rest, parentId: input.parentId, ...placed.slot } },
    };
  }
  return { kind: 'retry', params: ctx.params };
}

/** The input of a document check: the blocks it edits, each with its fingerprint and its edits. */
export interface DocumentEditsInput {
  readonly documentId: string;
  readonly oldName: string;
  readonly newName: string;
  readonly blocks: readonly {
    readonly blockId: string;
    readonly fingerprint: string;
    readonly edits: readonly PlannedEdit[];
    /**
     * CR-2026-11-R3 (R3-25): the sentence of EVERY occurrence of the old name in the block when planned, ticked or not
     * (absent in a check planned before this release). An edit is found again by its sentence only when that sentence
     * held the name once: a quotation repeating it, left out, is never renamed in its place.
     */
    readonly sentences?: readonly string[];
    /** Where it is, for the owner. */
    readonly where?: string;
  }[];
}

/** The key a block's new body is kept under in the check's result. */
export const blockKey = (documentId: string, blockId: string) => `block:${documentId}:${blockId}`;

/**
 * A fact row's value as the rename compares it: its text runs, a mention by its custom label, and a plain mention by
 * the page it points to (its shown name follows the page's own, which the rename itself changes).
 */
export function runsValue(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return (content as unknown[])
    .map((r) =>
      !isObj(r)
        ? ''
        : typeof r.text === 'string'
          ? r.text
          : isObj(r.mention)
            ? str(r.mention.text) || `@${str(r.mention.resourceId) ?? ''}`
            : '',
    )
    .join('');
}

const skippedOf = (
  list: readonly { item: string; reason: string; before: string; after: string | null; where?: string }[],
): SkippedItem[] =>
  list.map((s) => ({
    item: s.item,
    reason: s.reason,
    before: s.before,
    after: s.after,
    ...(s.where ? { where: s.where } : {}),
  }));

function documentCheck(ctx: DocumentCheckContext): DocumentCheckResult {
  const input = ctx.input as DocumentEditsInput;
  const bodies: Record<string, unknown> = {};
  const skipped: SkippedItem[] = [];
  for (const b of input.blocks) {
    const block = findBlock(ctx.document.blocks, b.blockId);
    const r = rebaseEdits(block, {
      fingerprint: b.fingerprint,
      edits: b.edits,
      oldName: input.oldName,
      newName: input.newName,
      ...(b.sentences ? { sentences: b.sentences } : {}),
      ...(b.where ? { where: b.where } : {}),
    });
    skipped.push(...skippedOf(r.skipped));
    if (!block || (r.edits.length === 0 && r.done.length === 0)) continue;
    const next = r.edits.length > 0 ? applyEdits(block, r.edits, input.oldName, input.newName) : block;
    if (!next) {
      for (const item of r.items)
        skipped.push({
          item,
          reason: 'changed meanwhile',
          before: null,
          after: null,
          where: b.where ?? b.blockId,
        });
      continue;
    }
    bodies[blockKey(input.documentId, b.blockId)] = writable(next);
  }
  return {
    differences: [],
    bodies,
    ...(skipped.length > 0 ? { skipped } : {}),
    observed: { blocks: input.blocks.length },
  };
}

function documentVerify(ctx: DocumentCheckContext): DocumentCheckResult {
  const input = ctx.input as DocumentEditsInput;
  const differences: StateDifference[] = [];
  for (const b of input.blocks) {
    if (b.edits.length === 0) continue;
    const block = findBlock(ctx.document.blocks, b.blockId);
    if (!block) {
      differences.push({ path: `${ctx.label} ${b.blockId}`, expected: 'the block', actual: '(gone)' });
      continue;
    }
    const occ = occurrencesWithSentences(block, input.oldName, input.newName);
    const mentions = blockOccurrences(block, input.oldName, input.newName).mentions;
    const same = fingerprint(block, input.oldName, input.newName) === b.fingerprint;
    for (const e of b.edits) {
      // Unchanged apart from the rename's own edits: by its number; otherwise by its sentence (it was rebased). A mention
      // label's edit (a proposal made before the amendment) by its number.
      const ok =
        e.kind === 'mention'
          ? mentions[e.ordinal]?.isOld === false
          : same
            ? occ[e.ordinal]?.isOld === false
            : occ.some(
                (o) =>
                  !o.isOld &&
                  o.sentence ===
                    replaceName(e.sentence, input.oldName, input.newName).replace(/\s+/g, ' ').trim(),
              );
      if (!ok)
        differences.push({
          path: `${ctx.label} ${b.where ?? b.blockId}`,
          expected: replaceName(e.sentence, input.oldName, input.newName),
          actual: deepText(block).slice(0, 300),
        });
    }
  }
  return { differences };
}

async function subjectCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as { resourceId: string; oldName: string; newName: string };
  const r = await ctx.read('getResource', { path: { resourceId: input.resourceId } });
  const name = str((r.body as Obj | null)?.name);
  if (!r.exists || name === null)
    return {
      differences: [],
      refusal: {
        code: 'SUBJECT_GONE',
        message: `The page this rename is about (${input.oldName}) is gone. Nothing was written.`,
      },
    };
  if (name !== input.oldName && name !== input.newName)
    return {
      differences: [],
      refusal: {
        code: 'SUBJECT_RENAMED',
        message: `${input.oldName} is called “${name}” now: someone renamed it after this rename was planned. Nothing was written. Plan the rename again from its name now.`,
        details: { expected: input.oldName, actual: name },
      },
    };
  return { differences: [], observed: { name } };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\u0001') === [...b].sort().join('\u0001');
const sameList = (a: readonly string[], b: readonly string[]) => a.join('\u0001') === b.join('\u0001');

/**
 * A page of the subject's set: there, with its old name or the new one (core: a difference stops the job). A proposal
 * made before the amendment also names the page's aliases and tags as planned (its writes do not re-check them inside
 * their own lock): compared as before.
 */
async function resourceCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as {
    resourceId: string;
    names: string[];
    aliases?: string[][];
    tags?: string[][];
  };
  const r = await ctx.read('getResource', { path: { resourceId: input.resourceId } });
  const body = (r.body ?? {}) as Obj;
  if (!r.exists || typeof body.deletedAt === 'string')
    return { differences: [{ path: ctx.label, expected: 'the page', actual: '(gone)' }] };
  const differences: StateDifference[] = [];
  const name = str(body.name) ?? '';
  if (!input.names.includes(name))
    differences.push({
      path: `${ctx.label} name`,
      expected: input.names[0] ?? '',
      actual: `${name} (renamed meanwhile: a page of the subject's own set is core, so the job stops; resume it once the name is as planned, or plan the rename again)`,
    });
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const aliases = list(body.aliases);
  if (input.aliases && !input.aliases.some((a) => sameSet(a, aliases)))
    differences.push({ path: `${ctx.label} aliases`, expected: input.aliases[0] ?? [], actual: aliases });
  const tags = list(body.tags);
  if (input.tags && !input.tags.some((t) => sameList(t, tags)))
    differences.push({ path: `${ctx.label} tags`, expected: input.tags[0] ?? [], actual: tags });
  return { differences };
}

/** One fact a rename changes: its key, and its value before (null: the row is added) and after. */
export interface FactChangeInput {
  readonly key: string;
  readonly before: string | null;
  readonly after: string;
}

function factRows(body: unknown): Obj[] {
  const b = (body ?? {}) as { data?: unknown; rows?: unknown };
  const list = Array.isArray(b.data) ? b.data : Array.isArray(b.rows) ? b.rows : [];
  return (list as unknown[]).filter(isObj);
}

/** Each fact's value now against its plan: as before, already as after, or something else. */
function judgeFacts(
  rows: readonly Obj[],
  facts: readonly FactChangeInput[],
): { key: string; state: 'before' | 'after' | 'changed'; now: string | null; before: string | null }[] {
  return facts.map((f) => {
    const row = rows.find((r) => typeof r.key === 'string' && textKey(r.key) === textKey(f.key));
    const now = row ? runsValue(row.content) : null;
    const state =
      f.before === null
        ? row === undefined || now === f.after
          ? row === undefined
            ? 'before'
            : 'after'
          : 'changed'
        : now === f.before
          ? 'before'
          : now === f.after
            ? 'after'
            : 'changed';
    return { key: f.key, state, now, before: f.before };
  });
}

async function factsCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as {
    resourceId: string;
    propertyId: string;
    facts: FactChangeInput[];
    core?: boolean;
    item: string;
    where: string;
  };
  const r = await ctx.read('listPropertyRows', {
    path: { resourceId: input.resourceId, propertyId: input.propertyId },
  });
  const version = str((r.body as Obj | null)?.version);
  const changed = r.exists
    ? judgeFacts(factRows(r.body), input.facts).filter((j) => j.state === 'changed')
    : [];
  if (r.exists && changed.length === 0) return { differences: [], version };
  const differences: StateDifference[] = r.exists
    ? changed.map((c) => ({
        path: `${input.where}: ${c.key}`,
        expected: c.before ?? '(absent)',
        actual: c.now ?? '(absent)',
      }))
    : [{ path: input.where, expected: 'the facts', actual: '(gone)' }];
  if (input.core) return { differences };
  return {
    differences: [],
    version,
    skipped: [
      {
        item: input.item,
        reason: 'changed meanwhile',
        before: differences.map((d) => `${d.path.split(': ').at(-1)}: ${String(d.expected)}`).join('; '),
        after: differences.map((d) => `${d.path.split(': ').at(-1)}: ${String(d.actual)}`).join('; '),
        where: input.where,
      },
    ],
  };
}

async function factsVerify(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as { resourceId: string; propertyId: string; facts: FactChangeInput[] };
  const r = await ctx.read('listPropertyRows', {
    path: { resourceId: input.resourceId, propertyId: input.propertyId },
  });
  const rows = factRows(r.body);
  const differences: StateDifference[] = [];
  for (const f of input.facts) {
    const row = rows.find((x) => typeof x.key === 'string' && textKey(x.key) === textKey(f.key));
    const now = row ? runsValue(row.content) : null;
    if (now !== f.after) differences.push({ path: `${ctx.label} ${f.key}`, expected: f.after, actual: now });
  }
  return { differences };
}

async function assetCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as { assetId: string; names: string[]; folderId: string | null; item?: string };
  const r = await ctx.read('getAsset', { path: { assetId: input.assetId } });
  const body = (r.body ?? {}) as Obj;
  const differences: StateDifference[] = [];
  if (!r.exists) differences.push({ path: ctx.label, expected: 'the asset', actual: '(gone)' });
  else {
    const name = str(body.name) ?? '';
    const want = ctx.phase === 'verify' ? input.names.slice(-1) : input.names;
    if (!want.includes(name))
      differences.push({ path: `${ctx.label} name`, expected: want[0] ?? '', actual: name });
    const folder = str(body.folderId) ?? str(body.parentId);
    if (input.folderId !== undefined && folder !== input.folderId)
      differences.push({ path: `${ctx.label} folder`, expected: input.folderId, actual: folder });
  }
  // ADR 0058 amendment (A): an asset renamed or moved meanwhile is skipped (the job carries on), never overwritten.
  if (ctx.phase !== 'verify' && differences.length > 0 && input.item)
    return {
      differences: [],
      skipped: [
        {
          item: input.item,
          reason: 'changed meanwhile',
          before: input.names[0] ?? null,
          after: differences.map((d) => `${d.path}: ${String(d.actual)}`).join('; '),
          where: ctx.label,
        },
      ],
    };
  return { differences };
}

/** A culture's or race's token: the pack, its map and the (new) value the APPROVED version must map to the tag. */
export interface TokenRef {
  readonly packId: string;
  readonly map: 'culture' | 'race';
  readonly value: string;
}

/** The tag the pack version the owner APPROVED maps the value to (undefined: none, or no version approved). */
function approvedToken(packs: Pick<Packs, 'get' | 'store'>, t: TokenRef): string | undefined {
  const pack = packs.get(t.packId);
  const rules =
    pack?.approved && pack.approved.version === pack.version
      ? pack.rules
      : pack?.approved
        ? packs.store.rulesAt(pack.id, pack.approved.version)
        : null;
  return rules?.tags[t.map]?.[t.value];
}

function packCheck(packs: Pick<Packs, 'get' | 'store'>) {
  return (ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> => {
    const input = ctx.input as TokenRef & { token: string };
    const pack = packs.get(input.packId);
    const have = approvedToken(packs, input);
    if (have !== input.token)
      return Promise.resolve({
        differences: [],
        refusal: {
          code: 'PACK_TOKEN_NOT_APPROVED',
          message: `The pack version the owner approved does not map the ${input.map} “${input.value}” to the tag “${input.token}” (it maps it to ${have ? `“${have}”` : 'nothing'}). The new identity tags are not written until the owner approves the pack version holding the new token map on the Packs page; then Resume the job.`,
          details: {
            pack: input.packId,
            map: input.map,
            value: input.value,
            token: input.token,
            approved: have ?? null,
          },
        },
      });
    return Promise.resolve({ differences: [], observed: { version: pack?.approved?.version ?? null } });
  };
}

// ============================================================================================ rebasers (ADR 0058, A)

const blockOf = (body: unknown): Obj | null =>
  isObj(body) ? (isObj(body.block) ? body.block : typeof body.id === 'string' ? body : null) : null;

/** A block's restatements (or routing lines), re-applied to the block as it is now. */
function rebaseBlock(ctx: RebaseContext): RebaseResult {
  const input = ctx.input as {
    oldName: string;
    newName: string;
    fingerprint: string;
    edits: PlannedEdit[];
    sentences?: string[];
    where?: string;
  };
  const block = ctx.current.exists ? blockOf(ctx.current.body) : null;
  // CR-2026-11-R3 (R3-12): only the edits of the items this write may still apply (never one left out by the owner or
  // skipped earlier in the job), so a conflict never widens the write.
  const live = ctx.items ? new Set(ctx.items) : null;
  const mine = live ? { ...input, edits: input.edits.filter((e) => live.has(e.item)) } : input;
  const r = rebaseEdits(block, mine);
  if (r.edits.length === 0) {
    if (r.skipped.length === 0) return { kind: 'unchanged', note: { done: r.done } };
    return { kind: 'skip', skipped: skippedOf(r.skipped) };
  }
  const next = applyEdits(block!, r.edits, input.oldName, input.newName);
  if (!next)
    return {
      kind: 'skip',
      skipped: mine.edits.map((e) => ({
        item: e.item,
        reason: 'changed meanwhile',
        before: e.sentence,
        after: null,
      })),
    };
  return {
    kind: 'retry',
    params: { ...ctx.params, body: writable(next) },
    ...(r.skipped.length > 0 ? { skipped: skippedOf(r.skipped) } : {}),
    note: { rebasedItems: r.items },
  };
}

/** A chronology row: its text exactly as planned (apart from this rename's own edits), re-applied; else skipped. */
function rebaseRow(ctx: RebaseContext): RebaseResult {
  const input = ctx.input as {
    oldName: string;
    newName: string;
    fingerprint: string;
    item: string;
    before: string;
    where?: string;
  };
  const block = ctx.current.exists ? blockOf(ctx.current.body) : null;
  if (!block || fingerprint(block, input.oldName, input.newName) !== input.fingerprint)
    return {
      kind: 'skip',
      skipped: [
        {
          item: input.item,
          reason: block ? 'changed meanwhile' : 'changed meanwhile: the row is gone',
          before: input.before,
          after: block ? deepText(block).slice(0, 300) : null,
          ...(input.where ? { where: input.where } : {}),
        },
      ],
    };
  const next = renameTextRuns(block, input.oldName, input.newName);
  if (JSON.stringify(writable(block)) === JSON.stringify(next)) return { kind: 'unchanged' };
  return { kind: 'retry', params: { ...ctx.params, body: next } };
}

/**
 * A page's name (core), one alias added, or one identity tag swapped, on the page as it is now.
 *
 * CR-2026-11-R3 (R3-60): an identity tag's swap also judges, inside its write's lock, that the pack version the owner
 * APPROVED still maps the new value to the new tag (`token`): the job's first check judged it once before any write,
 * and the owner may approve another version while the job runs. When it no longer does, the tag is not written: the
 * item is skipped, saying so. (A proposal planned before this release carries no `token`: as before.)
 */
function rebaseResource(ctx: RebaseContext, packs?: Pick<Packs, 'get' | 'store'>): RebaseResult {
  const input = ctx.input as
    | { kind: 'name'; from: string; to: string; item: string }
    | { kind: 'alias'; alias: string; item: string }
    | { kind: 'tags'; from: string; to: string; item: string; token?: TokenRef };
  const page = (ctx.current.entity ?? ctx.current.body ?? {}) as Obj;
  if (!ctx.current.exists)
    return { kind: 'skip', skipped: [{ item: input.item, reason: 'changed meanwhile: the page is gone' }] };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  if (input.kind === 'name') {
    const name = str(page.name) ?? '';
    if (name === input.to) return { kind: 'unchanged' };
    if (name === input.from) return { kind: 'retry', params: ctx.params };
    return {
      kind: 'skip',
      skipped: [
        {
          item: input.item,
          reason: 'changed meanwhile: the page was renamed',
          before: input.from,
          after: name,
        },
      ],
    };
  }
  if (input.kind === 'alias') {
    const aliases = list(page.aliases);
    if (aliases.some((a) => textKey(a) === textKey(input.alias))) return { kind: 'unchanged' };
    const body = isObj(ctx.params.body) ? ctx.params.body : {};
    return {
      kind: 'retry',
      params: { ...ctx.params, body: { ...body, aliases: [...aliases, input.alias] } },
    };
  }
  const tags = list(page.tags);
  if (tags.includes(input.from)) {
    if (input.token && packs) {
      const have = approvedToken(packs, input.token);
      if (have !== input.to)
        return {
          kind: 'skip',
          skipped: [
            {
              item: input.item,
              reason: `changed meanwhile: the pack version the owner approved no longer maps the ${input.token.map} “${input.token.value}” to the tag “${input.to}” (it maps it to ${have ? `“${have}”` : 'nothing'}), so the tag is not written; the rest of this page's rename stands`,
              before: input.from,
              after: tags.join(', '),
            },
          ],
        };
    }
    const next = tags.map((t) => (t === input.from ? input.to : t));
    const body = isObj(ctx.params.body) ? ctx.params.body : {};
    return { kind: 'retry', params: { ...ctx.params, body: { ...body, tags: [...new Set(next)] } } };
  }
  if (tags.includes(input.to)) return { kind: 'unchanged' };
  return {
    kind: 'skip',
    skipped: [
      {
        item: input.item,
        reason: `changed meanwhile: the page no longer has the tag ${input.from}`,
        before: input.from,
        after: tags.join(', '),
      },
    ],
  };
}

/** One fact row: still its old value (the same write, on the current version), already the new one, or skipped. */
function rebaseFactRow(ctx: RebaseContext): RebaseResult {
  const input = ctx.input as FactChangeInput & { item: string; where?: string };
  const rows =
    isObj(ctx.current.entity) && typeof ctx.current.entity.key === 'string'
      ? [ctx.current.entity]
      : factRows(ctx.current.body);
  const [j] = judgeFacts(rows, [input]);
  if (j?.state === 'after') return { kind: 'unchanged' };
  if (j?.state === 'before' && ctx.current.exists) return { kind: 'retry', params: ctx.params };
  return {
    kind: 'skip',
    skipped: [
      {
        item: input.item,
        reason: 'changed meanwhile',
        before: `${input.key}: ${input.before ?? '(absent)'}`,
        after: `${input.key}: ${j?.now ?? '(absent)'}`,
        ...(input.where ? { where: input.where } : {}),
      },
    ],
  };
}

/** Registers the rename's checks and rebasers with the engine. Returns an unregister. */
export function registerRenameChecks(
  engine: Pick<JobEngine, 'registerAsyncChecker' | 'registerChecker' | 'registerRebaser'>,
  packs: Pick<Packs, 'get' | 'store'>,
  /** CR-2026-11-R3 (R3-29): the repository tree, for the history check (absent: history is not judged again). */
  tree?: TreeNodeOf,
  /** CR-2026-11-R3 (R3-56): a parent's own sibling order, for the re-placing moves (absent: the ordinary rule). */
  orderFor?: OrderFor,
): () => void {
  const off = [
    engine.registerAsyncChecker(RENAME_CHECKS.history, (ctx) => historyCheck(tree, ctx)),
    engine.registerAsyncChecker(RENAME_CHECKS.subject, subjectCheck),
    engine.registerAsyncChecker(RENAME_CHECKS.resource, resourceCheck),
    engine.registerChecker(RENAME_CHECKS.document, documentCheck),
    engine.registerChecker(RENAME_CHECKS.documentVerify, documentVerify),
    engine.registerAsyncChecker(RENAME_CHECKS.facts, factsCheck),
    engine.registerAsyncChecker(RENAME_CHECKS.factsVerify, factsVerify),
    engine.registerAsyncChecker(RENAME_CHECKS.asset, assetCheck),
    engine.registerAsyncChecker(RENAME_CHECKS.assetVerify, assetCheck),
    engine.registerAsyncChecker(RENAME_CHECKS.pack, packCheck(packs)),
    engine.registerRebaser(RENAME_REBASERS.block, rebaseBlock),
    engine.registerRebaser(RENAME_REBASERS.row, rebaseRow),
    engine.registerRebaser(RENAME_REBASERS.resource, (ctx) => rebaseResource(ctx, packs)),
    engine.registerRebaser(RENAME_REBASERS.factRow, rebaseFactRow),
    engine.registerRebaser(RENAME_REBASERS.asset, rebaseAsset),
    engine.registerRebaser(RENAME_REBASERS.event, rebaseEvent),
    engine.registerRebaser(RENAME_REBASERS.place, (ctx) => rebasePlace(ctx, orderFor)),
  ];
  return () => {
    for (const f of off) f();
  };
}

/** Exposed for tests. */
export const renameCheckers = { documentCheck, documentVerify };
export const renameRebasers = { rebaseBlock, rebaseRow, rebaseResource, rebaseFactRow };

/** Whether a value is a block's edits list (for the planner's own checks). */
export const isEdits = (v: unknown): v is BlockEdit[] =>
  Array.isArray(v) && v.every((e) => isObj(e) && (e.kind === 'text' || e.kind === 'mention'));
