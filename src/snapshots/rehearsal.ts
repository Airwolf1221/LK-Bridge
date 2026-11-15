/**
 * The restore rehearsal (v2 E1a, ADR 0042; PLAN-v2 4.11): proving the backups work by restoring a snapshot into a
 * THROWAWAY root of a sandbox project (`lk-bridge rehearsal <time>`) and comparing what LegendKeeper then holds with the
 * snapshot. Never into the project the snapshot came from, never outside its root, and the root is deleted at the end
 * unless the owner keeps it to inspect.
 *
 * - Sampled by default: about 50 pages chosen to cover every block kind, every document type, the chronology, a map, a
 *   board, images, keep regions and unsupported blocks; or every page (`full`), with its estimated requests and time
 *   shown first (Arkona's full rehearsal takes hours under the write limits). v2 E5.4: a sample copies at most 25 events
 *   of a timeline and 40 features of a map (the plan's `cuts` say what was left out), and the estimate is paced at P3.
 * - It is the owner's job: ordinary jobs through the engine (the system principal, a dashboard origin, P3), so every guard
 *   applies. A rehearsal must not create canon or lifecycle state in the test project, so the three guarded signals are
 *   written in an INERT form and compared in that form: every page name gets the prefix `rehearsal: ` (so `[BSRC] …`,
 *   `[BWRK] …` and `[INDEX] Working` are never prefixes there), a Status value and any value a canon `value` rule
 *   protects gets `rehearsal: `, and the status tags (CANON, Working, Archived) get `rehearsal-`. Anything protected that
 *   slipped through would be refused by the guards and reported as a difference, never written.
 * - References are remapped: a mention, a link, a collection item, a feature's or event's link to a page in the rehearsal
 *   goes to its copy; one to a page outside it (a sample, or another project) becomes plain text, is dropped from a
 *   collection, or is cleared, and is counted. Images are uploaded (their bytes from the store) into a rehearsal folder
 *   and every URL remapped. Map features, lanes and events get new ids (minted by the bridge); board records keep theirs.
 * - The comparison: each page document through the Markdown round trip AND the block comparator, ignoring ids; sidebars
 *   by key and value (and collections by their pages); map features, timeline lanes and events and board shapes field by
 *   field; image bytes by SHA-256 (the upload's own verify downloads what LegendKeeper stored). What cannot be written
 *   (unsupported blocks, inline icons, board pages, unsupported properties) is listed, not counted as a difference.
 */
import { ICON_FIELDS, withWriteIcon } from '../lk/icons.js';
import { randomBytes } from 'node:crypto';
import type { JobEngine, JobOrigin, JobView, StepSpec } from '../jobs/index.js';
import { InvalidParamsError } from '../jobs/errors.js';
import {
  comparableFeature,
  isLabelSizeListError,
  LABEL_SIZE_NOT_RESTORABLE,
  LABEL_SIZE_UNLISTABLE,
  normaliseFeatureBody,
} from '../maps/features.js';
import { mintClientId } from '../jobs/ids.js';
import { stableJson } from '../jobs/sidebar-state.js';
import { normaliseRuns } from '../jobs/verify-blocks.js';
import { detectImageType } from '../images/convert.js';
import { toMarkdown, type DocumentInput } from '../markdown/index.js';
import { canonConfigFrom } from '../facts/rules.js';
import { lifecycleFrom } from '../lifecycle/settings.js';
import {
  isUnwritableRun,
  sidebarPiece,
  stripVersions,
  type DocumentPiece,
  type ResourcePiece,
  type SidebarPiece,
} from './canonical.js';
import { documentPieceOf, type Reader } from './capture.js';
import type { RehearsalRow } from './db.js';
import type { Manifest, PageEntry } from './manifest.js';
import { bodyFields, RestoreError } from './restore.js';
import type { SnapshotService } from './service.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const INERT = 'rehearsal: ';

export const SAMPLE_SIZE = 50;
/** v2 E5.4: in a sampled rehearsal, at most this many events of each timeline are copied (with every lane they use). */
export const SAMPLE_EVENTS_PER_TIMELINE = 25;
/** v2 E5.4: in a sampled rehearsal, at most this many features of each map (parents with their children). */
export const SAMPLE_FEATURES_PER_MAP = 40;

export interface RehearsalDeps {
  readonly svc: SnapshotService;
  readonly engine: JobEngine;
  readonly projects: {
    find(ref: string):
      | {
          readonly id: string | null;
          readonly name: string;
          readonly isSandbox: boolean;
          readonly status: string;
        }
      | undefined;
    list(): readonly {
      readonly id: string | null;
      readonly name: string;
      readonly isSandbox: boolean;
      readonly status: string;
    }[];
    client(id: string):
      | {
          governor: {
            estimate(i: { reads: number; writes: number; priority?: 'P3' }): {
              wallClockMs: number;
              fitsToday: boolean;
              tightestTier: string;
              pacingMs?: number;
              tiers?: readonly { tier: string; demand: number; capacityPerWindow: number }[];
            };
          };
        }
      | undefined;
  };
  readonly projectSettings: (projectId: string) => Readonly<Record<string, unknown>>;
  readonly now: () => number;
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
  /** Test seam: how long one wait for a job lasts (default 25 s). */
  readonly waitMs?: number;
}

export interface RehearsalPlan {
  readonly source: {
    readonly projectId: string;
    readonly snapshotId: string;
    readonly takenAt: string;
    readonly kind: string;
  };
  readonly target: { readonly projectId: string; readonly name: string };
  readonly mode: 'sampled' | 'full';
  readonly pages: readonly string[];
  readonly coverage: Readonly<Record<string, readonly string[]>>;
  readonly images: number;
  /** v2 E5.4: what a sampled rehearsal leaves out of the pages it copies (events of a timeline, features of a map). */
  readonly cuts: readonly SampleCut[];
  readonly estimate: {
    readonly reads: number;
    readonly writes: number;
    readonly uploads: number;
    /**
     * The time the run should take (v2 E5.4): the governor's estimate at P3, and at least the writes one after another
     * at P3's write rate (the write spacing, or the P3 share of the write tiers if slower) plus the reads at P3's share
     * of the request tiers, as the rehearsal's jobs run one at a time.
     */
    readonly wallClockMs: number | null;
    readonly fitsToday: boolean | null;
    /** What the pacing assumes: the time per write and per read at P3 (null without a governor). */
    readonly pacing?: { readonly msPerWrite: number; readonly msPerRead: number } | null;
  };
}

/** v2 E5.4: one cut a sampled rehearsal makes: of `of` items of a document, `kept` are copied. */
export interface SampleCut {
  readonly page: string;
  readonly document: string;
  readonly what: 'events' | 'features';
  readonly kept: number;
  readonly of: number;
  /** For events: how many lanes of the timeline are copied (the ones the kept events use). */
  readonly lanes?: { readonly kept: number; readonly of: number };
}

export interface Difference {
  readonly page: string;
  readonly piece: string;
  readonly reason: string;
  readonly detail?: unknown;
}

// ============================================================================================ choosing the pages

interface Loaded {
  readonly entry: PageEntry;
  readonly resource: ResourcePiece | null;
  readonly sidebar: SidebarPiece | null;
  readonly documents: { readonly id: string; readonly piece: DocumentPiece }[];
  readonly features: readonly string[];
}

function blockKinds(blocks: readonly unknown[], into: Set<string>): void {
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (typeof b.kind === 'string') into.add(b.kind);
    if (Array.isArray(b.content) && (b.content as unknown[]).some((r) => isObj(r) && r.mention))
      into.add('mention');
    if (Array.isArray(b.content) && (b.content as unknown[]).some(isUnwritableRun)) into.add('inline-icon');
    if (Array.isArray(b.children)) blockKinds(b.children as unknown[], into);
  }
}

