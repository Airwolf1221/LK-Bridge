/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * The v2 phase 0 spike (docs/PLAN-v2.md, section 6, session 0): ten checks of the plan's assumptions against the REAL
 * LegendKeeper test world, so later sessions do not build on guesses. Run it on the server with `deploy/spike-v2.sh`
 * (or `npm run spike:v2`); the owner sends the report back.
 *
 * Rules, as for the soak:
 * - It refuses to run unless the API key's own project (from `listProjects`) is exactly the sandbox project id given.
 * - EVERY LegendKeeper call goes through the real job engine and governor at priority P3 (never the raw SDK), so it stays
 *   inside the rate budget and the writes show up in the write journal. The asset downloads of check 3 go through the
 *   bridge's outbound fetch guard and are paced by the governor too.
 * - Writes happen ONLY in check 1, only under ONE throwaway root resource that is deleted (cascade) at the end, even
 *   after a failure. This is enforced in code, not by convention: `Ctx.call` refuses any write outside that window, any
 *   write operation other than createResource, createManyResources and deleteResource, and any write whose parent is
 *   not the throwaway tree.
 * - Nothing secret is read or printed.
 *
 * The same code runs, as a dry run, against a mock LegendKeeper in test/tools/spike-v2-dryrun.test.ts.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  BudgetExhaustedError,
  JobsError,
  LkOperationError,
  mintClientId,
  TERMINAL_JOB_STATUSES,
  type JobEngine,
  type JobView,
} from '../../src/jobs/index.js';
import type { LkClient } from '../../src/lk/index.js';
import { getOperation } from '../../src/lk/registry.js';
import {
  assertPublicTarget,
  checkTargetUrl,
  guardedRequest,
  UploadHttpError,
  type GuardOptions,
} from '../../src/mcp/tools/upload-http.js';
import { effectivePort } from '../../src/auth/ports.js';
import {
  code,
  Evidence,
  runLength,
  tally,
  txt,
  DEFAULT_SAMPLE_LINES,
  type CheckReport,
  type Verdict,
} from './spike-report.js';
import type { HttpCounters } from './soak.js';
import { SandboxGuardError } from './smoke.js';

type Obj = Record<string, any>;

// ------------------------------------------------------------------------------------------------ options

/** The known test-world ids (overridable with flags). */
export interface SpikeIds {
  /** The AI REPOSITORY root resource. */
  readonly root: string;
  /** The Universal Chronology resource. */
  readonly chronology: string;
  /** Its documents: the Main page, the Fourth Arkonan Age table page and timeline. */
  readonly mainDoc: string;
  readonly tableDoc: string;
  readonly timelineDoc: string;
  readonly calendar: string;
}

export const DEFAULT_SPIKE_IDS: SpikeIds = {
  root: 'fsbn0b7w',
  chronology: 'h0gczxh7',
  mainDoc: 'k6wkpozi',
  tableDoc: 'bt0bm3pc',
  timelineDoc: 'g2lm1d0v',
  calendar: 'rp86pkdr',
};

export interface SpikeOptions {
  readonly ids?: Partial<SpikeIds>;
  /** Check 2's queries. Defaults: a single-use word taken from the resource names, "Arkona", and "the". */
  readonly rareQuery?: string;
  readonly commonQuery?: string;
  /** Longest fenced sample, in lines (default 40). */
  readonly sampleLines?: number;
  /** Most `listAssets` calls the asset walk may make (default 600). */
  readonly maxAssetLists?: number;
  /** Largest asset body fetched in check 3 (default 25 MiB). */
  readonly maxAssetBytes?: number;
  /** Most extra pages of timeline events read to find a year-only, month-range and date-range event (default 8). */
  readonly maxEventPages?: number;
  /** Check numbers to leave out. */
  readonly skip?: ReadonlySet<number>;
  /** The outbound fetch guard for asset downloads: the bridge's production default (port 443, public addresses). */
  readonly guard?: GuardOptions;
  readonly log?: (line: string) => void;
  /** Stops the run between calls; the throwaway root is still deleted. */
  readonly signal?: AbortSignal;
}

export interface SpikeTarget {
  readonly engine: JobEngine;
  readonly lk: LkClient;
  readonly projectId: string;
  readonly counters: HttpCounters;
}

export interface SpikeOutcome {
  readonly checks: readonly CheckReport[];
  /** The calendar and events behind check 5, for the date engine's tests (written beside the report). */
  readonly oracle: unknown;
  readonly cleanup: { readonly attempted: boolean; readonly ok: boolean; readonly detail: string };
  readonly downloads: number;
  readonly ids: SpikeIds;
  readonly durationMs: number;
}

