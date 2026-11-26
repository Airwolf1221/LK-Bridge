/**
 * v3 F12 (ADR 0081, D2 and D3): Revert of every write kind the other targets do not cover, from the job's own record and
 * the write journal's pre-images, so that every write an agent can cause has a way back (`REVERT_PATHS`, kept complete by
 * a test). One table says, per kind of entity, how to read it live, and how to make, change, delete or restore it.
 *
 * - **An update** (a lane, an event, a map feature, a sidebar or infobox property, a row, a document's fields, a
 *   calendar, board shapes or a board's content, a page's other fields): its fields back to the pre-image, only while
 *   the entity still holds what the job wrote.
 * - **A creation** (a lane, an event, a feature, a property, a row, a document, a calendar, board shapes, an asset folder,
 *   an image uploaded straight into its folder, a page): deleted again, only while it is exactly as the job made it (a
 *   page: its name, parent and tags as the job left them, its documents at the versions the job left, and no page put
 *   under it since). Deleting a page keeps its copy first (D3), so this too is recoverable.
 * - **A deletion** (D3): a lane (with its events), an event, a feature, a property, a row, a calendar or board shapes is
 *   made again from its pre-image (with its old id where LegendKeeper takes it); a page or a document comes back by
 *   LegendKeeper's own restore while it still holds it (`restoreResource`, `restoreDocument`), otherwise a page is made
 *   again from the copy kept before the delete (a follow-up of the revert: its id changes, and the pages that linked to
 *   the old id are listed); an asset is uploaded again from the bytes kept before its delete, as a new asset in the same
 *   folder under the same name, its page images relinked where the pages have not changed since (a follow-up).
 * - **A restore** an agent made: deleted again (with its copy).
 *
 * Every plan starts with a check of the entity inside the revert job's locks (the registered `review.revert` checker,
 * `kind: 'entity'`) and ends with a verify, as every revert target does. A plan whose inverse the registry refuses (a
 * pre-image LegendKeeper would not take back) is not revertible, with why: never a write without a way back.
 */
import { EXPECT_STEP } from '../jobs/internal-steps.js';
import { mintClientId } from '../jobs/ids.js';
import { stableJson } from '../jobs/sidebar-state.js';
import type { OpParams, StepSpec } from '../jobs/types.js';
import { operationInputSchema } from '../lk/registry.js';
import { bodyFields } from '../snapshots/restore.js';
import type { PlanIo, TargetPlan, Difference } from './revert-plan.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The kinds of entity the generic undo knows. */
export type EntityKind =
  | 'resource'
  | 'document'
  | 'lane'
  | 'event'
  | 'feature'
  | 'property'
  | 'propertyRow'
  | 'blockRow'
  | 'blockProperty'
  | 'blockPropertyRow'
  | 'calendar'
  | 'asset'
  | 'boardShapes'
  | 'board';

interface EntityDef {
  /** In words, for the owner. */
  readonly label: string;
  /** The path parameter naming the entity itself (absent: the container is the entity, as a board). */
  readonly idParam?: string;
  /** The read: an `op` by its own id, or a list (`list`) the entity is found in by id. */
  readonly get?: string;
  readonly list?: string;
  readonly create?: string;
  readonly update?: string;
  readonly remove?: string;
  readonly restore?: string;
  /** The path parameters of the container (the read and the create take these). */
  readonly container: readonly string[];
  /** Fields LegendKeeper sets itself, never sent back. */
  readonly serverFields?: readonly string[];
}

const SERVER = ['id', 'version', 'createdAt', 'updatedAt', 'deletedAt', 'createdBy', 'updatedBy'];