async function load(svc: SnapshotService, m: Manifest, chronologyId: string | null): Promise<Loaded[]> {
  const out: Loaded[] = [];
  const parent = new Map(m.pages.map((p) => [p.id, p.parentId]));
  const underChronology = (id: string) => {
    for (let c: string | null | undefined = id, i = 0; c && i < 100; c = parent.get(c), i++)
      if (c === chronologyId) return true;
    return false;
  };
  for (const e of m.pages) {
    if (e.deleted) continue;
    const features = new Set<string>();
    const resource = e.resource ? await svc.store.getJson<ResourcePiece>(e.resource.sha256) : null;
    const sidebar = e.sidebar ? await svc.store.getJson<SidebarPiece>(e.sidebar.sha256) : null;
    const documents: { id: string; piece: DocumentPiece }[] = [];
    for (const d of e.documents ?? []) {
      const piece = await svc.store.getJson<DocumentPiece>(d.sha256);
      if (!piece) continue;
      documents.push({ id: d.id, piece });
      features.add(`doc:${d.type}`);
      if (d.type === 'page') {
        const kinds = new Set<string>();
        blockKinds(piece.blocks ?? [], kinds);
        for (const k of kinds) features.add(`block:${k}`);
        try {
          if (
            toMarkdown({ blocks: piece.blocks ?? [] } as DocumentInput, { selfCheck: false }).regions.length >
            0
          )
            features.add('keep-region');
        } catch {
          features.add('keep-region');
        }
      }
    }
    if ((e.images ?? []).length > 0) features.add('images');
    if (
      sidebar?.properties.some(
        (p) =>
          (p.kind === 'resourceCollection' || p.kind === 'resourceLink') &&
          Array.isArray(p.items) &&
          p.items.length > 0,
      )
    )
      features.add('sidebar-links');
    if (chronologyId && underChronology(e.id)) features.add('chronology');
    features.add(`kind:${e.kind}`);
    out.push({ entry: e, resource, sidebar, documents, features: [...features] });
  }
  return out;
}

/** Greedy coverage of every feature first, then a deterministic spread of the rest, up to `max`. */
export function choosePages(
  pages: readonly Loaded[],
  max: number,
): { ids: string[]; coverage: Record<string, string[]> } {
  const chosen: Loaded[] = [];
  const covered = new Set<string>();
  const all = new Set(pages.flatMap((p) => p.features));
  while (chosen.length < max && [...all].some((f) => !covered.has(f))) {
    let best: Loaded | null = null;
    let gain = 0;
    for (const p of pages) {
      if (chosen.includes(p)) continue;
      const g = p.features.filter((f) => !covered.has(f)).length;
      if (g > gain || (g === gain && best && p.entry.id < best.entry.id && g > 0)) {
        best = p;
        gain = g;
      }
    }
    if (!best || gain === 0) break;
    chosen.push(best);
    for (const f of best.features) covered.add(f);
  }
  const rest = pages
    .filter((p) => !chosen.includes(p))
    .sort((a, b) => (hash(a.entry.id) < hash(b.entry.id) ? -1 : 1));
  for (const p of rest) {
    if (chosen.length >= max) break;
    chosen.push(p);
  }
  const coverage: Record<string, string[]> = {};
  for (const f of [...all].sort())
    coverage[f] = chosen
      .filter((p) => p.features.includes(f))
      .map((p) => p.entry.id)
      .slice(0, 5);
  return { ids: chosen.map((p) => p.entry.id), coverage };
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};

// ============================================================================================ trimming a sample

const spread = <T>(xs: readonly T[], n: number): T[] => {
  if (xs.length <= n) return [...xs];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor((i * xs.length) / n)]!);
  return out;
};

/**
 * v2 E5.4: at most `max` events of a timeline, spread over it in its order (by start, then id), with every lane they
 * use and no other. Returns the piece unchanged when it is within the cap.
 */
export function sampleTimeline(piece: DocumentPiece, max: number): { piece: DocumentPiece; cut: boolean } {
  const events = ((piece.events ?? []) as Obj[]).filter(isObj);
  if (events.length <= max) return { piece, cut: false };
  const start = (e: Obj) => (typeof e.start === 'number' ? e.start : Number.POSITIVE_INFINITY);
  const ordered = [...events].sort((a, b) =>
    start(a) !== start(b) ? start(a) - start(b) : String(a.id) < String(b.id) ? -1 : 1,
  );
  const kept = new Set(spread(ordered, max));
  const keptEvents = events.filter((e) => kept.has(e));
  const used = new Set(keptEvents.map((e) => String(e.laneId)));
  const lanes = ((piece.lanes ?? []) as Obj[]).filter((l) => isObj(l) && used.has(String(l.id)));
  return { piece: { ...piece, events: keptEvents, lanes }, cut: true };
}

/**
 * v2 E5.4: at most `max` features of a map. A kept feature brings its parents (folders) with it, so nothing is copied
 * without its folder; a region and a path are kept first if the map has them, then the others in the map's order.
 * Returns the piece unchanged when it is within the cap.
 */
export function sampleMap(piece: DocumentPiece, max: number): { piece: DocumentPiece; cut: boolean } {
  const features = ((piece.features ?? []) as Obj[]).filter(isObj);
  if (features.length <= max) return { piece, cut: false };
  const byId = new Map(features.map((f) => [String(f.id), f]));
  const keep = new Set<string>();
  const chain = (f: Obj): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let c: Obj | undefined = f; c && !seen.has(String(c.id)); c = byId.get(str(c.parentId) ?? '')) {
      seen.add(String(c.id));
      if (!keep.has(String(c.id))) out.push(String(c.id));
    }
    return out;
  };
  const add = (f: Obj) => {
    const c = chain(f);
    if (c.length > 0 && keep.size + c.length <= max) for (const id of c) keep.add(id);
  };
  const region = features.find((f) => f.type === 'region');
  const path = features.find((f) => f.type === 'path');
  for (const f of [region, path]) if (f) add(f);
  // Features with something to show first (pins, labels, regions, paths); folders come with them, or after.
  for (const f of features.filter((x) => x.type !== 'folder')) {
    if (keep.size >= max) break;
    add(f);
  }
  for (const f of features.filter((x) => x.type === 'folder')) {
    if (keep.size >= max) break;
    add(f);
  }
  return { piece: { ...piece, features: features.filter((f) => keep.has(String(f.id))) }, cut: true };
}

/** The sampled copy of a page's documents (capped timelines and maps), and what was cut. */
function trimPage(l: Loaded): { loaded: Loaded; cuts: SampleCut[] } {
  const cuts: SampleCut[] = [];
  const documents = l.documents.map((d) => {
    const t = str(d.piece.settings.type) ?? 'blank';
    const name = str(d.piece.settings.name) ?? d.id;
    if (t === 'time') {
      const r = sampleTimeline(d.piece, SAMPLE_EVENTS_PER_TIMELINE);
      if (!r.cut) return d;
      cuts.push({
        page: l.entry.name,
        document: name,
        what: 'events',
        kept: (r.piece.events ?? []).length,
        of: (d.piece.events ?? []).length,
        lanes: { kept: (r.piece.lanes ?? []).length, of: (d.piece.lanes ?? []).length },
      });
      return { ...d, piece: r.piece };
    }
    if (t === 'map') {
      const r = sampleMap(d.piece, SAMPLE_FEATURES_PER_MAP);
      if (!r.cut) return d;
      cuts.push({
        page: l.entry.name,
        document: name,
        what: 'features',
        kept: (r.piece.features ?? []).length,
        of: (d.piece.features ?? []).length,
      });
      return { ...d, piece: r.piece };
    }
    return d;
  });
  return { loaded: cuts.length > 0 ? { ...l, documents } : l, cuts };
}

const WINDOW_MS: Readonly<Record<string, number>> = { min: 60_000, hour: 3_600_000, day: 86_400_000 };
const windowOf = (tier: string): number | null => WINDOW_MS[tier.split('-').pop() ?? ''] ?? null;

/**
 * v2 E5.4: the time per write and per read at P3, from the governor's own estimate: a write takes at least the write
 * spacing, and once the work needs more than a window's P3 share of a tier (`capacityPerWindow`), its share of that tier
 * (`window / capacity`): a write of the write and request tiers, a read of the request tiers.
 */
