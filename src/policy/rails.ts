/**
 * Safety rails at scope `write` (v3 F3.4, ADR 0055 decision C). A profile at scope `write` runs ordinary changes
 * directly; its rails name the kinds of change that still become a proposal for the owner:
 *
 * | Rail           | What it catches                                                                                   | Default   |
 * | -------------- | ------------------------------------------------------------------------------------------------- | --------- |
 * | `deletes`      | deleting a page, a document, a timeline event or lane, a map feature, an asset, a calendar, a      | on        |
 * |                | sidebar or infobox property or board shapes; replacing a board's whole content or a calendar      |           |
 * |                | (what is not sent is deleted); and, through the low-level tools only (`lk_api_write`,             |           |
 * |                | `lk_api_batch`, `lk_op_*`), every removal: a block, a fact row, a row of a block or of an infobox  |           |
 * |                | property, and a whole-list write that drops entries (ADR 0057 decision 4)                         |           |
 * | `bulk`         | one request that touches more than `bulkPages` pages (a page created counts; a cascade delete      | on, N=10  |
 * |                | counts every page under it; a template copy with its children counts every page copied; a restore |           |
 * |                | counts every page it may bring back, ADR 0057 decision 9)                                         |           |
 * | `renamesMoves` | renaming or moving a page the request did not create                                              | off       |
 * | `assets`       | deleting an asset, or moving one to another folder                                                | on        |
 *
 * Pure: the engine asks the policy gate (`LivePolicyGate.rails`) once per request, after the gate and the write guard
 * have let it through as a direct write. A rail can only ADD a proposal: a request the gate or a guard already made a
 * proposal is never judged here, and nothing here can turn a proposal into a direct write. Canon and lifecycle
 * changes stay proposals whatever the rails say (the write guard). The proposal says which rail sent it.
 */
import type { OpParams, StepOptions } from '../jobs/types.js';
import { PolicyError } from './errors.js';

export interface WriteRails {
  /** Deletes become proposals. */
  readonly deletes: boolean;
  /** A request touching more than `bulkPages` pages becomes a proposal. */
  readonly bulk: boolean;
  /** The bulk threshold, N (1-1000). */
  readonly bulkPages: number;
  /** Renames and moves of pages become proposals. */
  readonly renamesMoves: boolean;
  /** Asset deletes and asset moves become proposals. */
  readonly assets: boolean;
}

/** The owner's defaults (ADR 0055): deletes, bulk over 10 pages, and asset deletes and moves; renames and moves off. */
export const DEFAULT_WRITE_RAILS: WriteRails = Object.freeze({
  deletes: true,
  bulk: true,
  bulkPages: 10,
  renamesMoves: false,
  assets: true,
});

export const RAIL_NAMES = ['deletes', 'bulk', 'renamesMoves', 'assets'] as const;
export type RailName = (typeof RAIL_NAMES)[number];

/** The rails as stored (`agent_profiles.write_rails`, JSON; NULL or unreadable: the defaults, field by field). */
export function railsFrom(text: unknown): WriteRails {
  if (typeof text !== 'string' || text === '') return DEFAULT_WRITE_RAILS;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return DEFAULT_WRITE_RAILS;
  }
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const flag = (k: keyof WriteRails) =>
    typeof o[k] === 'boolean' ? o[k] : (DEFAULT_WRITE_RAILS[k] as boolean);
  const n = o.bulkPages;
  return {
    deletes: flag('deletes'),
    bulk: flag('bulk'),
    bulkPages:
      typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000 ? n : DEFAULT_WRITE_RAILS.bulkPages,
    renamesMoves: flag('renamesMoves'),
    assets: flag('assets'),
  };
}

