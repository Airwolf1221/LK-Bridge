/**
 * Map features as the bridge models them (v2 D2, ADR 0040): the five types, the style fields checked against the
 * schema's enums and formats (and the types each applies to), the geometry shapes each type takes, how a stored feature
 * is compared (numbers with a tolerance, a region's `polygon` and `polygons` as one list of polygons), and the hash the
 * bridge's own compare-and-swap uses. Pure.
 */
import { withWriteIcon } from '../lk/icons.js';
import { createHash } from 'node:crypto';
import * as z from 'zod';
import type { Geometry, LatLng } from './geometry.js';

export type Obj = Record<string, unknown>;

export const FEATURE_TYPES = ['pin', 'label', 'region', 'path', 'folder'] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];

export const isFeatureType = (v: unknown): v is FeatureType =>
  typeof v === 'string' && (FEATURE_TYPES as readonly string[]).includes(v);

// ------------------------------------------------------------------------------------------------ styles

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'a colour as #RRGGBB');
const num = z.number().finite();

/** The style fields, with LegendKeeper's names, enums and formats (FeatureCreateParams / FeatureUpdateParams). */
export const styleSchema = z
  .object({
    // pins
    iconGlyph: z.string().min(1).max(128).describe('A pin’s FontAwesome icon name.'),
    iconColor: hex.describe('A pin’s fill colour, #RRGGBB.'),
    iconShape: z.enum(['pin', 'diamond', 'flag', 'marker', 'shield', 'circle', 'banner', 'arch', 'none']),
    iconSize: z.enum(['medium', 'small']),
    pinImage: z
      .object({ url: z.string().min(1).max(2048), width: num, height: num })
      .strict()
      .describe('A pin’s image: the url of an image asset of this project, with its size.'),
    // regions
    fillOpacity: num,
    fillStyle: z.enum(['solid', 'striped', 'dotted', 'none']),
    borderStyle: z.enum(['solid', 'dashed', 'dotted', 'none']),
    // regions and paths
    color: hex.describe('A region’s fill and border colour, or a path’s line colour, #RRGGBB.'),
    // paths
    strokeWidth: num,
    strokeStyle: z.enum(['solid', 'dashed', 'dotted', 'none']),
    strokeOpacity: num,
    // labels, regions and paths: the name text
    textColor: hex,
    textEffect: z.enum(['outline', 'background']),
    textEffectColor: hex,
    labelSize: z.enum(['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl']),
    // any
    labelVisibility: z.enum(['always', 'hover', 'never']),
    visibilityRange: z.tuple([num, num]).describe('The zoom range [min, max], each 0 to 1.'),
  })
  .partial()
  .strict();

export type StyleInput = z.infer<typeof styleSchema>;

/** The types each style field applies to (a field sent on another type is refused here, as LegendKeeper would). */
const APPLIES: Readonly<Record<string, readonly FeatureType[]>> = {
  iconGlyph: ['pin'],
  iconColor: ['pin'],
  iconShape: ['pin'],
  iconSize: ['pin'],
  pinImage: ['pin'],
  fillOpacity: ['region'],
  fillStyle: ['region'],
  borderStyle: ['region'],
  color: ['region', 'path'],
  strokeWidth: ['path'],
  strokeStyle: ['path'],
  strokeOpacity: ['path'],
  textColor: ['label', 'region', 'path'],
  textEffect: ['label', 'region', 'path'],
  textEffectColor: ['label', 'region', 'path'],
  labelSize: ['label', 'region', 'path'],
  labelVisibility: ['pin', 'label', 'region', 'path'],
  visibilityRange: ['pin', 'label', 'region', 'path'],
};

/** The style fields that do not apply to `type`, each with the types it applies to. */
export function misplacedStyles(
  type: FeatureType,
  style: Readonly<Record<string, unknown>>,
): { field: string; appliesTo: readonly FeatureType[] }[] {
  return Object.keys(style)
    .filter((k) => style[k] !== undefined && !(APPLIES[k] ?? []).includes(type))
    .map((field) => ({ field, appliesTo: APPLIES[field] ?? [] }));
}

export function styleFields(style: Readonly<Record<string, unknown>> | undefined): Obj {
  // A pin's icon goes to LegendKeeper in the write form (`fas fa-book` as a read gives it → `book`; ADR 0042 decision 9).
  return withWriteIcon(Object.fromEntries(Object.entries(style ?? {}).filter(([, v]) => v !== undefined)));
}

