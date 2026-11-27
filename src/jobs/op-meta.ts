/**
 * Hand-written per-operation metadata the job engine needs on top of the generated registry (which already
 * carries `kind`, `risk`, `concurrency` and `versioned` for all 89 operations).
 *
 * For every operation it says:
 * - `verify`: how a write that may already have reached LK is checked before anything is re-sent (PLAN §5.3, §6.1):
 *   - `read`: a read; re-running it is harmless.
 *   - `client-id`: a create that takes a client-chosen id; GET by the minted id.
 *   - `gone`: a delete; re-read and check the entity is gone.
 *   - `state`: an update; re-read and compare with the intended state (`compare`: `replace` or `patch`).
 *   - `key`: a POST with no other evidence; trust the Idempotency-Key replay inside its window, else `uncertain`
 *     (versioned POSTs also use the version: unchanged means not applied).
 *   - `idempotent`: re-sending cannot duplicate anything (move, restore, assign block ids).
 * - `reader`: the read that returns the entity's current state (and version, for versioned writes). The engine uses
 *   ONE such read before a destructive or versioned write, for the If-Match version, the unsupported-block guard and
 *   the journal pre-image together.
 * - `journal`: `pre-image` (store what the read returned) or `ids` (store the ids only, no read).
 * - `guard`: `document` / `block` / `property` for the unsupported-block guard (PLAN §4 rule 2). CR-2026-11 (CR-02): a
 *   sidebar or infobox property can be `unsupported` itself (TAGS) or hold `unsupported` blocks (a text field's
 *   children); deleting it, or replacing its children, drops them for good, so property deletes and child replaces are
 *   guarded too.
 * - `clientId`: where the engine puts the id it mints (PLAN §5.3).
 */
import type { OpParams } from './types.js';

export type ReaderId =
  | 'resource'
  | 'document'
  | 'docBlocks'
  | 'block'
  | 'property'
  | 'propertyRows'
  | 'blockRows'
  | 'blockProperties'
  | 'blockProperty'
  | 'blockPropertyRows'
  | 'lane'
  | 'event'
  | 'feature'
  | 'board'
  | 'asset'
  | 'calendars'
  | 'members'
  | 'invites';

export interface ReaderDef {
  /** Registry read operation. */
  readonly op: string;
  /** Path parameter that holds the entity id (filled from the minted id for client-id creates). */
  readonly idParam?: string;
  /** Version to send as If-Match, from the read's body (and the selected entity). */
  readonly version?: (body: unknown, entity: unknown) => string | undefined;
  /** For list reads: picks the entity a write targets (by the write's path param `selectBy`). */
  readonly selectBy?: string;
  readonly list?: boolean;
}

const bodyVersion = (body: unknown) => str((body as { version?: unknown } | undefined)?.version);
const entityVersion = (_: unknown, entity: unknown) =>
  str((entity as { version?: unknown } | undefined)?.version);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export const READERS: Readonly<Record<ReaderId, ReaderDef>> = {
  resource: { op: 'getResource', idParam: 'resourceId' },
  document: { op: 'getDocument', idParam: 'documentId' },
  docBlocks: { op: 'getDocumentBlocks', version: bodyVersion },
  block: { op: 'getBlock', idParam: 'blockId', version: bodyVersion },
  property: { op: 'getProperty', idParam: 'propertyId' },
  propertyRows: { op: 'listPropertyRows', version: bodyVersion, list: true, selectBy: 'rowId' },
  blockRows: { op: 'listBlockRows', version: bodyVersion, list: true, selectBy: 'rowId' },
  blockProperties: { op: 'listBlockProperties', version: bodyVersion, list: true },
  blockProperty: { op: 'getBlockProperty', idParam: 'propertyId', version: bodyVersion },
  blockPropertyRows: { op: 'listBlockPropertyRows', version: bodyVersion, list: true, selectBy: 'rowId' },
  lane: { op: 'getLane', idParam: 'laneId' },
  event: { op: 'getEvent', idParam: 'eventId' },
  feature: { op: 'getFeature', idParam: 'featureId' },
  board: { op: 'getBoardContent', version: bodyVersion },
  asset: { op: 'getAsset', idParam: 'assetId' },
  calendars: { op: 'listCalendars', version: entityVersion, list: true, selectBy: 'calendarId' },
  members: { op: 'listMembers', list: true, selectBy: 'userId' },
  invites: { op: 'listInvites', list: true, selectBy: 'inviteId' },
};