export function pacingOf(
  est: {
    pacingMs?: number;
    tiers?: readonly { tier: string; demand: number; capacityPerWindow: number }[];
  },
  writes: number,
): { msPerWrite: number; msPerRead: number } {
  let msPerWrite = writes > 0 && est.pacingMs ? est.pacingMs / writes : 0;
  let msPerRead = 0;
  for (const t of est.tiers ?? []) {
    const w = windowOf(t.tier);
    // A tier slows the run only once the work needs more than one window's share; then it flows at its steady rate.
    if (w === null || t.capacityPerWindow <= 0 || t.demand <= t.capacityPerWindow) continue;
    const per = w / t.capacityPerWindow;
    if (t.tier.startsWith('write-')) msPerWrite = Math.max(msPerWrite, per);
    else if (!t.tier.startsWith('items-')) {
      msPerRead = Math.max(msPerRead, per);
      // A write is also a request: it costs at least its share of the request tiers.
      msPerWrite = Math.max(msPerWrite, per);
    }
  }
  return { msPerWrite: Math.ceil(msPerWrite), msPerRead: Math.ceil(msPerRead) };
}

// ============================================================================================ the copy's transforms

/** Turns snapshot pieces into the rehearsal's (inert guarded values, remapped references); the same for both sides. */
export class Mapper {
  readonly pages = new Map<string, string>();
  readonly docs = new Map<string, string>();
  readonly urls = new Map<string, string>();
  readonly assets = new Map<string, string>();
  readonly names = new Map<string, string>();
  outside = 0;
  inert = 0;
  constructor(
    private readonly guarded: { readonly keys: readonly string[]; readonly tags: readonly string[] },
  ) {}

  name(n: string): string {
    return `${INERT}${n}`;
  }

  tags(t: readonly unknown[]): string[] {
    const tags = this.guarded.tags.map((x) => x.toLowerCase());
    return t
      .filter((x): x is string => typeof x === 'string')
      .map((x) => (tags.includes(x.toLowerCase()) ? (this.inert++, `rehearsal-${x}`.slice(0, 100)) : x));
  }

  private link(href: string): string | null {
    const m = /^lk:\/\/resources\/([a-z][0-9a-z]+)(?:\/docs\/([a-z][0-9a-z]+))?$/.exec(href);
    if (!m) return href;
    const page = this.pages.get(m[1]!);
    if (!page) return null;
    if (!m[2]) return `lk://resources/${page}`;
    const doc = this.docs.get(m[2]);
    return doc ? `lk://resources/${page}/docs/${doc}` : `lk://resources/${page}`;
  }

  /** A run list: mentions remapped (outside: plain text), links remapped (outside: dropped), unwritable runs dropped. */
  runs(content: readonly unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const r of content) {
      if (!isObj(r) || isUnwritableRun(r)) continue;
      if (isObj(r.mention)) {
        const rid = str(r.mention.resourceId);
        const page = rid ? this.pages.get(rid) : undefined;
        if (!page) {
          this.outside++;
          out.push({ text: str(r.mention.text) ?? str(r.mention.name) ?? rid ?? '' });
          continue;
        }
        const doc = str(r.mention.documentId);
        const mapped: Obj = { resourceId: page };
        if (doc && this.docs.has(doc)) mapped.documentId = this.docs.get(doc);
        if (typeof r.mention.text === 'string') mapped.text = r.mention.text;
        out.push({ mention: mapped });
        continue;
      }
      if (typeof r.link === 'string') {
        const to = this.link(r.link);
        if (to === null) {
          this.outside++;
          const { link: _l, ...rest } = r;
          out.push(rest);
          continue;
        }
        out.push({ ...r, link: to });
        continue;
      }
      out.push(r);
    }
    return out;
  }

  /** Blocks for the copy: unsupported blocks left out (they cannot be written), runs and image URLs remapped. */
  blocks(blocks: readonly unknown[]): unknown[] {
    const walk = (list: readonly unknown[]): unknown[] => {
      const out: unknown[] = [];
      for (const raw of list) {
        if (!isObj(raw) || raw.kind === 'unsupported') continue;
        const b = { ...(stripVersions(raw) as Obj) };
        if (Array.isArray(b.content)) b.content = this.runs(b.content as unknown[]);
        if (typeof b.url === 'string') b.url = this.urls.get(b.url) ?? b.url;
        if (typeof b.uri === 'string') b.uri = this.link(b.uri) ?? '';
        if (Array.isArray(b.children)) b.children = walk(b.children as unknown[]);
        out.push(b);
      }
      return out;
    };
    return walk(blocks);
  }

  /** A sidebar's properties for the copy (unsupported ones left out). */
  properties(sb: SidebarPiece): Obj[] {
    const keys = this.guarded.keys.map((k) => k.trim().toLowerCase());
    const out: Obj[] = [];
    for (const p of sb.properties) {
      if (p.kind === 'unsupported') continue;
      const { rank: _r, ...base } = p;
      if (p.kind === 'keyValue') {
        out.push({
          ...base,
          rows: ((p.rows as Obj[] | undefined) ?? []).map((row) => {
            const { rank: _rank, ...r } = row;
            let content = this.runs(Array.isArray(r.content) ? (r.content as unknown[]) : []);
            if (keys.includes((str(r.key) ?? '').trim().toLowerCase()) && content.length > 0) {
              this.inert++;
              const text = content
                .map((x) =>
                  isObj(x) ? (str(x.text) ?? str(isObj(x.mention) ? x.mention.text : null) ?? '') : '',
                )
                .join('');
              content = [{ text: `${INERT}${text}` }];
            }
            return { ...r, content };
          }),
        });
      } else if (p.kind === 'resourceCollection' || p.kind === 'resourceLink') {
        const items: Obj[] = [];
        for (const i of (p.items as Obj[] | undefined) ?? []) {
          const page = this.pages.get(String(i.resourceId));
          if (!page) {
            this.outside++;
            continue;
          }
          const { rank: _rank, id: _id, ...rest } = i;
          const doc = str(i.documentId);
          items.push({
            ...rest,
            resourceId: page,
            ...(doc ? (this.docs.has(doc) ? { documentId: this.docs.get(doc) } : {}) : {}),
          });
          if (doc && !this.docs.has(doc)) delete items[items.length - 1]!.documentId;
        }
        const { filter: _f, ...noFilter } = base;
        out.push({ ...noFilter, items });
      } else out.push(base);
    }
    return out;
  }

  feature(f: Obj, ids: Map<string, string>): Obj {
    const out: Obj = { ...f, id: ids.get(String(f.id)) ?? f.id };
    if (typeof f.parentId === 'string' && f.parentId !== '') out.parentId = ids.get(f.parentId) ?? '';
    if (typeof f.uri === 'string' && f.uri !== '') {
      const to = this.link(f.uri);
      if (to === null) this.outside++;
      out.uri = to ?? '';
    }
    if (isObj(f.pinImage) && typeof f.pinImage.url === 'string')
      out.pinImage = { ...f.pinImage, url: this.urls.get(f.pinImage.url) ?? f.pinImage.url };
    return out;
  }

  event(e: Obj, ids: Map<string, string>, lanes: Map<string, string>): Obj {
    const out: Obj = {
      ...e,
      id: ids.get(String(e.id)) ?? e.id,
      laneId: lanes.get(String(e.laneId)) ?? e.laneId,
    };
    if (typeof e.uri === 'string' && e.uri !== '') {
      const to = this.link(e.uri);
      if (to === null) this.outside++;
      if (to === null) delete out.uri;
      else out.uri = to;
    }
    if (typeof e.imageUrl === 'string') out.imageUrl = this.urls.get(e.imageUrl) ?? e.imageUrl;
    return out;
  }

  boardContent(c: Obj): Obj {
    const remap = (x: unknown): unknown => {
      if (typeof x === 'string') return this.urls.get(x) ?? x;
      if (Array.isArray(x)) return x.map(remap);
      if (isObj(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, remap(v)]));
      return x;
    };
    return {
      shapes: remap(c.shapes ?? []),
      bindings: remap(c.bindings ?? []),
      assets: remap(c.assets ?? []),
    };
  }
}