export const ENTITIES: Readonly<Record<EntityKind, EntityDef>> = {
  resource: {
    label: 'a page',
    idParam: 'resourceId',
    get: 'getResource',
    update: 'updateResource',
    remove: 'deleteResource',
    restore: 'restoreResource',
    container: [],
  },
  document: {
    label: 'a document',
    idParam: 'documentId',
    get: 'getDocument',
    create: 'createDocument',
    update: 'updateDocument',
    remove: 'deleteDocument',
    restore: 'restoreDocument',
    container: ['resourceId'],
  },
  lane: {
    label: 'a timeline lane',
    idParam: 'laneId',
    get: 'getLane',
    create: 'createLane',
    update: 'updateLane',
    remove: 'deleteLane',
    container: ['resourceId', 'documentId'],
  },
  event: {
    label: 'a timeline event',
    idParam: 'eventId',
    get: 'getEvent',
    create: 'createEvent',
    update: 'updateEvent',
    remove: 'deleteEvent',
    container: ['resourceId', 'documentId'],
    serverFields: ['formattedStart', 'formattedEnd'],
  },
  feature: {
    label: 'a map feature',
    idParam: 'featureId',
    get: 'getFeature',
    create: 'createFeature',
    update: 'updateFeature',
    remove: 'deleteFeature',
    container: ['resourceId', 'documentId'],
  },
  property: {
    label: 'a sidebar property',
    idParam: 'propertyId',
    get: 'getProperty',
    create: 'createProperty',
    update: 'updateProperty',
    remove: 'deleteProperty',
    container: ['resourceId'],
  },
  propertyRow: {
    label: 'a sidebar row',
    idParam: 'rowId',
    list: 'listPropertyRows',
    create: 'createPropertyRow',
    update: 'updatePropertyRow',
    remove: 'deletePropertyRow',
    container: ['resourceId', 'propertyId'],
  },
  blockRow: {
    label: 'a row of a block',
    idParam: 'rowId',
    list: 'listBlockRows',
    create: 'createBlockRow',
    update: 'updateBlockRow',
    remove: 'deleteBlockRow',
    container: ['resourceId', 'documentId', 'blockId'],
  },
  blockProperty: {
    label: 'an infobox property',
    idParam: 'propertyId',
    get: 'getBlockProperty',
    create: 'createBlockProperty',
    update: 'updateBlockProperty',
    remove: 'deleteBlockProperty',
    container: ['resourceId', 'documentId', 'blockId'],
  },
  blockPropertyRow: {
    label: 'an infobox row',
    idParam: 'rowId',
    list: 'listBlockPropertyRows',
    create: 'createBlockPropertyRow',
    update: 'updateBlockPropertyRow',
    remove: 'deleteBlockPropertyRow',
    container: ['resourceId', 'documentId', 'blockId', 'propertyId'],
  },
  calendar: {
    label: 'a calendar',
    idParam: 'calendarId',
    list: 'listCalendars',
    create: 'createCalendar',
    update: 'updateCalendar',
    remove: 'deleteCalendar',
    container: [],
  },
  asset: {
    label: 'an asset',
    idParam: 'assetId',
    get: 'getAsset',
    update: 'updateAsset',
    remove: 'deleteAsset',
    container: [],
  },
  boardShapes: {
    label: 'board shapes',
    get: 'getBoardContent',
    create: 'createBoardShapes',
    update: 'updateBoardShapes',
    remove: 'deleteBoardShapes',
    container: ['resourceId', 'documentId'],
  },
  board: {
    label: 'a board’s content',
    get: 'getBoardContent',
    update: 'replaceBoardContent',
    container: ['resourceId', 'documentId'],
  },
};

/** Each write operation the generic undo handles: the entity and what the job did to it. */
export const ENTITY_OPS: Readonly<
  Record<string, { readonly entity: EntityKind; readonly action: 'update' | 'create' | 'delete' | 'restore' }>