// ------------------------------------------------------------------------------------------------ small helpers

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const norm = (s: unknown) => (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim().toLowerCase();
const PREFIX = /^\s*\[(INDEX|BSRC)\]\s*/;
export type Kind = 'index' | 'bsrc' | 'unclassified';
export function kindOf(name: string): Kind {
  const m = /^\s*\[(INDEX|BSRC)\]/.exec(name);
  return m ? (m[1] === 'INDEX' ? 'index' : 'bsrc') : 'unclassified';
}
const display = (name: string) => name.replace(PREFIX, '').trim();
const kindTag = (k: Kind) => (k === 'index' ? 'INDEX' : k === 'bsrc' ? 'BSRC' : '?');

export function describeError(e: unknown): string {
  if (e instanceof LkOperationError) {
    const issues = e.lk.errors
      .slice(0, 3)
      .map((i) => `${i.path}: ${i.message}`)
      .join('; ');
    return `HTTP ${e.status ?? '?'} ${e.lkCode ?? ''} ${txt(e.message, 200)}${issues ? ` [${txt(issues, 200)}]` : ''}`.replace(
      /\s+/g,
      ' ',
    );
  }
  if (e instanceof JobsError) return `${e.code}: ${txt(e.message, 200)}`;
  return txt(e instanceof Error ? e.message : String(e), 240);
}
const lkCodeOf = (e: unknown): string | undefined => (e instanceof LkOperationError ? e.lkCode : undefined);

/** The lines of a JSON-schema object's fields: name (type) [required] description. */
function schemaFields(spec: Obj, schemaName: string): string[] {
  const pool = spec.components?.schemas ?? {};
  const resolve = (s: Obj): Obj => {
    let cur = s;
    for (let i = 0; i < 10 && typeof cur?.$ref === 'string'; i++)
      cur = pool[cur.$ref.split('/').pop()!] ?? {};
    return cur ?? {};
  };
  const describeType = (s: Obj): string => {
    const r = resolve(s);
    if (typeof s.$ref === 'string') return s.$ref.split('/').pop()!;
    if (r.enum) return `enum ${r.enum.join('|')}`;
    if (Array.isArray(r.type)) return r.type.join('|');
    if (r.type === 'array') return `array of ${r.items ? describeType(r.items) : '?'}`;
    if (r.allOf) return r.allOf.map((x: Obj) => describeType(x)).join(' & ');
    if (r.anyOf || r.oneOf) return (r.anyOf ?? r.oneOf).map((x: Obj) => describeType(x)).join(' | ');
    return String(r.type ?? 'object');
  };
  const schema = resolve(pool[schemaName] ?? {});
  const required = new Set<string>(schema.required ?? []);
  return Object.entries<Obj>(schema.properties ?? {}).map(
    ([k, v]) =>
      `${k} (${describeType(v)})${required.has(k) ? ' [required]' : ''}${v.description ? ` - ${txt(v.description, 90)}` : ''}`,
  );
}

function loadSpec(): Obj {
  return JSON.parse(
    readFileSync(new URL('../../spec/legendkeeper-openapi.json', import.meta.url), 'utf8'),
  ) as Obj;
}

// ------------------------------------------------------------------------------------------------ the context

/** Operations the spike may ever write, and only inside check 1's window and the throwaway tree. */
const WRITE_OPS = new Set(['createResource', 'createManyResources', 'deleteResource']);

export interface AssetWalk {
  readonly items: readonly Obj[];
  readonly firstPage: {
    readonly count: number;
    readonly hasMore: boolean;
    readonly types: readonly string[];
    readonly withFolderId: number;
  };
  readonly listings: number;
  /** The unfiltered listing already returns assets that live in folders (so a folder walk is redundant). */
  readonly flat: boolean;
  readonly truncated: boolean;
  readonly folderCheck: string;
  readonly duplicates: number;
}

export class Ctx {
  readonly origin = { kind: 'test' as const, client: 'spike-v2', tool: 'spike-v2' };
  readonly ids: SpikeIds;
  rootId: string | null = null;
  private rootState: { attempted: boolean; ok: boolean; detail: string } = {
    attempted: false,
    ok: true,
    detail: 'not created',
  };
  /** Ids of the throwaway tree (the root and everything the spike created under it). */
  private readonly owned = new Set<string>();
  private writesOpen = false;
  downloads = 0;
  /** Filled by check 5. */
  oracle: unknown = null;
  private readonly memo = new Map<string, Promise<unknown>>();
  private spec: Obj | undefined;

  constructor(
    readonly t: SpikeTarget,
    readonly o: {
      readonly ids: SpikeIds;
      readonly sampleLines: number;
      readonly maxAssetLists: number;
      readonly maxAssetBytes: number;
      readonly maxEventPages: number;
      readonly guard: GuardOptions;
      readonly log: (l: string) => void;
      readonly signal: AbortSignal | undefined;
      readonly rareQuery: string | undefined;
      readonly commonQuery: string;
    },
  ) {
    this.ids = o.ids;
  }

  evidence(): Evidence {
    return new Evidence(this.o.sampleLines);
  }
  openspec(): Obj {
    return (this.spec ??= loadSpec());
  }
  once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.memo.set(key, p);
    }
    return p;
  }
  get requests(): number {
    return this.t.counters.requests + this.downloads;
  }

  /** Opens the write window for check 1. */
  openWrites<T>(fn: () => Promise<T>): Promise<T> {
    this.writesOpen = true;
    return fn().finally(() => {
      this.writesOpen = false;
    });
  }

  /** The one way to reach LegendKeeper: the job engine at P3. Reads wait out budget pauses; writes are policed. */
  async call(op: string, params: Obj = {}, extra: { confirm?: string; force?: boolean } = {}): Promise<any> {
    if (!extra.force && this.o.signal?.aborted) throw new Error('The run was interrupted');
    const def = getOperation(op);
    if (!def) throw new Error(`spike bug: unknown operation ${op}`);
    const isRead = def.kind === 'read';
    if (!isRead) this.assertThrowawayWrite(op, params, extra.force === true);
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.t.engine.run(op, params, {
          origin: this.origin,
          priority: 'P3',
          title: `spike-v2: ${op}`,
          ...(extra.confirm ? { confirm: extra.confirm as 'cascade' } : {}),
        });
        if (r.status === 'succeeded') return r.result;
        if (r.status === 'proposal_captured') throw new Error(`${op} was captured as a proposal`);
        // Queued by the engine (a slow estimate, or the budget): reads are cancelled and tried again later; a write is
        // waited for, because it is already recorded as a job and must not be sent twice.
        if (isRead) {
          this.t.engine.controls.cancel(r.jobId);
          if (attempt >= 20) throw new Error(`${op} stayed queued (${r.reason})`);
          await sleep(Math.min(60_000, Math.max(2_000, (r.eta ?? Date.now()) - Date.now())));
          continue;
        }
        await this.waitForJob(r.jobId);
        return { queued: true, jobId: r.jobId };
      } catch (e) {
        if (e instanceof BudgetExhaustedError && attempt < 30) {
          await sleep(Math.min(120_000, Math.max(1_000, e.retryAtMs - Date.now())));
          continue;
        }
        throw e;
      }
    }
  }

  private async waitForJob(jobId: string): Promise<void> {
    let job: JobView;
    for (;;) {
      job = await this.t.engine.wait(jobId, 25_000);
      if (TERMINAL_JOB_STATUSES.has(job.status)) break;
      this.o.log(`  waiting for job ${jobId}: ${job.status}`);
    }
    if (job.status !== 'succeeded')
      throw new Error(`job ${jobId} ${job.status}: ${job.lastError?.message ?? 'no detail'}`);
  }

  /** Throws unless this write is inside check 1's window and touches only the throwaway tree. */
  private assertThrowawayWrite(op: string, params: Obj, cleanup: boolean): void {
    const bug = (why: string) => new Error(`spike bug: refused write ${op} (${why})`);
    if (!this.writesOpen) throw bug('outside check 1');
    if (!WRITE_OPS.has(op)) throw bug('not an allowed operation');
    const parentOk = (parentId: unknown) => typeof parentId === 'string' && this.owned.has(parentId);
    if (op === 'deleteResource') {
      if (!this.rootId || params.path?.resourceId !== this.rootId) throw bug('not the throwaway root');
      return;
    }
    if (cleanup) throw bug('cleanup may only delete');
    if (op === 'createResource') {
      const b = params.body ?? {};
      if (b.parentId === undefined && this.rootId === null && typeof b.id === 'string') {
        this.rootId = b.id; // the throwaway root itself: the one resource created at the top level
        this.owned.add(b.id);
        return;
      }
      if (!parentOk(b.parentId)) throw bug('parent is not in the throwaway tree');
      if (typeof b.id === 'string') this.owned.add(b.id);
      return;
    }
    // createManyResources: each parent is the throwaway tree or an earlier item of the same batch.
    const items = arr(params.body?.resources);
    const batch = new Set<string>();
    for (const it of items) {
      if (!parentOk(it.parentId) && !(typeof it.parentId === 'string' && batch.has(it.parentId)))
        throw bug('parent is not in the throwaway tree');
      if (typeof it.id === 'string') batch.add(it.id);
    }
    for (const id of batch) this.owned.add(id);
  }

  /** Deletes the throwaway root (cascade). Safe to call twice; used by check 1 and again as the last safety net. */
  async cleanupThrowaway(): Promise<{ attempted: boolean; ok: boolean; detail: string }> {
    if (!this.rootId || this.rootState.attempted) return this.rootState;
    const rootId = this.rootId;
    this.rootState = { attempted: true, ok: false, detail: 'delete in progress' };
    try {
      await this.openWrites(() =>
        this.call(
          'deleteResource',
          { path: { resourceId: rootId }, query: { cascade: true } },
          { confirm: 'cascade', force: true },
        ),
      );
      this.rootState = { attempted: true, ok: true, detail: 'deleted (cascade)' };
    } catch (e) {
      this.rootState =
        lkCodeOf(e) === 'NOT_FOUND'
          ? { attempted: true, ok: true, detail: 'was never created (not found)' }
          : {
              attempted: true,
              ok: false,
              detail: `${describeError(e)}. Delete resource ${rootId} by hand in LegendKeeper.`,
            };
    }
    return this.rootState;
  }
  get cleanup() {
    return this.rootState;
  }

  /** All items of a paged read. */
  async list(
    op: string,
    params: Obj,
    o: { limit?: number; maxPages?: number } = {},
  ): Promise<{ items: Obj[]; pages: number; truncated: boolean; last: Obj }> {
    const items: Obj[] = [];
    let cursor: string | undefined;
    let last: Obj = {};
    const maxPages = o.maxPages ?? 500;
    for (let pages = 1; pages <= maxPages; pages++) {
      last = await this.call(op, {
        ...params,
        query: { ...params.query, limit: o.limit ?? 100, ...(cursor ? { cursor } : {}) },
      });
      items.push(...arr(last.data));
      const next: unknown = last.nextCursor;
      if (!last.hasMore || typeof next !== 'string' || next === cursor)
        return { items, pages, truncated: false, last };
      cursor = next;
    }
    return { items, pages: maxPages, truncated: true, last };
  }

  // ---- shared reads --------------------------------------------------------------------------------------------

  /** Every resource of the project, listed once (about 35 reads for 3,500) and shared by checks 2, 7, 8 and 9. */
  resources(): Promise<ResourceIndex> {
    return this.once('resources', async () => {
      const r = await this.list('listResources', {}, { limit: 100, maxPages: 1000 });
      return new ResourceIndex(r.items, r.pages, r.truncated);
    });
  }

  /** The assets of the project, walked once and shared by checks 3 and 10. */
  assets(): Promise<AssetWalk> {
    return this.once('assets', () => this.walkAssets());
  }

  private async walkAssets(): Promise<AssetWalk> {
    const seen = new Map<string, Obj>();
    let duplicates = 0;
    let listings = 0;
    const take = (batch: Obj[]) => {
      for (const a of batch) {
        if (typeof a.id !== 'string') continue;
        if (seen.has(a.id)) duplicates++;
        else seen.set(a.id, a);
      }
    };
    // The first page, reported on its own.
    const first = await this.call('listAssets', { query: { limit: 100 } });
    listings++;
    const firstItems = arr(first.data);
    take(firstItems);
    const firstPage = {
      count: firstItems.length,
      hasMore: first.hasMore === true,
      types: firstItems.map((a) => String(a.type)),
      withFolderId: firstItems.filter((a) => a.folderId != null).length,
    };
    // The rest of the unfiltered listing.
    let cursor: string | undefined =
      first.hasMore === true && typeof first.nextCursor === 'string' ? first.nextCursor : undefined;
    let truncated = false;
    while (cursor) {
      if (listings >= this.o.maxAssetLists) {
        truncated = true;
        break;
      }
      const page = await this.call('listAssets', { query: { limit: 100, cursor } });
      listings++;
      take(arr(page.data));
      const next: unknown = page.nextCursor;
      cursor = page.hasMore === true && typeof next === 'string' && next !== cursor ? next : undefined;
    }
    const flat = firstPage.withFolderId > 0 || [...seen.values()].some((a) => a.folderId != null);
    let folderCheck: string;
    if (!flat) {
      // Root-only listing: walk the folders breadth first.
      const queue = [...seen.values()].filter((a) => a.type === 'FOLDER').map((a) => a.id as string);
      const walked = new Set<string>();
      while (queue.length > 0 && !truncated) {
        const folderId = queue.shift()!;
        if (walked.has(folderId)) continue;
        walked.add(folderId);
        let c: string | undefined;
        do {
          if (listings >= this.o.maxAssetLists) {
            truncated = true;
            break;
          }
          const page = await this.call('listAssets', {
            query: { limit: 100, folderId, ...(c ? { cursor: c } : {}) },
          });
          listings++;
          const batch = arr(page.data);
          take(batch);
          for (const a of batch)
            if (a.type === 'FOLDER' && typeof a.id === 'string' && !walked.has(a.id)) queue.push(a.id);
          const next: unknown = page.nextCursor;
          c = page.hasMore === true && typeof next === 'string' && next !== c ? next : undefined;
        } while (c);
      }
      folderCheck = `folder walk: ${walked.size} folder(s) listed${truncated ? `, stopped at the ${this.o.maxAssetLists}-listing cap` : ''}`;
    } else {
      // Flat listing: confirm with one folder that listing by folderId returns that folder's children.
      const folder = [...seen.values()].find(
        (a) => a.type === 'FOLDER' && [...seen.values()].some((x) => x.folderId === a.id),
      );
      if (folder && listings < this.o.maxAssetLists) {
        const expected = [...seen.values()].filter((x) => x.folderId === folder.id).length;
        const page = await this.call('listAssets', { query: { limit: 100, folderId: folder.id } });
        listings++;
        const got = arr(page.data).length;
        folderCheck = `listing folder ${code(folder.id)} gave ${got} item(s); the flat listing implies ${expected}${got === expected ? ' (agrees)' : page.hasMore ? ' (more pages)' : ' (DIFFERS)'}`;
      } else folderCheck = 'no folder with children to test';
    }
    return { items: [...seen.values()], firstPage, listings, flat, truncated, folderCheck, duplicates };
  }

  /** The chronology resource's documents, and a document id resolved to a (resource, document) pair. */
  chronologyDocs(): Promise<Obj[]> {
    return this.once('chronology', async () => {
      const r = await this.call('getResource', { path: { resourceId: this.ids.chronology } });
      return arr(r.documents);
    });
  }
  async resolveDoc(documentId: string): Promise<{ resourceId: string; documentId: string; note?: string }> {
    const docs = await this.chronologyDocs();
    if (docs.some((d) => d.id === documentId)) return { resourceId: this.ids.chronology, documentId };
    // Maybe the id names a resource (a page of its own): use its first document.
    try {
      const r = await this.call('getResource', { path: { resourceId: documentId } });
      const d = arr(r.documents)[0];
      if (d?.id)
        return {
          resourceId: documentId,
          documentId: d.id as string,
          note: `${documentId} is a resource; used its first document ${d.id}`,
        };
    } catch {
      /* fall through */
    }
    throw new Error(
      `${documentId} is not a document of resource ${this.ids.chronology} (its documents: ${docs.map((d) => `${d.id} "${txt(d.name, 30)}" ${d.type}`).join('; ') || 'none'})`,
    );
  }

  /** Timeline events for checks 4 and 5. */
  events(): Promise<EventScan> {
    return this.once('events', () => scanEvents(this));
  }
}

// ------------------------------------------------------------------------------------------------ resource index

