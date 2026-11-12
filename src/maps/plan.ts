/**
 * Planning map-feature writes (v2 D2, ADR 0040). Pure functions of a map's state: the tools call them to plan (and to
 * refuse early), and the same functions run again INSIDE the lock as the bridge's own compare-and-swap for writes
 * LegendKeeper does not version (features carry no `version` and no `If-Match`): the plan's resolved request is checked
 * against the map as it is then, and the body to send (converted coordinates, the rank between the real neighbours) is
 * worked out from that, never from the plan.
 */
import type { StateDifference } from '../jobs/sidebar-state.js';
import {
  featureHash,
  holds,
  idOf,
  isFeatureType,
  misplacedStyles,
  nameOf,
  parentOf,
  rankOf,
  shapeProblem,
  shapesFor,
  storedGeometry,
  typeOf,
  type FeatureType,
  type Obj,
} from './features.js';
import {
  frameState,
  posToPixel,
  resolveGeometry,
  sameFrame,
  type FrameState,
  type Geometry,
  type LatLng,
  type MapFrame,
} from './geometry.js';
import { rankAmong, type Placement } from './rank.js';

export type { Placement } from './rank.js';

/** A map as read: its document type, its image frame, and every feature (listFeatures is not paged). */
export interface MapState {
  readonly documentType: string | null;
  readonly frame: FrameState;
  readonly features: readonly Obj[];
}

export function mapState(document: unknown, features: unknown): MapState {
  const d = (document && typeof document === 'object' ? document : {}) as Obj;
  const list = Array.isArray(features)
    ? (features as unknown[]).filter((f): f is Obj => !!f && typeof f === 'object' && !Array.isArray(f))
    : [];
  return {
    documentType: typeof d.type === 'string' ? d.type : null,
    frame: frameState(d.mapImage),
    features: list,
  };
}

export interface Fail {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly details?: Obj;
}
const fail = (code: string, message: string, details?: Obj): Fail => ({
  ok: false,
  code,
  message,
  ...(details ? { details } : {}),
});

/** The frame to check lat/lng against, when the map has one. */
export const frameOfState = (s: FrameState): MapFrame | null => (s.kind === 'none' ? null : s.frame);

// ------------------------------------------------------------------------------------------------ lookups

export const nameKey = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** The chain of folder names above a feature, `Shrines / North`, or null at the top level. */
export function folderPath(features: readonly Obj[], f: Obj): string | null {
  const byId = new Map(features.map((x) => [idOf(x), x]));
  const names: string[] = [];
  const seen = new Set<string>([idOf(f)]);
  let p = parentOf(f);
  while (p !== null && !seen.has(p)) {
    seen.add(p);
    const parent = byId.get(p);
    if (!parent) {
      names.unshift('(a deleted folder)');
      break;
    }
    names.unshift(nameOf(parent) || '(unnamed)');
    p = parentOf(parent);
  }
  return names.length > 0 ? names.join(' / ') : null;
}

const candidate = (features: readonly Obj[], f: Obj): Obj => ({
  id: idOf(f),
  type: typeOf(f),
  name: nameOf(f),
  folder: folderPath(features, f),
});

/** A folder by id or name. Several folders of one name are refused, each with its path. */
export function findFolder(
  features: readonly Obj[],
  query: string,
): { readonly ok: true; readonly folder: Obj } | Fail {
  const q = query.trim();
  const folders = features.filter((f) => typeOf(f) === 'folder');
  const byId = folders.filter((f) => idOf(f) === q);
  if (byId.length === 1) return { ok: true, folder: byId[0]! };
  const hits = folders.filter((f) => nameKey(nameOf(f)) === nameKey(q));
  if (hits.length === 1) return { ok: true, folder: hits[0]! };
  if (hits.length > 1) {
    return fail(
      'FOLDER_AMBIGUOUS',
      `${hits.length} folders are named “${q}”. Pass the id of the one you mean.`,
      { candidates: hits.map((f) => candidate(features, f)) },
    );
  }
  const other = features.find((f) => idOf(f) === q);
  return fail(
    'FOLDER_NOT_FOUND',
    other
      ? `“${nameOf(other) || q}” is a ${typeOf(other)}, not a folder.`
      : `The map has no folder named or numbered “${q}”.`,
    { folders: folders.map((f) => candidate(features, f)).slice(0, 50) },
  );
}

