/**
 * Restores (v2 E1a, ADR 0042; PLAN-v2 4.11): direct at scope write and as the owner's confirmed action, a proposal at
 * scope propose (v3 F12, ADR 0081; formerly always proposals, submitted with `forceProposal`), planned here from a snapshot's pieces and the page as it is now, and run by the ordinary machinery:
 * the page's job-level lock and its documents', the compare-and-swap inside the lock (If-Match for page blocks and boards,
 * a check of the features, lanes and events as planned for maps and timelines, which LegendKeeper does not version), the
 * verify step, journal pre-images, and every guard (canon, lifecycle, an approval covering only what it listed).
 *
 * Scopes:
 * - `document`: one document to its state at the snapshot (page blocks, map settings and features, timeline settings,
 *   lanes and events, board shapes, bindings and assets; a blank document's settings);
 * - `page`: every document the page had at the snapshot that it still has (documents added since are left alone, and
 *   ones deleted since are listed, to be restored one by one);
 * - `sidebar`: the facts property (PROPERTIES) and the link collections, by set_facts' planner;
 * - `deleted`: a deleted page, undeleted within LegendKeeper's soft delete (then its content follows as a second
 *   proposal), or recreated from the snapshot under its snapshot parent with its documents, content and sidebar.
 *
 * What cannot be restored exactly is said, never hidden: `unsupported` blocks are echoed by id when the page still holds
 * them, otherwise listed as lost (the API cannot write them); inline icons likewise (a page that still holds one cannot
 * be written whole at all: refused, as write_page refuses it); board pages; properties other than the facts property and
 * the link collections.
 */
import type { LmrMode } from '../jobs/lmr-hook.js';
import { ICON_FIELDS, withWriteIcon } from '../lk/icons.js';
import {
  comparableFeature,
  isLabelSizeListError,
  LABEL_SIZE_NOT_RESTORABLE,
  LABEL_SIZE_UNLISTABLE,
  normaliseFeatureBody,
} from '../maps/features.js';
import { randomBytes } from 'node:crypto';
import { expectStep, verifyStep, type ExpectCheck, type VerifyTarget } from '../jobs/internal-steps.js';
import { stableJson } from '../jobs/sidebar-state.js';
import type { LifecycleMarker, OpParams, StepSpec } from '../jobs/types.js';
import { requireOperation } from '../lk/registry.js';
import { defs } from '../lk/registry.defs.generated.js';
import { expandFacts } from '../facts/expand.js';
import { planFacts, FactsPlanError, type FactRequest, type LinkRequest } from '../facts/plan.js';
import type { PlanFigures } from './plan-estimate.js';
import { sidebarFrom } from '../facts/sidebar.js';
import { lifecycleFrom } from '../lifecycle/settings.js';
import { mintClientId } from '../jobs/ids.js';
import {
  blockIds,
  imageUrls,
  isUnwritableRun,
  stripVersions,
  unwritableBlocks,
  type DocumentPiece,
  type ResourcePiece,
  type SidebarPiece,
} from './canonical.js';
import { BLOCKWISE_CHECK, blocksHash, planBlockwise } from '../pages/blockwise.js';
import { opParams, validateBlockOp } from '../pages/blockwise-job.js';
import { documentPieceOf, listAll, type Reader } from './capture.js';
import type { PieceRow } from './db.js';
import { diffText, renderDocument, renderSidebar } from './diff.js';
import type { SnapshotService } from './service.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export type RestoreScope = 'page' | 'sidebar' | 'document' | 'deleted' | 'content';

export class RestoreError extends Error {
  override readonly name = 'RestoreError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export interface RestoreInput {
  readonly projectId: string;
  readonly pageId: string;
  readonly snapshotId: string;
  readonly scope: RestoreScope;
  readonly documentId?: string;
  /** For a deleted page: undelete (soft delete), recreate, or decide by when it was deleted (default). */
  readonly mode?: 'auto' | 'undelete' | 'recreate';
  /** For a recreated page: its original ids where LegendKeeper accepts them (default), or new ones. */
  readonly ids?: 'original' | 'new';
  /** For a recreated page whose snapshot parent is gone: where it goes instead. */
  readonly parentId?: string;
  /** v3 F3c (ADR 0051): the caller's Last Major Revision override (`auto`: the rule decides when the restore runs). */
  readonly lastMajorRevision?: LmrMode;
}

export interface PlanNote {
  readonly what: string;
  readonly where?: string;
  readonly why: string;
}

export interface RestorePlan {
  readonly scope: RestoreScope;
  readonly mode?: 'undelete' | 'recreate';
  readonly page: { readonly id: string; readonly name: string };
  readonly snapshot: { readonly id: string; readonly takenAt: number; readonly kind: string };
  readonly steps: StepSpec[];
  readonly holdLock?: { readonly resourceId: string };
  readonly holdDocuments?: readonly string[];
  readonly lifecycle?: LifecycleMarker;
  readonly summary: string;
  readonly parts: string[];
  /** Each restored piece as Markdown, before (now) and after (the snapshot), and their diff. */
  readonly pieces: {
    readonly label: string;
    readonly before: string;
    readonly after: string;
    readonly diff: string;
  }[];
  readonly lost: PlanNote[];
  readonly kept: PlanNote[];
  readonly notRestored: PlanNote[];
  readonly warnings: string[];
  readonly idMap?: Record<string, string>;
  /** After it runs, a second proposal brings the content back (an undeleted page). */
  readonly followUp?: 'content';
  readonly empty: boolean;
  readonly reads: number;
  /**
   * v2 E5.5 (backlog 16): how long the restore should take once approved (at P1, its steps one after another), and the
   * figures that rest on: the per-write duration (measured or the spacing), the tiers' effective limits, and any learned
   * operation group its steps belong to. Absent when the project has no governor now.
   */
  readonly estimate?: RestoreEstimate | null;
}

export interface RestoreEstimate {
  readonly reads: number;
  readonly writes: number;
  readonly wallClockMs: number | null;
  readonly fitsToday: boolean | null;
  readonly pacing: { readonly msPerWrite: number; readonly msPerRead: number } | null;
  readonly figures: PlanFigures | null;
}

// ============================================================================================ writable fields

/** The body fields an operation accepts, from the vendored spec (so a restore never sends a read-only field). */
export function bodyFields(opId: string): Set<string> {
  const body = (requireOperation(opId).inputJsonSchema.properties as Record<string, Obj> | undefined)?.body;
  const ref = isObj(body) && typeof body.$ref === 'string' ? body.$ref.split('/').pop()! : null;
  const def = ref ? (defs[ref] as Obj | undefined) : body;
  const props = isObj(def) && isObj(def.properties) ? def.properties : {};
  return new Set(Object.keys(props));
}

function pick(o: Obj, fields: Set<string>, drop: readonly string[] = []): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o))
    if (fields.has(k) && !drop.includes(k) && v !== undefined && v !== null) out[k] = v;
  return out;
}

const same = (a: unknown, b: unknown) => stableJson(a ?? null) === stableJson(b ?? null);

// ============================================================================================ the state at a snapshot

/** The row of a piece as it stood at the snapshot: the latest one taken at or before it (null: not there then). */
export function stateAt(
  svc: SnapshotService,
  projectId: string,
  pageId: string,
  piece: 'resource' | 'sidebar' | 'document',
  ref: string,
  snap: { id: string; takenAt: number; kind?: string },
): PieceRow | null {
  const rows = svc.index.pageHistory(projectId, pageId, {
    piece,
    ...(piece === 'document' ? { ref } : {}),
    limit: 5000,
  });
  const at = rows.filter(
    (r) => r.takenAt < snap.takenAt || r.snapshotId === snap.id || r.takenAt === snap.takenAt,
  );
  // The snapshot's own row first, then the newest before it.
  const own = at.find(
    (r) =>
      r.snapshotId === snap.id &&
      (r.piece === piece || r.piece === 'deleted' || r.piece === 'document-deleted'),
  );
  // v2 E4 (RV3-7): a full snapshot lists every page and every document it found; what it does not list was not there
  // then (a document added since, or one deleted before it). Only a change snapshot's missing piece means "not taken",
  // to be found in an older snapshot.
  if (!own && snap.kind === 'full') return null;
  const row = own ?? at[0] ?? null;
  if (!row || row.piece === 'deleted' || row.piece === 'document-deleted') return null;
  return row;
}

async function load<T>(svc: SnapshotService, row: PieceRow, what: string): Promise<T> {
  if (!row.sha256)
    throw new RestoreError(
      'SNAPSHOT_PIECE_MISSING',
      `The snapshot holds no ${what}: it could not be taken then (a partial snapshot). Choose another snapshot.`,
    );
  const v = await svc.store.getJson<T>(row.sha256);
  if (v === null)
    throw new RestoreError(
      'SNAPSHOT_PIECE_DAMAGED',
      `The stored ${what} (${row.sha256.slice(0, 12)}…) is missing or damaged in the snapshot store; nothing was planned. The Snapshots page lists the finding; choose another snapshot.`,
      { sha256: row.sha256 },
    );
  return v;
}

/**
 * v3 F2 (ADR 0049 decision 5): a deleted page's state as the newest snapshot holding it took it: its name (with its
 * prefix), parent, tags and sidebar rows. The lifecycle and canon guards judge a restore of a page deleted in the app
 * (the bridge holds no delete record of it) by it, as they would a create of that page. Null when no snapshot holds it.
 */