export type VerifyKind = 'read' | 'client-id' | 'gone' | 'state' | 'key' | 'idempotent';

export interface OpMeta {
  readonly verify: VerifyKind;
  readonly reader?: ReaderId;
  readonly compare?: 'replace' | 'patch';
  /** What the write intends the entity to look like (default: `params.body`). */
  readonly intent?: (params: OpParams) => unknown;
  /** The part of the re-read to compare with `intent` (default: the selected entity, else the body). */
  readonly actual?: (body: unknown, entity: unknown) => unknown;
  /** Custom "is it gone?" for deletes that remove several records (deleteBoardShapes). */
  readonly gone?: (body: unknown, params: OpParams) => boolean;
  readonly journal?: 'pre-image' | 'ids';
  readonly guard?: 'document' | 'block' | 'property';
  readonly clientId?: 'body.id' | 'body.resources[].id';
}

const read: OpMeta = { verify: 'read' };
const key = (reader?: ReaderId): OpMeta => (reader ? { verify: 'key', reader } : { verify: 'key' });
const patch = (reader: ReaderId, journal?: 'pre-image'): OpMeta =>
  journal
    ? { verify: 'state', compare: 'patch', reader, journal }
    : { verify: 'state', compare: 'patch', reader };
const gone = (reader: ReaderId, journal: 'pre-image' | 'ids'): OpMeta => ({
  verify: 'gone',
  reader,
  journal,
});
const created = (reader: ReaderId, clientId: OpMeta['clientId'] = 'body.id'): OpMeta => ({
  verify: 'client-id',
  reader,
  clientId: clientId,
});