export class ResourceIndex {
  readonly byId = new Map<string, Obj>();
  private readonly kids = new Map<string, Obj[]>();
  constructor(
    readonly all: readonly Obj[],
    readonly pages: number,
    readonly truncated: boolean,
  ) {
    for (const r of all) this.byId.set(r.id as string, r);
    for (const r of all) {
      const p = typeof r.parentId === 'string' ? r.parentId : '';
      const list = this.kids.get(p) ?? [];
      list.push(r);
      this.kids.set(p, list);
    }
    for (const list of this.kids.values())
      list.sort(
        (a, b) => cmp(String(a.rank ?? ''), String(b.rank ?? '')) || cmp(String(a.name), String(b.name)),
      );
  }
  children(id: string): readonly Obj[] {
    return this.kids.get(id) ?? [];
  }
  /** The subtree below `rootId` in tree order (rank order, depth first), root first, each with its depth. */
  subtree(rootId: string): { node: Obj; depth: number }[] {
    const root = this.byId.get(rootId);
    if (!root) return [];
    const out: { node: Obj; depth: number }[] = [];
    const seen = new Set<string>();
    const walk = (n: Obj, depth: number) => {
      if (seen.has(n.id as string)) return;
      seen.add(n.id as string);
      out.push({ node: n, depth });
      for (const c of this.children(n.id as string)) walk(c, depth + 1);
    };
    walk(root, 0);
    return out;
  }
  /** Display names from the top of the subtree down to the resource. */
  pathOf(id: string, stopAt: string): string {
    const names: string[] = [];
    for (let cur = this.byId.get(id), i = 0; cur && i < 100; i++) {
      names.unshift(display(String(cur.name)));
      if (cur.id === stopAt || typeof cur.parentId !== 'string') break;
      cur = this.byId.get(cur.parentId);
    }
    return names.join(' / ');
  }
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------------------------------------ events

export type EventShape =
  'year-only' | 'year-range' | 'month-only' | 'month-range' | 'day' | 'date-range' | 'time' | 'time-range';
export function eventShape(e: Obj): EventShape {
  const detail = typeof e.detail === 'number' ? e.detail : 3; // absent means day
  const range = typeof e.end === 'number' && e.end !== e.start;
  const base = detail <= 1 ? 'year' : detail === 2 ? 'month' : detail === 3 ? 'day' : 'time';
  if (base === 'year') return range ? 'year-range' : 'year-only';
  if (base === 'month') return range ? 'month-range' : 'month-only';
  if (base === 'day') return range ? 'date-range' : 'day';
  return range ? 'time-range' : 'time';
}

interface EventScan {
  readonly lanes: Obj[];
  readonly docRef: { resourceId: string; documentId: string; note?: string };
  readonly first30: Obj[];
  readonly scanned: Obj[];
  readonly extraPages: number;
  readonly hasMoreAfterScan: boolean;
  readonly samples: Obj[];
}
const WANTED_SHAPES: EventShape[] = ['year-only', 'month-range', 'date-range'];

async function scanEvents(ctx: Ctx): Promise<EventScan> {
  const docRef = await ctx.resolveDoc(ctx.ids.timelineDoc);
  const path = { resourceId: docRef.resourceId, documentId: docRef.documentId };
  const lanes = arr((await ctx.call('listLanes', { path })).data);
  const page1 = await ctx.call('listEvents', { path, query: { limit: 30 } });
  const first30 = arr(page1.data).slice(0, 30);
  const scanned = [...arr(page1.data)];
  let cursor: unknown = page1.hasMore === true ? page1.nextCursor : undefined;
  let extraPages = 0;
  const have = () => WANTED_SHAPES.every((s) => scanned.some((e) => eventShape(e) === s));
  while (typeof cursor === 'string' && !have() && extraPages < ctx.o.maxEventPages) {
    const p = await ctx.call('listEvents', { path, query: { limit: 100, cursor } });
    extraPages++;
    scanned.push(...arr(p.data));
    cursor = p.hasMore === true && p.nextCursor !== cursor ? p.nextCursor : undefined;
  }
  // Five samples: one of each wanted shape that exists, then other shapes, then the first events.
  const samples: Obj[] = [];
  const add = (e: Obj | undefined) => {
    if (e && !samples.includes(e) && samples.length < 5) samples.push(e);
  };
  for (const s of WANTED_SHAPES) add(scanned.find((e) => eventShape(e) === s));
  const shapesUsed = new Set(samples.map(eventShape));
  for (const e of scanned) {
    if (shapesUsed.has(eventShape(e))) continue;
    add(e);
    shapesUsed.add(eventShape(e));
  }
  for (const e of scanned) add(e);
  return {
    lanes,
    docRef,
    first30,
    scanned,
    extraPages,
    hasMoreAfterScan: typeof cursor === 'string',
    samples,
  };
}

// ------------------------------------------------------------------------------------------------ blocks (check 6)

interface CellInfo {
  readonly text: string;
  readonly header: boolean;
  readonly blocks: number;
  readonly paragraphs: number;
  readonly childKinds: readonly string[];
  readonly runs: readonly string[];
  readonly mentions: readonly Obj[];
  readonly links: number;
  readonly marks: readonly string[];
}
const MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'sub', 'sup'] as const;

function runsOf(block: Obj): Obj[] {
  const own = arr(block.content);
  const out = [...own];
  for (const c of arr(block.children)) out.push(...runsOf(c));
  return out;
}
function describeRun(r: Obj): string {
  if (r.mention) {
    const m = r.mention as Obj;
    return `mention(res ${m.resourceId}${m.documentId ? `, doc ${m.documentId}` : ''}, label ${JSON.stringify(txt(m.text ?? m.name ?? '', 30))})`;
  }
  if (r.break) return 'break';
  const marks = [...MARKS.filter((k) => r[k] === true), ...(r.link ? ['link'] : [])];
  return `text${marks.length ? `+${marks.join('+')}` : ''}(${JSON.stringify(txt(r.text, 30))})`;
}
function cellInfo(cell: Obj): CellInfo {
  const kids = arr(cell.children);
  const runs = kids.flatMap(runsOf);
  const text = runs
    .map((r) =>
      typeof r.text === 'string'
        ? r.text
        : r.mention
          ? String(r.mention.text ?? r.mention.name ?? '')
          : r.break
            ? ' '
            : '',
    )
    .join('');
  return {
    text: text.replace(/\s+/g, ' ').trim(),
    header: cell.header === true,
    blocks: kids.length,
    paragraphs: kids.filter((k) => k.kind === 'paragraph').length,
    childKinds: kids.map((k) => String(k.kind)),
    runs: runs.map(describeRun),
    mentions: runs.filter((r) => r.mention).map((r) => r.mention as Obj),
    links: runs.filter((r) => typeof r.link === 'string').length,
    marks: [...new Set(runs.flatMap((r) => MARKS.filter((k) => r[k] === true)))],
  };
}
interface TableInfo {
  readonly header: CellInfo[];
  readonly rows: CellInfo[][];
  readonly unsupported: number;
  readonly multiBlock: string[];
  readonly colspans: number;
}
function tableInfo(table: Obj): TableInfo {
  const trs = arr(table.children).filter((r) => r.kind === 'tableRow');
  const grid = trs.map((tr) => arr(tr.children).map((c) => ({ raw: c, info: cellInfo(c) })));
  const headerIndex = 1; // the first row is the header row
  const header = (grid[0] ?? []).map((c) => c.info);
  const rows = grid.slice(headerIndex).map((r) => r.map((c) => c.info));
  const multiBlock: string[] = [];
  grid.slice(headerIndex).forEach((r, i) =>
    r.forEach((c, j) => {
      if (c.info.blocks > 1 || c.info.childKinds.some((k) => k !== 'paragraph'))
        multiBlock.push(`row ${i + 1} col ${j + 1} (${c.info.childKinds.join('+') || 'empty'})`);
    }),
  );
  const flat = JSON.stringify(table);
  return {
    header,
    rows,
    unsupported: (flat.match(/"kind":"unsupported"/g) ?? []).length,
    multiBlock,
    colspans:
      (flat.match(/"colspan":(?!1[,}])\d+/g) ?? []).length +
      (flat.match(/"rowspan":(?!1[,}])\d+/g) ?? []).length,
  };
}
export type DateForm =
  'year-only' | 'year-range' | 'month-range' | 'date-range' | 'dated' | 'unknown-year' | 'other';
export function dateForm(text: string): DateForm {
  const t = text.trim();
  const sep = /\s[-–—]\s/.test(t);
  const commas = (t.match(/,/g) ?? []).length;
  if (/unknown/i.test(t)) return 'unknown-year';
  if (sep) return commas >= 2 ? 'date-range' : commas === 1 ? 'month-range' : 'year-range';
  if (commas === 0 && /^\S+\s+\d+$/.test(t)) return 'year-only';
  if (commas >= 1) return 'dated';
  return 'other';
}
const rowLine = (n: number, cells: CellInfo[]) =>
  `${String(n).padStart(4)}: ${cells.map((c) => txt(c.text, 44)).join(' | ')}`;
const headerLine = (cells: CellInfo[]) =>
  `head: ${cells.map((c) => `${txt(c.text, 30)}${c.header ? ' [header]' : ''}`).join(' | ')}`;

/** Describes a block list: top-level kinds in order, then the first table in it. */
function describeBlocks(
  ev: Evidence,
  blocks: Obj[],
): { table: Obj | undefined; info: TableInfo | undefined } {
  const kinds = blocks.map((b) => String(b.kind));
  ev.bullet(`Top-level blocks (${blocks.length}), in order: ${runLength(kinds)}`);
  const tables = blocks.filter((b) => b.kind === 'table');
  const table = tables[0];
  ev.bullet(
    `Tables at the top level: ${tables.length}. \`unsupported\` blocks anywhere in the page: ${(JSON.stringify(blocks).match(/"kind":"unsupported"/g) ?? []).length}.`,
  );
  return { table, info: table ? tableInfo(table) : undefined };
}

// ------------------------------------------------------------------------------------------------ checks

interface CheckResult {
  readonly verdict: Verdict;
  readonly summary: string;
}
type CheckFn = (ctx: Ctx, ev: Evidence) => Promise<CheckResult>;
const nodeLabel = (n: Obj) => `${code(n.name, 50)} (${n.id})`;