> = {
  updateResource: { entity: 'resource', action: 'update' },
  deleteResource: { entity: 'resource', action: 'delete' },
  restoreResource: { entity: 'resource', action: 'restore' },
  createDocument: { entity: 'document', action: 'create' },
  updateDocument: { entity: 'document', action: 'update' },
  deleteDocument: { entity: 'document', action: 'delete' },
  restoreDocument: { entity: 'document', action: 'restore' },
  createLane: { entity: 'lane', action: 'create' },
  updateLane: { entity: 'lane', action: 'update' },
  deleteLane: { entity: 'lane', action: 'delete' },
  createEvent: { entity: 'event', action: 'create' },
  updateEvent: { entity: 'event', action: 'update' },
  deleteEvent: { entity: 'event', action: 'delete' },
  createFeature: { entity: 'feature', action: 'create' },
  updateFeature: { entity: 'feature', action: 'update' },
  deleteFeature: { entity: 'feature', action: 'delete' },
  createProperty: { entity: 'property', action: 'create' },
  updateProperty: { entity: 'property', action: 'update' },
  deleteProperty: { entity: 'property', action: 'delete' },
  createPropertyRow: { entity: 'propertyRow', action: 'create' },
  updatePropertyRow: { entity: 'propertyRow', action: 'update' },
  deletePropertyRow: { entity: 'propertyRow', action: 'delete' },
  createBlockRow: { entity: 'blockRow', action: 'create' },
  updateBlockRow: { entity: 'blockRow', action: 'update' },
  deleteBlockRow: { entity: 'blockRow', action: 'delete' },
  createBlockProperty: { entity: 'blockProperty', action: 'create' },
  updateBlockProperty: { entity: 'blockProperty', action: 'update' },
  deleteBlockProperty: { entity: 'blockProperty', action: 'delete' },
  createBlockPropertyRow: { entity: 'blockPropertyRow', action: 'create' },
  updateBlockPropertyRow: { entity: 'blockPropertyRow', action: 'update' },
  deleteBlockPropertyRow: { entity: 'blockPropertyRow', action: 'delete' },
  createCalendar: { entity: 'calendar', action: 'create' },
  updateCalendar: { entity: 'calendar', action: 'update' },
  deleteCalendar: { entity: 'calendar', action: 'delete' },
  updateAsset: { entity: 'asset', action: 'update' },
  deleteAsset: { entity: 'asset', action: 'delete' },
  createBoardShapes: { entity: 'boardShapes', action: 'create' },
  updateBoardShapes: { entity: 'boardShapes', action: 'update' },
  deleteBoardShapes: { entity: 'boardShapes', action: 'delete' },
  replaceBoardContent: { entity: 'board', action: 'update' },
};

/** What a generic undo target carries (built in targets.ts from the job's step and its journal entry). */
export interface EntityUndo {
  readonly entity: EntityKind;
  readonly action: 'update' | 'create' | 'delete' | 'restore';
  /** The write's own operation. */
  readonly op: string;
  /** The entity's path: its container's parameters and its own id. */
  readonly path: Readonly<Record<string, string>>;
  /** What the job left (an update: the fields it wrote, as LegendKeeper answered; a create: what it made). */
  readonly left: Obj | null;
  /** What it was before (an update: those fields; a delete: the whole entity). */
  readonly before: Obj | null;
  /** Board shapes: the shapes' ids the job created, changed or deleted. */
  readonly shapeIds?: readonly string[];
  /** A deleted page or document: the copy kept before the delete (D3). */
  readonly copy?: { readonly snapshotId: string; readonly pages: number } | null;
  /** A page the job made: the documents it wrote and their versions as the job left them. */
  readonly documents?: readonly { readonly id: string; readonly version: string }[];
  /** A page the job made: the pages the same job made (put under it by the job itself). */
  readonly madeWith?: readonly string[];
  /** A page the job made: each sidebar row the job wrote on it (shown one line each on the Review card). */
  readonly sidebar?: readonly { readonly key: string; readonly value: string }[];
}

const pathOf = (def: EntityDef, path: Readonly<Record<string, string>>, withId: boolean): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of def.container) {
    const v = path[k];
    if (v) out[k] = v;
  }
  const id = def.idParam ? path[def.idParam] : undefined;
  if (withId && def.idParam && id) out[def.idParam] = id;
  return out;
};