// ------------------------------------------------------------------------------------------------ geometry shapes

/** The geometry shape each type takes (null: none). Regions take `points` (one polygon) or `polygons` (several). */
export function shapesFor(type: FeatureType): readonly Geometry['shape'][] {
  switch (type) {
    case 'pin':
    case 'label':
      return ['point'];
    case 'region':
      return ['points', 'polygons'];
    case 'path':
      return ['points'];
    case 'folder':
      return [];
  }
}

export const MIN_POINTS: Readonly<Record<string, number>> = { region: 3, path: 2 };
export const MAX_POINTS = 10_000;
export const MAX_POLYGONS = 100;

/** A problem with a geometry's shape or size for its type, or null. */
export function shapeProblem(type: FeatureType, g: Geometry | null): string | null {
  const shapes = shapesFor(type);
  if (g === null) return null;
  if (shapes.length === 0) return `A ${type} takes no coordinates.`;
  if (!shapes.includes(g.shape)) {
    return type === 'region'
      ? 'A region takes `points` (one polygon) or `polygons` (several).'
      : type === 'path'
        ? 'A path takes `points`, in order.'
        : `A ${type} takes one position (\`latlng\` or \`pixel\`).`;
  }
  const min = MIN_POINTS[type] ?? 1;
  if (g.shape === 'points') {
    if (g.points.length < min) return `A ${type} needs at least ${min} points; ${g.points.length} given.`;
    if (g.points.length > MAX_POINTS) return `At most ${MAX_POINTS} points; ${g.points.length} given.`;
  }
  if (g.shape === 'polygons') {
    if (g.polygons.length < 1 || g.polygons.length > MAX_POLYGONS)
      return `A region takes 1 to ${MAX_POLYGONS} polygons; ${g.polygons.length} given.`;
    for (const [i, poly] of g.polygons.entries()) {
      if (poly.length < min) return `Polygon ${i + 1} needs at least ${min} points; ${poly.length} given.`;
      if (poly.length > MAX_POINTS) return `Polygon ${i + 1} has more than ${MAX_POINTS} points.`;
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ stored features

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

/** A stored feature's geometry in one shape: its position, its polygons (from `polygons`, else `polygon`) and its line. */
export function storedGeometry(f: Obj): {
  pos: LatLng | null;
  polygons: LatLng[][] | null;
  polyline: LatLng[] | null;
} {
  const list = (v: unknown): LatLng[] | null => (Array.isArray(v) && v.every(isPair) ? v : null);
  let polygons: LatLng[][] | null = null;
  if (Array.isArray(f.polygons) && f.polygons.length > 0 && f.polygons.every((p) => list(p) !== null))
    polygons = f.polygons as LatLng[][];
  else if (Array.isArray(f.polygon) && f.polygon.length > 0 && list(f.polygon) !== null)
    polygons = [f.polygon as LatLng[]];
  return { pos: isPair(f.pos) ? f.pos : null, polygons, polyline: list(f.polyline) };
}

/**
 * v2 E4 (backlog 4): the regions that carry BOTH a non-empty `polygon` and a non-empty `polygons` (LegendKeeper keeps
 * the old field when the other is written; which one the app draws is not known until the sandbox probe M6e answers).
 * read_document and the snapshots say so, rather than show one of them as the region's shape without a word.
 */
export function regionsWithBothForms(
  features: readonly unknown[],
): { id: string; name: string; polygonPoints: number; polygons: number }[] {
  const out: { id: string; name: string; polygonPoints: number; polygons: number }[] = [];
  for (const f of features) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Obj;
    if (o.type !== 'region') continue;
    if (
      Array.isArray(o.polygon) &&
      o.polygon.length > 0 &&
      Array.isArray(o.polygons) &&
      o.polygons.length > 0
    )
      out.push({
        id: String(o.id),
        name: typeof o.name === 'string' ? o.name : '',
        polygonPoints: o.polygon.length,
        polygons: o.polygons.length,
      });
  }
  return out;
}

/** The note read_document and the snapshots give for such regions (empty when there are none). */
export function bothFormsNote(features: readonly unknown[]): string | null {
  const both = regionsWithBothForms(features);
  if (both.length === 0) return null;
  return `${both.length} region(s) carry both a single \`polygon\` and \`polygons\` (${both
    .slice(0, 10)
    .map((r) => `“${r.name || r.id}”: polygon of ${r.polygonPoints} points, ${r.polygons} polygon(s)`)
    .join(
      '; ',
    )}). LegendKeeper keeps both; the positions shown are the \`polygons\`, and the app may draw the other. Check them in the app.`;
}

const close = (a: number, b: number): boolean =>
  Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));