export async function snapshotPageState(
  svc: SnapshotService,
  projectId: string,
  pageId: string,
): Promise<{
  readonly snapshotId: string;
  readonly takenAt: number;
  readonly name: string;
  readonly parentId: string | null;
  readonly tags: readonly string[];
  readonly rows: readonly { readonly key: string; readonly content: readonly Obj[] }[];
} | null> {
  const rows = svc.index.pageHistory(projectId, pageId, { piece: 'resource', limit: 50 });
  const row = rows.find((r) => r.piece === 'resource' && r.sha256);
  if (!row?.sha256) return null;
  const res = await svc.store.getJson<Obj>(row.sha256);
  if (!res) return null;
  const sbRow = svc.index
    .pageHistory(projectId, pageId, { piece: 'sidebar', limit: 50 })
    .find((r) => r.piece === 'sidebar' && r.sha256);
  const sb = sbRow?.sha256 ? await svc.store.getJson<SidebarPiece>(sbRow.sha256) : null;
  const entry = (await svc.manifest(row.snapshotId).catch(() => null))?.pages.find((p) => p.id === pageId);
  const kv = (sb?.properties ?? []).filter((p) => p.kind === 'keyValue');
  return {
    snapshotId: row.snapshotId,
    takenAt: row.takenAt,
    name: typeof res.name === 'string' ? res.name : (row.name ?? pageId),
    parentId: typeof res.parentId === 'string' ? res.parentId : (entry?.parentId ?? null),
    tags: Array.isArray(res.tags)
      ? (res.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    rows: kv.flatMap((p) =>
      (Array.isArray(p.rows) ? (p.rows as Obj[]) : []).map((r) => ({
        key: typeof r.key === 'string' ? r.key : '',
        content: Array.isArray(r.content)
          ? (r.content as Obj[])
          : typeof r.text === 'string'
            ? [{ text: r.text }]
            : [],
      })),
    ),
  };
}

/** Every document a page had at the snapshot: its rows (live documents and ones deleted since alike). */
function documentsAt(
  svc: SnapshotService,
  projectId: string,
  pageId: string,
  snap: { id: string; takenAt: number; kind?: string },
): PieceRow[] {
  const all = svc.index.pageHistory(projectId, pageId, { piece: 'document', limit: 10_000 });
  const refs = [
    ...new Set(all.filter((r) => r.piece === 'document' || r.piece === 'document-deleted').map((r) => r.ref)),
  ];
  const out: PieceRow[] = [];
  for (const ref of refs) {
    const r = stateAt(svc, projectId, pageId, 'document', ref, snap);
    if (r) out.push(r);
  }
  return out;
}

// ============================================================================================ page blocks

/** Blocks as LegendKeeper's write schema takes them: read-only versions off, unsupported blocks by id. */
export function writeFormBlocks(
  blocks: readonly unknown[],
  liveIds: ReadonlySet<string> | null,
  lost: PlanNote[],
  where: string,
  /** v2 E4: blocks left exactly as the live page holds them (inline icons, restored block by block around them). */
  keepAsIs: ReadonlySet<string> = new Set(),
): unknown[] {
  const walk = (list: readonly unknown[]): unknown[] => {
    const out: unknown[] = [];
    for (const raw of list) {
      if (!isObj(raw)) continue;
      const b = stripVersions(raw) as Obj;
      if (b.kind === 'unsupported') {
        const id = str(b.id);
        if (id && liveIds?.has(id)) out.push({ id, kind: 'unsupported' });
        else
          lost.push({
            what: `unsupported block ${id ?? '(no id)'}`,
            where,
            why: 'content the API cannot write; it is no longer on the page, so it cannot be echoed back by id',
          });
        continue;
      }
      if (Array.isArray(b.content) && !(typeof b.id === 'string' && keepAsIs.has(b.id))) {
        const runs = b.content as unknown[];
        const kept = runs.filter((r) => !isUnwritableRun(r));
        if (kept.length !== runs.length)
          lost.push({
            what: `${runs.length - kept.length} inline icon(s) or other inline content in block ${str(b.id) ?? '?'}`,
            where,
            why: 'the API has no form for it; the block is restored without it',
          });
        b.content = kept;
      }
      if (Array.isArray(b.children)) b.children = walk(b.children as unknown[]);
      out.push(b);
    }
    return out;
  };
  return walk(blocks);
}

/** Placeholders for a block-by-block document's If-Match chain, bound to step numbers by `chainBlockwise`. */
const BLOCKWISE_FIRST = -101;
const BLOCKWISE_NEXT = -102;

/**
 * v2 E4: binds the If-Match chain of each block-by-block document of a restore job, once its steps are in order: the
 * first write chains from the check step's version of that document, each next one from the write before.
 */
export function chainBlockwise(steps: StepSpec[]): StepSpec[] {
  const checkStep = steps.findIndex(
    (s) => s.op === 'bridge.expect' && JSON.stringify(s.params).includes(BLOCKWISE_CHECK),
  );
  return steps.map((s, i) => {
    const from = s.ifMatchFrom;
    if (!from) return s;
    if (from.step === BLOCKWISE_FIRST) return { ...s, ifMatchFrom: { step: checkStep + 1, key: from.key! } };
    if (from.step === BLOCKWISE_NEXT) return { ...s, ifMatchFrom: { step: i } };
    return s;
  });
}

/**
 * v2 E4: the snapshot's blocks with each live inline-icon block put back as the page holds it now (the API cannot write
 * it). When the snapshot held it otherwise, that difference cannot be restored and is said so. A live icon block the
 * snapshot did not hold at all stays where it is (`planBlockwise` refuses a restore that would have to remove it).
 */
function keepLiveBlocks(
  target: readonly unknown[],
  live: readonly unknown[],
  ids: ReadonlySet<string>,
  notRestored: PlanNote[],
  where: string,
): unknown[] {
  const liveById = new Map<string, Obj>();
  const index = (list: readonly unknown[]): void => {
    for (const b of list) {
      if (!isObj(b)) continue;
      if (typeof b.id === 'string' && ids.has(b.id)) liveById.set(b.id, stripVersions(b) as Obj);
      if (Array.isArray(b.children)) index(b.children as unknown[]);
    }
  };
  index(live);
  const walk = (list: readonly unknown[]): unknown[] =>
    list.map((raw) => {
      if (!isObj(raw)) return raw;
      const id = str(raw.id);
      const now = id ? liveById.get(id) : undefined;
      if (now) {
        if (!same(stripVersions(raw), now))
          notRestored.push({
            what: `block ${id}`,
            where,
            why: 'it holds an inline icon, which the API cannot write: it stays as the page holds it now (change it in the LegendKeeper app)',
          });
        return now;
      }
      return Array.isArray(raw.children) ? { ...raw, children: walk(raw.children as unknown[]) } : raw;
    });
  return walk(target);
}

function liveUnsupported(blocks: readonly unknown[]): string[] {
  return unwritableBlocks(blocks)
    .filter((f) => f.what === 'unsupported' && f.blockId)
    .map((f) => f.blockId!);
}

// ============================================================================================ one live document

interface DocPlan {
  readonly writes: StepSpec[];
  readonly checks: ExpectCheck[];
  readonly verify: VerifyTarget[];
  readonly label: string;
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
}

/**
 * v2 E1a (ADR 0042 decision 9): a body written back from what was read has its icon in the write form (`fas fa-book` →
 * `book`), and a write whose icon LegendKeeper still refuses is sent again without it (its default applies; the result
 * lists it). The icon is not part of the read-back check, for the same reason.
 */
const ICON_DROP = { dropIfRefused: [...ICON_FIELDS] } as const;
const noIcon = (o: Obj): Obj => {
  const { iconGlyph: _omit, ...rest } = o;
  return rest;
};

const featureCreate = () => bodyFields('createFeature');
const featureUpdate = () => bodyFields('updateFeature');

/**
 * v2 E5.4: a feature body written back from a stored feature: the writable fields, no `labelSize` (LegendKeeper's API
 * cannot round-trip it: counted in `dropped`, listed once per map) and the icon in the write form.
 */
function featureBody(f: Obj, fields: Set<string>, dropped: { n: number }): Obj {
  const r = normaliseFeatureBody(pick(f, fields));
  if (r.dropped) dropped.n++;
  return withWriteIcon(r.body);
}

/** v2 E5.4: the one note per map for the features whose label size was left out. */
function labelSizeNote(notes: PlanNote[], map: string, dropped: { n: number }): void {
  if (dropped.n > 0)
    notes.push({
      what: `the label size of ${dropped.n} feature(s) of map ${map}`,
      where: map,
      why: `${LABEL_SIZE_NOT_RESTORABLE}; LegendKeeper's default applies`,
    });
}

/** A feature as the owner finds it: its name and id. */
const featureLabel = (f: Obj): string =>
  typeof f.name === 'string' && f.name !== '' ? `“${f.name}” (${String(f.id)})` : String(f.id);

/**
 * A map's features as the plan compares and checks them: by id, the writable fields only, without `labelSize` (v2 E5.4:
 * the bridge never writes it, so it is no difference and no reason to update).
 */
export function featureState(features: readonly unknown[]): Obj[] {
  const fields = featureCreate();
  return features
    .filter(isObj)
    .map((f) => comparableFeature(pick(f, fields)))
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
}

const EVENT_FIELDS = () => {
  const f = bodyFields('createEvent');
  f.delete('formattedStart');
  f.delete('formattedEnd');
  return f;
};

async function planDocument(
  read: Reader,
  pageId: string,
  target: DocumentPiece,
  liveDoc: Obj,
  o: {
    lost: PlanNote[];
    kept: PlanNote[];
    notRestored: PlanNote[];
    warnings: string[];
    journal: Obj;
    assetLive: (id: string) => boolean;
    hosts: readonly string[];
  },
): Promise<DocPlan> {
  const documentId = String(liveDoc.id);
  const path = { resourceId: pageId, documentId };
  const name = str(liveDoc.name) ?? documentId;
  const label = `${name} (${str(target.settings.type) ?? 'document'})`;
  const liveType = str(liveDoc.type) ?? 'blank';
  const type = str(target.settings.type) ?? 'blank';
  const writes: StepSpec[] = [];
  const checks: ExpectCheck[] = [];
  const verify: VerifyTarget[] = [];
  let current: DocumentPiece | undefined;
  try {
    current = (await documentPieceOf(read, pageId, liveDoc)) as DocumentPiece | undefined;
  } catch (e) {
    // v2 E5.4: a map LegendKeeper refuses to list cannot be planned against; say why, not the raw 400.
    if (isLabelSizeListError(e))
      throw new RestoreError('MAP_FEATURES_UNREADABLE', `${name}: ${LABEL_SIZE_UNLISTABLE}.`);
    throw e;
  }
  if (current === undefined)
    throw new RestoreError('DOCUMENT_GONE', `The document ${name} has gone; read the page again.`);
  const before = renderDocument(current);
  const after = renderDocument(target);
  if (type !== liveType && !(liveType === 'blank')) {
    o.notRestored.push({
      what: `document ${name}`,
      why: `it is a ${liveType} document now and was a ${type} document at the snapshot; LegendKeeper cannot change a document's type (restore into a new document by hand)`,
    });
    return { writes, checks, verify, label, before, after, changed: false };
  }
  const journalOperation = { ...o.journal, document: { id: documentId, name } };

  // ---- settings (name, hidden, full width; a timeline's calendar and sources; a map's image)
  const settings: Obj = {};
  for (const k of ['name', 'isHidden', 'isFullWidth'] as const)
    if (target.settings[k] !== undefined && !same(target.settings[k], liveDoc[k] ?? current.settings[k]))
      settings[k] = target.settings[k];
  if (type === 'time') {
    for (const k of ['calendarId', 'sources'] as const)
      if (target.settings[k] !== undefined && !same(target.settings[k], current.settings[k]))
        settings[k] = target.settings[k];
  }
  if (type === 'map') {
    const want = isObj(target.settings.mapImage) ? str(target.settings.mapImage.assetId) : null;
    const now = isObj(current.settings.mapImage) ? str(current.settings.mapImage.assetId) : null;
    if (want && want !== now) {
      if (o.assetLive(want)) settings.mapImage = { assetId: want };
      else
        o.notRestored.push({
          what: `the image of map ${name}`,
          why: `its asset ${want} is no longer in the library; restore the image first (restore_snapshot scope "image" is E1b's; re-upload it with upload_image), then set it with update_document`,
        });
    }
  }

  if (type === 'page') {
    const body = (await read('getDocumentBlocks', { path })) as Obj | undefined;
    if (!body) throw new RestoreError('DOCUMENT_GONE', `The document ${name} has gone; read the page again.`);
    const liveBlocks = Array.isArray(body.blocks) ? (body.blocks as unknown[]) : [];
    const icons = unwritableBlocks(liveBlocks).filter((f) => f.what === 'inline-icon');
    // v2 E4 (ADR 0046): a page holding inline icons now cannot be written back whole; it is restored block by block,
    // each icon paragraph left exactly as the page holds it (the API cannot write it).
    const iconIds = new Set(icons.map((f) => f.blockId).filter((id): id is string => id !== null));
    const live = new Set(liveUnsupported(liveBlocks));
    const targetBlocks = writeFormBlocks(
      iconIds.size > 0
        ? keepLiveBlocks(target.blocks ?? [], liveBlocks, iconIds, o.notRestored, name)
        : (target.blocks ?? []),
      live,
      o.lost,
      name,
      iconIds,
    );
    const echoed = blockIds(targetBlocks);
    for (const id of live) {
      if (echoed.has(id)) continue;
      targetBlocks.push({ id, kind: 'unsupported' });
      o.kept.push({
        what: `unsupported block ${id}`,
        where: name,
        why: 'added after the snapshot; never dropped, so it is kept, at the end of the page',
      });
    }
    for (const id of live)
      if (echoed.has(id))
        o.kept.push({
          what: `unsupported block ${id}`,
          where: name,
          why: 'echoed back by id (the page still holds it)',
        });
    const urls = imageUrls(targetBlocks, o.hosts).filter((u) => !imageUrls(liveBlocks, o.hosts).includes(u));
    if (urls.length > 0)
      o.warnings.push(
        `${name} gets back ${urls.length} image(s) it does not show now; LegendKeeper refuses an image whose asset was deleted (the write then fails and nothing changes).`,
      );
    const changedBlocks = !same(stripVersions(liveBlocks), targetBlocks);
    if (changedBlocks && iconIds.size > 0) {
      const plan = planBlockwise(stripVersions(liveBlocks) as unknown[], targetBlocks, {
        unwritable: iconIds,
        validate: (op) => validateBlockOp(pageId, documentId, op),
      });
      if (!plan.ok)
        throw new RestoreError(
          'RESTORE_NOT_WRITABLE',
          `The page ${name} holds inline icons (${[...iconIds].slice(0, 5).join(', ')}), so it is restored block by block, but not this restore: ${plan.refusal.message} Restore the rest by hand.`,
          { blocks: [...iconIds], reason: plan.refusal.reason, refused: plan.refusal.blocks },
        );
      const label = `blocks of ${documentId}`;
      checks.push({
        label,
        kind: 'document',
        resourceId: pageId,
        documentId,
        checker: BLOCKWISE_CHECK,
        input: { hash: blocksHash(liveBlocks), before: stripVersions(liveBlocks) },
      });
      plan.ops.forEach((op, n) =>
        writes.push({
          op: op.op,
          judgedInLock: true,
          params: opParams(pageId, documentId, op),
          // Bound to real step numbers when the job is put together (`chainBlockwise`).
          ifMatchFrom: n === 0 ? { step: BLOCKWISE_FIRST, key: label } : { step: BLOCKWISE_NEXT },
          journalOperation: { ...journalOperation, write: 'blocks', blockwise: true, block: op.id },
        }),
      );
      verify.push({
        kind: 'blocks',
        label: `${name} (block by block)`,
        resourceId: pageId,
        documentId,
        blocks: targetBlocks,
      });
      o.kept.push({
        what: `${iconIds.size} block(s) with inline icons`,
        where: name,
        why: 'the API cannot write them: the page is restored block by block around them, and they stay as the page holds them now',
      });
    } else if (changedBlocks) {
      writes.push({
        op: 'replaceDocumentBlocks',
        params: { path, ifMatch: str(body.version) ?? '', body: { blocks: targetBlocks } },
        verifyAfterWrite: true,
        journalOperation: { ...journalOperation, write: 'blocks' },
      });
    }
    if (Object.keys(settings).length > 0)
      writes.push({
        op: 'updateDocument',
        params: { path, body: settings },
        journalOperation: { ...journalOperation, write: 'settings' },
      });
    return { writes, checks, verify, label, before, after, changed: writes.length > 0 };
  }

  if (type === 'map') {
    const live = (current.features ?? []) as Obj[];
    const want = (target.features ?? []) as Obj[];
    const liveById = new Map(live.map((f) => [String(f.id), f]));
    const wantById = new Map(want.map((f) => [String(f.id), f]));
    const create = featureCreate();
    const update = featureUpdate();
    const depth = (f: Obj, by: Map<string, Obj>): number => {
      let d = 0;
      for (let p = str(f.parentId); p && d < 50; p = str(by.get(p)?.parentId)) d++;
      return d;
    };
    const deletes = live
      .filter((f) => !wantById.has(String(f.id)))
      .sort((a, b) => depth(b, liveById) - depth(a, liveById));
    const creates = want
      .filter((f) => !liveById.has(String(f.id)))
      .sort((a, b) => depth(a, wantById) - depth(b, wantById));
    const updates = want.filter((f) => {
      const l = liveById.get(String(f.id));
      return l && !same(comparableFeature(pick(l, update)), comparableFeature(pick(f, update)));
    });
    for (const f of deletes)
      writes.push({
        op: 'deleteFeature',
        params: { path: { ...path, featureId: String(f.id) } },
        journalOperation: { ...journalOperation, write: `delete feature ${String(f.name ?? f.id)}` },
      });
    const dropped = { n: 0 };
    for (const f of creates)
      writes.push({
        op: 'createFeature',
        params: { path, body: featureBody(f, create, dropped) },
        ...ICON_DROP,
        journalOperation: {
          ...journalOperation,
          write: `create feature ${featureLabel(f)}`,
          feature: { id: String(f.id), name: str(f.name) ?? '' },
        },
      });
    for (const f of updates) {
      const body = featureBody(f, update, dropped);
      const l = liveById.get(String(f.id))!;
      // A link or a folder the snapshot did not have is cleared (LegendKeeper takes "" for both).
      if (l.uri && !f.uri) body.uri = '';
      if (l.parentId && !f.parentId) body.parentId = '';
      writes.push({
        op: 'updateFeature',
        params: { path: { ...path, featureId: String(f.id) }, body },
        ...ICON_DROP,
        journalOperation: {
          ...journalOperation,
          write: `update feature ${featureLabel(f)}`,
          feature: { id: String(f.id), name: str(f.name) ?? '' },
        },
      });
    }
    labelSizeNote(o.notRestored, name, dropped);
    if (Object.keys(settings).length > 0)
      writes.push({
        op: 'updateDocument',
        params: { path, body: settings },
        journalOperation: { ...journalOperation, write: 'settings' },
      });
    if (writes.length > 0) {
      checks.push({
        label: `${name} features`,
        kind: 'map',
        resourceId: pageId,
        documentId,
        checker: SNAPSHOT_MAP_CHECK,
        input: { state: stableJson(featureState(live)) },
      });
      verify.push({
        label: `${name} features`,
        kind: 'mapChecked',
        resourceId: pageId,
        documentId,
        checker: SNAPSHOT_MAP_VERIFY,
        input: { state: stableJson(featureState(want)) },
      });
    }
    return { writes, checks, verify, label, before, after, changed: writes.length > 0 };
  }

  if (type === 'time') {
    const liveLanes = (current.lanes ?? []) as Obj[];
    const wantLanes = (target.lanes ?? []) as Obj[];
    const liveEvents = (current.events ?? []) as Obj[];
    const wantEvents = (target.events ?? []) as Obj[];
    const laneCreate = bodyFields('createLane');
    const laneUpdate = bodyFields('updateLane');
    const evCreate = EVENT_FIELDS();
    const evUpdate = bodyFields('updateEvent');
    evUpdate.delete('formattedStart');
    evUpdate.delete('formattedEnd');
    const liveL = new Map(liveLanes.map((l) => [String(l.id), l]));
    const wantL = new Map(wantLanes.map((l) => [String(l.id), l]));
    const liveE = new Map(liveEvents.map((e) => [String(e.id), e]));
    const wantE = new Map(wantEvents.map((e) => [String(e.id), e]));
    const w = (op: string, params: OpParams, what: string) =>
      writes.push({
        op,
        params,
        ...(op === 'createEvent' || op === 'updateEvent' ? ICON_DROP : {}),
        journalOperation: { ...journalOperation, write: what },
      });
    for (const l of wantLanes.filter((l) => !liveL.has(String(l.id))))
      w(
        'createLane',
        { path, body: { size: 'sm', ...pick(l, laneCreate) } },
        `create lane ${String(l.name ?? l.id)}`,
      );
    for (const l of wantLanes) {
      const now = liveL.get(String(l.id));
      if (!now || same(pick(now, laneUpdate), pick(l, laneUpdate))) continue;
      checks.push({
        label: `lane ${String(now.name ?? now.id)}`,
        kind: 'lane',
        resourceId: pageId,
        documentId,
        laneId: String(l.id),
        ...(str(now.name) !== null ? { name: str(now.name)! } : {}),
      });
      w(
        'updateLane',
        { path: { ...path, laneId: String(l.id) }, body: pick(l, laneUpdate) },
        `update lane ${String(l.name ?? l.id)}`,
      );
      verify.push({
        label: `lane ${String(l.name ?? l.id)}`,
        kind: 'lane',
        resourceId: pageId,
        documentId,
        laneId: String(l.id),
        ...(str(l.name) !== null ? { name: str(l.name)! } : {}),
      });
    }
    for (const e of wantEvents) {
      const now = liveE.get(String(e.id));
      if (!now) {
        checks.push({
          label: `event ${String(e.name ?? e.id)}`,
          kind: 'event',
          resourceId: pageId,
          documentId,
          eventId: String(e.id),
          present: false,
        });
        w(
          'createEvent',
          { path, body: withWriteIcon(pick(e, evCreate)) },
          `create event ${String(e.name ?? e.id)}`,
        );
      } else if (!same(pick(now, evUpdate), pick(e, evUpdate))) {
        checks.push({
          label: `event ${String(now.name ?? now.id)}`,
          kind: 'event',
          resourceId: pageId,
          documentId,
          eventId: String(e.id),
          present: true,
          fields: pick(now, evUpdate),
        });
        w(
          'updateEvent',
          { path: { ...path, eventId: String(e.id) }, body: withWriteIcon(pick(e, evUpdate)) },
          `update event ${String(e.name ?? e.id)}`,
        );
      } else continue;
      verify.push({
        label: `event ${String(e.name ?? e.id)}`,
        kind: 'event',
        resourceId: pageId,
        documentId,
        eventId: String(e.id),
        present: true,
        fields: noIcon(pick(e, evUpdate)),
      });
    }
    for (const e of liveEvents.filter((x) => !wantE.has(String(x.id)))) {
      // An event of a lane that goes is deleted with it; only events of lanes that stay are deleted one by one.
      if (!wantL.has(String(e.laneId))) continue;
      checks.push({
        label: `event ${String(e.name ?? e.id)}`,
        kind: 'event',
        resourceId: pageId,
        documentId,
        eventId: String(e.id),
        present: true,
        fields: pick(e, evUpdate),
      });
      w(
        'deleteEvent',
        { path: { ...path, eventId: String(e.id) } },
        `delete event ${String(e.name ?? e.id)}`,
      );
      verify.push({
        label: `event ${String(e.name ?? e.id)}`,
        kind: 'event',
        resourceId: pageId,
        documentId,
        eventId: String(e.id),
        present: false,
      });
    }
    for (const l of liveLanes.filter((x) => !wantL.has(String(x.id)))) {
      checks.push({
        label: `lane ${String(l.name ?? l.id)}`,
        kind: 'lane',
        resourceId: pageId,
        documentId,
        laneId: String(l.id),
        ...(str(l.name) !== null ? { name: str(l.name)! } : {}),
      });
      w(
        'deleteLane',
        { path: { ...path, laneId: String(l.id) } },
        `delete lane ${String(l.name ?? l.id)} and its events`,
      );
    }
    if (Object.keys(settings).length > 0) w('updateDocument', { path, body: settings }, 'settings');
    return { writes, checks, verify, label, before, after, changed: writes.length > 0 };
  }

  if (type === 'board') {
    const body = (await read('getBoardContent', { path })) as Obj | undefined;
    if (!body) throw new RestoreError('DOCUMENT_GONE', `The board ${name} has gone; read the page again.`);
    const want = target.content ?? {};
    const sorted = (x: unknown) =>
      (Array.isArray(x) ? (x as Obj[]) : [])
        .slice()
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    if (!same(sorted(body.pages), sorted(want.pages)))
      o.notRestored.push({
        what: `the pages of board ${name}`,
        why: 'the API cannot write a board’s pages; its shapes are restored onto the pages it has now (a shape whose page is gone is refused by LegendKeeper, and nothing is written)',
      });
    const changed =
      !same(sorted(body.shapes), sorted(want.shapes)) ||
      !same(sorted(body.bindings), sorted(want.bindings)) ||
      !same(sorted(body.assets), sorted(want.assets));
    if (changed)
      writes.push({
        op: 'replaceBoardContent',
        params: {
          path,
          ifMatch: str(body.version) ?? '',
          body: { shapes: want.shapes ?? [], bindings: want.bindings ?? [], assets: want.assets ?? [] },
        },
        journalOperation: { ...journalOperation, write: 'board content' },
      });
    if (Object.keys(settings).length > 0)
      writes.push({
        op: 'updateDocument',
        params: { path, body: settings },
        journalOperation: { ...journalOperation, write: 'settings' },
      });
    return { writes, checks, verify, label, before, after, changed: writes.length > 0 };
  }

  // A blank document: its settings only.
  if (Object.keys(settings).length > 0)
    writes.push({
      op: 'updateDocument',
      params: { path, body: settings },
      journalOperation: { ...journalOperation, write: 'settings' },
    });
  return { writes, checks, verify, label, before, after, changed: writes.length > 0 };
}

export const SNAPSHOT_MAP_CHECK = 'snapshot.map';
export const SNAPSHOT_MAP_VERIFY = 'snapshot.mapVerify';

/** The map checkers the restore jobs use (registered by the snapshot service). */
export function snapshotMapCheckers() {
  return {
    [SNAPSHOT_MAP_CHECK]: (ctx: {
      label: string;
      input: unknown;
      features: readonly Record<string, unknown>[];
    }) => {
      const want = isObj(ctx.input) ? str(ctx.input.state) : null;
      const now = stableJson(featureState(ctx.features));
      return want === now
        ? { differences: [] }
        : {
            differences: [
              {
                path: ctx.label,
                expected: 'the features as planned',
                actual: 'changed since the restore was planned',
              },
            ],
          };
    },
    [SNAPSHOT_MAP_VERIFY]: (ctx: {
      label: string;
      input: unknown;
      features: readonly Record<string, unknown>[];
    }) => {
      const want =
        isObj(ctx.input) && typeof ctx.input.state === 'string' ? (JSON.parse(ctx.input.state) as Obj[]) : [];
      const now = new Map(featureState(ctx.features).map((f) => [String(f.id), f]));
      const diffs: { path: string; expected: unknown; actual: unknown }[] = [];
      for (const f of want) {
        const l = now.get(String(f.id));
        if (!l) diffs.push({ path: `${ctx.label} ${String(f.id)}`, expected: 'present', actual: '(gone)' });
        else {
          for (const k of Object.keys(f))
            if (k !== 'rank' && !same(f[k], l[k]))
              diffs.push({ path: `${ctx.label} ${String(f.id)} ${k}`, expected: f[k], actual: l[k] ?? null });
          now.delete(String(f.id));
        }
      }
      for (const id of now.keys())
        diffs.push({ path: `${ctx.label} ${id}`, expected: 'absent', actual: 'present' });
      return { differences: diffs };
    },
  };
}

// ============================================================================================ the planner

export interface RestoreDeps {
  readonly svc: SnapshotService;
  readonly read: Reader;
  readonly projectSettings: (projectId: string) => Readonly<Record<string, unknown>>;
  /** The repository tree's node of a page (null: not in the tree, or gone). */
  readonly node: (
    projectId: string,
    id: string,
  ) => {
    id: string;
    rawName: string;
    parentId: string | null;
    rank: string | null;
    path: { ids: readonly string[] };
  } | null;
  /** The live children of a page in rank order (to place a recreated page). */
  readonly children: (projectId: string, id: string) => { id: string; rank: string | null }[];
  /** Whether an asset is in the library now (the asset tree). */
  readonly assetLive: (projectId: string, assetId: string) => boolean;
  /** When the bridge saw the page deleted (its change snapshot, or the last snapshot that had it), or null. */
  readonly now: () => number;
  /**
   * v3 F2 (ADR 0049 decision 6): the page an earlier recreate of this page from this snapshot made (its id, minted when
   * that proposal was captured), or null. A second run of the same request, or "Finish" on the dashboard, then finishes
   * it instead of making another page.
   */
  readonly recreatedTarget?: (projectId: string, pageId: string, snapshotId: string) => string | null;
}

export async function planRestore(d: RestoreDeps, input: RestoreInput): Promise<RestorePlan> {
  const svc = d.svc;
  const snapRow = svc.index.snapshot(input.snapshotId);
  if (!snapRow || snapRow.projectId !== input.projectId)
    throw new RestoreError(
      'SNAPSHOT_NOT_FOUND',
      `No snapshot ${input.snapshotId} of this project; list_snapshots lists them.`,
    );
  const snap = { id: snapRow.id, takenAt: snapRow.takenAt, kind: snapRow.kind };
  let reads = 0;
  const read: Reader = async (op, params) => {
    reads++;
    return d.read(op, params);
  };
  const lost: PlanNote[] = [];
  const kept: PlanNote[] = [];
  const notRestored: PlanNote[] = [];
  const warnings: string[] = [];
  const pieces: RestorePlan['pieces'][number][] = [];
  const nameAt = (): string => {
    // v3 F2: the page's own name (its resource piece's), never a document's.
    const rows = svc.index
      .pageHistory(input.projectId, input.pageId, { limit: 200 })
      .filter((r) => r.piece === 'resource' && r.name);
    return rows.find((r) => r.takenAt <= snap.takenAt)?.name ?? rows[0]?.name ?? input.pageId;
  };
  const res = (await read('getResource', { path: { resourceId: input.pageId } })) as Obj | undefined;
  const pageName = str(res?.name) ?? nameAt();
  const page = { id: input.pageId, name: pageName };
  const journal = { tool: 'restore_snapshot', page, snapshot: snap.id, scope: input.scope };

  if (input.scope === 'deleted') {
    // v3 F2 (ADR 0049 decision 6): a recreate of this page from this snapshot that already made its page (and stopped
    // part-way, or not): finish it, writing only what is missing. Never a second page.
    const target =
      input.mode === 'undelete'
        ? null
        : (d.recreatedTarget?.(input.projectId, input.pageId, snap.id) ?? null);
    if (target) {
      const live =
        target === input.pageId
          ? res
          : ((await read('getResource', { path: { resourceId: target } })) as Obj | undefined);
      if (live) return planFinish(d, input, { snap, targetId: target, live, read, reads: () => reads });
    }
    if (res)
      throw new RestoreError(
        'NOT_DELETED',
        `${pageName} is not deleted; restore its documents (scope "page" or "document") or its sidebar instead.`,
      );
    return planDeleted(d, input, {
      snap,
      page: { id: input.pageId, name: nameAt() },
      read,
      reads: () => reads,
    });
  }
  if (!res) {
    throw new RestoreError(
      'PAGE_DELETED',
      `${pageName} has been deleted. Restore it with scope "deleted" (it is undeleted, or recreated from the snapshot), then its content.`,
    );
  }
  if (!d.node(input.projectId, input.pageId))
    throw new RestoreError(
      'OUTSIDE_REPOSITORY',
      `${pageName} is not under the AI REPOSITORY (or the repository tree has not seen it yet).`,
    );

  // ---------------------------------------------------------------- the sidebar
  if (input.scope === 'sidebar') {
    const row = stateAt(svc, input.projectId, input.pageId, 'sidebar', '', snap);
    if (!row)
      throw new RestoreError(
        'NOT_IN_SNAPSHOT',
        `The snapshot has no sidebar of ${pageName} (no snapshot at or before it took one).`,
      );
    const target = await load<SidebarPiece>(svc, row, 'sidebar');
    const plan = await planSidebar(d, input, { page, target, read, lost, notRestored, warnings });
    pieces.push(plan.piece);
    return finish({
      scope: 'sidebar',
      page,
      snap,
      steps: plan.steps,
      holdLock: { resourceId: page.id },
      lost,
      kept,
      notRestored,
      warnings,
      pieces,
      parts: plan.parts,
      reads,
    });
  }

  // ---------------------------------------------------------------- documents
  const liveDocs = (Array.isArray(res.documents) ? (res.documents as Obj[]) : []).filter(
    (x) => typeof x.id === 'string' && x.deletedAt == null,
  );
  let wanted: PieceRow[];
  if (input.scope === 'document' || input.scope === 'page' || input.scope === 'content') {
    const at = documentsAt(svc, input.projectId, input.pageId, snap);
    if (input.scope === 'document') {
      if (!input.documentId)
        throw new RestoreError('DOCUMENT_REQUIRED', 'Scope "document" needs the document (its id or name).');
      const hit = at.filter((r) => r.ref === input.documentId || (r.name ?? '') === input.documentId);
      if (hit.length === 0)
        throw new RestoreError(
          'NOT_IN_SNAPSHOT',
          `The snapshot has no document ${input.documentId} of ${pageName}.`,
          {
            documents: at.map((r) => ({ id: r.ref, name: r.name, type: r.docType })),
          },
        );
      if (hit.length > 1)
        throw new RestoreError(
          'DOCUMENT_AMBIGUOUS',
          `${pageName} had several documents named ${input.documentId}; name it by id.`,
          {
            documents: hit.map((r) => ({ id: r.ref, name: r.name, type: r.docType })),
          },
        );
      wanted = hit;
    } else wanted = at;
  } else throw new RestoreError('INVALID_SCOPE', `Unknown scope ${String(input.scope)}.`);

  const liveById = new Map(liveDocs.map((x) => [String(x.id), x]));
  const writes: StepSpec[] = [];
  const checks: ExpectCheck[] = [];
  const verify: VerifyTarget[] = [];
  const held: string[] = [];
  let sidebarSteps: StepSpec[] = [];
  const parts: string[] = [];
  for (const r of wanted) {
    const live = liveById.get(r.ref);
    if (!live) {
      notRestored.push({
        what: `document ${r.name ?? r.ref}`,
        why:
          input.scope === 'document'
            ? 'it has been deleted since the snapshot; LegendKeeper keeps a deleted document for a while: restore it in the app (or delete_document’s journal entry), then restore its content with this tool'
            : 'deleted since the snapshot: it is not recreated by a page restore (restore it in the app, then restore it with scope "document")',
      });
      continue;
    }
    const target = await load<DocumentPiece>(svc, r, `document ${r.name ?? r.ref}`);
    const p = await planDocument(read, page.id, target, live, {
      lost,
      kept,
      notRestored,
      warnings,
      journal,
      assetLive: (id) => d.assetLive(input.projectId, id),
      hosts: svc.o.assetHosts,
    });
    const diff = diffText(p.before, p.after);
    pieces.push({ label: p.label, before: p.before, after: p.after, diff: diff.text });
    if (!p.changed) continue;
    writes.push(...p.writes);
    checks.push(...p.checks);
    verify.push(...p.verify);
    held.push(String(live.id));
    parts.push(p.label);
  }
  if (input.scope === 'page' || input.scope === 'content') {
    const atIds = new Set(wanted.map((r) => r.ref));
    for (const x of liveDocs)
      if (!atIds.has(String(x.id)))
        notRestored.push({
          what: `document ${String(x.name ?? x.id)}`,
          why: 'added after the snapshot; left as it is (a restore covers only what it lists)',
        });
  }
  if (input.scope === 'content') {
    const row = stateAt(svc, input.projectId, input.pageId, 'sidebar', '', snap);
    if (row) {
      const target = await load<SidebarPiece>(svc, row, 'sidebar');
      const plan = await planSidebar(d, input, { page, target, read, lost, notRestored, warnings });
      pieces.unshift(plan.piece);
      sidebarSteps = plan.steps;
      parts.unshift(...plan.parts);
    }
  }
  const steps: StepSpec[] = chainBlockwise([
    // The sidebar's steps first: their own check is step 1 and their writes chain from it by step number.
    ...sidebarSteps,
    ...(checks.length > 0 ? [expectStep(checks)] : []),
    ...writes,
    ...(verify.length > 0 ? [verifyStep(verify)] : []),
  ]);
  return finish({
    scope: input.scope,
    page,
    snap,
    steps,
    holdLock: { resourceId: page.id },
    ...(held.length > 0 ? { holdDocuments: held } : {}),
    lost,
    kept,
    notRestored,
    warnings,
    pieces,
    parts,
    reads,
  });
}

function finish(o: {
  scope: RestoreScope;
  mode?: 'undelete' | 'recreate';
  page: { id: string; name: string };
  snap: { id: string; takenAt: number; kind: string };
  steps: StepSpec[];
  holdLock?: { resourceId: string };
  holdDocuments?: string[];
  lifecycle?: LifecycleMarker;
  lost: PlanNote[];
  kept: PlanNote[];
  notRestored: PlanNote[];
  warnings: string[];
  pieces: RestorePlan['pieces'][number][];
  parts: string[];
  idMap?: Record<string, string>;
  followUp?: 'content';
  reads: number;
  /** v3 F2: the plan finishes a recreate that stopped part-way. */
  finishing?: boolean;
}): RestorePlan {
  const empty = !o.steps.some((s) => !s.op.startsWith('bridge.'));
  const when = new Date(o.snap.takenAt).toISOString();
  const what =
    o.scope === 'deleted'
      ? o.mode === 'undelete'
        ? 'undelete'
        : o.finishing
          ? 'finish the recreate (only what is missing)'
          : 'recreate'
      : o.scope === 'sidebar'
        ? 'sidebar'
        : o.scope === 'document'
          ? `document${o.parts.length ? ` ${o.parts[0]}` : ''}`
          : o.scope === 'content'
            ? 'content'
            : 'documents';
  // v3 F2 (ADR 0049 decision 5): the proposal names the snapshot it came from and when it was taken.
  const summary =
    `restore_snapshot on “${o.page.name}”: ${what} to the ${o.snap.kind} snapshot ${o.snap.id} (taken ${when})${
      o.lost.length ? `; ${o.lost.length} item(s) cannot be restored (listed)` : ''
    }`.slice(0, 500);
  return {
    scope: o.scope,
    ...(o.mode ? { mode: o.mode } : {}),
    page: o.page,
    snapshot: o.snap,
    steps: o.steps,
    ...(o.holdLock ? { holdLock: o.holdLock } : {}),
    ...(o.holdDocuments && o.holdDocuments.length > 0
      ? { holdDocuments: [...new Set(o.holdDocuments)] }
      : {}),
    ...(o.lifecycle ? { lifecycle: o.lifecycle } : {}),
    summary,
    parts: o.parts,
    pieces: o.pieces,
    lost: o.lost,
    kept: o.kept,
    notRestored: o.notRestored,
    warnings: o.warnings,
    ...(o.idMap ? { idMap: o.idMap } : {}),
    ...(o.followUp ? { followUp: o.followUp } : {}),
    empty,
    reads: o.reads,
  };
}

// ============================================================================================ the sidebar

async function planSidebar(
  d: RestoreDeps,
  input: RestoreInput,
  o: {
    page: { id: string; name: string };
    target: SidebarPiece;
    read: Reader;
    lost: PlanNote[];
    notRestored: PlanNote[];
    warnings: string[];
  },
): Promise<{ steps: StepSpec[]; parts: string[]; piece: RestorePlan['pieces'][number] }> {
  const settings = d.projectSettings(input.projectId);
  const title =
    typeof settings.factsPropertyName === 'string' && settings.factsPropertyName.trim() !== ''
      ? settings.factsPropertyName
      : 'PROPERTIES';
  const body = await o.read('listProperties', { path: { resourceId: o.page.id } });
  if (body === undefined) throw new RestoreError('PAGE_DELETED', `${o.page.name} has gone; read it again.`);
  const sidebar = sidebarFrom(body);
  const current = {
    properties: isObj(body) && Array.isArray(body.data) ? (body.data as Obj[]) : [],
  } as SidebarPiece;
  const before = renderSidebar(current);
  const after = renderSidebar(o.target);
  const same_ = (a: string, b: string) =>
    a.trim().toLocaleLowerCase('en-GB') === b.trim().toLocaleLowerCase('en-GB');
  const tKv = o.target.properties.filter((p) => p.kind === 'keyValue' && same_(str(p.title) ?? '', title));
  const lKv = sidebar.filter((p) => p.kind === 'keyValue' && same_(p.title, title));
  const facts: FactRequest[] = [];
  if (tKv.length === 1 && lKv.length === 1) {
    const rows = (tKv[0]!.rows as Obj[] | undefined) ?? [];
    const seen = new Set<string>();
    for (const r of rows) {
      const key = str(r.key) ?? '';
      if (seen.has(key.trim().toLowerCase())) {
        o.notRestored.push({
          what: `fact ${key}`,
          why: 'the snapshot has it twice; set_facts cannot tell the rows apart',
        });
        continue;
      }
      seen.add(key.trim().toLowerCase());
      facts.push({ key, value: Array.isArray(r.content) ? (r.content as Obj[]) : [] });
    }
    for (const r of lKv[0]!.rows ?? [])
      if (!seen.has(r.key.trim().toLowerCase())) facts.push({ key: r.key, value: null });
  } else if (tKv.length !== 0 || lKv.length !== 0) {
    o.notRestored.push({
      what: `the ${title} property`,
      why: `the page ${lKv.length === 0 ? 'has no' : tKv.length === 0 ? 'had no' : 'has or had more than one'} ${title} property; restore it by hand`,
    });
  }
  // ---- lifecycle: a restore never changes a page's state (prefix, Status, status tag)
  const lc = lifecycleFrom(settings);
  const statusKey = lc.fields.status;
  const statusNow = lKv[0]?.rows?.find((r) => same_(r.key, statusKey));
  const statusWant = facts.find((f) => same_(f.key, statusKey));
  const text = (runs: readonly Obj[] | null | undefined) =>
    (runs ?? [])
      .map((r) => (typeof r.text === 'string' ? r.text : ''))
      .join('')
      .trim();
  const nowText = statusNow ? text(statusNow.content) : '';
  const wantText = statusWant ? text(statusWant.value) : nowText;
  const lifecycleValues = [lc.status.working, lc.status.archived].map((v) => v.toLowerCase());
  if (
    nowText.toLowerCase() !== wantText.toLowerCase() &&
    (lifecycleValues.includes(nowText.toLowerCase()) || lifecycleValues.includes(wantText.toLowerCase()))
  ) {
    throw new RestoreError(
      'RESTORE_LIFECYCLE',
      `This restore would change ${o.page.name}'s Status from “${nowText || '(none)'}” to “${wantText || '(none)'}”, a lifecycle change. Restores never change a page's lifecycle state: use archive_page, unarchive_page, move_to_working or promote_page, then restore the sidebar again. Nothing was planned.`,
      { from: nowText, to: wantText },
    );
  }
  // ---- link collections
  const links: LinkRequest[] = [];
  for (const p of o.target.properties.filter(
    (x) => x.kind === 'resourceCollection' || x.kind === 'resourceLink',
  )) {
    const t = str(p.title) ?? '';
    const live = sidebar.filter(
      (x) => (x.kind === 'resourceCollection' || x.kind === 'resourceLink') && same_(x.title, t),
    );
    if (live.length !== 1) {
      o.notRestored.push({
        what: `link collection ${t}`,
        why:
          live.length === 0
            ? 'the page has no such collection now (the API cannot recreate a property on a live page’s sidebar here)'
            : 'the page has several collections of that title',
      });
      continue;
    }
    const want = ((p.items as Obj[] | undefined) ?? []).map((i) => ({
      resourceId: String(i.resourceId),
      documentId: str(i.documentId),
    }));
    const have = ((live[0]!.raw.items as Obj[] | undefined) ?? []).map((i) => ({
      resourceId: String(i.resourceId),
      documentId: str(i.documentId),
    }));
    const key = (x: { resourceId: string; documentId: string | null }) =>
      `${x.resourceId}/${x.documentId ?? ''}`;
    const add = want.filter((x) => !have.some((h) => key(h) === key(x)));
    const remove = have.filter((x) => !want.some((h) => key(h) === key(x)));
    if (add.length === 0 && remove.length === 0) continue;
    const name = (id: string) => d.node(input.projectId, id)?.rawName ?? id;
    links.push({
      title: t,
      add: add.map((x) => ({
        resourceId: x.resourceId,
        ...(x.documentId ? { documentId: x.documentId } : {}),
        name: name(x.resourceId),
      })),
      remove: remove.map((x) => ({
        resourceId: x.resourceId,
        ...(x.documentId ? { documentId: x.documentId } : {}),
        name: name(x.resourceId),
      })),
    });
    const orderChanged = !add.length && !remove.length;
    if (orderChanged) o.warnings.push(`${t}: the order of its links may differ from the snapshot`);
  }
  for (const p of o.target.properties.filter((x) => x.kind === 'unsupported')) {
    if (!sidebar.some((x) => x.id === p.id))
      o.lost.push({
        what: `unsupported property ${String(p.title ?? p.id)}`,
        why: 'the API cannot recreate it',
      });
  }
  for (const p of o.target.properties.filter(
    (x) =>
      x.kind !== 'keyValue' &&
      x.kind !== 'resourceCollection' &&
      x.kind !== 'resourceLink' &&
      x.kind !== 'unsupported',
  ))
    o.notRestored.push({
      what: `property ${String(p.title ?? p.id)} (${String(p.kind)})`,
      why: 'only the facts property and the link collections are restored',
    });
  // ---- the other key-value properties (not the facts property): their rows, by property id and row id. Each row is
  // one write (updatePropertyRow, createPropertyRow, deletePropertyRow): the engine reads its version inside the lock,
  // journals what it replaces, and the guards see it like any other sidebar write.
  const rowSteps: StepSpec[] = [];
  const rowParts = new Set<string>();
  for (const p of o.target.properties.filter(
    (x) => x.kind === 'keyValue' && !same_(str(x.title) ?? '', title),
  )) {
    const label = String(p.title ?? p.id);
    const live = current.properties.find((x) => x.id === p.id);
    if (!live || live.kind !== 'keyValue') {
      o.notRestored.push({
        what: `key-value property ${label}`,
        why: live
          ? 'a property of that id is no longer a key-value property'
          : 'the page has no such property now; restore it by hand',
      });
      continue;
    }
    const want = ((p.rows as Obj[] | undefined) ?? []).filter((r) => typeof r.id === 'string');
    const have = ((live.rows as Obj[] | undefined) ?? []).filter((r) => typeof r.id === 'string');
    const path = { resourceId: o.page.id, propertyId: String(p.id) };
    const journal = (write: string) => ({
      tool: 'restore_snapshot',
      snapshotRestore: true,
      page: { id: o.page.id, name: o.page.name },
      write,
    });
    let prev: string | null = null;
    for (const r of want) {
      const key = str(r.key) ?? '';
      const content = Array.isArray(r.content) ? (r.content as Obj[]) : [];
      if (content.some((run) => isUnwritableRun(run))) {
        o.lost.push({
          what: `${label}: ${key}`,
          where: 'sidebar',
          why: 'its value holds an inline icon or another run the API cannot write back',
        });
        prev = have.some((h) => h.id === r.id) ? String(r.id) : prev;
        continue;
      }
      const cur = have.find((h) => h.id === r.id);
      if (cur) {
        if (str(cur.key) !== key || !same(cur.content ?? [], content)) {
          rowSteps.push({
            op: 'updatePropertyRow',
            params: { path: { ...path, rowId: String(r.id) }, body: { key, content } },
            journalOperation: journal(`${label}: ${key}`),
          });
          rowParts.add(`${label}: ${key}`);
        }
        prev = String(r.id);
      } else {
        rowSteps.push({
          op: 'createPropertyRow',
          params: { path, body: { key, content, ...(prev ? { after: prev } : {}) } },
          journalOperation: journal(`${label}: ${key} (back)`),
        });
        rowParts.add(`${label}: ${key}`);
      }
    }
    for (const h of have)
      if (!want.some((r) => r.id === h.id)) {
        rowSteps.push({
          op: 'deletePropertyRow',
          params: { path: { ...path, rowId: String(h.id) } },
          journalOperation: journal(`${label}: ${String(h.key)} (removed)`),
        });
        rowParts.add(`${label}: ${String(h.key)}`);
      }
    if (want.some((r) => !have.some((h) => h.id === r.id)))
      o.warnings.push(`${label}: rows the page lost come back with new ids, after the row before them`);
    // v2 E4 (RV3-2): the first row write of each property keeps the whole property as it is now (as set_facts does),
    // so what the restore replaces is in the journal; LegendKeeper keeps no history of rows.
    const firstOfThis = rowSteps.findIndex((st) => st.params?.path?.propertyId === String(p.id));
    if (firstOfThis >= 0)
      rowSteps[firstOfThis] = { ...rowSteps[firstOfThis]!, journalPreImage: { property: live } };
  }
  let plan;
  try {
    plan = planFacts({
      resourceId: o.page.id,
      sidebar,
      propertyTitle: title,
      facts,
      links,
      templateKeys: null,
    });
  } catch (e) {
    if (e instanceof FactsPlanError) throw new RestoreError(e.code, e.message, e.details);
    throw e;
  }
  const piece = { label: 'sidebar', before, after, diff: diffText(before, after).text };
  if (plan.empty) return { steps: rowSteps, parts: rowSteps.length ? ['sidebar', ...rowParts] : [], piece };
  const job = expandFacts(plan, { id: o.page.id, name: o.page.name }, sidebar, {
    facts: 'restore',
    links: 'restore',
  });
  if (plan.facts.some((f) => f.change === 'added'))
    o.warnings.push(
      'facts the page lost since the snapshot come back at the bottom of the property (or in template order), not necessarily where they stood',
    );
  const steps = job.steps.map((s) =>
    s.journalOperation
      ? { ...s, journalOperation: { ...s.journalOperation, tool: 'restore_snapshot', snapshotRestore: true } }
      : s,
  );
  return {
    steps: [...steps, ...rowSteps],
    parts: [...job.pageParts.map((p) => (p === 'sidebar' ? 'sidebar' : p)), ...rowParts],
    piece,
  };
}

// ============================================================================================ a deleted page

async function planDeleted(
  d: RestoreDeps,
  input: RestoreInput,
  o: {
    snap: { id: string; takenAt: number; kind: string };
    page: { id: string; name: string };
    read: Reader;
    reads: () => number;
  },
): Promise<RestorePlan> {
  const svc = d.svc;
  const lost: PlanNote[] = [];
  const kept: PlanNote[] = [];
  const notRestored: PlanNote[] = [];
  const warnings: string[] = [];
  const hist = svc.index.pageHistory(input.projectId, input.pageId, { limit: 5000 });
  const resRow = stateAt(svc, input.projectId, input.pageId, 'resource', '', o.snap);
  if (!resRow)
    throw new RestoreError(
      'NOT_IN_SNAPSHOT',
      `The snapshot has no state of ${o.page.name} (it did not exist then, or was already deleted). Choose an earlier snapshot.`,
    );
  // When was it deleted? The change snapshot after the bridge's delete says; else after the last snapshot that had it.
  const deletedRow = hist.find((r) => r.piece === 'deleted');
  const lastSeen = hist.find((r) => r.piece === 'resource')?.takenAt ?? resRow.takenAt;
  const deletedAt = deletedRow?.takenAt ?? lastSeen;
  const softMs = svc.settings.softDeleteDays * 86_400_000;
  const mode: 'undelete' | 'recreate' =
    input.mode === 'undelete' || input.mode === 'recreate'
      ? input.mode
      : d.now() - deletedAt <= softMs
        ? 'undelete'
        : 'recreate';
  const pieceAfter: RestorePlan['pieces'][number][] = [];

  if (mode === 'undelete') {
    const steps: StepSpec[] = [
      {
        op: 'restoreResource',
        params: { path: { resourceId: input.pageId } },
        journalOperation: {
          tool: 'restore_snapshot',
          page: o.page,
          snapshot: o.snap.id,
          scope: 'deleted',
          mode,
        },
      },
    ];
    warnings.push(
      `It was deleted ${deletedRow ? 'on' : 'after'} ${new Date(deletedAt).toISOString()}${deletedRow ? '' : ' (when it was last seen)'}; LegendKeeper keeps a deleted page for a while (taken as ${svc.settings.softDeleteDays} days, SNAPSHOT_SOFT_DELETE_DAYS). If it has gone for good, the restore fails and nothing changes: propose it again with mode "recreate".`,
      'Pages deleted with it (a cascade) come back with it.',
    );
    return finish({
      scope: 'deleted',
      mode,
      page: o.page,
      snap: o.snap,
      steps,
      holdLock: { resourceId: input.pageId },
      lost,
      kept,
      notRestored,
      warnings,
      pieces: pieceAfter,
      parts: ['undelete', 'then its content, as a second proposal'],
      followUp: 'content',
      reads: o.reads(),
    });
  }

  // ---------------------------------------------------------------- recreate
  const resource = await load<ResourcePiece>(svc, resRow, 'page settings');
  const entry = (await svc.manifest(resRow.snapshotId))?.pages.find((p) => p.id === input.pageId);
  const parentId = input.parentId ?? entry?.parentId ?? null;
  if (!parentId || !d.node(input.projectId, parentId)) {
    throw new RestoreError(
      'RESTORE_PARENT_GONE',
      `${o.page.name}'s parent at the snapshot (${parentId ?? 'none'}) is not in the repository now. Restore the parent first, or pass parent (a page under the AI REPOSITORY) to recreate it there.`,
      { parentId },
    );
  }
  const name = str(resource.name) ?? o.page.name;
  if (/^\s*\[\s*(bwrk|barc)\s*\]/i.test(name))
    throw new RestoreError(
      'RESTORE_LIFECYCLE',
      `${name} is a ${/barc/i.test(name) ? 'Archived' : 'Working'} page. A recreated page cannot take a lifecycle state (only the lifecycle tools and the creation tools' status may); undelete it within LegendKeeper's soft delete (mode "undelete"), or recreate it by hand. Nothing was planned.`,
    );
  const parentNode = d.node(input.projectId, parentId)!;
  const lc = lifecycleFrom(d.projectSettings(input.projectId));
  if (
    [lc.workingIndexId, lc.archiveIndexId].some(
      (x) => x && (parentNode.id === x || parentNode.path.ids.includes(x)),
    )
  )
    throw new RestoreError(
      'RESTORE_LIFECYCLE',
      `${name} would be recreated inside a lifecycle area; pass parent elsewhere, or undelete it. Nothing was planned.`,
    );
  const ids = input.ids ?? 'original';
  const newId = ids === 'original' ? input.pageId : mintClientId();
  const idMap: Record<string, string> = {};
  if (newId !== input.pageId) idMap[input.pageId] = newId;
  if (ids === 'original')
    warnings.push(
      `It is recreated with its original id ${input.pageId}. LegendKeeper refuses an id any resource has used, deleted ones included (DUPLICATE_ID), so this works only once LegendKeeper has purged the old page; if the restore fails for that reason, nothing is written: propose it again with ids "new".`,
    );

  // Placement: after the live sibling that ranked just before it at the snapshot.
  const siblings = d.children(input.projectId, parentId);
  const rank = entry?.rank ?? null;
  const prev = rank ? [...siblings].filter((s) => s.rank !== null && s.rank < rank).at(-1) : siblings.at(-1);
  const placement = prev ? { after: prev.id } : siblings[0] ? { before: siblings[0].id } : {};
  const createFields = bodyFields('createResource');
  const body: Obj = {
    ...withWriteIcon(pick(resource, createFields, ['documents', 'after', 'before', 'id', 'parentId'])),
    id: newId,
    parentId,
    ...placement,
  };
  // Status tags are guarded (only the lifecycle tools add them): a recreated page gets its other tags; CANON is listed.
  const statusTags = [lc.tags.canon, lc.tags.working, lc.tags.archived].map((t) => t.toLowerCase());
  if (Array.isArray(body.tags)) {
    const tags = body.tags as string[];
    const keep = tags.filter((t) => !statusTags.includes(t.toLowerCase()));
    if (keep.length !== tags.length) {
      notRestored.push({
        what: `tag(s) ${tags.filter((t) => statusTags.includes(t.toLowerCase())).join(', ')}`,
        why: 'status tags are added only by the lifecycle tools; add CANON with promote_page or by hand',
      });
      body.tags = keep;
    }
  }
  // ---- documents: up to five with the page itself (page blocks inline), the rest one by one
  const docs = documentsAt(svc, input.projectId, input.pageId, o.snap);
  const targets: { row: PieceRow; piece: DocumentPiece }[] = [];
  for (const r of docs)
    targets.push({ row: r, piece: await load<DocumentPiece>(svc, r, `document ${r.name ?? r.ref}`) });
  const steps: StepSpec[] = [];
  const journal = {
    tool: 'restore_snapshot',
    page: { id: newId, name },
    snapshot: o.snap.id,
    scope: 'deleted',
    mode,
  };
  const first = targets.slice(0, 5);
  const inline = first.map((t) => {
    const type = str(t.piece.settings.type) ?? 'blank';
    const doc: Obj = { type, name: str(t.piece.settings.name) ?? t.row.name ?? 'Main' };
    if (type === 'time' && typeof t.piece.settings.calendarId === 'string')
      doc.calendarId = t.piece.settings.calendarId;
    if (type === 'page') doc.blocks = writeFormBlocks(t.piece.blocks ?? [], null, lost, String(doc.name));
    return doc;
  });
  if (inline.length > 0) body.documents = inline;
  steps.push({
    op: 'createResource',
    params: { body },
    ...ICON_DROP,
    journalOperation: { ...journal, write: 'the page and its first documents' },
  });
  const createStep = 1;
  const docStep = new Map<string, { step: number; from: 'id' | `documents.${number}.id` }>();
  first.forEach((t, i) => docStep.set(t.row.ref, { step: createStep, from: `documents.${i}.id` }));
  for (const t of targets.slice(5)) {
    const type = str(t.piece.settings.type) ?? 'blank';
    const b: Obj = { type, name: str(t.piece.settings.name) ?? t.row.name ?? 'Document' };
    if (type === 'time' && typeof t.piece.settings.calendarId === 'string')
      b.calendarId = t.piece.settings.calendarId;
    steps.push({
      op: 'createDocument',
      params: { path: { resourceId: newId }, body: b },
      journalOperation: { ...journal, write: `document ${String(b.name)}` },
    });
    docStep.set(t.row.ref, { step: steps.length, from: 'id' });
    if (type === 'page') {
      steps.push({
        op: 'replaceDocumentBlocks',
        params: {
          path: { resourceId: newId, documentId: t.row.ref },
          body: { blocks: writeFormBlocks(t.piece.blocks ?? [], null, lost, String(b.name)) },
        },
        bindFrom: { step: steps.length, to: 'path.documentId' },
        journalOperation: { ...journal, write: `blocks of ${String(b.name)}` },
      });
    }
  }
  const bound = (ref: string) => {
    const s = docStep.get(ref)!;
    return { step: s.step, to: 'path.documentId' as const, ...(s.from !== 'id' ? { from: s.from } : {}) };
  };
  for (const t of targets) {
    const ref = t.row.ref;
    const type = str(t.piece.settings.type) ?? 'blank';
    steps.push(
      ...documentContentSteps(
        d,
        input,
        journal,
        t,
        { resourceId: newId, documentId: ref },
        bound(ref),
        notRestored,
      ),
    );
    pieceAfter.push({
      label: `${str(t.piece.settings.name) ?? ref} (${type})`,
      before: '(deleted)',
      after: renderDocument(t.piece),
      diff: '',
    });
  }
  // ---- the sidebar: each property created as it was (property, row and item ids are the page's own: ADR 0037)
  const sbRow = stateAt(svc, input.projectId, input.pageId, 'sidebar', '', o.snap);
  if (sbRow) {
    const sb = await load<SidebarPiece>(svc, sbRow, 'sidebar');
    let prevProp: string | null = null;
    for (const prop of sb.properties) {
      if (prop.kind === 'unsupported') {
        lost.push({
          what: `unsupported property ${String(prop.title ?? prop.id)}`,
          why: 'the API cannot recreate it',
        });
        continue;
      }
      const b = Object.fromEntries(Object.entries(prop).filter(([k]) => !['rank', 'version'].includes(k)));
      if (prevProp) b.after = prevProp;
      steps.push({
        op: 'createProperty',
        params: { path: { resourceId: newId }, body: b },
        journalOperation: { ...journal, write: `property ${String(prop.title ?? prop.id)}` },
      });
      if (typeof prop.id === 'string') prevProp = prop.id;
    }
    pieceAfter.unshift({ label: 'sidebar', before: '(deleted)', after: renderSidebar(sb), diff: '' });
  }
  steps.push(
    verifyStep([
      {
        kind: 'resource',
        label: name,
        resourceId: newId,
        fields: { name },
        ...(placement.after
          ? { placement: { parentId, after: placement.after } }
          : placement.before
            ? { placement: { parentId, before: placement.before } }
            : {}),
      },
    ]),
  );
  const mentions = new Set<string>();
  for (const t of targets)
    for (const m of JSON.stringify(t.piece).matchAll(/"resourceId":"([a-z][0-9a-z]{7,23})"/g))
      if (m[1] !== input.pageId) mentions.add(m[1]!);
  const gone = [...mentions].filter((id) => !d.node(input.projectId, id));
  if (gone.length > 0)
    warnings.push(
      `It mentions or links ${gone.length} page(s) the repository tree does not hold now (${gone.slice(0, 5).join(', ')}); LegendKeeper refuses a mention of a deleted page, and then nothing is written.`,
    );
  return finish({
    scope: 'deleted',
    mode,
    page: { id: newId, name },
    snap: o.snap,
    steps,
    lost,
    kept,
    notRestored,
    warnings,
    pieces: pieceAfter,
    parts: ['recreate', `${targets.length} document(s)`, ...(sbRow ? ['sidebar'] : [])],
    idMap: {
      ...idMap,
      ...Object.fromEntries(targets.map((t) => [t.row.ref, '(a new id; see the job result)'])),
    },
    reads: o.reads(),
  });
}

/**
 * The content writes of one document of a recreated page (a map's features, a timeline's lanes and events, a board's
 * content, its settings), into `p` (the new page and document; `bind` when the document's id is bound in the job).
 * v3 F2 (ADR 0049 decision 6): `have` lists what the live document already holds (a finish of a recreate that stopped
 * part-way), which is skipped: never written twice.
 */

/**
 * v3 F2 (ADR 0049 decision 6; E4-OPEN-1): finishes a recreate that stopped part-way. The page the recreate made (its
 * id minted when that proposal was captured) is compared with the snapshot, and only what is missing is planned: a
 * document of that type and name it lacks (created, with its content), the blocks of a page document that is still
 * empty, a map's features, a timeline's lanes and events, a board's content it lacks, and the sidebar's properties it
 * lacks. Nothing is written twice, and no second page or document is made.
 */
async function planFinish(
  d: RestoreDeps,
  input: RestoreInput,
  o: {
    snap: { id: string; takenAt: number; kind: string };
    targetId: string;
    live: Obj;
    read: Reader;
    reads: () => number;
  },
): Promise<RestorePlan> {
  const svc = d.svc;
  const lost: PlanNote[] = [];
  const kept: PlanNote[] = [];
  const notRestored: PlanNote[] = [];
  const warnings: string[] = [
    'This finishes a recreate that stopped part-way: only what the page lacks is written; nothing is written twice.',
  ];
  const targetId = o.targetId;
  const name = str(o.live.name) ?? targetId;
  const journal = {
    tool: 'restore_snapshot',
    page: { id: targetId, name },
    snapshot: o.snap.id,
    scope: 'deleted',
    mode: 'recreate',
    finish: true,
  };
  const liveDocs = (Array.isArray(o.live.documents) ? (o.live.documents as Obj[]) : []).filter(
    (x) => typeof x.id === 'string' && x.deletedAt == null,
  );
  const used = new Set<string>();
  const steps: StepSpec[] = [];
  const parts: string[] = [];
  const docs = documentsAt(svc, input.projectId, input.pageId, o.snap);
  for (const r of docs) {
    const t = { row: r, piece: await load<DocumentPiece>(svc, r, `document ${r.name ?? r.ref}`) };
    const type = str(t.piece.settings.type) ?? 'blank';
    const dname = str(t.piece.settings.name) ?? r.name ?? 'Document';
    const match = liveDocs.find(
      (l) => !used.has(String(l.id)) && (str(l.type) ?? 'blank') === type && str(l.name) === dname,
    );
    if (!match) {
      const b: Obj = { type, name: dname };
      if (type === 'time' && typeof t.piece.settings.calendarId === 'string')
        b.calendarId = t.piece.settings.calendarId;
      steps.push({
        op: 'createDocument',
        params: { path: { resourceId: targetId }, body: b },
        journalOperation: { ...journal, write: `document ${dname}` },
      });
      const docStep = steps.length;
      const bind = { step: docStep, to: 'path.documentId' as const };
      if (type === 'page')
        steps.push({
          op: 'replaceDocumentBlocks',
          params: {
            path: { resourceId: targetId, documentId: r.ref },
            body: { blocks: writeFormBlocks(t.piece.blocks ?? [], null, lost, dname) },
          },
          bindFrom: bind,
          journalOperation: { ...journal, write: `blocks of ${dname}` },
        });
      steps.push(
        ...documentContentSteps(
          d,
          input,
          journal,
          t,
          { resourceId: targetId, documentId: r.ref },
          bind,
          notRestored,
        ),
      );
      parts.push(`document ${dname}`);
      continue;
    }
    used.add(String(match.id));
    const p = { resourceId: targetId, documentId: String(match.id) };
    const before = steps.length;
    if (type === 'page' && (t.piece.blocks ?? []).length > 0) {
      const got = (await o.read('getDocumentBlocks', { path: p })) as
        { blocks?: unknown[]; version?: unknown } | undefined;
      const blank = (got?.blocks ?? []).every(
        (b) =>
          isObj(b) &&
          b.kind === 'paragraph' &&
          (!Array.isArray(b.content) || (b.content as Obj[]).every((x) => !str(x.text))),
      );
      if (got && blank)
        steps.push({
          op: 'replaceDocumentBlocks',
          params: {
            path: p,
            ...(typeof got.version === 'string' ? { ifMatch: got.version } : {}),
            body: { blocks: writeFormBlocks(t.piece.blocks ?? [], null, lost, dname) },
          },
          journalOperation: { ...journal, write: `blocks of ${dname}` },
        });
    }
    const have: { features?: Set<string>; lanes?: Set<string>; events?: Set<string>; board?: boolean } = {};
    if (type === 'map') {
      const f = (await o.read('listFeatures', { path: p })) as { data?: Obj[] } | Obj[] | undefined;
      const list = Array.isArray(f) ? f : (f?.data ?? []);
      have.features = new Set(list.flatMap((x) => [txt(x.id), `${txt(x.type)}:${txt(x.name)}`]));
    }
    if (type === 'time') {
      const l = (await o.read('listLanes', { path: p })) as { data?: Obj[] } | undefined;
      // CR-2026-11-R2 (R2-47): every page of the events (100 a page), or an event already made past the first hundred
      // is planned again.
      const e = (await listAll(o.read, 'listEvents', p, { limit: 100 })) ?? [];
      have.lanes = new Set((l?.data ?? []).map((x) => txt(x.name)));
      have.events = new Set(e.map((x) => `${txt(x.name)}@${txt(x.start)}`));
    }
    if (type === 'board') {
      const c = (await o.read('getBoardContent', { path: p })) as { shapes?: unknown[] } | undefined;
      have.board = (c?.shapes ?? []).length > 0;
    }
    steps.push(
      ...documentContentSteps(d, input, journal, t, p, undefined, notRestored, have).filter(
        (x) => x.op !== 'updateDocument',
      ),
    );
    if (steps.length > before) parts.push(`the content of ${dname}`);
  }
  // The sidebar: the properties the page lacks (property ids are the page's own: ADR 0037).
  const sbRow = stateAt(svc, input.projectId, input.pageId, 'sidebar', '', o.snap);
  if (sbRow) {
    const sb = await load<SidebarPiece>(svc, sbRow, 'sidebar');
    const now = (await o.read('listProperties', { path: { resourceId: targetId } })) as
      { data?: Obj[] } | undefined;
    const ids = new Set((now?.data ?? []).map((x) => txt(x.id)));
    const titles = new Set((now?.data ?? []).map((x) => `${txt(x.kind)}:${txt(x.title)}`));
    let prevProp: string | null = null;
    let added = 0;
    for (const prop of sb.properties) {
      const id = txt(prop.id);
      if (ids.has(id) || titles.has(`${txt(prop.kind)}:${txt(prop.title)}`)) {
        prevProp = id || prevProp;
        continue;
      }
      if (prop.kind === 'unsupported') {
        lost.push({
          what: `unsupported property ${txt(prop.title) || id}`,
          why: 'the API cannot recreate it',
        });
        continue;
      }
      const b = Object.fromEntries(Object.entries(prop).filter(([k]) => !['rank', 'version'].includes(k)));
      if (prevProp) b.after = prevProp;
      steps.push({
        op: 'createProperty',
        params: { path: { resourceId: targetId }, body: b },
        journalOperation: { ...journal, write: `property ${txt(prop.title) || id}` },
      });
      added++;
      if (id) prevProp = id;
    }
    if (added > 0) parts.push('sidebar');
  }
  if (steps.length > 0)
    steps.push(verifyStep([{ kind: 'resource', label: name, resourceId: targetId, fields: { name } }]));
  return finish({
    scope: 'deleted',
    mode: 'recreate',
    finishing: true,
    page: { id: targetId, name },
    snap: o.snap,
    steps,
    lost,
    kept,
    notRestored,
    warnings,
    pieces: [],
    parts: ['finish the recreate', ...parts],
    reads: o.reads(),
  });
}

/** A value as text for a comparison key (a string or a number; anything else is empty). */
const txt = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

function documentContentSteps(
  d: RestoreDeps,
  input: RestoreInput,
  journal: Obj,
  t: { row: PieceRow; piece: DocumentPiece },
  p: { resourceId: string; documentId: string },
  bind: StepSpec['bindFrom'] | undefined,
  notRestored: PlanNote[],
  have: {
    readonly features?: ReadonlySet<string>;
    readonly lanes?: ReadonlySet<string>;
    readonly events?: ReadonlySet<string>;
    readonly board?: boolean;
  } = {},
): StepSpec[] {
  const steps: StepSpec[] = [];
  const ref = t.row.ref;
  const bound = () => bind;
  const type = str(t.piece.settings.type) ?? 'blank';
  const set: Obj = {};
  for (const k of ['isHidden', 'isFullWidth'] as const) if (t.piece.settings[k] === true) set[k] = true;
  if (type === 'map') {
    const create = featureCreate();
    const docName = str(t.piece.settings.name) ?? t.row.name ?? ref;
    const byId = new Map(((t.piece.features ?? []) as Obj[]).map((f) => [String(f.id), f]));
    const depth = (f: Obj) => {
      let n = 0;
      for (let q = str(f.parentId); q && n < 50; q = str(byId.get(q)?.parentId)) n++;
      return n;
    };
    const dropped = { n: 0 };
    for (const f of [...byId.values()].sort((a, b) => depth(a) - depth(b)))
      if (!have.features?.has(txt(f.id)) && !have.features?.has(`${txt(f.type)}:${txt(f.name)}`))
        steps.push({
          op: 'createFeature',
          params: { path: p, body: featureBody(f, create, dropped) },
          ...ICON_DROP,
          ...(bound() ? { bindFrom: bound()! } : {}),
          journalOperation: {
            ...journal,
            document: { id: ref, name: docName },
            write: `feature ${featureLabel(f)}`,
            feature: { id: String(f.id), name: str(f.name) ?? '' },
          },
        });
    labelSizeNote(notRestored, docName, dropped);
    const img = isObj(t.piece.settings.mapImage) ? str(t.piece.settings.mapImage.assetId) : null;
    if (img) {
      if (d.assetLive(input.projectId, img)) set.mapImage = { assetId: img };
      else
        notRestored.push({
          what: `the image of map ${str(t.piece.settings.name) ?? ref}`,
          why: `its asset ${img} is no longer in the library`,
        });
    }
  }
  if (type === 'time') {
    const laneCreate = bodyFields('createLane');
    const evCreate = EVENT_FIELDS();
    for (const l of (t.piece.lanes ?? []) as Obj[])
      if (!have.lanes?.has(txt(l.name)))
        steps.push({
          op: 'createLane',
          params: { path: p, body: { size: 'sm', ...pick(l, laneCreate) } },
          ...(bound() ? { bindFrom: bound()! } : {}),
          journalOperation: { ...journal, write: `lane ${String(l.name ?? l.id)}` },
        });
    for (const e of (t.piece.events ?? []) as Obj[])
      if (!have.events?.has(`${txt(e.name)}@${txt(e.start)}`))
        steps.push({
          op: 'createEvent',
          params: { path: p, body: withWriteIcon(pick(e, evCreate)) },
          ...ICON_DROP,
          ...(bound() ? { bindFrom: bound()! } : {}),
          journalOperation: { ...journal, write: `event ${String(e.name ?? e.id)}` },
        });
  }
  if (type === 'board' && have.board !== true) {
    const c = t.piece.content ?? {};
    steps.push({
      op: 'replaceBoardContent',
      params: {
        path: p,
        body: { shapes: c.shapes ?? [], bindings: c.bindings ?? [], assets: c.assets ?? [] },
      },
      ...(bound() ? { bindFrom: bound()! } : {}),
      journalOperation: { ...journal, write: 'board content' },
    });
    notRestored.push({
      what: `the pages of board ${str(t.piece.settings.name) ?? ref}`,
      why: 'the API cannot write a board’s pages; a new board has one page, which its shapes must name',
    });
  }
  if (Object.keys(set).length > 0)
    steps.push({
      op: 'updateDocument',
      params: { path: p, body: set },
      ...(bound() ? { bindFrom: bound()! } : {}),
      journalOperation: { ...journal, write: 'document settings' },
    });

  return steps;
}

/** A short random id (for rehearsal and tests). */
export const shortId = () => randomBytes(4).toString('hex');