const comparable = (v: unknown): string => stableJson(stripServer(v));
function stripServer(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripServer);
  if (!isObj(v)) return v ?? null;
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'version' || k === 'updatedAt' || k === 'createdAt') continue;
    out[k] = stripServer(x);
  }
  return out;
}

/** The entity as LegendKeeper holds it now: present (with its body), deleted softly, or gone. */
async function live(
  u: EntityUndo,
  io: PlanIo,
): Promise<{ readonly state: 'present' | 'soft' | 'gone'; readonly entity: Obj | null }> {
  const def = ENTITIES[u.entity];
  if (def.get) {
    const withId = def.idParam !== undefined;
    const r = await io.read(def.get, { path: pathOf(def, u.path, withId) });
    if (!r.exists || !isObj(r.body)) return { state: 'gone', entity: null };
    if (typeof r.body.deletedAt === 'string') return { state: 'soft', entity: r.body };
    return { state: 'present', entity: r.body };
  }
  const r = await io.read(def.list!, { path: pathOf(def, u.path, false) });
  const data: unknown[] = isObj(r.body) && Array.isArray(r.body.data) ? (r.body.data as unknown[]) : [];
  const id = def.idParam ? u.path[def.idParam] : undefined;
  const hit = data.find((x) => isObj(x) && x.id === id);
  return isObj(hit) ? { state: 'present', entity: hit } : { state: 'gone', entity: null };
}

/** Board shapes by id, as a board's content holds them. */
function shapesOf(board: Obj | null, ids: readonly string[]): Map<string, Obj> {
  const shapes = board && Array.isArray(board.shapes) ? board.shapes : [];
  const want = new Set(ids);
  const out = new Map<string, Obj>();
  for (const s of shapes) if (isObj(s) && typeof s.id === 'string' && want.has(s.id)) out.set(s.id, s);
  return out;
}

/** The fields of `want` that `have` does not hold the same (the differences an outside edit made). */
function fieldDiffs(label: string, want: Obj, have: Obj): Difference[] {
  const out: Difference[] = [];
  for (const [k, v] of Object.entries(want)) {
    if (SERVER.includes(k)) continue;
    if (comparable(v) !== comparable(have[k])) out.push({ path: `${label}: ${k}`, expected: v, actual: have[k] });
  }
  return out;
}

/** The body a create takes, from what the entity was (its schema's fields; a union body: all but the server's). */
function createBody(def: EntityDef, opId: string, was: Obj): Obj {
  const fields = bodyFields(opId);
  const drop = new Set([...SERVER.filter((k) => k !== 'id'), ...(def.serverFields ?? [])]);
  const out: Obj = {};
  for (const [k, v] of Object.entries(was)) {
    if (v === undefined || v === null || drop.has(k)) continue;
    if (fields.size > 0 ? fields.has(k) : k !== 'id') out[k] = v;
  }
  return out;
}

/** Whether the registry takes these params for the operation (null), or why not. */
function invalid(opId: string, params: OpParams): string | null {
  const r = operationInputSchema(opId).safeParse({ ...params, ifMatch: 'v' });
  if (r.success) return null;
  const first = r.error.issues[0];
  return first ? `${first.path.join('.')}: ${first.message}` : 'not valid';
}

interface Outcome {
  readonly state: 'ready' | 'changed' | 'gone' | 'nothing_to_do' | 'not_revertible';
  readonly detail: string;
  readonly differences?: readonly Difference[];
  readonly writes?: readonly StepSpec[];
  /** The bridge-side follow-up once the revert job has run (a page made again from its copy, an asset uploaded again). */
  readonly followUp?: EntityFollowUp;
}

/** What the revert does after its job, for a deletion LegendKeeper can no longer undo itself. */
export type EntityFollowUp =
  | {
      /** LegendKeeper's restore of the page (with the pages deleted with it), else made again from the copy. */
      readonly kind: 'recreate_pages';
      /** The copy kept before the delete ('' for a delete from before F12: LegendKeeper's restore only). */
      readonly snapshotId: string;
      readonly rootId: string;
    }
  | {
      readonly kind: 'restore_document';
      readonly resourceId: string;
      readonly documentId: string;
      readonly snapshotId: string | null;
    }
  | { readonly kind: 'reupload_asset'; readonly assetId: string; readonly before: Obj };