/** Checks an owner's change (the admin API); a partial change keeps the other fields. */
export function mergeRails(current: WriteRails, change: unknown): WriteRails {
  if (typeof change !== 'object' || change === null || Array.isArray(change))
    throw new PolicyError('INVALID_INPUT', 'The rails are an object of switches');
  const c = change as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    if (!(RAIL_NAMES as readonly string[]).includes(k) && k !== 'bulkPages')
      throw new PolicyError('INVALID_INPUT', `Unknown rail: ${k}`);
  }
  const out: Record<string, unknown> = { ...current };
  for (const k of RAIL_NAMES) {
    if (c[k] === undefined) continue;
    if (typeof c[k] !== 'boolean') throw new PolicyError('INVALID_INPUT', `${k} is on (true) or off (false)`);
    out[k] = c[k];
  }
  if (c.bulkPages !== undefined) {
    const n = c.bulkPages;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1000)
      throw new PolicyError('INVALID_INPUT', 'bulkPages is a whole number of pages from 1 to 1000');
    out.bulkPages = n;
  }
  return out as unknown as WriteRails;
}

/** One operation of a request, as the engine hands it to the gate. */
export interface RailItem {
  readonly opId: string;
  /** The operation's kind (`read`, `write`, `upload`). */
  readonly kind: string;
  readonly params: OpParams;
  readonly options: StepOptions;
}

export interface RailContext {
  /**
   * How many pages lie under a page (its descendants, not counting it), for a cascade delete or a copy with its children
   * (`createResourceFromTemplate`, `saveResourceAsTemplate`); null when not known (then the request counts as more than
   * any threshold: a rail fails closed, towards a proposal).
   */
  readonly descendants?: (resourceId: string) => number | null;
  /** A page's name, for the reason (null when not known). */
  readonly pageName?: (resourceId: string) => string | null;
  /**
   * ADR 0057 decision 9: how many pages a restore of a page may bring back WITH it (the restore set the canon guard reads,
   * not counting the page itself); null when the set is not known (the request then counts as more than any threshold).
   */
  readonly restored?: (resourceId: string) => number | null;
  /**
   * ADR 0057 decision 4: the request came through a low-level tool (`lk_api_write`, `lk_api_batch`, `lk_op_*`), whose
   * removals of content (blocks, rows, list entries) are deletes for the rail. The high-level tools' removals are
   * planned, checked and revertible, and stay edits.
   */
  readonly lowLevel?: boolean;
  /**
   * ADR 0057 decision 4: whether the item at this index of the request (a whole-list write: `LIST_WRITES`) drops an entry
   * LegendKeeper holds now; null or absent when it cannot be told (then it counts as a removal: the rail fails closed).
   */
  readonly drops?: (index: number) => boolean | null;
  /**
   * The request places a staged image (set by bridge code only, never from an agent's input: `BatchSubmit.stagedPlacement`).
   * Moving the staged asset out of the staging folder is the placement itself, not a reorganisation of the library, so
   * the asset rail does not count its `updateAsset` (an asset delete still counts).
   */
  readonly stagedPlacement?: boolean;
}

export interface RailHit {
  readonly rail: RailName;
  /** In words, for the proposal: `bulk change (14 pages > 10)`. */
  readonly text: string;
}

export interface RailVerdict {
  readonly hits: readonly RailHit[];
  /** `proposed because: …`, the hits joined. */
  readonly reason: string;
}

/**
 * Deletes the `deletes` rail catches, with what each deletes (in words). CR-2026-11-R2: an infobox property (with its
 * rows), as a sidebar property; and the two whole replaces, which delete whatever they do not send: a board's content
 * (every shape, binding and asset not sent) and a calendar (`updateCalendar` is a PUT of the whole calendar).
 */
export const RAIL_DELETES: Readonly<Record<string, string>> = Object.freeze({
  deleteResource: 'page',
  deleteDocument: 'document',
  deleteEvent: 'timeline event',
  deleteLane: 'timeline lane',
  deleteFeature: 'map feature',
  deleteAsset: 'asset',
  deleteCalendar: 'calendar',
  deleteProperty: 'sidebar property',
  deleteBlockProperty: 'infobox property',
  deleteBoardShapes: 'board shapes',
  replaceBoardContent: 'board content replaced',
  updateCalendar: 'calendar replaced',
});