/**
 * A feature by id, or by name. `inFolder` narrows a name: a folder (found as findFolder does) or `null` for the top
 * level only. Several matches are refused, each with its folder.
 */
export function findFeature(
  features: readonly Obj[],
  query: string,
  inFolder?: string | null,
): { readonly ok: true; readonly feature: Obj } | Fail {
  const q = query.trim();
  const byId = features.filter((f) => idOf(f) === q);
  if (byId.length === 1) return { ok: true, feature: byId[0]! };
  let scope: string | null | undefined;
  if (typeof inFolder === 'string') {
    const f = findFolder(features, inFolder);
    if (!f.ok) return f;
    scope = idOf(f.folder);
  } else if (inFolder === null) scope = null;
  const hits = features.filter(
    (f) => nameKey(nameOf(f)) === nameKey(q) && (scope === undefined || parentOf(f) === scope),
  );
  if (hits.length === 1) return { ok: true, feature: hits[0]! };
  if (hits.length > 1) {
    return fail(
      'FEATURE_AMBIGUOUS',
      `${hits.length} features are named “${q}”${scope !== undefined ? ' there' : ''}. Pass the id of the one you mean, or name its folder.`,
      { candidates: hits.map((f) => candidate(features, f)) },
    );
  }
  return fail(
    'FEATURE_NOT_FOUND',
    `The map has no feature named or numbered “${q}”${scope !== undefined ? ' there' : ''}.`,
  );
}

/** Features directly under a parent (the top level: no parent, or a parent that no longer exists), in rank order. */
export function siblingsOf(features: readonly Obj[], parentId: string | null, exceptId?: string): Obj[] {
  const ids = new Set(features.map(idOf));
  return features.filter((f) => {
    if (exceptId !== undefined && idOf(f) === exceptId) return false;
    const p = parentOf(f);
    return parentId === null ? p === null || !ids.has(p) : p === parentId;
  });
}

/** Every feature under a feature (any depth), children before their parents (deepest first). */
export function descendantsOf(features: readonly Obj[], id: string): Obj[] {
  const out: Obj[] = [];
  const seen = new Set<string>([id]);
  let layer = [id];
  while (layer.length > 0) {
    const next: string[] = [];
    for (const f of features) {
      const p = parentOf(f);
      if (p !== null && layer.includes(p) && !seen.has(idOf(f))) {
        seen.add(idOf(f));
        next.push(idOf(f));
        out.push(f);
      }
    }
    layer = next;
  }
  return out.reverse();
}

// ------------------------------------------------------------------------------------------------ geometry