/** Plans one generic undo (see the module comment). */
export async function planEntityUndo(
  u: EntityUndo,
  io: PlanIo,
  journalOperation: Obj,
): Promise<Outcome> {
  const def = ENTITIES[u.entity];
  const now = await live(u, io);
  const label = def.label;
  const w = (op: string, params: OpParams, what: string): StepSpec => ({
    op,
    params,
    journalOperation: { ...journalOperation, write: what },
  });
  // ---- an update: back to the pre-image, only while it holds what the job wrote
  if (u.action === 'update') {
    if (now.state !== 'present') return { state: 'gone', detail: `${label} is gone` };
    if (!u.before || !u.left)
      return { state: 'not_revertible', detail: `${label} was changed, but the journal holds no pre-image of it` };
    if (u.entity === 'boardShapes' || u.entity === 'board') {
      const ids = u.shapeIds ?? [];
      const have = u.entity === 'board' ? (now.entity ?? {}) : Object.fromEntries(shapesOf(now.entity, ids));
      const left = u.entity === 'board' ? u.left : u.left;
      const d =
        u.entity === 'board'
          ? comparable(have.shapes) === comparable(left.shapes)
            ? []
            : [{ path: label, expected: 'as the job left it', actual: 'changed since' }]
          : fieldDiffs(label, left, have);
      if (d.length > 0) return { state: 'changed', detail: `${label} changed since the job`, differences: d };
      const params: OpParams =
        u.entity === 'board'
          ? { path: pathOf(def, u.path, false), body: u.before }
          : { path: pathOf(def, u.path, false), body: { shapes: Object.values(u.before) } };
      const why = invalid(def.update!, params);
      if (why) return { state: 'not_revertible', detail: `${label}: its old content is not one LegendKeeper takes (${why})` };
      return { state: 'ready', detail: `${label} back as it was`, writes: [w(def.update!, params, `${label} back`)] };
    }
    const d = fieldDiffs(label, u.left, now.entity ?? {});
    if (d.length > 0) return { state: 'changed', detail: `${label} changed since the job`, differences: d };
    if (Object.keys(u.before).every((k) => comparable(u.before![k]) === comparable(now.entity?.[k])))
      return { state: 'nothing_to_do', detail: `${label} is already as it was before the job` };
    const body =
      u.op === 'updateCalendar' ? createBody(def, 'updateCalendar', { ...now.entity, ...u.before }) : u.before;
    const params: OpParams = { path: pathOf(def, u.path, true), body };
    const why = invalid(def.update!, params);
    if (why) return { state: 'not_revertible', detail: `${label}: its old fields are not ones LegendKeeper takes (${why})` };
    return {
      state: 'ready',
      detail: `${label}: ${Object.keys(u.before).join(', ')} back`,
      writes: [w(def.update!, params, `${label} back`)],
    };
  }
  // ---- a creation (or an agent's restore): deleted again, only while it is as the job left it
  if (u.action === 'create' || u.action === 'restore') {
    if (u.entity === 'boardShapes') {
      const ids = u.shapeIds ?? [];
      const have = shapesOf(now.entity, ids);
      if (have.size === 0) return { state: 'gone', detail: `${label} are gone` };
      const d = u.left ? fieldDiffs(label, u.left, Object.fromEntries(have)) : [];
      if (d.length > 0) return { state: 'changed', detail: `${label} changed since the job`, differences: d };
      return {
        state: 'ready',
        detail: `${label} the job made deleted again`,
        writes: [w('deleteBoardShapes', { path: pathOf(def, u.path, false), body: { ids: [...have.keys()] } }, label)],
      };
    }
    if (now.state !== 'present') return { state: 'gone', detail: `${label} is gone already` };
    const d = u.left ? fieldDiffs(label, u.left, now.entity ?? {}) : [];
    if (u.entity === 'resource') {
      // A page: its documents at the versions the job left, and nothing put under it since but the job's own pages.
      for (const doc of u.documents ?? []) {
        const r = await io.read('getDocument', { path: { resourceId: u.path.resourceId!, documentId: doc.id } });
        const v = isObj(r.body) ? str(r.body.version) : undefined;
        if (r.exists && v !== undefined && v !== doc.version)
          d.push({ path: `${label}: document ${doc.id}`, expected: `version ${doc.version}`, actual: `version ${v}` });
      }
      const kids = await io.read('listResources', { query: { parentId: u.path.resourceId!, limit: 100 } });
      const madeWith = new Set(u.madeWith ?? []);
      for (const k of isObj(kids.body) && Array.isArray(kids.body.data) ? kids.body.data : [])
        if (isObj(k) && typeof k.id === 'string' && !madeWith.has(k.id))
          d.push({ path: `${label}: a page under it`, expected: '(none)', actual: str(k.name) ?? k.id });
    }
    if (d.length > 0)
      return {
        state: 'changed',
        detail: `${label} changed since the job made it (it is kept: delete it yourself if it should go)`,
        differences: d,
      };
    const params: OpParams = { path: pathOf(def, u.path, true) };
    return {
      state: 'ready',
      detail:
        u.entity === 'resource'
          ? `${label} the job ${u.action === 'restore' ? 'restored' : 'made'}, untouched since: deleted (a copy is kept first)`
          : `${label} the job ${u.action === 'restore' ? 'restored' : 'made'}, untouched since: deleted`,
      writes: [w(def.remove!, params, `${label} the job ${u.action === 'restore' ? 'restored' : 'made'}`)],
    };
  }
  // ---- a deletion (D3): back from LegendKeeper's own restore, the pre-image, or the copy
  if (u.entity === 'boardShapes') {
    const ids = u.shapeIds ?? [];
    const have = shapesOf(now.entity, ids);
    if (have.size > 0)
      return { state: 'changed', detail: `${label}: some are back already`, differences: [] };
    const was = u.before ? Object.values(u.before).filter(isObj) : [];
    if (was.length === 0) return { state: 'not_revertible', detail: `${label}: the journal holds no copy of them` };
    const params: OpParams = { path: pathOf(def, u.path, false), body: { shapes: was } };
    const why = invalid('createBoardShapes', params);
    if (why) return { state: 'not_revertible', detail: `${label}: their copy is not one LegendKeeper takes (${why})` };
    return { state: 'ready', detail: `${label} made again`, writes: [w('createBoardShapes', params, label)] };
  }
  if (now.state === 'present') return { state: 'nothing_to_do', detail: `${label} is back already` };
  if (u.entity === 'resource' || u.entity === 'document') {
    // LegendKeeper's own restore first (a soft delete it may still hold, whether or not a read shows it), then, for a
    // page, the copy kept before the delete: a follow-up once the revert job has checked the page is still gone.
    if (u.entity === 'document' && now.state === 'soft')
      return {
        state: 'ready',
        detail: `${label} restored by LegendKeeper's own restore`,
        writes: [w(def.restore!, { path: pathOf(def, u.path, true) }, `${label} restored`)],
      };
    if (u.entity === 'resource' && (u.copy?.snapshotId || now.state === 'soft'))
      return {
        state: 'ready',
        detail: `${label}${(u.copy?.pages ?? 1) > 1 ? ` and the ${(u.copy?.pages ?? 1) - 1} pages under it` : ''} restored by LegendKeeper's own restore; if it no longer holds them, made again from the copy kept before the delete${u.copy?.snapshotId ? ` (snapshot ${u.copy.snapshotId})` : ''}, with new ids`,
        writes: [],
        followUp: {
          kind: 'recreate_pages',
          snapshotId: u.copy?.snapshotId ?? '',
          rootId: u.path.resourceId!,
        },
      };
    if (u.entity === 'document')
      return {
        state: 'ready',
        detail: `${label} restored by LegendKeeper's own restore${u.copy?.snapshotId ? ` (its copy: snapshot ${u.copy.snapshotId})` : ''}`,
        writes: [],
        followUp: {
          kind: 'restore_document',
          resourceId: u.path.resourceId!,
          documentId: u.path.documentId!,
          snapshotId: u.copy?.snapshotId ?? null,
        },
      };
    return {
      state: 'not_revertible',
      detail: `LegendKeeper no longer holds ${label}, and no copy was kept (a delete from before F12)`,
    };
  }
  if (u.entity === 'asset') {
    if (!u.before) return { state: 'not_revertible', detail: `${label}: the journal holds no record of it` };
    return {
      state: 'ready',
      detail: `${label} uploaded again from the bytes kept before its delete, as a new asset in the same folder under the same name (pages that showed it relinked where unchanged)`,
      writes: [],
      followUp: { kind: 'reupload_asset', assetId: u.path.assetId!, before: u.before },
    };
  }
  if (!u.before) return { state: 'not_revertible', detail: `${label}: the journal holds no copy of it` };
  // An entity with a client-chosen id (lanes, events, features) comes back under its old id; the rest under a new one.
  const body = createBody(def, def.create!, u.before);
  if (u.entity === 'lane' || u.entity === 'event' || u.entity === 'feature')
    body.id = str(u.before.id) ?? mintClientId();
  const params: OpParams = { path: pathOf(def, u.path, false), body };
  const why = invalid(def.create!, params);
  if (why) return { state: 'not_revertible', detail: `${label}: its copy is not one LegendKeeper takes (${why})` };
  const writes: StepSpec[] = [w(def.create!, params, `${label} made again`)];
  // A lane takes its events with it: each made again in it.
  if (u.entity === 'lane' && Array.isArray(u.before.events)) {
    const ev = ENTITIES.event;
    for (const e of u.before.events) {
      if (!isObj(e)) continue;
      const eb = createBody(ev, 'createEvent', { ...e, laneId: body.id });
      eb.id = str(e.id) ?? mintClientId();
      writes.push(w('createEvent', { path: pathOf(ev, u.path, false), body: eb }, `an event of the lane made again`));
    }
  }
  return { state: 'ready', detail: `${label} made again from its copy${writes.length > 1 ? ` (with its ${writes.length - 1} events)` : ''}`, writes };
}