// ---- 1. createManyResources nesting (the only check that writes) ----------------------------------------------------
const check1: CheckFn = async (ctx, ev) => {
  const a = mintClientId();
  const b = mintClientId();
  const c = mintClientId();
  let result: CheckResult | undefined;
  let failure: unknown;
  /** The tree LegendKeeper reports under `rootId` for a chain of ids: each level read with listResources by parentId. */
  const treeOf = async (rootId: string, ids: string[]) => {
    const lines: string[] = [];
    const found: Obj[] = [];
    let parent = rootId;
    for (const [depth, id] of ids.entries()) {
      const kids = arr((await ctx.call('listResources', { query: { parentId: parent, limit: 100 } })).data);
      for (const k of kids)
        lines.push(`${'  '.repeat(depth)}- ${txt(k.name, 40)} (${k.id}) parentId=${k.parentId}`);
      const next = kids.find((k) => k.id === id);
      if (!next) break;
      found.push(next);
      parent = id;
    }
    return { lines, found };
  };
  try {
    result = await ctx.openWrites(async () => {
      const rootId = mintClientId();
      const stamp = new Date().toISOString();
      await ctx.call('createResource', { body: { id: rootId, name: `lk-bridge spike ${stamp}` } });
      ev.bullet(
        `Throwaway root ${code(rootId)} created (a plain resource at the top level; deleted at the end of this check).`,
      );
      const items = [
        { id: a, name: 'spike A', parentId: rootId },
        { id: b, name: 'spike B', parentId: a },
        { id: c, name: 'spike C', parentId: b },
      ];
      ev.label(
        'Batch sent (one createManyResources call, B under A and C under B, all minted ids in the same batch)',
      );
      ev.sample(
        items.map(
          (i) => `${i.name}: id ${i.id}, parentId ${i.parentId}${i.parentId === rootId ? ' (the root)' : ''}`,
        ),
      );
      let accepted = false;
      let refusal = '';
      let returned: Obj[] = [];
      try {
        const res = await ctx.call('createManyResources', { body: { resources: items } });
        accepted = true;
        returned = arr(res?.resources);
      } catch (e) {
        refusal = describeError(e);
      }
      if (accepted) {
        ev.bullet('LegendKeeper **accepted** the batch.');
        if (returned.length > 0)
          ev.bullet(
            `Response echoes ${returned.length} resource(s) in request order: ${returned.map((r) => `${txt(r.name, 12)}→parent ${r.parentId ?? '-'}`).join(', ')}.`,
          );
        const t = await treeOf(rootId, [a, b, c]);
        ev.label('Resulting tree under the throwaway root (listResources by parentId)');
        ev.sample(t.lines.length > 0 ? t.lines : ['(nothing found under the root)']);
        const nested =
          t.found.length === 3 &&
          t.found[0]?.id === a &&
          t.found[1]?.id === b &&
          t.found[2]?.id === c &&
          t.found[1]?.parentId === a &&
          t.found[2]?.parentId === b;
        return nested
          ? {
              verdict: 'PASS',
              summary:
                'A parent minted in the same batch works: A, B and C came out nested as asked (one call).',
            }
          : {
              verdict: 'FAIL',
              summary: 'The batch was accepted but the nesting is NOT what was asked (see the tree).',
            };
      }
      ev.bullet(`LegendKeeper **refused** the batch: ${refusal}`);
      const leftovers = arr(
        (await ctx.call('listResources', { query: { parentId: rootId, limit: 100 } })).data,
      );
      ev.bullet(
        `Resources left under the root by the refused batch: ${leftovers.length}${leftovers.length > 0 ? ` (${leftovers.map((l) => txt(l.name, 20)).join(', ')})` : ''}.`,
      );
      // Fallback: the same three, as three ordered calls.
      const d = mintClientId();
      const e = mintClientId();
      const f = mintClientId();
      let fallback: string;
      try {
        await ctx.call('createResource', { body: { id: d, name: 'spike D', parentId: rootId } });
        await ctx.call('createResource', { body: { id: e, name: 'spike E', parentId: d } });
        await ctx.call('createResource', { body: { id: f, name: 'spike F', parentId: e } });
        const t = await treeOf(rootId, [d, e, f]);
        const ok = t.found.length === 3 && t.found[1]?.parentId === d && t.found[2]?.parentId === e;
        fallback = ok ? 'PASS' : 'FAIL (tree differs)';
        ev.label('Fallback: three ordered createResource calls (D under the root, E under D, F under E)');
        ev.sample(t.lines);
      } catch (err) {
        fallback = `FAIL (${describeError(err)})`;
      }
      ev.bullet(`Fallback result: **${fallback}**.`);
      return {
        verdict: 'FAIL',
        summary: `Nesting in one batch is refused (${txt(refusal, 90)}). Three ordered calls: ${fallback.split(' ')[0]}.`,
      };
    });
  } catch (e) {
    failure = e;
  }
  const cleanup = await ctx.cleanupThrowaway();
  ev.bullet(
    `Clean-up: ${cleanup.attempted ? (cleanup.ok ? cleanup.detail : `**FAILED**: ${cleanup.detail}`) : 'nothing to delete'}.`,
  );
  if (failure) throw failure instanceof Error ? failure : new Error('check 1 failed', { cause: failure });
  return result!;
};

// ---- 2. search behaviour --------------------------------------------------------------------------------------------
const check2: CheckFn = async (ctx, ev) => {
  const index = await ctx.resources();
  // The rare name: a word that occurs in exactly one resource name (longest first), unless given.
  let rare = ctx.o.rareQuery;
  let how = 'given with --rare-query';
  if (!rare) {
    const counts = new Map<string, number>();
    for (const r of index.all)
      for (const w of new Set(
        String(r.name)
          .toLowerCase()
          .match(/[a-z]{6,}/g) ?? [],
      ))
        counts.set(w, (counts.get(w) ?? 0) + 1);
    rare =
      [...counts]
        .filter(([, n]) => n === 1)
        .sort((x, y) => y[0].length - x[0].length || cmp(x[0], y[0]))[0]?.[0] ?? 'Arkona';
    how = 'a word that appears in exactly one resource name';
  }
  const queries = [
    { label: 'rare', q: rare, note: how },
    { label: 'broad', q: 'Arkona', note: 'fixed' },
    { label: 'common', q: ctx.o.commonQuery, note: 'a very common word' },
  ];
  const rows: string[] = [];
  const problems: string[] = [];
  let capped = false;
  for (const { label, q, note } of queries) {
    const r100 = await ctx.call('search', { query: { q, limit: 100 } });
    const r50 = await ctx.call('search', { query: { q, limit: 50 } });
    const d100 = arr(r100.data);
    const d50 = arr(r50.data);
    const ids100 = d100.map((x) => String(x.resource?.id));
    const distinct = new Set(ids100);
    const dupes = ids100.length - distinct.size;
    const withDoc = d100.filter((x) => x.document).length;
    const known = index.all.filter((r) => norm(r.name).includes(norm(q)));
    const missing = known.filter((r) => !distinct.has(r.id as string));
    const samePrefix = d50.every(
      (x, i) => x.resource?.id === d100[i]?.resource?.id && x.document?.id === d100[i]?.document?.id,
    );
    const notes: string[] = [];
    if (r100.hasMore === true && d100.length < 100) notes.push('hasMore=true below the limit');
    if (d100.length < 100 && d50.length === 50 && d100.length === 50)
      notes.push('limit 100 gave no more than limit 50');
    if (d100.length < d50.length) notes.push('limit 100 gave FEWER than limit 50');
    if (missing.length > 0 && d100.length < 100)
      notes.push(`${missing.length} resource name(s) containing the query are absent`);
    if (notes.length > 0) {
      capped = true;
      problems.push(`${code(q, 30)}: ${notes.join('; ')}`);
    }
    rows.push(
      `${label.padEnd(6)} q=${JSON.stringify(q)} (${note})`,
      `       limit 100 → ${d100.length} results, ${distinct.size} distinct resources, ${dupes} repeat(s), ${withDoc} content hit(s), hasMore=${r100.hasMore === true}, nextCursor=${r100.nextCursor ? 'yes' : 'no'}`,
      `       limit 50  → ${d50.length} results, hasMore=${r50.hasMore === true}; same order as the first ${d50.length} of limit 100: ${samePrefix ? 'yes' : 'NO'}`,
      `       resource names containing the query (from the listing): ${known.length}; of those not in the limit-100 results: ${missing.length}${
        missing.length > 0
          ? ` e.g. ${missing
              .slice(0, 3)
              .map((m) => JSON.stringify(txt(m.name, 24)))
              .join(', ')}`
          : ''
      }`,
      `       repeated resources: ${
        dupes > 0
          ? tally(
              ids100
                .filter((id, i) => ids100.indexOf(id) !== i)
                .map((id) => `${txt(index.byId.get(id)?.name ?? id, 24)}`),
              3,
            )
          : 'none'
      }`,
    );
  }
  ev.bullet(
    'Search takes `q` and `limit` only (no cursor parameter in the spec). Each query was sent with limit 100 and limit 50.',
  );
  ev.bullet(
    `Resource names used for cross-checking come from the full listing (${index.all.length} resources).`,
  );
  ev.sample(rows);
  ev.bullet(
    capped
      ? `Possible hidden cap: ${problems.join(' | ')}`
      : 'No sign of a hidden cap: no query returned fewer than asked while more were known to exist.',
  );
  return capped
    ? { verdict: 'FAIL', summary: `Search looks capped or inconsistent: ${txt(problems.join(' | '), 140)}` }
    : {
        verdict: 'PASS',
        summary:
          'Search honours limit 100 and 50 with no sign of a hidden cap; see the notes on repeated resources.',
      };
};

// ---- 3. asset download -----------------------------------------------------------------------------------------------
interface Download {
  readonly ok: boolean;
  readonly status?: number;
  readonly contentType?: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly location?: string;
  readonly refusal?: string;
  readonly ms: number;
}
async function downloadThroughGuard(ctx: Ctx, url: string): Promise<Download> {
  const started = Date.now();
  const guard = ctx.o.guard;
  let target: URL;
  try {
    target = checkTargetUrl(url, guard);
    await assertPublicTarget(url, guard);
  } catch (e) {
    return {
      ok: false,
      refusal: e instanceof UploadHttpError ? `${e.reason}: ${e.message}` : describeError(e),
      ms: Date.now() - started,
    };
  }
  ctx.downloads++;
  // One governed call: pacing, in-flight cap and P3 priority apply; the body is fetched by the guarded request, which
  // checks the port and every address inside the connection's DNS lookup and never sends a credential.
  const r = await ctx.t.lk.governor.execute<Download>({
    opId: 'spike.downloadAsset',
    kind: 'read',
    costs: { tiers: [] },
    priority: 'P3',
    run: async (signal) => {
      try {
        const res = await guardedRequest({
          ...guard,
          url: target,
          method: 'GET',
          headers: { accept: 'image/*,*/*;q=0.5', 'user-agent': 'lk-bridge-spike' },
          signal,
          timeoutMs: 60_000,
          maxResponseBytes: ctx.o.maxAssetBytes,
        });
        const loc = res.headers['location'];
        return {
          ok: true,
          status: res.status,
          contentType: res.headers['content-type'] ?? '(none)',
          bytes: res.body.length,
          sha256: createHash('sha256').update(res.body).digest('hex'),
          ...(loc ? { location: safeHost(loc, target) } : {}),
          ms: Date.now() - started,
        };
      } catch (e) {
        return {
          ok: false,
          refusal: e instanceof UploadHttpError ? `${e.reason}: ${e.message}` : describeError(e),
          ms: Date.now() - started,
        };
      }
    },
  });
  return r;
}
function safeHost(location: string, base: URL): string {
  try {
    return new URL(location, base).host;
  } catch {
    return '(unparseable)';
  }
}
const urlShape = (u: URL) =>
  `${u.protocol}//${u.host}${u.pathname.split('/').slice(0, 3).join('/')}/…${u.search ? ' (+query string, not shown)' : ''}`;

