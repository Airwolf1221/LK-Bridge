/**
 * Safety rails at scope `write` (v3 F3.4, ADR 0055 decision C). A profile at scope `write` runs ordinary changes
 * directly; its rails name the kinds of change that still become a proposal for the owner:
 *
 * | Rail           | What it catches                                                                                   | Default   |
 * | -------------- | ------------------------------------------------------------------------------------------------- | --------- |
 * | `deletes`      | deleting a page, a document, a timeline event or lane, a map feature, an asset, a calendar, a      | on        |
 * |                | sidebar property or board shapes (never a block, a fact row or a row of a block: those are edits)  |           |
 * | `bulk`         | one request that touches more than `bulkPages` pages (a page created counts; a cascade delete      | on, N=10  |
 * |                | counts every page under it)                                                                       |           |
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
    typeof o[k] === 'boolean' ? (o[k] as boolean) : (DEFAULT_WRITE_RAILS[k] as boolean);
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
  readonly kind: 'read' | 'write' | 'upload' | string;
  readonly params: OpParams;
  readonly options: StepOptions;
}

export interface RailContext {
  /**
   * How many pages lie under a page (its descendants, not counting it), for a cascade delete; null when not known (then
   * the cascade counts as more than any threshold: a rail fails closed, towards a proposal).
   */
  readonly descendants?: (resourceId: string) => number | null;
  /** A page's name, for the reason (null when not known). */
  readonly pageName?: (resourceId: string) => string | null;
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

/** Deletes the `deletes` rail catches, with what each deletes (in words). */
export const RAIL_DELETES: Readonly<Record<string, string>> = Object.freeze({
  deleteResource: 'page',
  deleteDocument: 'document',
  deleteEvent: 'timeline event',
  deleteLane: 'timeline lane',
  deleteFeature: 'map feature',
  deleteAsset: 'asset',
  deleteCalendar: 'calendar',
  deleteProperty: 'sidebar property',
  deleteBoardShapes: 'board shapes',
});

const CREATES_ONE = new Set(['createResource', 'createResourceFromTemplate', 'saveResourceAsTemplate']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whether the operation writes (bridge steps and reads never count). */
function writes(it: RailItem): boolean {
  if (it.opId.startsWith('bridge.') || it.opId.startsWith('upload_image.')) return false;
  return it.kind !== 'read';
}

/** The pages a request touches: every page a write names, every page it creates, every page under a cascade. */
export function pagesTouched(
  items: readonly RailItem[],
  ctx: RailContext = {},
): { readonly pages: ReadonlySet<string>; readonly unknownCascade: boolean; readonly created: ReadonlySet<string> } {
  const pages = new Set<string>();
  const created = new Set<string>();
  let unknownCascade = false;
  items.forEach((it, i) => {
    if (!writes(it)) return;
    const body = isObj(it.params.body) ? it.params.body : {};
    if (CREATES_ONE.has(it.opId)) {
      const id = str(body.id) ?? `#new:${i}`;
      pages.add(id);
      created.add(id);
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
    if (it.opId === 'deleteResource' && (it.params.query?.cascade === true || it.params.query?.cascade === 'true')) {
      const n = ctx.descendants?.(rid) ?? null;
      if (n === null) unknownCascade = true;
      else for (let k = 0; k < n; k++) pages.add(`#under:${rid}:${k}`);
    }
  });
  return { pages, unknownCascade, created };
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
    let only: string | null = null;
    // A chronology change that deletes a timeline event and creates its replacement in the same request (an event whose
    // end is removed, or one moved to another age: LegendKeeper cannot do either in place) recreates it: not a delete.
    const chronology = (it: RailItem) => isObj(it.options.journalOperation?.chronology);
    let recreated = Math.min(
      items.filter((it) => it.opId === 'deleteEvent' && writes(it) && chronology(it)).length,
      items.filter((it) => it.opId === 'createEvent' && writes(it) && chronology(it)).length,
    );
    for (const it of items) {
      const what = RAIL_DELETES[it.opId];
      if (!what || !writes(it)) continue;
      if (it.opId === 'deleteEvent' && chronology(it) && recreated > 0) {
        recreated--;
        continue;
      }
      kinds.set(what, (kinds.get(what) ?? 0) + 1);
      only = it.opId === 'deleteResource' ? named(str(it.params.path?.resourceId)) : null;
    }
    const total = [...kinds.values()].reduce((a, b) => a + b, 0);
    if (total > 0) {
      const parts = [...kinds.entries()].map(([k, n]) => plural(n, k));
      hits.push({
        rail: 'deletes',
        text:
          total === 1
            ? `delete (${parts[0]}${only ? ` ${only}` : ''})`
            : `deletes (${parts.join(', ')})`,
      });
    }
  }

  if (rails.bulk) {
    const n = touched.pages.size;
    if (touched.unknownCascade) {
      hits.push({
        rail: 'bulk',
        text: `bulk change (a cascade delete whose pages are not known, so more than ${rails.bulkPages} pages are assumed)`,
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
        renames.push(`${from ?? 'a page'} → “${String(body.name)}”`);
      }
      if (it.opId === 'moveResource') moves.push(named(rid) ?? 'a page');
    }
    if (renames.length > 0)
      hits.push({
        rail: 'renamesMoves',
        text:
          renames.length === 1 ? `rename of a page (${renames[0]})` : `renames of ${plural(renames.length, 'page')}`,
      });
    if (moves.length > 0)
      hits.push({
        rail: 'renamesMoves',
        text: moves.length === 1 ? `move of a page (${moves[0]})` : `moves of ${plural(moves.length, 'page')}`,
      });
  }

  if (rails.assets) {
    let deletes = 0;
    let moves = 0;
    for (const it of items) {
      if (!writes(it)) continue;
      if (it.opId === 'deleteAsset') deletes++;
      if (it.opId === 'updateAsset') {
        const body = isObj(it.params.body) ? it.params.body : {};
        if (body.folderId !== undefined || it.options.bindFrom?.to === 'body.folderId') moves++;
      }
    }
    if (deletes > 0) hits.push({ rail: 'assets', text: deletes === 1 ? 'asset delete' : `${deletes} asset deletes` });
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
  deletes: 'Deletes (pages, documents, timeline events, map features, assets)',
  bulk: 'Bulk changes (one request touching more than N pages)',
  renamesMoves: 'Renames and moves of pages',
  assets: 'Asset deletes and asset moves',
});