/** The check a generic undo's part of the revert job starts with (inside the job's locks; `review.revert`). */
export function entityCheck(u: EntityUndo, label: string, checker: string): StepSpec {
  return {
    op: EXPECT_STEP,
    params: {
      body: {
        checks: [
          {
            label,
            kind: 'registered',
            checker,
            ...(u.path.resourceId ? { resourceId: u.path.resourceId } : {}),
            input: { kind: 'entity', undo: u },
          },
        ],
      },
    },
  };
}

/** The checker's judgement: the entity is still as the plan read it (the plan's state, made again inside the lock). */
export async function entityStillAsPlanned(u: EntityUndo, io: PlanIo): Promise<readonly Difference[]> {
  const out = await planEntityUndo(u, io, {});
  if (out.state === 'ready') return [];
  return out.differences && out.differences.length > 0
    ? out.differences
    : [{ path: ENTITIES[u.entity].label, expected: 'as the revert planned', actual: out.detail }];
}

/** A plan's TargetPlan parts for a generic undo (the check first, then its writes). */
export function entityPlanParts(
  u: EntityUndo,
  out: Outcome,
  label: string,
  checker: string,
): Pick<TargetPlan, 'steps' | 'resources' | 'documents'> {
  if (out.state !== 'ready' || !out.writes || out.writes.length === 0) return {};
  return {
    steps: [entityCheck(u, label, checker), ...out.writes],
    ...(u.path.resourceId ? { resources: [u.path.resourceId] } : {}),
    ...(u.path.documentId ? { documents: [u.path.documentId] } : {}),
  };
}

export { AGENT_REFUSED, REVERT_PATHS } from './write-kinds.js';