const check3: CheckFn = async (ctx, ev) => {
  const walk = await ctx.assets();
  const first300 = walk.items.slice(0, 300);
  const images = first300.filter((a) => a.type === 'IMAGE' && typeof a.url === 'string');
  ev.bullet(
    `First page of listAssets: ${walk.firstPage.count} item(s) (${tally(walk.firstPage.types)}), hasMore=${walk.firstPage.hasMore}. ` +
      `Walk covered ${walk.items.length} asset(s) in ${walk.listings} listing call(s); this check looks at the first ${first300.length} found: ${tally(first300.map((a) => String(a.type)))}.`,
  );
  const hosts = tally(
    images.map((a) => {
      try {
        return new URL(a.url as string).host;
      } catch {
        return '(bad url)';
      }
    }),
  );
  ev.bullet(`Image assets with a \`url\` in those: ${images.length}. Hosts: ${hosts}.`);
  if (images.length === 0)
    return {
      verdict: 'INFO',
      summary: 'No image assets with a url found in the first 300 assets; nothing to download.',
    };
  // Three images, from different folders where possible.
  const pick: Obj[] = [];
  for (const a of images) if (pick.length < 3 && !pick.some((p) => p.folderId === a.folderId)) pick.push(a);
  for (const a of images) if (pick.length < 3 && !pick.includes(a)) pick.push(a);
  const lines: string[] = [];
  let fine = 0;
  let blocked = 0;
  let needAuth = 0;
  for (const a of pick) {
    const d = await downloadThroughGuard(ctx, a.url as string);
    let shape = '(bad url)';
    let port = '?';
    try {
      const u = new URL(a.url as string);
      shape = urlShape(u);
      port = String(effectivePort(u));
    } catch {
      /* keep defaults */
    }
    lines.push(
      `${JSON.stringify(txt(a.name, 40))} (asset ${a.id}, ${a.width ?? '?'}×${a.height ?? '?'})`,
      `  url shape: ${shape}`,
    );
    if (d.refusal) {
      const isGuard = /^(blocked_port|blocked_address|invalid_url|dns):/.test(d.refusal);
      if (isGuard) blocked++;
      lines.push(`  guard: ${isGuard ? 'REFUSED' : 'allowed'}; result: ${d.refusal} (port ${port})`);
      continue;
    }
    const authNeeded = d.status === 401 || d.status === 403;
    if (authNeeded) needAuth++;
    if (d.status === 200) fine++;
    lines.push(
      `  guard: allowed (https, port ${port}, public address); credentials sent: none`,
      `  status ${d.status}, content-type ${d.contentType}, ${d.bytes} bytes, ${d.ms} ms${d.location ? `, redirect to ${d.location} (not followed)` : ''}`,
      `  sha256 ${d.sha256}`,
      `  authentication needed: ${d.status === 200 ? 'no (anonymous GET worked)' : authNeeded ? 'YES (anonymous GET refused)' : 'unclear'}`,
    );
  }
  ev.label(`Downloads through the outbound guard (${pick.length})`);
  ev.sample(lines);
  if (fine > 0)
    return {
      verdict: 'PASS',
      summary: `${fine} of ${pick.length} images downloaded anonymously through the guard (status 200, SHA-256 recorded).`,
    };
  if (blocked > 0)
    return {
      verdict: 'FAIL',
      summary: `The outbound guard refused the asset host (${blocked} of ${pick.length}); see the reason.`,
    };
  return {
    verdict: 'FAIL',
    summary:
      needAuth > 0
        ? 'The asset host refused anonymous downloads (authentication needed).'
        : 'No image could be downloaded (see the statuses).',
  };
};

// ---- 4. timeline events ---------------------------------------------------------------------------------------------
const check4: CheckFn = async (ctx, ev) => {
  const scan = await ctx.events();
  ev.bullet(
    `Timeline ${code(scan.docRef.documentId)} of resource ${code(scan.docRef.resourceId)}${scan.docRef.note ? ` (${scan.docRef.note})` : ''}: ${scan.lanes.length} lane(s).`,
  );
  ev.sample(
    scan.lanes.map(
      (l) =>
        `${l.id}  ${JSON.stringify(txt(l.name, 40))}  size ${l.size}  rank ${l.rank}${l.style ? `  style ${JSON.stringify(l.style).slice(0, 60)}` : ''}`,
    ),
  );
  const shapes = scan.first30.map(eventShape);
  ev.bullet(
    `First ${scan.first30.length} event(s): shapes ${tally(shapes)}; types ${tally(scan.first30.map((e) => String(e.type)))}; ` +
      `every one has formattedStart: ${scan.first30.every((e) => typeof e.formattedStart === 'string')}; with an end: ${scan.first30.filter((e) => e.end != null).length}.`,
  );
  const allShapes = tally(scan.scanned.map(eventShape));
  ev.bullet(
    `To find a year-only, a month-range and a date-range event, ${scan.extraPages} more page(s) were read (${scan.scanned.length} events scanned in all${scan.hasMoreAfterScan ? ', more remain' : ''}). Shapes seen: ${allShapes}.`,
  );
  const lookup = (s: EventShape) => scan.scanned.find((e) => eventShape(e) === s);
  ev.label('How each shape is represented (the first event of each kind that exists)');
  const rep: string[] = [];
  for (const s of WANTED_SHAPES) {
    const e = lookup(s);
    rep.push(
      e
        ? `${s.padEnd(11)} → detail=${e.detail ?? '(absent)'}, start=${e.start}, end=${e.end ?? '(absent)'}, formattedStart=${JSON.stringify(e.formattedStart)}, formattedEnd=${JSON.stringify(e.formattedEnd ?? null)}`
        : `${s.padEnd(11)} → none found in ${scan.scanned.length} event(s)`,
    );
  }
  ev.sample(rep);
  ev.label('Five sample events, raw fields (urls shortened)');
  for (const e of scan.samples) {
    const copy: Obj = {};
    for (const [k, v] of Object.entries(e))
      copy[k] = k === 'imageUrl' && typeof v === 'string' ? '<image url>' : v;
    ev.caption(`${eventShape(e)}: ${JSON.stringify(txt(e.name, 50))}`);
    ev.fields(copy);
  }
  // The field lists from the vendored spec.
  const spec = ctx.openspec();
  const createRef: string | undefined =
    spec.paths?.['/api/v3/projects/{projectId}/resources/{resourceId}/docs/{documentId}/events']?.post
      ?.requestBody?.content?.['application/json']?.schema?.$ref;
  const createName = createRef?.split('/').pop();
  ev.label('Event schema fields in the vendored OpenAPI spec (spec/legendkeeper-openapi.json)');
  ev.caption('Event (what listEvents returns):');
  ev.sample(schemaFields(spec, 'Event'));
  ev.caption('EventDate (startDate and endDate):');
  ev.sample(schemaFields(spec, 'EventDate'));
  if (createName) {
    ev.caption(`${createName} (createEvent body):`);
    ev.sample(schemaFields(spec, createName));
  }
  const missingFormatted = scan.first30.filter((e) => typeof e.formattedStart !== 'string').length;
  const found = WANTED_SHAPES.map((s) => `${s} ${lookup(s) ? 'found' : 'not found'}`).join(', ');
  if (scan.first30.length === 0) return { verdict: 'FAIL', summary: 'The timeline returned no events.' };
  if (missingFormatted > 0)
    return {
      verdict: 'FAIL',
      summary: `${missingFormatted} of the first ${scan.first30.length} events lack formattedStart.`,
    };
  return { verdict: 'PASS', summary: `Events carry formattedStart/End, detail and minute values; ${found}.` };
};