/** Deep equality of two JSON values, numbers within a small tolerance (a stored coordinate may be rounded). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isNum(a) && isNum(b)) return close(a, b);
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as Obj).filter((k) => (a as Obj)[k] !== undefined);
    const kb = Object.keys(b as Obj).filter((k) => (b as Obj)[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => sameValue((a as Obj)[k], (b as Obj)[k]));
  }
  return false;
}

/**
 * Whether a stored feature holds `fields` (the values a write intended). A region's `polygon` and `polygons` are one
 * list of polygons; a `parentId` that is absent, `""` or null is "the top level" (see {@link parentOf}); `uri: ''` is
 * "no link"; numbers compare with a tolerance.
 */
export function holds(stored: Obj, fields: Obj): { field: string; expected: unknown; actual: unknown }[] {
  const out: { field: string; expected: unknown; actual: unknown }[] = [];
  const g = storedGeometry(stored);
  for (const [k, want] of Object.entries(fields)) {
    if (want === undefined) continue;
    // v2 E4 (backlog 4): written beside `polygons`, `polygon` is their first one (one consistent form): compared as it is.
    if (k === 'polygon' && fields.polygons !== undefined) {
      if (!sameValue(stored.polygon ?? null, want))
        out.push({ field: k, expected: want, actual: stored.polygon ?? null });
      continue;
    }
    if (k === 'polygon' || k === 'polygons') {
      const wantList = k === 'polygon' ? [want as LatLng[]] : (want as LatLng[][]);
      if (!sameValue(g.polygons ?? [], wantList))
        out.push({ field: k, expected: want, actual: stored[k] ?? null });
      continue;
    }
    if (k === 'parentId') {
      const expected = parentOfValue(want);
      const actual = parentOf(stored);
      if (expected !== actual) out.push({ field: k, expected, actual });
      continue;
    }
    if (k === 'uri') {
      const actual = typeof stored.uri === 'string' ? stored.uri : '';
      if ((want ?? '') !== actual) out.push({ field: k, expected: want ?? '', actual: stored.uri ?? null });
      continue;
    }
    if (!sameValue(want, stored[k])) out.push({ field: k, expected: want, actual: stored[k] ?? null });
  }
  return out;
}

/** A stable hash of a stored feature (its `updatedAt` left out): the plan's expectation, confirmed inside the lock. */
export function featureHash(f: Obj): string {
  const clean = Object.fromEntries(
    Object.entries(f)
      .filter(([k, v]) => k !== 'updatedAt' && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash('sha256').update(JSON.stringify(clean)).digest('hex').slice(0, 32);
}

/**
 * The ONE reading of a feature's parent (ADR 0040 decision 9, the owner's probe of 12 November 2026): LegendKeeper
 * reports a feature created at the top level with NO `parentId` field and one moved there with `parentId: ""`, and both
 * mean the top level; `null` is read the same way (the bridge's own plans use it for "no parent"). Anything else is the
 * id of the folder. Planning, siblings, the checks inside the lock, verify, `read_document`, the cascade and the
 * journal summaries all read a parent through this and nothing else.
 */
export const parentOfValue = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
export const parentOf = (f: Obj): string | null => parentOfValue(f.parentId);
/**
 * What to SEND to put a feature under `parent`: the folder's id, or `""` for the top level. LegendKeeper enforces the
 * schema's `type: string` and refuses `null` (400, `parentId: "Expected string, received null"`); the schema's "(null =
 * root)" text is wrong.
 */
export const wireParent = (parent: string | null): string => parent ?? '';
export const idOf = (f: Obj): string => (typeof f.id === 'string' ? f.id : '');
export const rankOf = (f: Obj): string | null =>
  typeof f.rank === 'string' && f.rank !== '' ? f.rank : null;
export const nameOf = (f: Obj): string => (typeof f.name === 'string' ? f.name : '');
export const typeOf = (f: Obj): string => (typeof f.type === 'string' ? f.type : '');