/**
 * ADR 0057 decision 4 (R2-52): operations that remove content and are deletes for the rail when sent through a
 * low-level tool. Revert does not put them back yet (the journal keeps the pre-image; ADR 0057 leaves Revert open).
 */
export const LOW_LEVEL_REMOVALS: Readonly<Record<string, string>> = Object.freeze({
  deleteBlock: 'block',
  deleteBlockRow: 'row of a block',
  deletePropertyRow: 'sidebar row',
  deleteBlockPropertyRow: 'infobox row',
});

/**
 * ADR 0057 decision 4: the low-level writes that send a whole list (a document's blocks, a property's rows, items or
 * children, a block's rows, items or children) and so remove every entry they do not send. A removal for the rail only
 * when it drops an entry LegendKeeper holds now (`RailContext.drops`).
 */
export const LIST_WRITES: Readonly<
  Record<string, { readonly what: string; readonly lists: readonly string[] }>
> = Object.freeze({
  replaceDocumentBlocks: { what: 'document replace that drops blocks', lists: ['blocks'] },
  updateProperty: { what: 'sidebar property write that drops entries', lists: ['items', 'rows', 'children'] },
  updateBlockProperty: {
    what: 'infobox property write that drops entries',
    lists: ['items', 'rows', 'children'],
  },
  replaceBlock: { what: 'block write that drops entries', lists: ['items', 'rows', 'children'] },
  updateBlock: { what: 'block write that drops entries', lists: ['items', 'rows', 'children'] },
});

/** The lists a whole-list write sends (empty: it sends none, so it drops nothing). */
export function listsSent(opId: string, body: unknown): string[] {
  const spec = LIST_WRITES[opId];
  if (!spec || typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  if (opId === 'replaceDocumentBlocks') return ['blocks'];
  // replaceBlock replaces the whole block: whatever list it holds now and is not sent is dropped too.
  if (opId === 'replaceBlock') return [...spec.lists];
  return spec.lists.filter((k) => Array.isArray((body as Record<string, unknown>)[k]));
}

/** Low-level tools (their origin's tool name). */
export function isLowLevelTool(tool: string | undefined): boolean {
  return tool === 'lk_api_write' || tool === 'lk_api_batch' || (tool?.startsWith('lk_op_') ?? false);
}

/** Plurals that are not the noun plus `s`. */
const PLURALS: Readonly<Record<string, string>> = Object.freeze({
  'board shapes': 'board shapes',
  'board content replaced': 'board contents replaced',
  'calendar replaced': 'calendars replaced',
  'row of a block': 'rows of blocks',
  'document replace that drops blocks': 'document replaces that drop blocks',
  'sidebar property write that drops entries': 'sidebar property writes that drop entries',
  'infobox property write that drops entries': 'infobox property writes that drop entries',
  'block write that drops entries': 'block writes that drop entries',
});

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * Creates that copy a page and, with `includeChildren`, every page under it (CR-2026-11-R2): the page whose descendants
 * are copied too (the template, or the page saved as a template).
 */
const COPIES: Readonly<Record<string, (it: RailItem, body: Obj) => string | undefined>> = Object.freeze({
  createResourceFromTemplate: (_it: RailItem, body: Obj) => str(body.templateId),
  saveResourceAsTemplate: (it: RailItem) => str(it.params.path?.resourceId),
});

const plural = (n: number, one: string, many = PLURALS[one] ?? `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whether the operation writes (bridge steps and reads never count). */
function writes(it: RailItem): boolean {
  if (it.opId.startsWith('bridge.') || it.opId.startsWith('upload_image.')) return false;
  return it.kind !== 'read';
}

/**
 * The pages a request touches: every page a write names, every page it creates, every page under a cascade, and every
 * page a copy with its children makes.
 */
export function pagesTouched(
  items: readonly RailItem[],
  ctx: RailContext = {},
): {
  readonly pages: ReadonlySet<string>;
  readonly unknownCascade: boolean;
  /** A copy with its children whose source's pages are not known (CR-2026-11-R2: the rail then fails closed). */
  readonly unknownCopy: boolean;
  /** A restore whose restore set is not known (ADR 0057 decision 9: the rail then fails closed). */
  readonly unknownRestore: boolean;
  readonly created: ReadonlySet<string>;
} {
  const pages = new Set<string>();
  const created = new Set<string>();
  let unknownCascade = false;
  let unknownCopy = false;
  let unknownRestore = false;
  items.forEach((it, i) => {
    if (!writes(it)) return;
    const body = isObj(it.params.body) ? it.params.body : {};
    const copy = COPIES[it.opId];
    if (it.opId === 'createResource' || copy) {
      const id = str(body.id) ?? `#new:${i}`;
      pages.add(id);
      created.add(id);
      // CR-2026-11-R2 (R2-01): one call copies the source and, with `includeChildren`, every page under it (up to 100).
      if (copy && body.includeChildren === true) {
        const source = copy(it, body);
        const n = source ? (ctx.descendants?.(source) ?? null) : null;
        if (n === null) unknownCopy = true;
        else for (let k = 0; k < n; k++) pages.add(`#copy:${i}:${k}`);
      }
      return;
    }
    if (it.opId === 'createManyResources') {
      const list = Array.isArray(body.resources) ? body.resources : [];
      list.forEach((r, j) => {
        const id = (isObj(r) ? str(r.id) : undefined) ?? `#new:${i}.${j}`;
        pages.add(id);
        created.add(id);
      });
      return;
    }
    const rid = str(it.params.path?.resourceId);
    if (!rid) return;
    pages.add(rid);
    if (
      it.opId === 'deleteResource' &&
      (it.params.query?.cascade === true || it.params.query?.cascade === 'true')
    ) {
      const n = ctx.descendants?.(rid) ?? null;
      if (n === null) unknownCascade = true;
      else for (let k = 0; k < n; k++) pages.add(`#under:${rid}:${k}`);
    }
    // ADR 0057 decision 9: LegendKeeper restores every page deleted by the same delete with the page.
    if (it.opId === 'restoreResource') {
      const n = ctx.restored?.(rid) ?? null;
      if (n === null) unknownRestore = true;
      else for (let k = 0; k < n; k++) pages.add(`#restored:${rid}:${k}`);
    }
  });
  return { pages, unknownCascade, unknownCopy, unknownRestore, created };
}