/** The fields of a feature's geometry for LegendKeeper, converting pixels with the map's live frame. */
function geometryFields(
  state: MapState,
  type: FeatureType,
  g: Geometry,
  o: { allowOutside: boolean; plannedFrame: MapFrame | null },
): { readonly ok: true; readonly fields: Obj } | Fail {
  const bad = shapeProblem(type, g);
  if (bad) return fail('GEOMETRY_SHAPE', bad);
  let frame: MapFrame | null;
  if (g.system === 'pixel') {
    if (state.frame.kind === 'legacy') {
      return fail(
        'PIXEL_NEEDS_IMAGE',
        'This is a legacy tiled map: it has no single image, so pixel positions mean nothing here. Give `latlng` coordinates instead.',
      );
    }
    if (state.frame.kind === 'none') {
      return fail(
        'PIXEL_NEEDS_IMAGE',
        'This map has no image yet, so pixel positions mean nothing. Set its image with update_document (mapImage), or give `latlng` coordinates.',
      );
    }
    frame = state.frame.frame;
    if (o.plannedFrame && !sameFrame(o.plannedFrame, frame)) {
      return fail(
        'FRAME_CHANGED',
        `The map’s image changed since this was planned (it was ${o.plannedFrame.width}×${o.plannedFrame.height}, it is now ${frame.width}×${frame.height}), so the pixels no longer mean what they did. Read the map again.`,
        { planned: o.plannedFrame, now: frame },
      );
    }
  } else {
    frame = frameOfState(state.frame);
  }
  const { resolved, outside } = resolveGeometry(g, frame);
  if (outside.length > 0 && !o.allowOutside) {
    return fail(
      'OUT_OF_BOUNDS',
      g.system === 'pixel'
        ? `${outside.length} point(s) lie outside the image (${frame!.width}×${frame!.height} pixels, from the top-left corner): ${outside
            .slice(0, 3)
            .map((x) => `${x.index} at ${x.value}`)
            .join('; ')}. Fix them, or pass allowOutside: true to place them there on purpose.`
        : `${outside.length} point(s) lie outside the map’s bounds ${JSON.stringify(frame!.bounds)}: ${outside
            .slice(0, 3)
            .map((x) => `${x.index} at ${x.value}`)
            .join('; ')}. Fix them, or pass allowOutside: true to place them there on purpose.`,
      { outside: outside.slice(0, 10), count: outside.length },
    );
  }
  switch (g.shape) {
    case 'point':
      return { ok: true, fields: { pos: resolved.point } };
    case 'points':
      return {
        ok: true,
        fields: type === 'path' ? { polyline: resolved.points } : { polygon: resolved.points },
      };
    case 'polygons': {
      return { ok: true, fields: { polygons: resolved.polygons } };
    }
  }
}

// ------------------------------------------------------------------------------------------------ create

export interface CreateRequest {
  readonly id: string;
  readonly type: FeatureType;
  readonly name: string;
  readonly geometry: Geometry | null;
  readonly allowOutside: boolean;
  /** The frame the caller's pixels were meant for (the map's image when planned); null when none was used. */
  readonly frame: MapFrame | null;
  readonly parentId: string | null;
  readonly placement: Placement;
  readonly uri?: string;
  readonly hidden?: boolean;
  readonly style: Obj;
}

export interface Built {
  readonly ok: true;
  /** The body to send (create: the whole feature; update: the changed fields). */
  readonly body: Obj;
  /** The fields to see back, and where the feature must stand. */
  readonly verify: VerifyInput;
  /** Update only: nothing differs from what is stored. */
  readonly noChange?: boolean;
  /** Update only: the names of the changed fields. */
  readonly changes?: readonly string[];
}

export function buildCreate(state: MapState, req: CreateRequest): Built | Fail {
  if (state.documentType !== 'map') return notAMap(state);
  if (state.features.some((f) => idOf(f) === req.id)) {
    return fail('ID_TAKEN', `A feature with the id ${req.id} already exists on this map.`);
  }
  if (req.parentId !== null) {
    const p = state.features.find((f) => idOf(f) === req.parentId);
    if (!p || typeOf(p) !== 'folder') {
      return fail('FOLDER_NOT_FOUND', `The folder ${req.parentId} is not on this map any more.`);
    }
  }
  const misplaced = misplacedStyles(req.type, req.style);
  if (misplaced.length > 0) return styleFail(req.type, misplaced);
  const body: Obj = { id: req.id, name: req.name, type: req.type };
  if (req.type === 'folder') {
    if (req.geometry !== null) return fail('GEOMETRY_SHAPE', 'A folder takes no coordinates.');
  } else {
    if (req.geometry === null) {
      return fail(
        'GEOMETRY_REQUIRED',
        `A ${req.type} needs ${req.type === 'region' ? '`points` (one polygon) or `polygons`' : req.type === 'path' ? '`points`' : 'a position (`latlng` or `pixel`)'}.`,
      );
    }
    const g = geometryFields(state, req.type, req.geometry, {
      allowOutside: req.allowOutside,
      plannedFrame: req.frame,
    });
    if (!g.ok) return g;
    Object.assign(body, g.fields);
  }
  if (req.parentId !== null) body.parentId = req.parentId;
  if (req.uri !== undefined && req.uri !== '') body.uri = req.uri;
  if (req.hidden !== undefined) body.isHidden = req.hidden;
  Object.assign(body, req.style);
  const rank = rankAmong(
    siblingsOf(state.features, req.parentId).map((f) => ({ id: idOf(f), rank: rankOf(f) })),
    req.placement,
  );
  if (!rank.ok) return fail(rank.code, rank.message);
  body.rank = rank.rank;
  return {
    ok: true,
    body,
    verify: {
      present: [
        {
          id: req.id,
          label: `${req.type} “${req.name}”`,
          fields: body,
          place: { parentId: req.parentId, after: rank.after, before: rank.before },
        },
      ],
      gone: [],
    },
  };
}