// ---- 5. calendar arithmetic oracle ----------------------------------------------------------------------------------
function eraAt(cal: Obj, minute: number): Obj | undefined {
  if (minute < 0) return cal.negativeEra;
  let found: Obj | undefined;
  for (const era of arr(cal.positiveEras))
    if (typeof era.startsAt === 'number' && era.startsAt <= minute) found = era;
  return found;
}
const check5: CheckFn = async (ctx, ev) => {
  const cals = arr((await ctx.call('listCalendars')).data);
  const cal = cals.find((c) => c.id === ctx.ids.calendar);
  if (!cal) {
    ev.bullet(
      `Calendar ${code(ctx.ids.calendar)} was not found. Calendars in the project: ${cals.map((c) => `${c.id} "${txt(c.name, 30)}"`).join('; ') || 'none'}.`,
    );
    return { verdict: 'FAIL', summary: `Calendar ${ctx.ids.calendar} not found.` };
  }
  const months = arr(cal.months);
  const perYear = months
    .filter((m) => m.interval === 1 || m.interval === undefined)
    .reduce((n, m) => n + Number(m.length), 0);
  const minutesPerDay = Number(cal.hoursInDay) * Number(cal.minutesInHour);
  ev.bullet(
    `${code(cal.name)} (${cal.id}): ${months.length} months; ${perYear} days in a year of always-present months.`,
  );
  ev.bullet(
    `${cal.hoursInDay}-hour days of ${cal.minutesInHour}-minute hours: ${minutesPerDay} minutes a day, ${perYear * minutesPerDay} minutes a year.`,
  );
  ev.bullet(
    `${arr(cal.leapDays).length} leap day rule(s), ${arr(cal.weekdays).length} weekday(s), hasZeroYear=${cal.hasZeroYear}, maxMinutes=${cal.maxMinutes}.`,
  );
  ev.bullet(`Top-level fields of a calendar: ${Object.keys(cal).join(', ')}.`);
  ev.label('Months, in order (length; i = interval, offset; * = intercalary)');
  const mlines: string[] = [];
  for (let i = 0; i < months.length; i += 3)
    mlines.push(
      months
        .slice(i, i + 3)
        .map(
          (m, j) =>
            `${String(i + j + 1).padStart(2)}. ${String(m.name).padEnd(12)} ${m.length}d${m.isIntercalary ? '*' : ''}${m.interval !== 1 ? ` i${m.interval}/${m.offset}` : ''}`,
        )
        .join('   '),
    );
  ev.sample(mlines);
  ev.label('Eras (startsAt in minutes, resetMode, abbr)');
  const elines: string[] = [];
  if (cal.negativeEra) {
    const n = cal.negativeEra as Obj;
    elines.push(
      `negative: ${n.id} ${JSON.stringify(n.name)} abbr=${JSON.stringify(n.abbr)} startsAt=${n.startsAt} resetMode=${n.resetMode} hideAbbr=${n.hideAbbr ?? false}`,
    );
  }
  for (const e of arr(cal.positiveEras))
    elines.push(
      `forward:  ${e.id} ${JSON.stringify(e.name)} abbr=${JSON.stringify(e.abbr ?? '(default AD)')} startsAt=${e.startsAt} resetMode=${e.resetMode} hideAbbr=${e.hideAbbr ?? false}`,
    );
  ev.sample(elines);
  ev.label('Formats');
  ev.fields((cal.format ?? {}) as Obj);
  if (cal.halfClock !== undefined) ev.text(`halfClock: ${String(cal.halfClock)}`);

  // The oracle: LegendKeeper's own minute values and formatted text for sampled events, with the era.
  const scan = await ctx.events();
  const sample = [...scan.samples];
  for (const s of WANTED_SHAPES) {
    const e = scan.scanned.find((x) => eventShape(x) === s);
    if (e && !sample.includes(e)) sample.push(e);
  }
  const rows: string[] = [];
  let mismatches = 0;
  for (const e of sample) {
    const start = Number(e.start);
    const mine = eraAt(cal, start);
    const lk = e.startDate?.era as Obj | undefined;
    const agrees = mine !== undefined && lk !== undefined && mine.id === lk.id;
    if (!agrees) mismatches++;
    rows.push(
      `${eventShape(e).padEnd(11)} start=${start} → ${JSON.stringify(e.formattedStart)}  era ${lk?.abbr ?? '?'} (${lk?.id ?? '?'}) ${agrees ? '' : `[calendar says ${mine?.id ?? '?'}: MISMATCH] `}` +
        `y${e.startDate?.year} m${e.startDate?.month} ${e.startDate?.monthName ?? ''} d${e.startDate?.day}` +
        (e.end !== undefined ? `  end=${e.end} → ${JSON.stringify(e.formattedEnd)}` : ''),
    );
  }
  ev.label(
    `Oracle rows: ${sample.length} sampled event(s) (minute value, LegendKeeper's formatted text, era); all ${scan.scanned.length} scanned events are in the oracle file`,
  );
  ev.sample(rows);
  ev.bullet(
    mismatches === 0
      ? "For every sampled event, the era worked out from the calendar's `startsAt` values (the last era starting at or before the minute) is the era LegendKeeper reports."
      : `${mismatches} sampled event(s): the era from the calendar's startsAt values differs from LegendKeeper's.`,
  );
  const result: CheckResult =
    mismatches === 0
      ? {
          verdict: 'PASS',
          summary: `Calendar ${cal.id} read (${months.length} months, ${arr(cal.positiveEras).length} forward eras); ${sample.length} oracle rows agree on the era.`,
        }
      : { verdict: 'FAIL', summary: `${mismatches} oracle row(s) disagree on the era.` };
  ctx.oracle = {
    note: "LegendKeeper's own answers, for the date engine's tests (docs/PLAN-v2.md, 4.8). start/end are minutes.",
    calendar: cal,
    events: scan.scanned.map((e) => ({
      id: e.id,
      name: e.name,
      shape: eventShape(e),
      detail: e.detail,
      start: e.start,
      end: e.end,
      formattedStart: e.formattedStart,
      formattedEnd: e.formattedEnd,
      startDate: e.startDate,
      endDate: e.endDate,
    })),
  };
  return result;
};
// ---- 6. chronology table structure ------------------------------------------------------------------------------------
const check6: CheckFn = async (ctx, ev) => {
  // ---- the Fourth Arkonan Age table page
  const ref = await ctx.resolveDoc(ctx.ids.tableDoc);
  const docs = await ctx.chronologyDocs();
  ev.bullet(
    `Documents of the chronology resource ${code(ctx.ids.chronology)}: ${docs.map((d) => `${d.id} "${txt(d.name, 34)}" (${d.type})`).join('; ') || 'none'}.`,
  );
  const page = await ctx.call('getDocumentBlocks', {
    path: { resourceId: ref.resourceId, documentId: ref.documentId },
  });
  const blocks = arr(page.blocks);
  ev.label(`Age table page ${code(ref.documentId)}${ref.note ? ` (${ref.note})` : ''}`);
  const { info } = describeBlocks(ev, blocks);
  if (!info) return { verdict: 'FAIL', summary: 'The age table page has no top-level table.' };
  ev.bullet(
    `Header cells (${info.header.length}): ${info.header.map((c) => `${JSON.stringify(txt(c.text, 30))}${c.header ? ' [header flag]' : ''}`).join(' | ')}.`,
  );
  ev.bullet(
    `Rows (excluding the header row): ${info.rows.length}. Merged cells: ${info.colspans}. \`unsupported\` blocks in the table: ${info.unsupported}. ` +
      `Cells holding more than one block (or a non-paragraph block): ${info.multiBlock.length}${info.multiBlock.length > 0 ? ` e.g. ${info.multiBlock.slice(0, 4).join('; ')}` : ''}.`,
  );
  const cols = info.header.length;
  const dateCol = Math.max(
    0,
    info.header.findIndex((c) => /date/i.test(c.text)),
  );
  const forms = info.rows.map((r) => dateForm(r[dateCol]?.text ?? ''));
  ev.bullet(`Date column = column ${dateCol + 1}. Date forms by text pattern: ${tally(forms)}.`);
  const all = info.rows.flat();
  ev.bullet(
    `Cell contents across ${all.length} cells: plain text only ${all.filter((c) => c.mentions.length === 0 && c.links === 0 && c.marks.length === 0 && c.runs.length > 0).length}, ` +
      `with mentions ${all.filter((c) => c.mentions.length > 0).length}, with link marks ${all.filter((c) => c.links > 0).length}, with other marks ${all.filter((c) => c.marks.length > 0).length} (${tally(all.flatMap((c) => c.marks))}), empty ${all.filter((c) => c.runs.length === 0).length}.`,
  );
  const exactIdx = info.rows.findIndex((r) => norm(r[dateCol]?.text) === '4a 139');
  const yearIdx = exactIdx >= 0 ? exactIdx : forms.findIndex((f, i) => f === 'year-only' && i >= 2);
  const rangeIdx = ((): number => {
    const dr = forms.findIndex((f) => f === 'date-range');
    return dr >= 0 ? dr : forms.findIndex((f) => f === 'month-range' || f === 'year-range');
  })();
  const around = (i: number) =>
    info.rows.slice(Math.max(0, i - 2), i + 3).map((r, k) => rowLine(Math.max(0, i - 2) + k + 1, r));
  const oneRow = info.rows[yearIdx >= 0 ? yearIdx : 0];
  ev.label(
    `Run structure of one row (${yearIdx >= 0 ? `row ${yearIdx + 1}, the year-only row` : 'row 1; no year-only row found'})`,
  );
  ev.sample(
    oneRow
      ? oneRow.map(
          (c, j) =>
            `col ${j + 1} ${JSON.stringify(txt(info.header[j]?.text ?? '', 24))}: ${c.blocks} block(s) [${c.childKinds.join(', ') || 'none'}]; runs: ${c.runs.slice(0, 6).join(' + ') || '(empty)'}${c.runs.length > 6 ? ` +${c.runs.length - 6} more` : ''}`,
        )
      : ['(no rows)'],
  );
  ev.label(
    yearIdx >= 0
      ? `Five rows around the year-only row ${yearIdx + 1} (${JSON.stringify(info.rows[yearIdx]?.[dateCol]?.text)})`
      : 'No year-only row found',
  );
  ev.sample(yearIdx >= 0 ? [headerLine(info.header), ...around(yearIdx)] : ['(none)']);
  ev.label(
    rangeIdx >= 0
      ? `Five rows around the range row ${rangeIdx + 1} (${forms[rangeIdx]}: ${JSON.stringify(info.rows[rangeIdx]?.[dateCol]?.text)})`
      : 'No range row found',
  );
  ev.sample(rangeIdx >= 0 ? [headerLine(info.header), ...around(rangeIdx)] : ['(none)']);
  const rangeRow = info.rows[rangeIdx];
  if (rangeRow) {
    ev.caption('Run structure of that range row:');
    ev.sample(rangeRow.map((c, j) => `col ${j + 1}: ${c.runs.slice(0, 6).join(' + ') || '(empty)'}`));
  }

  // ---- the Main page
  const mainRef = await ctx.resolveDoc(ctx.ids.mainDoc);
  const main = await ctx.call('getDocumentBlocks', {
    path: { resourceId: mainRef.resourceId, documentId: mainRef.documentId },
  });
  const mainBlocks = arr(main.blocks);
  ev.label(`Main page ${code(mainRef.documentId)}${mainRef.note ? ` (${mainRef.note})` : ''}`);
  const m = describeBlocks(ev, mainBlocks);
  if (!m.info) {
    ev.bullet('The Main page has no top-level table.');
    return { verdict: 'FAIL', summary: 'The Main page has no top-level table.' };
  }
  const mi = m.info;
  ev.bullet(
    `Columns (${mi.header.length}): ${mi.header.map((c) => JSON.stringify(txt(c.text, 30))).join(' | ')}; rows: ${mi.rows.length}; multi-block cells: ${mi.multiBlock.length}.`,
  );
  const countCol = Math.max(
    0,
    mi.header.findIndex((c) => /event count/i.test(c.text)),
  );
  const formatOf = (t: string) =>
    /^\d+$/.test(t)
      ? 'digits only'
      : /^\d{1,3}(,\d{3})+$/.test(t)
        ? 'digits with thousands commas'
        : t === ''
          ? 'empty'
          : 'other';
  ev.bullet(
    `'${mi.header[countCol]?.text ?? 'Event count'}' cells (column ${countCol + 1}): ${tally(mi.rows.map((r) => formatOf(r[countCol]?.text ?? '')))}; all plain text without mentions: ${mi.rows.every((r) => (r[countCol]?.mentions.length ?? 0) === 0)}.`,
  );
  ev.label('Main page table rows (all cells as text)');
  ev.sample([headerLine(mi.header), ...mi.rows.map((r, i) => rowLine(i + 1, r))]);
  const first = mi.rows[0];
  ev.label('Run structure of the first row (are the table and timeline cells mentions?)');
  ev.sample(
    first
      ? first.map(
          (c, j) =>
            `col ${j + 1} ${JSON.stringify(txt(mi.header[j]?.text ?? '', 26))}: ${c.runs.slice(0, 5).join(' + ') || '(empty)'}`,
        )
      : ['(no rows)'],
  );
  const mentionCols = mi.header.map(
    (h, j) =>
      `${txt(h.text, 22)}: mention in ${mi.rows.filter((r) => (r[j]?.mentions.length ?? 0) > 0).length}/${mi.rows.length} rows, link mark in ${mi.rows.filter((r) => (r[j]?.links ?? 0) > 0).length}`,
  );
  ev.bullet(`By column: ${mentionCols.join('; ')}.`);
  return {
    verdict: 'INFO',
    summary: `Age table: ${cols} columns, ${info.rows.length} rows, forms ${tally(forms, 5)}; ${info.multiBlock.length} multi-block cell(s). Main table: ${mi.rows.length} rows.`,
  };
};