// ============================================================================================ comparing

const stripIds = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stripIds);
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'id' || k === 'version' || k === 'rank') continue;
    if (k === 'content' && Array.isArray(x)) {
      out[k] = normaliseRuns(
        (x as Obj[]).map((r) =>
          isObj(r) && isObj(r.mention)
            ? {
                mention: {
                  resourceId: r.mention.resourceId,
                  ...(r.mention.documentId ? { documentId: r.mention.documentId } : {}),
                },
              }
            : r,
        ),
      );
      continue;
    }
    out[k] = stripIds(x);
  }
  return out;
};

function markdownOf(blocks: readonly unknown[]): string {
  try {
    return toMarkdown({ blocks: stripIds(blocks) as unknown[] } as DocumentInput, { selfCheck: false })
      .markdown;
  } catch (e) {
    return `(no Markdown: ${e instanceof Error ? e.message : String(e)})`;
  }
}

function firstDiff(a: unknown, b: unknown, path = ''): string | null {
  if (stableJson(a) === stableJson(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path || '(top)'}: ${a.length} items expected, ${b.length} found`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
  }
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return `${path || '(top)'}: expected ${JSON.stringify(a)?.slice(0, 120)}, found ${JSON.stringify(b)?.slice(0, 120)}`;
}

const byKey = (rows: readonly Obj[]) =>
  rows
    .map((r) => `${str(r.key) ?? ''}=${stableJson(stripIds(Array.isArray(r.content) ? r.content : []))}`)
    .sort();

// ============================================================================================ the service

export class Rehearsals {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly d: RehearsalDeps) {}

  private targetOf(targetRef: string) {
    const t = this.d.projects.find(targetRef);
    if (!t?.id) throw new RestoreError('UNKNOWN_PROJECT', `No served project ${targetRef}.`);
    if (!t.isSandbox)
      throw new RestoreError(
        'REHEARSAL_NOT_SANDBOX',
        `${t.name} is not marked as a sandbox project. A rehearsal writes a throwaway copy, so it goes only into a sandbox (the test world); mark it on the Projects page.`,
      );
    if (t.status !== 'active')
      throw new RestoreError('PROJECT_UNAVAILABLE', `${t.name} is not served now (${t.status}).`);
    return { id: t.id, name: t.name };
  }

  /** What a rehearsal would do: the pages, what they cover, and its estimated requests and time. */
  async plan(o: {
    targetProject: string;
    snapshotId: string;
    mode: 'sampled' | 'full';
    max?: number;
  }): Promise<{ plan: RehearsalPlan; loaded: Loaded[]; manifest: Manifest }> {
    const row = this.d.svc.index.snapshot(o.snapshotId);
    if (!row) throw new RestoreError('SNAPSHOT_NOT_FOUND', `No snapshot ${o.snapshotId}.`);
    if (row.kind !== 'full')
      throw new RestoreError(
        'REHEARSAL_NEEDS_FULL',
        'A rehearsal restores a full snapshot (the others hold only what changed).',
      );
    // The project the snapshot came from is refused first, whatever else is true of it.
    if (this.d.projects.find(o.targetProject)?.id === row.projectId)
      throw new RestoreError(
        'REHEARSAL_SAME_PROJECT',
        'A rehearsal never goes into the project the snapshot came from; choose the test world.',
      );
    const target = this.targetOf(o.targetProject);
    const manifest = await this.d.svc.manifest(row.id);
    if (!manifest)
      throw new RestoreError('SNAPSHOT_DAMAGED', `The manifest of ${row.id} is missing or unreadable.`);
    const chronologyId = str(this.d.projectSettings(row.projectId).chronologyResourceId);
    let loaded = await load(this.d.svc, manifest, chronologyId);
    const chosen =
      o.mode === 'full'
        ? { ids: loaded.map((l) => l.entry.id), coverage: {} }
        : choosePages(loaded, o.max ?? SAMPLE_SIZE);
    // v2 E5.4: a sampled rehearsal copies at most SAMPLE_EVENTS_PER_TIMELINE events of a timeline and
    // SAMPLE_FEATURES_PER_MAP features of a map (full mode copies everything); the plan says what was cut.
    const cuts: SampleCut[] = [];
    if (o.mode === 'sampled')
      loaded = loaded.map((l) => {
        if (!chosen.ids.includes(l.entry.id)) return l;
        const t = trimPage(l);
        cuts.push(...t.cuts);
        return t.loaded;
      });
    const pick = loaded.filter((l) => chosen.ids.includes(l.entry.id));
    const images = new Set(pick.flatMap((l) => (l.entry.images ?? []).map((i) => i.url)));
    let writes = 2 + 2; // the root and its asset folder, made and deleted
    let reads = 0;
    for (const l of pick) {
      writes += 1 + Math.max(0, l.documents.length - 5);
      reads += 1;
      for (const d of l.documents) {
        const t = str(d.piece.settings.type) ?? 'blank';
        if (t === 'page') {
          writes += 1;
          reads += 2;
        } else if (t === 'map') {
          writes += (d.piece.features ?? []).length + 1;
          reads += 2;
        } else if (t === 'time') {
          writes += (d.piece.lanes ?? []).length + (d.piece.events ?? []).length;
          reads += 3;
        } else if (t === 'board') {
          writes += 1;
          reads += 2;
        }
      }
      writes += l.sidebar?.properties.filter((p) => p.kind !== 'unsupported').length ?? 0;
    }
    writes += images.size * 2;
    reads += images.size;
    const est = this.d.projects.client(target.id)?.governor.estimate({ reads, writes, priority: 'P3' });
    // v2 E5.4: the governor's estimate assumes the work flows in parallel at the budget's steady rate; the rehearsal's
    // jobs run one after another, so the writes at P3's write rate plus the reads at its request rate bound it from below.
    const pacing = est ? pacingOf(est, writes) : null;
    const paced = pacing ? writes * pacing.msPerWrite + reads * pacing.msPerRead : 0;
    return {
      plan: {
        source: {
          projectId: row.projectId,
          snapshotId: row.id,
          takenAt: new Date(row.takenAt).toISOString(),
          kind: row.kind,
        },
        target: { projectId: target.id, name: target.name },
        mode: o.mode,
        pages: chosen.ids,
        coverage: chosen.coverage,
        images: images.size,
        cuts,
        estimate: {
          reads,
          writes,
          uploads: images.size,
          wallClockMs: est ? Math.max(est.wallClockMs, paced) : null,
          fitsToday: est ? est.fitsToday : null,
          pacing,
        },
      },
      loaded,
      manifest,
    };
  }

  /** Starts a rehearsal (the owner's, from the dashboard). It runs in the background; its row records its progress. */
  async start(o: {
    targetProject: string;
    snapshotId: string;
    mode: 'sampled' | 'full';
    keep: boolean;
    by: string;
    max?: number;
  }): Promise<RehearsalRow> {
    const { plan, loaded, manifest } = await this.plan(o);
    const id = `rh_${randomBytes(8).toString('hex')}`;
    this.d.svc.index.createRehearsal({
      id,
      projectId: plan.target.projectId,
      sourceProjectId: plan.source.projectId,
      snapshotId: plan.source.snapshotId,
      mode: o.mode,
      keep: o.keep,
      startedBy: o.by,
      estimate: plan.estimate,
      plan: { pages: plan.pages, coverage: plan.coverage, images: plan.images, cuts: plan.cuts },
    });
    const run = this.run(id, plan, loaded, manifest).catch((e: unknown) => {
      this.d.svc.index.updateRehearsal(id, {
        state: 'failed',
        error: e instanceof Error ? e.message : String(e),
        finished: true,
      });
      this.d.log?.warn({ err: e, rehearsal: id }, 'a rehearsal failed');
    });
    this.running.set(
      id,
      run.finally(() => this.running.delete(id)),
    );
    return this.d.svc.index.rehearsal(id)!;
  }

  /** Waits for a rehearsal started here to finish (tests, shutdown). */
  async settled(id: string): Promise<RehearsalRow | null> {
    await this.running.get(id);
    return this.d.svc.index.rehearsal(id);
  }

  /** Rehearsals a restart interrupted: stopped (their root, if any, is listed for the owner to delete). */
  markInterrupted(): void {
    for (const r of this.d.svc.index.runningRehearsals())
      if (!this.running.has(r.id))
        this.d.svc.index.updateRehearsal(r.id, {
          state: 'stopped',
          error: 'the bridge restarted during the rehearsal; delete its root from the Snapshots page',
          finished: true,
          rootState: r.rootId ? 'kept' : 'none',
        });
  }

  // ------------------------------------------------------------------------------------------ the run

  private origin(): JobOrigin {
    return { kind: 'ui', client: 'owner', tool: 'snapshot_rehearsal' };
  }

  /** Submits a batch to the target and waits for it to end. */
  /**
   * `named` (v2 E5.2): what a step writes, so a refused one is named for the owner (the page, the document, the feature
   * with its name and id), not only by its index.
   */
  private async job(
    projectId: string,
    steps: StepSpec[],
    title: string,
    named?: ReadonlyMap<StepSpec, string>,
  ): Promise<JobView> {
    let r: Awaited<ReturnType<JobEngine['submit']>>;
    try {
      r = await this.d.engine.submit({
        kind: 'batch_ops',
        project: projectId,
        steps,
        onError: 'continue',
        priority: 'P3',
        origin: this.origin(),
        title: title.slice(0, 300),
      });
    } catch (e) {
      if (e instanceof InvalidParamsError && named) {
        const at = e.issues.map((x) => /^steps\[(\d+)\]/.exec(x.path)).find((m) => m !== null);
        const step = at ? steps[Number(at[1])] : undefined;
        const what = step ? named.get(step) : undefined;
        if (what) throw new InvalidParamsError(e.opId, e.issues, `${e.message} (${what})`);
      }
      throw e;
    }
    if (!('jobId' in r))
      throw new RestoreError(
        'REHEARSAL_PROPOSED',
        `The rehearsal's writes were turned into a proposal (${String((r as { proposalId?: string }).proposalId)}); a guard judged them protected. Nothing was written.`,
      );
    for (;;) {
      const j = await this.d.engine.wait(projectId, r.jobId, this.d.waitMs ?? 25_000);
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    }
  }

  private results(projectId: string, job: JobView) {
    return this.d.engine.stepResults(projectId, job.id) ?? [];
  }

  async run(id: string, plan: RehearsalPlan, loaded: Loaded[], manifest: Manifest): Promise<void> {
    const started = this.d.now();
    const target = plan.target.projectId;
    const idx = this.d.svc.index;
    const lc = lifecycleFrom(this.d.projectSettings(target));
    const canon = canonConfigFrom(this.d.projectSettings(target));
    const guardedKeys = new Set([
      lc.fields.status,
      ...canon.active.filter((r) => r.kind === 'value').map((r) => (r as { key: string }).key),
    ]);
    const map = new Mapper({
      keys: [...guardedKeys],
      tags: [lc.tags.canon, lc.tags.working, lc.tags.archived],
    });
    const pick = loaded.filter((l) => plan.pages.includes(l.entry.id));
    const differences: Difference[] = [];
    const cannot: Difference[] = [];
    const created = new Set<string>();
    const counts = { writes: 0, reads: 0, uploads: 0, jobs: 0 };
    const stamp = new Date(started).toISOString().replace(/\.\d+Z$/, 'Z');
    const rootName = `lk-bridge rehearsal ${stamp}`;
    const rootId = mintClientId(8);
    let assetFolder: string | null = null;
    // The asset folder's id rides along with the progress, so "Delete its root" later removes it too.
    const progress = (p: Obj) =>
      idx.updateRehearsal(id, {
        progress: {
          ...p,
          writes: counts.writes,
          reads: counts.reads,
          ...(assetFolder ? { assetFolder } : {}),
        },
      });

    /** Every write the rehearsal makes stays in its root (or its own asset folder): checked before each job. */
    const inside = (steps: readonly StepSpec[], folder: string | null) =>
      assertInsideRoot(steps, { created, rootId, assetFolder: folder });

    // ---- 1. the root and its asset folder
    const rootSteps: StepSpec[] = [
      { op: 'createResource', params: { body: { id: rootId, name: rootName } } },
    ];
    inside(rootSteps, null);
    let j = await this.job(target, rootSteps, `rehearsal ${id}: root`);
    counts.jobs++;
    counts.writes++;
    if (j.status !== 'succeeded')
      throw new RestoreError(
        'REHEARSAL_ROOT',
        `The rehearsal's root could not be created: ${j.lastError?.message ?? j.status}`,
      );
    created.add(rootId);
    idx.updateRehearsal(id, { rootId, rootName, rootState: 'kept' });
    const images = [
      ...new Set(
        pick
          .flatMap((l) => l.entry.images ?? [])
          .filter((i) => i.sha256)
          .map((i) => `${i.url}\u0000${i.sha256!}`),
      ),
    ].map((x) => {
      const [url, sha] = x.split('\u0000') as [string, string];
      return { url, sha };
    });
    if (images.length > 0) {
      j = await this.job(
        target,
        [{ op: 'createAssetFolder', params: { body: { name: rootName } } }],
        `rehearsal ${id}: asset folder`,
      );
      counts.writes++;
      const v = this.results(target, j)[0]?.value as Obj | undefined;
      assetFolder = str(v?.id);
      progress({ stage: 'images', images: images.length });
    }
    // ---- 2. images: their bytes from the store, uploaded as they are; the upload's verify compares the SHA-256
    for (const img of images) {
      const bytes = await this.d.svc.store.get(img.sha);
      if (!bytes) {
        differences.push({
          page: '(library)',
          piece: `image ${img.url}`,
          reason: 'its bytes are missing or damaged in the snapshot store',
        });
        continue;
      }
      let type: string;
      try {
        type = detectImageType(bytes).contentType;
      } catch {
        type = 'application/octet-stream';
      }
      const r = await this.d.engine.submit({
        kind: 'upload_image',
        project: target,
        contentType: type,
        contentLength: bytes.length,
        contentHash: img.sha,
        dataBase64: bytes.toString('base64'),
        name: img.url
          .split('/')
          .pop()!
          .replace(/\.[a-z0-9]+$/i, ''),
        ...(assetFolder ? { folderId: assetFolder } : {}),
        verifyStored: true,
        origin: this.origin(),
        priority: 'P3',
      });
      counts.uploads++;
      counts.writes += 2;
      if (!('jobId' in r)) continue;
      let done: JobView;
      for (;;) {
        done = await this.d.engine.wait(target, r.jobId, this.d.waitMs ?? 25_000);
        if (['succeeded', 'failed', 'cancelled'].includes(done.status)) break;
      }
      const steps = this.results(target, done);
      const asset = steps
        .map((s) => s.value as Obj | null)
        .find((v) => isObj(v) && typeof v.url === 'string' && typeof v.id === 'string');
      const verify = steps
        .map((s) => s.value as Obj | null)
        .find((v) => isObj(v) && typeof v.storedBytesVerified === 'boolean');
      if (!asset) {
        differences.push({
          page: '(library)',
          piece: `image ${img.url}`,
          reason: `the upload failed: ${done.lastError?.message ?? done.status}`,
        });
        continue;
      }
      map.urls.set(img.url, String(asset.url));
      if (verify && verify.storedBytesVerified !== true)
        differences.push({
          page: '(library)',
          piece: `image ${img.url}`,
          reason: `the stored bytes differ from the snapshot's (SHA-256): ${str(verify.reason) ?? ''}`,
        });
    }
    progress({ stage: 'structure', images: images.length });

    // A field LegendKeeper refused (an icon name it does not know) goes without it: listed, and not compared.
    const iconDropped = new Set<string>();
    const noteDropped = (page: string, results: readonly { value: unknown }[]) => {
      for (const x of results) {
        const v = x.value as { droppedFields?: Record<string, unknown>; droppedWhere?: unknown } | null;
        if (!v || typeof v !== 'object' || !v.droppedFields) continue;
        iconDropped.add(page);
        for (const [field, value] of Object.entries(v.droppedFields))
          cannot.push({
            page,
            piece: `${field} ${JSON.stringify(value)}${typeof v.droppedWhere === 'string' ? ` (${v.droppedWhere})` : ''}`,
            reason: 'LegendKeeper refused it; written without it (its default applies)',
          });
      }
    };

    // ---- 3. the structure: every page (parents first) with its documents (typed, up to five with the page)
    const order = [...pick].sort((a, b) => depthOf(a.entry, manifest) - depthOf(b.entry, manifest));
    for (const l of pick) map.pages.set(l.entry.id, mintClientId(8));
    // Pages that were not made (LegendKeeper refused them, or an ancestor they hang from): never written under.
    const notMade = new Map<string, string>();
    for (const l of order) {
      const e = l.entry;
      let parent = rootId;
      let parentEntry: string | null = null;
      for (
        let c = e.parentId, i = 0;
        c && i < 100;
        c = manifest.pages.find((p) => p.id === c)?.parentId ?? null, i++
      ) {
        if (map.pages.has(c)) {
          parent = map.pages.get(c)!;
          parentEntry = c;
          break;
        }
      }
      if (parentEntry !== null && notMade.has(parentEntry)) {
        // Its copy's parent does not exist: say so, and go on with the pages that do not hang from it.
        const pname = notMade.get(parentEntry)!;
        notMade.set(e.id, pname);
        differences.push({
          page: e.name,
          piece: 'page',
          reason: `not attempted: its parent in the copy (${pname}) could not be created`,
        });
        continue;
      }
      const res = l.resource ?? { name: e.name };
      const body: Obj = {
        id: map.pages.get(e.id),
        parentId: parent,
        name: map.name(str(res.name) ?? e.name),
        // What was read goes back in the write form (`fas fa-book` → `book`, ADR 0042 decision 9).
        ...withWriteIcon(
          pickFields(res, bodyFields('createResource'), [
            'name',
            'tags',
            'documents',
            'id',
            'parentId',
            'after',
            'before',
          ]),
        ),
        tags: map.tags(Array.isArray(res.tags) ? (res.tags as unknown[]) : []),
      };
      const first = l.documents.slice(0, 5);
      if (first.length > 0)
        body.documents = first.map((d) => ({
          type: str(d.piece.settings.type) ?? 'blank',
          name: str(d.piece.settings.name) ?? 'Main',
        }));
      const steps: StepSpec[] = [{ op: 'createResource', params: { body }, ...ICON_DROP }];
      for (const d of l.documents.slice(5))
        steps.push({
          op: 'createDocument',
          params: {
            path: { resourceId: String(body.id) },
            body: {
              type: str(d.piece.settings.type) ?? 'blank',
              name: str(d.piece.settings.name) ?? 'Document',
            },
          },
        });
      inside(steps, assetFolder);
      j = await this.job(target, steps, `rehearsal ${id}: page ${e.name}`);
      counts.jobs++;
      counts.writes += steps.length;
      const r = this.results(target, j);
      if (r[0]?.status !== 'succeeded') {
        differences.push({
          page: e.name,
          piece: 'page',
          reason: `could not be created: ${JSON.stringify(r[0]?.error ?? j.lastError).slice(0, 300)}`,
        });
        notMade.set(e.id, e.name);
        continue;
      }
      created.add(String(body.id));
      noteDropped(l.entry.name, r);
      const docsMade = (
        isObj(r[0].value) && Array.isArray(r[0].value.documents) ? (r[0].value.documents as Obj[]) : []
      ).map((x) => String(x.id));
      first.forEach((d, i) => docsMade[i] && map.docs.set(d.id, docsMade[i]));
      l.documents.slice(5).forEach((d, i) => {
        const v = r[i + 1]?.value as Obj | undefined;
        if (typeof v?.id === 'string') map.docs.set(d.id, v.id);
      });
    }
    progress({ stage: 'content', pages: created.size - 1 });

    // ---- 4. the content: documents, sidebars and settings, with every reference remapped
    const expected = new Map<string, { docs: Map<string, Obj>; sidebar: Obj[] }>();
    for (const l of order) {
      const pageId = map.pages.get(l.entry.id)!;
      if (!created.has(pageId)) continue;
      const steps: StepSpec[] = [];
      const named = new Map<StepSpec, string>();
      const exp = { docs: new Map<string, Obj>(), sidebar: [] as Obj[] };
      for (const d of l.documents) {
        const docId = map.docs.get(d.id);
        if (!docId) continue;
        const path = { resourceId: pageId, documentId: docId };
        const t = str(d.piece.settings.type) ?? 'blank';
        if (t === 'page') {
          const blocks = map.blocks(d.piece.blocks ?? []);
          for (const b of (d.piece.blocks ?? []).filter((x) => isObj(x) && x.kind === 'unsupported'))
            cannot.push({
              page: l.entry.name,
              piece: `${String(d.piece.settings.name)} block ${String((b as Obj).id)}`,
              reason: 'unsupported: the API cannot write it',
            });
          steps.push({ op: 'replaceDocumentBlocks', params: { path, body: { blocks } } });
          exp.docs.set(docId, { type: 'page', blocks });
        } else if (t === 'map') {
          const ids = new Map(
            ((d.piece.features ?? []) as Obj[]).map((f) => [String(f.id), mintClientId(8)]),
          );
          const byId = new Map(((d.piece.features ?? []) as Obj[]).map((f) => [String(f.id), f]));
          const depth = (f: Obj) => {
            let n = 0;
            for (let q = str(f.parentId); q && n < 50; q = str(byId.get(q)?.parentId)) n++;
            return n;
          };
          const create = bodyFields('createFeature');
          const docName = str(d.piece.settings.name) ?? d.id;
          const sorted = [...byId.values()].sort((a, b) => depth(a) - depth(b));
          // v2 E5.4: no label size is ever sent (LegendKeeper's API cannot round-trip it): left out, its default applies,
          // and counted once for the map.
          let dropped = 0;
          const feats = sorted.map((f) => {
            const n = normaliseFeatureBody(pickFields(f, create));
            if (n.dropped) dropped++;
            return map.feature(n.body, ids);
          });
          if (dropped > 0)
            cannot.push({
              page: l.entry.name,
              piece: `${docName}: the label size of ${dropped} feature(s)`,
              reason: LABEL_SIZE_NOT_RESTORABLE,
            });
          feats.forEach((f, i) => {
            const step: StepSpec = {
              op: 'createFeature',
              params: { path, body: withWriteIcon(f) },
              ...ICON_DROP,
            };
            steps.push(step);
            named.set(
              step,
              `page “${l.entry.name}” (${l.entry.id}), document “${docName}” (${d.id}), feature ${featureName(sorted[i]!)}`,
            );
          });
          const img = isObj(d.piece.settings.mapImage) ? d.piece.settings.mapImage : null;
          if (img && typeof img.url === 'string' && map.urls.has(img.url)) {
            // The uploaded copy's asset id: the URL's last part is not the id, so the asset is looked up by its upload.
            const assetId = this.assetByUrl(target, map.urls.get(img.url)!);
            if (assetId)
              steps.push({ op: 'updateDocument', params: { path, body: { mapImage: { assetId } } } });
          }
          exp.docs.set(docId, { type: 'map', features: feats });
        } else if (t === 'time') {
          const laneIds = new Map(
            ((d.piece.lanes ?? []) as Obj[]).map((x) => [String(x.id), mintClientId(8)]),
          );
          const evIds = new Map(
            ((d.piece.events ?? []) as Obj[]).map((x) => [String(x.id), mintClientId(8)]),
          );
          const lanes = ((d.piece.lanes ?? []) as Obj[]).map((x) => ({
            size: 'sm',
            ...pickFields(x, bodyFields('createLane')),
            id: laneIds.get(String(x.id)),
          }));
          const evFields = bodyFields('createEvent');
          evFields.delete('formattedStart');
          evFields.delete('formattedEnd');
          const events = ((d.piece.events ?? []) as Obj[]).map((x) =>
            map.event(pickFields(x, evFields), evIds, laneIds),
          );
          for (const x of lanes) steps.push({ op: 'createLane', params: { path, body: x } });
          for (const x of events)
            steps.push({ op: 'createEvent', params: { path, body: withWriteIcon(x) }, ...ICON_DROP });
          exp.docs.set(docId, { type: 'time', lanes, events });
        } else if (t === 'board') {
          const c = map.boardContent(d.piece.content ?? {});
          steps.push({ op: 'replaceBoardContent', params: { path, body: c } });
          cannot.push({
            page: l.entry.name,
            piece: `${String(d.piece.settings.name)} pages`,
            reason: 'board pages cannot be written by the API (a new board has one)',
          });
          exp.docs.set(docId, { type: 'board', ...c });
        }
        const set: Obj = {};
        for (const k of ['isHidden', 'isFullWidth'] as const) if (d.piece.settings[k] === true) set[k] = true;
        if (Object.keys(set).length > 0) steps.push({ op: 'updateDocument', params: { path, body: set } });
      }
      if (l.sidebar) {
        let prev: string | null = null;
        for (const p of map.properties(l.sidebar)) {
          steps.push({
            op: 'createProperty',
            params: { path: { resourceId: pageId }, body: { ...p, ...(prev ? { after: prev } : {}) } },
          });
          exp.sidebar.push(p);
          if (typeof p.id === 'string') prev = p.id;
        }
        for (const p of l.sidebar.properties.filter((x) => x.kind === 'unsupported'))
          cannot.push({
            page: l.entry.name,
            piece: `property ${String(p.title ?? p.id)}`,
            reason: 'unsupported: the API cannot recreate it',
          });
      }
      expected.set(pageId, exp);
      if (steps.length === 0) continue;
      inside(steps, assetFolder);
      j = await this.job(target, steps, `rehearsal ${id}: content of ${l.entry.name}`, named);
      counts.jobs++;
      counts.writes += steps.length;
      noteDropped(l.entry.name, this.results(target, j));
      for (const s of this.results(target, j))
        if (s.status !== 'succeeded')
          differences.push({
            page: l.entry.name,
            piece: ((st) => (st ? (named.get(st) ?? st.op) : 'write'))(steps[s.stepNo - 1]),
            reason: `refused: ${JSON.stringify(s.error).slice(0, 300)}`,
          });
    }
    progress({ stage: 'compare', pages: created.size - 1 });

    // ---- 5. the comparison: read back and compare with the expected copy
    const read = this.d.svc.reader(target, 'P3');
    const counted: Reader = async (op, params) => {
      counts.reads++;
      return read(op, params);
    };
    let exact = 0;
    let compared = 0;
    for (const l of order) {
      const pageId = map.pages.get(l.entry.id)!;
      const exp = expected.get(pageId);
      if (!exp) continue;
      compared++;
      const before = differences.length;
      // v2 E5.4: a read that fails is a difference for that page and piece; the comparison goes on with the rest.
      const failed = (piece: string, e: unknown) =>
        differences.push({
          page: l.entry.name,
          piece,
          reason: isLabelSizeListError(e)
            ? LABEL_SIZE_UNLISTABLE
            : `could not be read: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
        });
      let res: Obj | undefined;
      try {
        res = (await counted('getResource', { path: { resourceId: pageId } })) as Obj | undefined;
      } catch (e) {
        failed('page', e);
        continue;
      }
      if (!res) {
        differences.push({ page: l.entry.name, piece: 'page', reason: 'not found after it was written' });
        continue;
      }
      const wantName = map.name(str(l.resource?.name) ?? l.entry.name);
      if (res.name !== wantName)
        differences.push({
          page: l.entry.name,
          piece: 'name',
          reason: `expected “${wantName}”, found “${String(res.name)}”`,
        });
      // Sidebars by key and value; collections by their pages.
      const live = sidebarPiece(res.properties ?? []).properties;
      const wantKv = exp.sidebar.filter((p) => p.kind === 'keyValue');
      const liveKv = live.filter((p) => p.kind === 'keyValue');
      if (
        stableJson(wantKv.map((p) => [p.title, byKey((p.rows as Obj[]) ?? [])])) !==
        stableJson(liveKv.map((p) => [p.title, byKey((p.rows as Obj[]) ?? [])]))
      )
        differences.push({
          page: l.entry.name,
          piece: 'sidebar facts',
          reason:
            firstDiff(
              wantKv.map((p) => byKey((p.rows as Obj[]) ?? [])),
              liveKv.map((p) => byKey((p.rows as Obj[]) ?? [])),
            ) ?? 'differ',
        });
      const coll = (ps: readonly Obj[]) =>
        ps
          .filter((p) => p.kind === 'resourceCollection' || p.kind === 'resourceLink')
          .map((p) => [
            p.title,
            ((p.items as Obj[]) ?? [])
              .map((i) => `${String(i.resourceId)}/${str(i.documentId) ?? ''}`)
              .sort(),
          ]);
      if (stableJson(coll(exp.sidebar)) !== stableJson(coll(live)))
        differences.push({
          page: l.entry.name,
          piece: 'sidebar links',
          reason: firstDiff(coll(exp.sidebar), coll(live)) ?? 'differ',
        });
      // Documents.
      const liveDocs = (Array.isArray(res.documents) ? (res.documents as Obj[]) : []).filter(
        (x) => x.deletedAt == null,
      );
      for (const [docId, want] of exp.docs) {
        const doc = liveDocs.find((x) => x.id === docId);
        if (!doc) {
          differences.push({ page: l.entry.name, piece: `document ${docId}`, reason: 'missing' });
          continue;
        }
        const name = str(doc.name) ?? docId;
        let got: DocumentPiece | undefined;
        try {
          got = (await documentPieceOf(counted, pageId, doc)) as DocumentPiece | undefined;
        } catch (e) {
          failed(name, e);
          continue;
        }
        if (!got) {
          differences.push({ page: l.entry.name, piece: name, reason: 'could not be read' });
          continue;
        }
        if (want.type === 'page') {
          const a = stripIds(want.blocks);
          const b = stripIds(got.blocks ?? []);
          const mdA = markdownOf(want.blocks as unknown[]);
          const mdB = markdownOf(got.blocks ?? []);
          if (stableJson(a) !== stableJson(b) || mdA !== mdB)
            differences.push({
              page: l.entry.name,
              piece: name,
              reason: mdA !== mdB ? 'its Markdown differs' : 'its blocks differ (ids ignored)',
              detail: firstDiff(a, b),
            });
        } else if (want.type === 'map') {
          const skip = iconDropped.has(l.entry.name) ? ['rank', ...ICON_FIELDS] : ['rank'];
          // The write form has no style (`far`, `fab`): an icon is compared by its name.
          // v2 E5.4: the label size is never written, so never compared.
          const norm = (fs: readonly Obj[]) =>
            fs
              .map((f) =>
                stableJson(
                  withWriteIcon(comparableFeature(pickFields(f, bodyFields('createFeature'), skip))),
                ),
              )
              .sort();
          if (stableJson(norm(want.features as Obj[])) !== stableJson(norm(got.features ?? [])))
            differences.push({
              page: l.entry.name,
              piece: name,
              reason: 'map features differ',
              detail: firstDiff(norm(want.features as Obj[]), norm(got.features ?? [])),
            });
        } else if (want.type === 'time') {
          const evF = bodyFields('createEvent');
          const n = (xs: readonly Obj[], fields: Set<string>) =>
            xs
              .map((x) =>
                stableJson(
                  withWriteIcon(
                    pickFields(x, fields, [
                      'rank',
                      'formattedStart',
                      'formattedEnd',
                      ...(iconDropped.has(l.entry.name) ? ICON_FIELDS : []),
                    ]),
                  ),
                ),
              )
              .sort();
          if (
            stableJson(n(want.events as Obj[], evF)) !== stableJson(n(got.events ?? [], evF)) ||
            stableJson(n(want.lanes as Obj[], bodyFields('createLane'))) !==
              stableJson(n(got.lanes ?? [], bodyFields('createLane')))
          )
            differences.push({
              page: l.entry.name,
              piece: name,
              reason: 'timeline lanes or events differ',
              detail: firstDiff(n(want.events as Obj[], evF), n(got.events ?? [], evF)),
            });
        } else if (want.type === 'board') {
          const ids = (xs: unknown) =>
            stableJson((Array.isArray(xs) ? (xs as Obj[]) : []).map((x) => stableJson(x)).sort());
          if (
            ids(want.shapes) !== ids(got.content?.shapes) ||
            ids(want.bindings) !== ids(got.content?.bindings)
          )
            differences.push({ page: l.entry.name, piece: name, reason: 'board shapes or bindings differ' });
        }
      }
      if (differences.length === before) exact++;
    }

    // ---- 6. clean up (unless kept)
    const result = {
      pagesPlanned: plan.pages.length,
      pagesCompared: compared,
      exact,
      differences,
      cannotRestore: cannot,
      changedForRehearsal: { names: compared, guardedValues: map.inert, referencesOutside: map.outside },
      images: { uploaded: map.urls.size, of: images.length },
      cost: { ...counts },
      ms: this.d.now() - started,
    };
    const row = idx.rehearsal(id);
    let rootState: RehearsalRow['rootState'] = 'kept';
    if (!row?.keep) {
      j = await this.d.engine
        .submit({
          kind: 'batch_ops',
          project: target,
          steps: [
            {
              op: 'deleteResource',
              params: { path: { resourceId: rootId }, query: { cascade: true } },
              confirm: 'cascade',
            },
            ...(assetFolder ? [{ op: 'deleteAsset', params: { path: { assetId: assetFolder } } }] : []),
          ],
          onError: 'continue',
          priority: 'P3',
          origin: this.origin(),
          title: `rehearsal ${id}: delete its root`,
        })
        .then(async (r) => {
          if (!('jobId' in r))
            throw new RestoreError(
              'REHEARSAL_PROPOSED',
              'The clean-up was turned into a proposal; delete the root by hand.',
            );
          for (;;) {
            const x = await this.d.engine.wait(target, r.jobId, this.d.waitMs ?? 25_000);
            if (['succeeded', 'failed', 'cancelled'].includes(x.status)) return x;
          }
        });
      counts.writes += assetFolder ? 2 : 1;
      rootState = j.status === 'succeeded' ? 'deleted' : 'delete_failed';
    }
    idx.updateRehearsal(id, {
      state: 'succeeded',
      result: { ...result, cost: { ...counts }, ms: this.d.now() - started },
      rootState,
      finished: true,
    });
  }

  /** The asset id of an image the rehearsal uploaded, by its URL (the target's asset tree, or the upload's own record). */
  private assetByUrl(projectId: string, url: string): string | null {
    try {
      const r = this.d.svc.o.db
        .prepare('SELECT id FROM asset_items WHERE project_id = ? AND url = ? LIMIT 1')
        .get(projectId, url) as { id: string } | undefined;
      return r?.id ?? null;
    } catch {
      return null;
    }
  }

  /** The owner's "Delete the root" for a kept rehearsal root. */
  async deleteRoot(id: string): Promise<RehearsalRow> {
    const row = this.d.svc.index.rehearsal(id);
    if (!row?.rootId) throw new RestoreError('NO_ROOT', 'This rehearsal has no root to delete.');
    if (row.rootState === 'deleted') return row;
    const folder = str(row.progress.assetFolder);
    const r = await this.d.engine.submit({
      kind: 'batch_ops',
      project: row.projectId,
      steps: [
        {
          op: 'deleteResource',
          params: { path: { resourceId: row.rootId }, query: { cascade: true } },
          confirm: 'cascade',
        },
        ...(folder ? [{ op: 'deleteAsset', params: { path: { assetId: folder } } }] : []),
      ],
      onError: 'continue',
      priority: 'P2',
      origin: this.origin(),
      title: `rehearsal ${id}: delete its root`,
    });
    if ('jobId' in r) {
      let j: JobView;
      for (;;) {
        j = await this.d.engine.wait(row.projectId, r.jobId, this.d.waitMs ?? 25_000);
        if (['succeeded', 'failed', 'cancelled'].includes(j.status)) break;
      }
      this.d.svc.index.updateRehearsal(id, {
        rootState: j.status === 'succeeded' ? 'deleted' : 'delete_failed',
      });
    }
    return this.d.svc.index.rehearsal(id)!;
  }
}

/**
 * The rehearsal's guard (ADR 0042 decision 7): every write a job holds stays in the rehearsal's root or its own asset
 * folder, judged before the job is submitted. A page a step creates counts as inside for the steps AFTER it in the same
 * job (a root, a child and a grandchild made in one job are all inside), and for later jobs once `created` holds them
 * (the caller adds a page when its job succeeded). A parent the rehearsal did not make is refused.
 */
export function assertInsideRoot(
  steps: readonly StepSpec[],
  ctx: {
    readonly created: ReadonlySet<string>;
    readonly rootId: string;
    readonly assetFolder: string | null;
  },
): void {
  const here = new Set<string>();
  const isInside = (id: unknown): boolean =>
    typeof id === 'string' && (id === ctx.rootId || ctx.created.has(id) || here.has(id));
  for (const s of steps) {
    const p = s.params ?? {};
    const rid = p.path?.resourceId;
    if (s.op === 'createResource') {
      const body = (p.body ?? {}) as Obj;
      const parent = body.parentId;
      // The root is the one page with no parent, and only when it is the root's own id.
      const ok = parent === undefined ? body.id === ctx.rootId : isInside(parent);
      if (!ok)
        throw new RestoreError(
          'REHEARSAL_OUTSIDE_ROOT',
          `refused: ${s.op} would create a page outside the rehearsal's root`,
        );
      if (typeof body.id === 'string') here.add(body.id);
      continue;
    }
    if (['createAssetFolder', 'createImageUpload', 'createImageAsset'].includes(s.op)) continue;
    if (s.op === 'updateAsset' || s.op === 'deleteAsset') {
      if (p.path?.assetId !== ctx.assetFolder)
        throw new RestoreError(
          'REHEARSAL_OUTSIDE_ROOT',
          `refused: ${s.op} on an asset that is not the rehearsal's`,
        );
      continue;
    }
    if (!isInside(rid))
      throw new RestoreError(
        'REHEARSAL_OUTSIDE_ROOT',
        `refused: ${s.op} on ${String(rid)}, which is not in the rehearsal's root`,
      );
  }
}

const ICON_DROP = { dropIfRefused: [...ICON_FIELDS] } as const;

function depthOf(e: PageEntry, m: Manifest): number {
  let n = 0;
  for (let c = e.parentId; c && n < 100; c = m.pages.find((p) => p.id === c)?.parentId ?? null) n++;
  return n;
}

/** A feature as the owner finds it: its name and its id in the snapshot. */
function featureName(f: Obj): string {
  return typeof f.name === 'string' && f.name !== '' ? `“${f.name}” (${String(f.id)})` : String(f.id);
}

function pickFields(o: Obj, fields: Set<string>, drop: readonly string[] = []): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o))
    if (fields.has(k) && !drop.includes(k) && v !== undefined && v !== null) out[k] = v;
  return out;
}