// ------------------------------------------------------------------------------------------------ update

export interface UpdateRequest {
  readonly featureId: string;
  /** The feature as the plan read it (`featureHash`), confirmed inside the lock. */
  readonly expectedHash: string;
  readonly name?: string;
  readonly geometry?: Geometry;
  readonly allowOutside: boolean;
  readonly frame: MapFrame | null;
  /** undefined: unchanged; null: the top level; a string: that folder. */
  readonly parentId?: string | null;
  readonly placement?: Placement;
  /** '' clears the link; undefined leaves it. */
  readonly uri?: string;
  readonly hidden?: boolean;
  readonly style: Obj;
}

export function buildUpdate(state: MapState, req: UpdateRequest): Built | Fail {
  if (state.documentType !== 'map') return notAMap(state);
  const cur = state.features.find((f) => idOf(f) === req.featureId);
  if (!cur) return fail('FEATURE_GONE', `The feature ${req.featureId} is not on this map any more.`);
  if (featureHash(cur) !== req.expectedHash) {
    return fail(
      'FEATURE_CHANGED',
      `“${nameOf(cur) || req.featureId}” was changed since this was planned (in the app, or by another request). Read the map again.`,
    );
  }
  const type = typeOf(cur);
  if (!isFeatureType(type))
    return fail('FEATURE_TYPE', `The feature has the type “${type}”, which the tools do not change.`);
  const misplaced = misplacedStyles(type, req.style);
  if (misplaced.length > 0) return styleFail(type, misplaced);
  const want: Obj = {};
  if (req.name !== undefined) want.name = req.name;
  if (req.hidden !== undefined) want.isHidden = req.hidden;
  if (req.uri !== undefined) want.uri = req.uri;
  Object.assign(want, req.style);
  if (req.geometry) {
    if (type === 'folder') return fail('GEOMETRY_SHAPE', 'A folder takes no coordinates.');
    const g = geometryFields(state, type, req.geometry, {
      allowOutside: req.allowOutside,
      plannedFrame: req.frame,
    });
    if (!g.ok) return g;
    const stored = storedGeometry(cur);
    // A region keeps the field it already uses, so the old shape cannot linger beside the new one.
    if (
      type === 'region' &&
      'polygon' in g.fields &&
      stored.polygons &&
      Array.isArray(cur.polygons) &&
      cur.polygons.length > 0
    ) {
      want.polygons = [g.fields.polygon];
    } else Object.assign(want, g.fields);
  }
  // The parent and the place.
  let newParent = parentOf(cur);
  if (req.parentId !== undefined) {
    if (req.parentId !== null) {
      const p = state.features.find((f) => idOf(f) === req.parentId);
      if (!p || typeOf(p) !== 'folder')
        return fail('FOLDER_NOT_FOUND', `The folder ${req.parentId} is not on this map any more.`);
      if (
        req.parentId === req.featureId ||
        descendantsOf(state.features, req.featureId).some((d) => idOf(d) === req.parentId)
      ) {
        return fail('FOLDER_CYCLE', 'A folder cannot be moved into itself or into a folder beneath it.');
      }
    }
    newParent = req.parentId;
  }
  const moved = newParent !== parentOf(cur);
  let place: { parentId: string | null; after: string | null; before: string | null } | null = null;
  if (moved || req.placement !== undefined) {
    const sibs = siblingsOf(state.features, newParent, req.featureId).map((f) => ({
      id: idOf(f),
      rank: rankOf(f),
    }));
    const rank = rankAmong(sibs, req.placement ?? { at: 'end' });
    if (!rank.ok) return fail(rank.code, rank.message);
    // Already standing exactly there: no write.
    const here = siblingsOf(state.features, parentOf(cur)).sort((a, b) =>
      (rankOf(a) ?? '') < (rankOf(b) ?? '') ? -1 : (rankOf(a) ?? '') > (rankOf(b) ?? '') ? 1 : 0,
    );
    const at = here.findIndex((f) => idOf(f) === req.featureId);
    const curPrev = at > 0 ? idOf(here[at - 1]!) : null;
    const curNext = at >= 0 && at + 1 < here.length ? idOf(here[at + 1]!) : null;
    const same = !moved && rank.after === curPrev && rank.before === curNext;
    if (!same) {
      want.rank = rank.rank;
      place = { parentId: newParent, after: rank.after, before: rank.before };
    }
    if (moved) want.parentId = newParent;
  }
  // Only what differs.
  const body: Obj = {};
  const diffs = holds(cur, want);
  for (const d of diffs) body[d.field] = want[d.field];
  const changes = Object.keys(body);
  if (changes.length === 0) {
    return { ok: true, body: {}, noChange: true, changes: [], verify: { present: [], gone: [] } };
  }
  return {
    ok: true,
    body,
    changes,
    verify: {
      present: [
        {
          id: req.featureId,
          label: `${type} “${nameOf(cur) || req.featureId}”`,
          fields: body,
          ...(place ? { place } : {}),
        },
      ],
      gone: [],
    },
  };
}