// ---- 7. map coordinates ------------------------------------------------------------------------------------------------
const check7: CheckFn = async (ctx, ev) => {
  const index = await ctx.resources();
  const rootNodes = index.subtree(ctx.ids.root);
  if (rootNodes.length === 0)
    ev.bullet(`The AI REPOSITORY root ${code(ctx.ids.root)} is not in the resource listing.`);
  const maps: { res: Obj; doc: Obj }[] = [];
  for (const { node } of rootNodes) {
    for (const d of arr(node.documents))
      if (d.type === 'map' && maps.length < 3) maps.push({ res: node, doc: d });
    if (maps.length >= 3) break;
  }
  const mapDocsTotal = rootNodes.reduce(
    (n, { node }) => n + arr(node.documents).filter((d) => d.type === 'map').length,
    0,
  );
  if (maps.length === 0) {
    ev.bullet(`Looked through ${rootNodes.length} resource(s) under the root: no document of type \`map\`.`);
    return { verdict: 'INFO', summary: 'No maps found under the AI REPOSITORY root.' };
  }
  ev.bullet(
    `Map documents under the root: ${mapDocsTotal}; the first ${maps.length} (in tree order) were read.`,
  );
  let boundsOk = 0;
  for (const { res, doc } of maps) {
    const d = await ctx.call('getDocument', { path: { resourceId: res.id, documentId: doc.id } });
    const features = arr(
      (await ctx.call('listFeatures', { path: { resourceId: res.id, documentId: doc.id } })).data,
    );
    const mi = (d.mapImage ?? null) as Obj | null;
    ev.label(
      `Map ${JSON.stringify(txt(doc.name ?? res.name, 40))} (resource ${res.id}, document ${doc.id}) in ${JSON.stringify(txt(index.pathOf(res.id as string, ctx.ids.root), 80))}`,
    );
    if (!mi) {
      ev.bullet('No `mapImage` on this document (null).');
      continue;
    }
    const b = mi.bounds as number[][] | undefined;
    const [[south, west], [north, east]] = (b ?? [
      [0, 0],
      [0, 0],
    ]) as [[number, number], [number, number]];
    const w = Number(mi.width);
    const h = Number(mi.height);
    const z = Math.ceil(Math.log2(Math.max(w, h) / 256));
    const exp = { north: 0, west: 0, south: -h / 2 ** z, east: w / 2 ** z };
    const close = (x: number, y: number) => Math.abs(x - y) < 1e-6 * Math.max(1, Math.abs(y));
    const follows =
      close(north, exp.north) && close(west, exp.west) && close(south, exp.south) && close(east, exp.east);
    if (follows) boundsOk++;
    ev.fields(
      {
        mapImage: { ...mi, url: mi.url ? '<url>' : mi.url },
        'tiles field': 'tiles' in mi ? mi.tiles : '(not present on mapImage)',
        'other document fields': Object.keys(d).filter(
          (k) => !['id', 'name', 'type', 'rank', 'isHidden', 'mapImage'].includes(k),
        ),
        'zoom z = ceil(log2(max(w,h)/256))': z,
        'bounds from the documented pixel formula': `[[${exp.south}, ${exp.west}], [${exp.north}, ${exp.east}]]`,
        'reported bounds follow that formula': follows,
      },
      12,
    );
    const types = new Set<string>();
    const chosen: Obj[] = [];
    for (const f of features) {
      if (chosen.length >= 5 || types.has(String(f.type))) continue;
      chosen.push(f);
      types.add(String(f.type));
    }
    for (const f of features) if (chosen.length < 5 && !chosen.includes(f)) chosen.push(f);
    ev.bullet(
      `${features.length} feature(s): ${tally(features.map((f) => String(f.type)))}; with a link: ${features.filter((f) => f.uri).length}; with a pos inside the bounds: ${features.filter((f) => Array.isArray(f.pos) && f.pos[0] <= north && f.pos[0] >= south && f.pos[1] >= west && f.pos[1] <= east).length} of ${features.filter((f) => Array.isArray(f.pos)).length}.`,
    );
    ev.sample(
      chosen.length === 0
        ? ['(no features)']
        : chosen.flatMap((f) => {
            const pos = f.pos as number[] | undefined;
            const px = pos
              ? `x=${(((pos[1]! - west) * w) / (east - west)).toFixed(1)}, y=${(((north - pos[0]!) * h) / (north - south)).toFixed(1)}`
              : '-';
            const poly = [
              Array.isArray(f.polygon) ? `polygon ${f.polygon.length} pts` : '',
              Array.isArray(f.polygons)
                ? `polygons ${f.polygons.length} ring(s) / ${f.polygons.reduce((n: number, r: unknown[]) => n + r.length, 0)} pts`
                : '',
              Array.isArray(f.polyline) ? `polyline ${f.polyline.length} pts` : '',
            ].filter(Boolean);
            const m = /^lk:\/\/(?:resources|documents)\/([a-z0-9]+)/.exec(String(f.uri ?? ''));
            const linked = m
              ? `${m[1]}${index.byId.get(m[1]!) ? ` ("${txt(index.byId.get(m[1]!)!.name, 30)}")` : ' (not a resource id in the listing)'}`
              : f.uri
                ? String(f.uri)
                : 'none';
            return [
              `${String(f.type).padEnd(6)} ${JSON.stringify(txt(f.name, 30))}  pos ${pos ? `[${pos[0]}, ${pos[1]}]` : '-'}  → pixel ${px}`,
              `       shape: ${poly.join(', ') || 'none'}; linked: ${linked}`,
            ];
          }),
    );
  }
  return {
    verdict: 'INFO',
    summary: `${maps.length} map(s) read; the documented pixel formula reproduces the reported bounds for ${boundsOk} of ${maps.length}.`,
  };
};

// ---- 8. tree preview ------------------------------------------------------------------------------------------------------
const GROUP: Record<Kind, number> = { index: 0, bsrc: 1, unclassified: 2 };
/** The expected order of siblings: [INDEX] first, then [BSRC], then the rest; each alphabetical by display name. */
export function siblingOrderOk(children: readonly Obj[]): { ok: boolean; firstBreak?: string } {
  for (let i = 1; i < children.length; i++) {
    const a = children[i - 1]!;
    const b = children[i]!;
    const ka = kindOf(String(a.name));
    const kb = kindOf(String(b.name));
    const wrong =
      GROUP[ka] > GROUP[kb] ||
      (ka === kb &&
        display(String(a.name)).localeCompare(display(String(b.name)), undefined, { sensitivity: 'base' }) >
          0);
    if (wrong)
      return {
        ok: false,
        firstBreak: `position ${i + 1}: ${JSON.stringify(txt(a.name, 30))} [${kindTag(ka)}] then ${JSON.stringify(txt(b.name, 30))} [${kindTag(kb)}]`,
      };
  }
  return { ok: true };
}
const check8: CheckFn = async (ctx, ev) => {
  const index = await ctx.resources();
  ev.bullet(
    `Listed ${index.all.length} resource(s) in ${index.pages} read(s)${index.truncated ? ' (STOPPED at the page cap)' : ''}.`,
  );
  const nodes = index.subtree(ctx.ids.root);
  if (nodes.length === 0) {
    ev.bullet(`The AI REPOSITORY root ${code(ctx.ids.root)} is not in the listing.`);
    return {
      verdict: 'FAIL',
      summary: `Root ${ctx.ids.root} not found among ${index.all.length} resources.`,
    };
  }
  const below = nodes.slice(1);
  const byKind = new Map<Kind, Obj[]>([
    ['index', []],
    ['bsrc', []],
    ['unclassified', []],
  ]);
  for (const { node } of below) byKind.get(kindOf(String(node.name)))!.push(node);
  const maxDepth = below.reduce((n, x) => Math.max(n, x.depth), 0);
  const inSubtree = new Set(nodes.map((x) => x.node.id as string));
  const outside = index.all.filter((r) => !inSubtree.has(r.id as string));
  ev.bullet(
    `Root: ${nodeLabel(nodes[0]!.node)}. Resources below it: ${below.length}. Maximum depth below the root: ${maxDepth}.`,
  );
  ev.bullet(
    `By kind: [INDEX] ${byKind.get('index')!.length}, [BSRC] ${byKind.get('bsrc')!.length}, unclassified ${byKind.get('unclassified')!.length}.`,
  );
  const unclassified = byKind.get('unclassified')!;
  ev.bullet(
    `Unclassified names (up to 20 of ${unclassified.length}): ${
      unclassified
        .slice(0, 20)
        .map((n) => JSON.stringify(txt(n.name, 40)))
        .join(', ') || 'none'
    }.`,
  );
  const outsideTops = outside.filter((r) => typeof r.parentId !== 'string' || !index.byId.has(r.parentId));
  ev.bullet(
    `Resources OUTSIDE the root: ${outside.length} (${outsideTops.length} top-level: ${outsideTops
      .slice(0, 6)
      .map((r) => JSON.stringify(txt(r.name, 24)))
      .join(', ')}${outsideTops.length > 6 ? ', …' : ''}).`,
  );
  const perDepth = new Map<number, number>();
  for (const x of below) perDepth.set(x.depth, (perDepth.get(x.depth) ?? 0) + 1);
  ev.bullet(
    `Resources per depth below the root: ${[...perDepth]
      .sort((a, b) => a[0] - b[0])
      .map(([d, n]) => `depth ${d}: ${n}`)
      .join(', ')}.`,
  );

  // Five [BSRC] pages, spread through the tree, read with getResource.
  const bsrc = byKind.get('bsrc')!;
  const picks =
    bsrc.length <= 5 ? bsrc : Array.from({ length: 5 }, (_, i) => bsrc[Math.floor((i * bsrc.length) / 5)]!);
  const lines: string[] = [];
  for (const p of picks) {
    const r = await ctx.call('getResource', { path: { resourceId: p.id } });
    const props = arr(r.properties);
    lines.push(
      `${JSON.stringify(txt(p.name, 44))} (${p.id}) path: ${txt(index.pathOf(p.id as string, ctx.ids.root), 90)}`,
    );
    lines.push(
      `  tags ${(r.tags ?? []).length}, aliases ${(r.aliases ?? []).length}, documents: ${
        arr(r.documents)
          .map((d) => d.type)
          .join(', ') || 'none'
      }, ${props.length} sidebar propert${props.length === 1 ? 'y' : 'ies'}`,
    );
    for (const pr of props) {
      const keys =
        pr.kind === 'keyValue'
          ? ` rows: ${arr(pr.rows).length}${
              arr(pr.rows).length > 0
                ? ` keys: ${arr(pr.rows)
                    .slice(0, 14)
                    .map((row) => JSON.stringify(txt(row.key, 24)))
                    .join(', ')}${arr(pr.rows).length > 14 ? ', …' : ''}`
                : ''
            }`
          : '';
      lines.push(`  - ${pr.kind} ${JSON.stringify(txt(pr.title ?? '(no title)', 30))}${keys}`);
    }
  }
  ev.label(`Sidebar properties of ${picks.length} sampled [BSRC] page(s) (getResource)`);
  ev.sample(lines.length > 0 ? lines : ['(no [BSRC] pages)']);

  // Sibling order under three indexes with several children.
  const candidates = byKind.get('index')!.filter((n) => index.children(n.id as string).length >= 3);
  const idxPicks =
    candidates.length <= 3
      ? candidates
      : Array.from({ length: 3 }, (_, i) => candidates[Math.floor((i * candidates.length) / 3)]!);
  const orderLines: string[] = [];
  let followed = 0;
  for (const n of idxPicks) {
    const kids = index.children(n.id as string);
    const verdict = siblingOrderOk(kids);
    if (verdict.ok) followed++;
    orderLines.push(
      `${JSON.stringify(txt(n.name, 40))}: ${kids.length} children; by rank, follows "[INDEX] first, then [BSRC], alphabetical": ${verdict.ok ? 'yes' : `NO, first break at ${verdict.firstBreak}`}`,
    );
    orderLines.push(
      `   first in rank order: ${kids
        .slice(0, 5)
        .map(
          (k) => `${kindTag(kindOf(String(k.name)))} ${JSON.stringify(display(String(k.name)).slice(0, 18))}`,
        )
        .join(', ')}`,
    );
  }
  ev.label('Sibling order under sampled indexes (children sorted by rank)');
  ev.sample(orderLines.length > 0 ? orderLines : ['(no index with three or more children)']);
  return {
    verdict: 'INFO',
    summary: `${below.length} below the root (${byKind.get('index')!.length} index, ${bsrc.length} bsrc, ${unclassified.length} unclassified), depth ${maxDepth}, ${outside.length} outside; order followed under ${followed} of ${idxPicks.length} sampled indexes.`,
  };
};