/**
 * The rails a request meets (see the module comment), or null when none: the request runs directly. Only ever asked
 * about a request that would otherwise run directly at scope `write`.
 */
export function railsVerdict(
  rails: WriteRails,
  items: readonly RailItem[],
  ctx: RailContext = {},
): RailVerdict | null {
  const hits: RailHit[] = [];
  const named = (rid: string | undefined) => {
    const n = rid ? ctx.pageName?.(rid) : null;
    return n ? `“${n}”` : null;
  };
  const touched = pagesTouched(items, ctx);

  if (rails.deletes) {
    const kinds = new Map<string, number>();
    let only = null as string | null; // assigned in the callback below
    // A chronology change that deletes a timeline event and creates its replacement in the same request (an event whose
    // end is removed, or one moved to another age: LegendKeeper cannot do either in place) recreates it: not a delete.
    const chronology = (it: RailItem) => isObj(it.options.journalOperation?.chronology);
    let recreated = Math.min(
      items.filter((it) => it.opId === 'deleteEvent' && writes(it) && chronology(it)).length,
      items.filter((it) => it.opId === 'createEvent' && writes(it) && chronology(it)).length,
    );
    items.forEach((it, i) => {
      if (!writes(it)) return;
      // ADR 0057 decision 4: a removal through a low-level tool.
      if (ctx.lowLevel === true) {
        const removed =
          LOW_LEVEL_REMOVALS[it.opId] ??
          (listsSent(it.opId, it.params.body).length > 0 && ctx.drops?.(i) !== false
            ? LIST_WRITES[it.opId]?.what
            : undefined);
        if (removed) {
          kinds.set(removed, (kinds.get(removed) ?? 0) + 1);
          only = null;
          return;
        }
      }
      const what = RAIL_DELETES[it.opId];
      if (!what) return;
      if (it.opId === 'deleteEvent' && chronology(it) && recreated > 0) {
        recreated--;
        return;
      }
      kinds.set(what, (kinds.get(what) ?? 0) + 1);
      only = it.opId === 'deleteResource' ? named(str(it.params.path?.resourceId)) : null;
    });
    const total = [...kinds.values()].reduce((a, b) => a + b, 0);
    if (total > 0) {
      const parts = [...kinds.entries()].map(([k, n]) => plural(n, k));
      hits.push({
        rail: 'deletes',
        text: total === 1 ? `delete (${parts[0]}${only ? ` ${only}` : ''})` : `deletes (${parts.join(', ')})`,
      });
    }
  }

  if (rails.bulk) {
    const n = touched.pages.size;
    if (touched.unknownCascade || touched.unknownCopy || touched.unknownRestore) {
      const what = touched.unknownCascade
        ? 'a cascade delete whose pages are not known'
        : touched.unknownCopy
          ? 'a copy with its children whose pages are not known'
          : 'a restore whose pages are not known';
      hits.push({
        rail: 'bulk',
        text: `bulk change (${what}, so more than ${rails.bulkPages} pages are assumed)`,
      });
    } else if (n > rails.bulkPages) {
      hits.push({ rail: 'bulk', text: `bulk change (${n} pages > ${rails.bulkPages})` });
    }
  }

  if (rails.renamesMoves) {
    const renames: string[] = [];
    const moves: string[] = [];
    for (const it of items) {
      if (!writes(it)) continue;
      const rid = str(it.params.path?.resourceId);
      if (!rid || touched.created.has(rid)) continue;
      const body = isObj(it.params.body) ? it.params.body : {};
      if (it.opId === 'updateResource' && body.name !== undefined) {
        const from = named(rid);
        renames.push(`${from ?? 'a page'} → “${typeof body.name === 'string' ? body.name : ''}”`);
      }
      if (it.opId === 'moveResource') moves.push(named(rid) ?? 'a page');
    }
    if (renames.length > 0)
      hits.push({
        rail: 'renamesMoves',
        text:
          renames.length === 1
            ? `rename of a page (${renames[0]})`
            : `renames of ${plural(renames.length, 'page')}`,
      });
    if (moves.length > 0)
      hits.push({
        rail: 'renamesMoves',
        text:
          moves.length === 1 ? `move of a page (${moves[0]})` : `moves of ${plural(moves.length, 'page')}`,
      });
  }

  if (rails.assets) {
    let deletes = 0;
    let moves = 0;
    for (const it of items) {
      if (!writes(it)) continue;
      if (it.opId === 'deleteAsset') deletes++;
      if (it.opId === 'updateAsset' && ctx.stagedPlacement !== true) {
        const body = isObj(it.params.body) ? it.params.body : {};
        if (body.folderId !== undefined || it.options.bindFrom?.to === 'body.folderId') moves++;
      }
    }
    if (deletes > 0)
      hits.push({ rail: 'assets', text: deletes === 1 ? 'asset delete' : `${deletes} asset deletes` });
    if (moves > 0)
      hits.push({
        rail: 'assets',
        text: moves === 1 ? 'asset move (to another folder)' : `${moves} asset moves (to other folders)`,
      });
  }

  if (hits.length === 0) return null;
  return { hits, reason: `proposed because: ${hits.map((h) => h.text).join('; ')}` };
}

/** The rails in words, for the dashboard and the guide. */
export const RAIL_LABELS: Readonly<Record<RailName, string>> = Object.freeze({
  deletes:
    'Deletes (pages, documents, timeline events, map features, assets, calendars, properties, board content; and any removal through the low-level tools)',
  bulk: 'Bulk changes (one request touching more than N pages)',
  renamesMoves: 'Renames and moves of pages',
  assets: 'Asset deletes and asset moves',
});