// ------------------------------------------------------------------------------------------------ delete

export interface DeleteRequest {
  /** Every feature to delete, deepest first (children before the folder that holds them). */
  readonly ids: readonly string[];
  /** Each one's `featureHash` as planned. */
  readonly hashes: Readonly<Record<string, string>>;
  readonly cascade: boolean;
}

/** What a delete removes: the feature, and with `cascade` everything under it. Refused when a folder holds features. */
export function planDelete(
  state: MapState,
  featureId: string,
  cascade: boolean,
): { readonly ok: true; readonly order: readonly Obj[] } | Fail {
  const f = state.features.find((x) => idOf(x) === featureId);
  if (!f) return fail('FEATURE_GONE', `The feature ${featureId} is not on this map.`);
  const under = descendantsOf(state.features, featureId);
  if (under.length > 0 && !cascade) {
    return fail(
      'HAS_FEATURES',
      `“${nameOf(f) || featureId}” holds ${under.length} feature(s). LegendKeeper does not delete them with the folder (they would keep pointing at a folder that is gone): pass cascade: true to delete them too, or move them out first.`,
      {
        holds: under
          .map((x) => candidate(state.features, x))
          .reverse()
          .slice(0, 50),
        count: under.length,
      },
    );
  }
  return { ok: true, order: [...under, f] };
}

/** Inside the lock: every feature still there as planned, and nothing new under a folder being deleted. */
export function checkDelete(
  state: MapState,
  req: DeleteRequest,
): { readonly ok: true; readonly features: Obj[] } | Fail {
  if (state.documentType !== 'map') return notAMap(state);
  const set = new Set(req.ids);
  const out: Obj[] = [];
  for (const id of req.ids) {
    const f = state.features.find((x) => idOf(x) === id);
    if (!f) return fail('FEATURE_GONE', `The feature ${id} is not on this map any more.`);
    if (featureHash(f) !== req.hashes[id]) {
      return fail(
        'FEATURE_CHANGED',
        `“${nameOf(f) || id}” was changed since this was planned. Read the map again.`,
      );
    }
    out.push(f);
  }
  for (const f of out) {
    for (const d of descendantsOf(state.features, idOf(f))) {
      if (!set.has(idOf(d))) {
        return fail(
          'FOLDER_CHANGED',
          `“${nameOf(d) || idOf(d)}” is now under “${nameOf(f) || idOf(f)}” and was not part of what was approved to delete. Nothing was deleted; read the map again.`,
        );
      }
    }
  }
  return { ok: true, features: out };
}