// ---- 9. characters and templates ---------------------------------------------------------------------------------------------
const check9: CheckFn = async (ctx, ev) => {
  const index = await ctx.resources();
  const nodes = index.subtree(ctx.ids.root);
  const chars = nodes.filter(
    (x) =>
      x.depth > 0 &&
      kindOf(String(x.node.name)) === 'index' &&
      norm(display(String(x.node.name))) === 'characters',
  );
  ev.bullet(
    `\`[INDEX] Characters\` under the root: ${chars.length} found${chars.length > 0 ? ` (${chars.map((c) => `${c.node.id} at depth ${c.depth}`).join(', ')})` : ''}.`,
  );
  let problems = 0;
  if (chars.length !== 1) problems++;
  const top = chars[0]?.node;
  if (top) {
    const kids = index.children(top.id as string);
    const lines: string[] = [];
    let grand = 0;
    for (const k of kids) {
      const g = index.children(k.id as string);
      grand += g.length;
      const names = g
        .slice(0, 10)
        .map((x) => `${JSON.stringify(txt(display(String(x.name)), 22))}[${kindTag(kindOf(String(x.name)))}]`)
        .join(', ');
      lines.push(
        `${JSON.stringify(txt(display(String(k.name)), 32))} [${kindTag(kindOf(String(k.name)))}]: ${g.length} child(ren)${g.length > 0 ? ` → ${names}${g.length > 10 ? `, … +${g.length - 10}` : ''}` : ''}`,
      );
    }
    ev.bullet(
      `Children of Characters: ${kids.length} (${tally(kids.map((k) => kindTag(kindOf(String(k.name)))))}); grandchildren: ${grand} (${tally(kids.flatMap((k) => index.children(k.id as string)).map((x) => kindTag(kindOf(String(x.name)))))}).`,
    );
    ev.label('Children, each with its children (names without the prefix, kind in brackets)');
    ev.sample(lines.length > 0 ? lines : ['(Characters has no children)']);
    // The Undetermined / Unknown index.
    const target = norm('Undetermined / Unknown');
    const direct = kids.filter(
      (k) => kindOf(String(k.name)) === 'index' && norm(display(String(k.name))) === target,
    );
    const deeper = index
      .subtree(top.id as string)
      .filter((x) => x.depth > 1 && norm(display(String(x.node.name))) === target);
    ev.bullet(
      `\`[INDEX] Undetermined / Unknown\` directly under Characters: ${direct.length}${direct.length > 0 ? ` (${direct.map((d) => d.id).join(', ')})` : ''}; deeper in Characters: ${deeper.length}${deeper.length > 0 ? ` (${deeper.map((d) => `${d.node.id} at depth ${d.depth}`).join(', ')})` : ''}.`,
    );
    if (direct.length !== 1) problems++;
    const near = kids.filter(
      (k) => /undetermined|unknown|unestablished/i.test(String(k.name)) && !direct.includes(k),
    );
    if (near.length > 0)
      ev.bullet(
        `Similar names directly under Characters: ${near.map((k) => JSON.stringify(txt(k.name, 40))).join(', ')}.`,
      );
  }
  // Templates.
  const templates = await ctx.list('listTemplates', {}, { limit: 100, maxPages: 50 });
  ev.label(
    `Templates (${templates.items.length}${templates.truncated ? ', list cut at the page cap' : ''}): name, id, parent`,
  );
  ev.sample(
    templates.items.map(
      (t) =>
        `${JSON.stringify(txt(t.name, 44))}  ${t.id}  parent ${t.parentId ?? 'none'}${index.byId.get(String(t.parentId)) ? ` (${JSON.stringify(txt(index.byId.get(String(t.parentId))!.name, 24))})` : ''}`,
    ),
  );
  return problems === 0
    ? {
        verdict: 'PASS',
        summary: `One [INDEX] Characters and exactly one [INDEX] Undetermined / Unknown under it; ${templates.items.length} template(s) listed.`,
      }
    : {
        verdict: 'FAIL',
        summary: `Characters root found ${chars.length} time(s), or the Undetermined / Unknown index is not unique (see the counts); ${templates.items.length} template(s) listed.`,
      };
};

// ---- 10. asset tree preview --------------------------------------------------------------------------------------------------
const check10: CheckFn = async (ctx, ev) => {
  const walk = await ctx.assets();
  const byId = new Map(walk.items.map((a) => [a.id as string, a]));
  const folders = walk.items.filter((a) => a.type === 'FOLDER');
  const assets = walk.items.filter((a) => a.type !== 'FOLDER');
  const pathOf = (a: Obj): string[] => {
    const names: string[] = [String(a.name)];
    for (let cur = a, i = 0; i < 50 && typeof cur.folderId === 'string'; i++) {
      const p = byId.get(cur.folderId);
      if (!p) {
        names.unshift('(missing folder)');
        break;
      }
      names.unshift(String(p.name));
      cur = p;
    }
    return names;
  };
  ev.bullet(
    `Total: ${folders.length} folder(s) and ${assets.length} other asset(s) (${tally(assets.map((a) => String(a.type)))}), found with ${walk.listings} listing call(s)${walk.truncated ? ` (**STOPPED at the cap of ${ctx.o.maxAssetLists} listings, so the totals are lower bounds**)` : ''}.`,
  );
  ev.bullet(
    `Unfiltered listAssets ${walk.flat ? 'returns assets from inside folders as well (a flat listing)' : 'returns only the root level (folders must be walked)'}. ${walk.folderCheck}. Repeats seen while walking: ${walk.duplicates}.`,
  );
  const top = folders.filter((f) => f.folderId == null);
  ev.bullet(
    `Top-level folders (${top.length}): ${top
      .slice(0, 20)
      .map((f) => JSON.stringify(txt(f.name, 24)))
      .join(', ')}${top.length > 20 ? ', …' : ''}.`,
  );
  const chars = folders.filter((f) => norm(f.name) === 'characters');
  if (chars.length === 0) {
    ev.bullet('No folder named `Characters` exists.');
    return {
      verdict: 'INFO',
      summary: `${folders.length} folders, ${assets.length} assets; no Characters folder.`,
    };
  }
  ev.bullet(
    `Folders named \`Characters\`: ${chars.length}${chars.length > 1 ? ` (${chars.map((c) => pathOf(c).join('/')).join('; ')})` : ''}.`,
  );
  const kids = new Map<string, Obj[]>();
  for (const f of folders)
    if (typeof f.folderId === 'string')
      (kids.get(f.folderId) ?? kids.set(f.folderId, []).get(f.folderId)!).push(f);
  for (const v of kids.values()) v.sort((a, b) => cmp(norm(a.name), norm(b.name)));
  const lines: string[] = [];
  const perDepth: number[] = [0, 0, 0, 0, 0];
  const walkF = (f: Obj, depth: number) => {
    perDepth[depth] = (perDepth[depth] ?? 0) + 1;
    const own = kids.get(f.id as string) ?? [];
    const files = assets.filter((a) => a.folderId === f.id).length;
    lines.push(
      `${'  '.repeat(depth - 1)}${txt(f.name, 40)}/  (${own.length} subfolder(s), ${files} file(s))`,
    );
    if (depth < 4) for (const c of own) walkF(c, depth + 1);
  };
  for (const c of chars) walkF(c, 1);
  ev.label('Folder paths under Characters, to depth 4 (Characters = depth 1)');
  ev.sample(lines);
  ev.bullet(
    `Folders per depth (1 to 4): ${perDepth.slice(1, 5).join(', ')}. Shown above up to ${ctx.o.sampleLines} lines; re-run with --sample-lines for more.`,
  );
  return {
    verdict: 'INFO',
    summary: `${folders.length} folders, ${assets.length} assets; Characters has ${perDepth.slice(1, 5).join('/')} folders at depths 1-4.`,
  };
};

// ------------------------------------------------------------------------------------------------ the run

const CHECKS: readonly { id: number; title: string; fn: CheckFn }[] = [
  { id: 1, title: 'createManyResources nesting (writes, throwaway root only)', fn: check1 },
  { id: 2, title: 'Search behaviour and caps', fn: check2 },
  { id: 3, title: 'Asset download through the outbound guard', fn: check3 },
  { id: 4, title: 'Timeline events: lanes, precision and raw fields', fn: check4 },
  { id: 5, title: 'Calendar arithmetic oracle', fn: check5 },
  { id: 6, title: 'Chronology table structure', fn: check6 },
  { id: 7, title: 'Map coordinates', fn: check7 },
  { id: 8, title: 'Tree preview', fn: check8 },
  { id: 9, title: 'Characters and templates', fn: check9 },
  { id: 10, title: 'Asset tree preview', fn: check10 },
];

/** The context the checks share: the engine, the shared reads and the write guard. Exported for the tests. */
export function newSpikeContext(t: SpikeTarget, o: SpikeOptions = {}): Ctx {
  const ids: SpikeIds = { ...DEFAULT_SPIKE_IDS, ...o.ids };
  return new Ctx(t, {
    ids,
    sampleLines: o.sampleLines ?? DEFAULT_SAMPLE_LINES,
    maxAssetLists: o.maxAssetLists ?? 600,
    maxAssetBytes: o.maxAssetBytes ?? 25 * 1024 * 1024,
    maxEventPages: o.maxEventPages ?? 8,
    guard: o.guard ?? {},
    log: o.log ?? (() => undefined),
    signal: o.signal,
    rareQuery: o.rareQuery,
    commonQuery: o.commonQuery ?? 'the',
  });
}

/** Runs the spike. Throws {@link SandboxGuardError} (nothing written) if the key's project is not `expectedProjectId`. */
export async function runSpike(
  t: SpikeTarget,
  expectedProjectId: string,
  o: SpikeOptions = {},
): Promise<SpikeOutcome> {
  const log = o.log ?? (() => undefined);
  const ctx = newSpikeContext(t, o);
  const ids = ctx.ids;

  // ---- guard: the key must belong to exactly the sandbox project (nothing is written before this) --------------------
  const projects = (await ctx.call('listProjects')) as { data?: { id: string }[] };
  const projectIds = (projects.data ?? []).map((x) => x.id);
  if (projectIds.length !== 1 || projectIds[0] !== expectedProjectId || t.projectId !== expectedProjectId) {
    throw new SandboxGuardError(
      `Refusing to run: the key's project is [${projectIds.join(', ')}], not the sandbox project ${expectedProjectId}.`,
    );
  }

  const started = Date.now();
  const checks: CheckReport[] = [];
  try {
    for (const c of CHECKS) {
      if (o.skip?.has(c.id)) {
        checks.push({
          id: c.id,
          title: c.title,
          verdict: 'INFO',
          summary: 'Skipped (--skip).',
          evidence: [],
          requests: 0,
          ms: 0,
        });
        continue;
      }
      const ev = ctx.evidence();
      const before = ctx.requests;
      const t0 = Date.now();
      log(`Check ${c.id}: ${c.title}`);
      let res: CheckResult;
      try {
        res = await c.fn(ctx, ev);
      } catch (e) {
        res = { verdict: 'FAIL', summary: `The check could not complete: ${describeError(e)}` };
        ev.bullet(`**The check stopped with an error:** ${describeError(e)}`);
      }
      log(`  ${res.verdict}: ${res.summary}`);
      checks.push({
        id: c.id,
        title: c.title,
        verdict: res.verdict,
        summary: res.summary,
        evidence: ev.lines,
        requests: ctx.requests - before,
        ms: Date.now() - t0,
      });
      if (o.signal?.aborted) break;
    }
  } finally {
    // The safety net: whatever happened, the throwaway root goes.
    await ctx.cleanupThrowaway();
  }
  return {
    checks,
    oracle: ctx.oracle,
    cleanup: ctx.cleanup,
    downloads: ctx.downloads,
    ids,
    durationMs: Date.now() - started,
  };
}