function shapeIds(params: OpParams): string[] {
  const ids = (params.body as { ids?: unknown } | undefined)?.ids;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

function boardShapes(body: unknown): unknown[] {
  const shapes = (body as { shapes?: unknown } | undefined)?.shapes;
  return Array.isArray(shapes) ? (shapes as unknown[]) : [];
}

export const OP_META: Readonly<Record<string, OpMeta>> = {
  // Projects
  listProjects: read,
  getProject: read,
  // Resources
  listResources: read,
  getResource: read,
  listTemplates: read,
  createResource: created('resource'),
  createManyResources: created('resource', 'body.resources[].id'),
  createResourceFromTemplate: created('resource'),
  saveResourceAsTemplate: created('resource'),
  updateResource: patch('resource', 'pre-image'),
  // v2 E4 (RV2-1): the page itself (name, parent, tags) is kept, so a later restore of it can be judged by the lifecycle
  // guard (it lands back under that parent); restoreResource brings back its content, so nothing more is needed.
  deleteResource: gone('resource', 'pre-image'),
  moveResource: { verify: 'idempotent', reader: 'resource', journal: 'pre-image' },
  restoreResource: { verify: 'idempotent' },
  // Documents
  listDocuments: read,
  getDocument: read,
  getDocumentBlocks: read,
  createDocument: key(),
  updateDocument: patch('document', 'pre-image'),
  deleteDocument: gone('document', 'ids'),
  restoreDocument: { verify: 'idempotent' },
  assignBlockIds: { verify: 'idempotent' },
  replaceDocumentBlocks: {
    verify: 'state',
    compare: 'replace',
    reader: 'docBlocks',
    journal: 'pre-image',
    guard: 'document',
    intent: (p) => (p.body as { blocks?: unknown } | undefined)?.blocks ?? [],
    actual: (body) => (body as { blocks?: unknown } | undefined)?.blocks,
  },
  // Blocks
  getBlock: read,
  insertBlock: key('docBlocks'),
  replaceBlock: {
    verify: 'state',
    compare: 'replace',
    reader: 'block',
    journal: 'pre-image',
    guard: 'block',
  },
  // v3 F12 (ADR 0081, D2): an update keeps what it overwrote, so Revert can put it back (one read, the guard's anyway).
  updateBlock: patch('block', 'pre-image'),
  // Chunk 8 (F-03): deleting a block removes its whole subtree, and block deletes cannot be restored; the guard refuses
  // a delete that would remove an `unsupported` block (the target or a descendant) unless allowUnsupportedLoss is set.
  deleteBlock: { ...gone('block', 'pre-image'), guard: 'block' },
  moveBlock: key('block'),
  listBlockRows: read,
  createBlockRow: key('blockRows'),
  updateBlockRow: patch('blockRows', 'pre-image'),
  deleteBlockRow: gone('blockRows', 'pre-image'),
  listBlockProperties: read,
  createBlockProperty: key('blockProperties'),
  getBlockProperty: read,
  // CR-2026-11 (CR-02): an infobox property can be `unsupported` or hold `unsupported` blocks (as a sidebar property).
  updateBlockProperty: { ...patch('blockProperty', 'pre-image'), guard: 'property' },
  deleteBlockProperty: { ...gone('blockProperty', 'pre-image'), guard: 'property' },
  listBlockPropertyRows: read,
  createBlockPropertyRow: key('blockPropertyRows'),
  updateBlockPropertyRow: patch('blockPropertyRows', 'pre-image'),
  deleteBlockPropertyRow: gone('blockPropertyRows', 'pre-image'),
  // Properties (sidebar)
  listProperties: read,
  createProperty: key(),
  getProperty: read,
  // CR-2026-11 (CR-01, CR-02): LegendKeeper has no restore for a property, so its delete keeps the property as it was
  // (rows, items, children) for a restore by hand; and neither may drop an `unsupported` property or block unguarded.
  updateProperty: { ...patch('property', 'pre-image'), guard: 'property' },
  deleteProperty: { ...gone('property', 'pre-image'), guard: 'property' },
  listPropertyRows: read,
  createPropertyRow: key('propertyRows'),
  updatePropertyRow: patch('propertyRows', 'pre-image'),
  deletePropertyRow: gone('propertyRows', 'pre-image'),
  // Timelines
  listLanes: read,
  createLane: created('lane'),
  getLane: read,
  // v2 E4 (RV3-6): LegendKeeper keeps no history of lanes, events or features: an update keeps what it overwrote.
  updateLane: patch('lane', 'pre-image'),
  // CR-2026-11 (CR-01): lanes, events and features have no restore: their deletes keep what they deleted. A lane's
  // pre-image holds its events too (D1: step-exec reads them before the delete, on every route).
  deleteLane: gone('lane', 'pre-image'),
  listEvents: read,
  createEvent: created('event'),
  getEvent: read,
  updateEvent: patch('event', 'pre-image'),
  deleteEvent: gone('event', 'pre-image'),
  // Map features
  listFeatures: read,
  createFeature: created('feature'),
  getFeature: read,
  updateFeature: patch('feature', 'pre-image'),
  deleteFeature: gone('feature', 'pre-image'),
  // Boards
  getBoardContent: read,
  replaceBoardContent: {
    verify: 'state',
    compare: 'replace',
    reader: 'board',
    journal: 'pre-image',
    intent: (p) => (p.body as { shapes?: unknown } | undefined)?.shapes ?? [],
    actual: (body) => boardShapes(body),
  },
  listBoardShapes: read,
  createBoardShapes: key('board'),
  updateBoardShapes: {
    verify: 'state',
    compare: 'patch',
    reader: 'board',
    journal: 'pre-image',
    intent: (p) => (p.body as { shapes?: unknown } | undefined)?.shapes ?? [],
    actual: (body) => boardShapes(body),
  },
  deleteBoardShapes: {
    verify: 'gone',
    reader: 'board',
    journal: 'pre-image',
    gone: (body, params) => {
      const ids = new Set(shapeIds(params));
      return !boardShapes(body).some((s) => ids.has((s as { id?: string }).id ?? ''));
    },
  },
  // Assets
  listAssets: read,
  createAssetFolder: key(),
  createImageUpload: key(),
  createImageAsset: key(),
  getAsset: read,
  // v3 F3.4 (ADR 0055 decision F): the asset as it was (its folder, name and hidden flag), so a revert of an image
  // placement or an asset move can put it back. One read per updateAsset (a rare write).
  updateAsset: patch('asset', 'pre-image'),
  // CR-2026-11 (CR-01): the asset's record (not its bytes, nor a folder's contents: open for D3 and E1).
  deleteAsset: gone('asset', 'pre-image'),
  // Calendars
  listCalendars: read,
  createCalendar: key(),
  updateCalendar: { verify: 'state', compare: 'replace', reader: 'calendars', journal: 'pre-image' },
  deleteCalendar: gone('calendars', 'pre-image'),
  // Tags and search
  listTags: read,
  search: read,
  // Members and invites
  listMembers: read,
  inviteMember: key(),
  removeMember: gone('members', 'ids'),
  listInvites: read,
  revokeInvite: gone('invites', 'ids'),
};

export function opMeta(opId: string): OpMeta {
  const meta = OP_META[opId];
  if (!meta) throw new Error(`No job-engine metadata for ${opId}`);
  return meta;
}