// ------------------------------------------------------------------------------------------------ verify

export interface VerifyInput {
  readonly present: readonly {
    readonly id: string;
    readonly label: string;
    readonly fields: Obj;
    readonly place?: {
      readonly parentId: string | null;
      readonly after: string | null;
      readonly before: string | null;
    };
  }[];
  readonly gone: readonly { readonly id: string; readonly label: string }[];
}

/** After the writes: each feature present with the fields written (and between its neighbours), each deleted one gone. */
export function verifyFeatures(features: readonly Obj[], input: VerifyInput): StateDifference[] {
  const diffs: StateDifference[] = [];
  const by = new Map(features.map((f) => [idOf(f), f]));
  for (const p of input.present) {
    const f = by.get(p.id);
    if (!f) {
      diffs.push({ path: p.label, expected: 'present', actual: '(gone)' });
      continue;
    }
    for (const d of holds(f, p.fields))
      diffs.push({ path: `${p.label} ${d.field}`, expected: d.expected, actual: d.actual });
    if (p.place) {
      const rank = rankOf(f) ?? '';
      const a = p.place.after ? by.get(p.place.after) : undefined;
      const b = p.place.before ? by.get(p.place.before) : undefined;
      if (a && (rankOf(a) ?? '') > rank)
        diffs.push({
          path: `${p.label} place`,
          expected: `after ${nameOf(a) || idOf(a)}`,
          actual: 'before it',
        });
      if (b && (rankOf(b) ?? '') < rank)
        diffs.push({
          path: `${p.label} place`,
          expected: `before ${nameOf(b) || idOf(b)}`,
          actual: 'after it',
        });
    }
  }
  for (const g of input.gone) {
    if (by.has(g.id)) diffs.push({ path: g.label, expected: '(deleted)', actual: 'still there' });
  }
  return diffs;
}

// ------------------------------------------------------------------------------------------------ views

/** A feature as the tools show it: its place in pixels as well when the map has an image. */
export function featureView(state: MapState, f: Obj): Obj {
  const frame = state.frame.kind === 'image' ? state.frame.frame : null;
  const g = storedGeometry(f);
  const px = (p: LatLng) => {
    const v = posToPixel(frame!, p);
    return { x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100 };
  };
  return {
    id: idOf(f),
    type: typeOf(f),
    name: nameOf(f),
    ...(folderPath(state.features, f) ? { folder: folderPath(state.features, f) } : {}),
    ...(g.pos ? { latlng: g.pos, ...(frame ? { pixel: px(g.pos) } : {}) } : {}),
    ...(g.polygons
      ? { polygons: g.polygons.length, points: g.polygons.reduce((n, p) => n + p.length, 0) }
      : {}),
    ...(g.polyline ? { points: g.polyline.length } : {}),
    ...(typeof f.uri === 'string' && f.uri !== '' ? { link: f.uri } : {}),
    ...(f.isHidden === true ? { hidden: true } : {}),
  };
}

function notAMap(state: MapState): Fail {
  return fail(
    'NOT_A_MAP',
    state.documentType === null
      ? 'The document could not be read as a map.'
      : `The document is a ${state.documentType} document now, not a map.`,
  );
}

function styleFail(
  type: FeatureType,
  misplaced: { field: string; appliesTo: readonly FeatureType[] }[],
): Fail {
  return fail(
    'STYLE_NOT_FOR_TYPE',
    `${misplaced.map((m) => `${m.field} (for ${m.appliesTo.join(', ') || 'no type'})`).join('; ')} do not apply to a ${type}. LegendKeeper would refuse them.`,
    { misplaced },
  );
}

/** A problem with a type's geometry requirement, shared by the tools' early checks. */
export const needsGeometry = (type: FeatureType): boolean => shapesFor(type).length > 0;
