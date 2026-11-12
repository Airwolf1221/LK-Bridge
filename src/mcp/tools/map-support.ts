/**
 * Shared parts of the map-feature tools (v2 D2, ADR 0040): finding the map (page plus document, as read_document does),
 * reading it, turning a `link` into a `uri`, parsing coordinates (latlng or pixel, never both), and placing a feature
 * among its siblings by name. Every refusal is a typed error that names what to do next; nothing here writes.
 */
import * as z from 'zod';
import {
  findFolder,
  idOf,
  mapState,
  nameKey,
  nameOf,
  siblingsOf,
  typeOf,
  type Fail,
  type Geometry,
  type MapState,
  type Obj,
} from '../../maps/index.js';
import type { TreeDocument, TreeNode } from '../../tree/index.js';
import type { McpToolContext, McpToolResult } from '../server.js';
import { liveRead, resolvePage, type RepoCtx } from './repo.js';
import { errorResult, type ProjectDeps } from './shape.js';

// ------------------------------------------------------------------------------------------------ arguments

const finite = z.number().finite();
export const latlngArg = z
  .tuple([finite, finite])
  .describe('[lat, lng], in the map’s own frame (the frame LegendKeeper stores).');
export const pixelArg = z
  .object({ x: finite, y: finite })
  .strict()
  .describe('{ x, y } in pixels from the image’s TOP-LEFT corner (x to the right, y downwards).');
const pointArg = z.union([latlngArg, pixelArg]);

/** The four ways to give coordinates; at most one per request. */
export const coordinateArgs = {
  latlng: latlngArg
    .optional()
    .describe('A pin’s or label’s position as [lat, lng]. Never together with pixel.'),
  pixel: pixelArg
    .optional()
    .describe('A pin’s or label’s position in image pixels. Never together with latlng.'),
  points: z
    .array(pointArg)
    .min(1)
    .max(10_000)
    .optional()
    .describe(
      'A region’s polygon (3 points or more) or a path’s line (2 or more), in order: each point [lat, lng] or { x, y } in pixels. All points one kind.',
    ),
  polygons: z
    .array(z.array(pointArg).min(1).max(10_000))
    .min(1)
    .max(100)
    .optional()
    .describe('A region of several polygons: a list of point lists (each as for points).'),
  allowOutside: z
    .boolean()
    .optional()
    .describe(
      'Pixels outside the image, and lat/lng outside the map’s bounds, are refused unless this is true.',
    ),
};

export const linkArg = z
  .union([
    z.string().min(1).max(500),
    z.object({ page: z.string().min(1).max(500), document: z.string().min(1).max(500).optional() }).strict(),
  ])
  .describe(
    'A page by name or id, or { page, document } for one document of it. It becomes the feature’s link. Names resolve as write targets do: an ambiguous name is refused with each candidate.',
  );

export const refArg = z.string().min(1).max(500);

// ------------------------------------------------------------------------------------------------ results

type Answer = { readonly ok: false; readonly result: McpToolResult };

export const failResult = (pd: ProjectDeps, f: Fail): McpToolResult =>
  errorResult({ code: f.code, message: f.message, ...(f.details ?? {}) }, pd);

export const refuse = (pd: ProjectDeps, code: string, message: string, more: Obj = {}): Answer => ({
  ok: false,
  result: errorResult({ code, message, ...more }, pd),
});

/** The code of an error result (LegendKeeper's own `lkCode` when it is one of its answers); the text's first line is the JSON body. */
function codeOf(r: McpToolResult): string | null {
  const t = r.content[0];
  if (!t || t.type !== 'text') return null;
  try {
    const e = (JSON.parse(t.text.split('\n')[0]!) as { error?: { code?: unknown; lkCode?: unknown } }).error;
    const code = typeof e?.lkCode === 'string' ? e.lkCode : e?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

const typeName = (t: string | null) => (t === 'time' ? 'timeline' : (t ?? 'unknown'));

// ------------------------------------------------------------------------------------------------ the map

export interface LoadedMap {
  readonly ok: true;
  readonly node: TreeNode;
  readonly doc: TreeDocument;
  readonly state: MapState;
  readonly page: { readonly id: string; readonly name: string };
  readonly document: { readonly id: string; readonly name: string | null };
}

const WRONG_TOOL: Readonly<Record<string, string>> = {
  page: 'Page text is changed with write_page.',
  time: 'A timeline is changed with the timeline tools (create_timeline_event and the others).',
  board: 'Boards have no write tool yet; read one with read_document.',
};

/**
 * The map named by a page and a document (the document may be left out when the page has exactly one map), read live:
 * its settings (image frame) and every feature. A document that is not a map is refused, with the tool to use instead.
 */
export async function loadMap(
  pd: ProjectDeps,
  mctx: McpToolContext,
  ctx: RepoCtx,
  tool: string,
  pageQuery: string,
  documentQuery: string | undefined,
): Promise<LoadedMap | Answer> {
  const r = resolvePage(ctx, pageQuery);
  if (!r.ok) return r;
  const node = r.node;
  if (node.kind === 'root') {
    return refuse(pd, 'ROOT_PAGE', 'The AI REPOSITORY page itself is not changed by the tools.');
  }
  const list = node.documents.map((d) => ({ id: d.id, name: d.name, type: typeName(d.type) }));
  let doc: TreeDocument | undefined;
  if (documentQuery !== undefined) {
    const q = documentQuery.trim();
    const byId = node.documents.filter((d) => d.id === q);
    const hits =
      byId.length > 0 ? byId : node.documents.filter((d) => (d.name ?? '').toLowerCase() === q.toLowerCase());
    if (hits.length !== 1) {
      return refuse(
        pd,
        hits.length === 0 ? 'DOCUMENT_NOT_FOUND' : 'DOCUMENT_AMBIGUOUS',
        hits.length === 0
          ? `“${node.displayName}” has no document named or numbered “${q}”.`
          : `“${node.displayName}” has ${hits.length} documents named “${q}”; pass the id of the one you mean.`,
        { documents: list },
      );
    }
    doc = hits[0]!;
  } else {
    const maps = node.documents.filter((d) => d.type === 'map');
    if (maps.length !== 1) {
      return refuse(
        pd,
        maps.length === 0 ? 'NO_MAP' : 'DOCUMENT_REQUIRED',
        maps.length === 0
          ? `“${node.displayName}” has no map document. Add one with create_document (type map).`
          : `“${node.displayName}” has ${maps.length} maps: name the one you mean with \`document\`.`,
        { documents: list },
      );
    }
    doc = maps[0]!;
  }
  const refuseType = (type: string | null): Answer =>
    refuse(
      pd,
      type === 'blank' || type === null ? 'BLANK_DOCUMENT' : 'NOT_A_MAP',
      type === 'blank' || type === null
        ? `“${doc.name}” is a blank document, not a map. Give it a map image with update_document (mapImage) and it becomes one.`
        : `“${doc.name}” is a ${typeName(type)} document, not a map. ${WRONG_TOOL[type] ?? ''}`.trim(),
      { documents: list },
    );
  // The tree may lag (a blank document that has just been given an image is a map): only a type that can never become a
  // map is refused from the tree; a blank one is judged by the live read below.
  if (doc.type !== 'map' && doc.type !== 'blank' && doc.type !== null) return refuseType(doc.type);
  const path = { resourceId: node.id, documentId: doc.id };
  const d = await liveRead(pd, mctx, tool, 'getDocument', { path });
  if (!d.ok) return d;
  const f = await liveRead(pd, mctx, tool, 'listFeatures', { path });
  if (!f.ok) return f;
  const state = mapState(d.value, (f.value as { data?: unknown } | undefined)?.data);
  if (state.documentType !== 'map') return refuseType(state.documentType);
  return {
    ok: true,
    node,
    doc,
    state,
    page: { id: node.id, name: node.rawName },
    document: { id: doc.id, name: doc.name },
  };
}

// ------------------------------------------------------------------------------------------------ links

export interface ResolvedLink {
  readonly ok: true;
  /** The `uri` to store: `lk://resources/<id>` or `lk://resources/<id>/docs/<documentId>`. */
  readonly uri: string;
  readonly view: Obj;
}

/**
 * A `link` to a `uri`. The page is resolved as a write target is (a name that matches several pages is refused with each
 * candidate and its role), then read live: it must exist and not be deleted, and so must the document named. The check
 * costs one read.
 */
export async function resolveLink(
  pd: ProjectDeps,
  mctx: McpToolContext,
  ctx: RepoCtx,
  tool: string,
  link: string | { readonly page: string; readonly document?: string | undefined },
): Promise<ResolvedLink | Answer> {
  const q = typeof link === 'string' ? { page: link } : link;
  const r = resolvePage(ctx, q.page, { what: `The link “${q.page}”` });
  if (!r.ok) return r;
  const node = r.node;
  const live = await liveRead(pd, mctx, tool, 'getResource', { path: { resourceId: node.id } });
  if (!live.ok) {
    // The tree can lag behind the app: a page deleted there is a 404 here.
    return codeOf(live.result) === 'NOT_FOUND'
      ? refuse(
          pd,
          'LINK_TARGET_DELETED',
          `“${node.displayName}” no longer exists in LegendKeeper (it was deleted since the repository tree last saw it), so it cannot be linked to.`,
        )
      : live;
  }
  const res = (live.value ?? {}) as Obj;
  if (typeof res.deletedAt === 'string') {
    return refuse(pd, 'LINK_TARGET_DELETED', `“${node.displayName}” is deleted, so it cannot be linked to.`);
  }
  if (q.document === undefined) {
    return {
      ok: true,
      uri: `lk://resources/${node.id}`,
      view: { page: { id: node.id, name: node.displayName }, uri: `lk://resources/${node.id}` },
    };
  }
  const liveDocs = Array.isArray(res.documents) ? (res.documents as Obj[]) : null;
  const docs: { id: string; name: string | null }[] = (
    liveDocs ?? node.documents.map((d) => ({ id: d.id, name: d.name }))
  )
    .filter((d) => typeof d.deletedAt !== 'string')
    .map((d) => ({
      id: String((d as Obj).id),
      name: typeof (d as Obj).name === 'string' ? ((d as Obj).name as string) : null,
    }));
  const want = q.document.trim();
  const byId = docs.filter((d) => d.id === want);
  const hits = byId.length > 0 ? byId : docs.filter((d) => nameKey(d.name ?? '') === nameKey(want));
  if (hits.length !== 1) {
    return refuse(
      pd,
      hits.length === 0 ? 'LINK_DOCUMENT_NOT_FOUND' : 'LINK_DOCUMENT_AMBIGUOUS',
      hits.length === 0
        ? `“${node.displayName}” has no document named or numbered “${want}” (or it is deleted).`
        : `“${node.displayName}” has ${hits.length} documents named “${want}”; pass the id of the one you mean.`,
      { documents: docs },
    );
  }
  const uri = `lk://resources/${node.id}/docs/${hits[0]!.id}`;
  return {
    ok: true,
    uri,
    view: {
      page: { id: node.id, name: node.displayName },
      document: { id: hits[0]!.id, name: hits[0]!.name },
      uri,
    },
  };
}

// ------------------------------------------------------------------------------------------------ coordinates

type Raw = {
  readonly latlng?: readonly [number, number] | undefined;
  readonly pixel?: { readonly x: number; readonly y: number } | undefined;
  readonly points?:
    readonly (readonly [number, number] | { readonly x: number; readonly y: number })[] | undefined;
  readonly polygons?:
    | readonly (readonly (readonly [number, number] | { readonly x: number; readonly y: number })[])[]
    | undefined;
};

const isPix = (v: unknown): v is { x: number; y: number } => !Array.isArray(v);

/** The coordinates a request gave, as one geometry in one system, or null when it gave none. */
export function parseGeometry(
  pd: ProjectDeps,
  raw: Raw,
): { readonly ok: true; readonly geometry: Geometry | null } | Answer {
  const given = (['latlng', 'pixel', 'points', 'polygons'] as const).filter((k) => raw[k] !== undefined);
  if (given.length > 1) {
    return refuse(
      pd,
      given.includes('latlng') && given.includes('pixel') ? 'COORDINATES_BOTH' : 'COORDINATES_CONFLICT',
      given.includes('latlng') && given.includes('pixel')
        ? 'Give coordinates as latlng or as pixel, never both in one request.'
        : `Give one of ${given.join(', ')}, not several: a pin or label takes latlng or pixel, a region or path takes points (or a region polygons).`,
    );
  }
  const mixed = () =>
    refuse(
      pd,
      'COORDINATES_BOTH',
      'Give coordinates as latlng ([lat, lng]) or as pixel ({ x, y }), never both in one request: every point must be the same kind.',
    );
  if (raw.latlng) return { ok: true, geometry: { system: 'latlng', shape: 'point', point: raw.latlng } };
  if (raw.pixel) return { ok: true, geometry: { system: 'pixel', shape: 'point', point: raw.pixel } };
  const system = (pts: readonly unknown[]): 'latlng' | 'pixel' | null => {
    const px = pts.filter(isPix).length;
    return px === 0 ? 'latlng' : px === pts.length ? 'pixel' : null;
  };
  if (raw.points) {
    const s = system(raw.points);
    if (s === null) return mixed();
    return {
      ok: true,
      geometry:
        s === 'pixel'
          ? { system: 'pixel', shape: 'points', points: raw.points as { x: number; y: number }[] }
          : { system: 'latlng', shape: 'points', points: raw.points as [number, number][] },
    };
  }
  if (raw.polygons) {
    const flat = raw.polygons.flat();
    const s = system(flat);
    if (s === null) return mixed();
    return {
      ok: true,
      geometry:
        s === 'pixel'
          ? { system: 'pixel', shape: 'polygons', polygons: raw.polygons as { x: number; y: number }[][] }
          : { system: 'latlng', shape: 'polygons', polygons: raw.polygons as [number, number][][] },
    };
  }
  return { ok: true, geometry: null };
}

// ------------------------------------------------------------------------------------------------ folders, siblings

/** A folder by name or id on the map (the result's `id`), or the refusal. */
export function folderIdOf(
  pd: ProjectDeps,
  state: MapState,
  query: string,
): { readonly ok: true; readonly id: string; readonly name: string } | Answer {
  const f = findFolder(state.features, query);
  if (!f.ok) return { ok: false, result: failResult(pd, f) };
  return { ok: true, id: idOf(f.folder), name: nameOf(f.folder) };
}

/**
 * A sibling by id or name among the features under `parentId` (not `exceptId`, the feature being moved), to place a
 * feature after or before it. Several of one name are refused with each candidate.
 */
export function siblingIdOf(
  pd: ProjectDeps,
  state: MapState,
  parentId: string | null,
  query: string,
  exceptId?: string,
): { readonly ok: true; readonly id: string; readonly name: string } | Answer {
  const sibs = siblingsOf(state.features, parentId, exceptId);
  const q = query.trim();
  const byId = sibs.filter((f) => idOf(f) === q);
  const hits = byId.length > 0 ? byId : sibs.filter((f) => nameKey(nameOf(f)) === nameKey(q));
  if (hits.length === 1) return { ok: true, id: idOf(hits[0]!), name: nameOf(hits[0]!) };
  const where = parentId === null ? 'at the top level' : 'in that folder';
  return refuse(
    pd,
    hits.length === 0 ? 'SIBLING_NOT_FOUND' : 'SIBLING_AMBIGUOUS',
    hits.length === 0
      ? `No feature named or numbered “${q}” ${where} to place it beside (it must be under the same folder).`
      : `${hits.length} features ${where} are named “${q}”. Pass the id of the one you mean.`,
    {
      candidates: (hits.length === 0 ? sibs.slice(0, 30) : hits).map((f) => ({
        id: idOf(f),
        type: typeOf(f),
        name: nameOf(f),
      })),
    },
  );
}

// ------------------------------------------------------------------------------------------------ the image asset

export interface MapAsset {
  readonly ok: true;
  readonly id: string;
  readonly name: string;
  readonly url: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * The asset to use as a map's image, by id or by name (as list_assets shows them). An id is found in the bridge's asset
 * tree or read live; a name is looked up in the tree (exact, without case) and several of one name are refused with each
 * candidate and where it is. Either way the asset is then read live (`getAsset`: it must exist and be an image or map
 * asset, and its size is what the replacement warning compares).
 */
export async function resolveMapAsset(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  query: string,
): Promise<MapAsset | Answer> {
  const q = query.trim();
  const projectId = pd.project.id;
  const assets = pd.services?.assets.queries;
  const treeReady =
    assets !== undefined &&
    assets.status(projectId).status !== 'not_built' &&
    assets.status(projectId).status !== 'building';
  let id: string | null = null;
  if (treeReady) {
    const byId = assets.asset(projectId, q).data;
    if (byId) id = byId.id;
    else {
      const hits = assets
        .findAssetsByName(projectId, q)
        .data.filter((a) => a.type === 'IMAGE' || a.type === 'MAP');
      if (hits.length > 1) {
        return refuse(
          pd,
          'ASSET_AMBIGUOUS',
          `${hits.length} assets are named “${q}”. Pass the id of the one you mean (list_assets shows them).`,
          {
            candidates: hits.slice(0, 30).map((a) => ({
              id: a.id,
              name: a.name,
              type: a.type,
              folder:
                a.folderId === null
                  ? '(library top)'
                  : assets
                      .path(projectId, a.folderId)
                      .data.map((f) => f.name)
                      .join(' / ') || a.folderId,
              ...(a.width && a.height ? { width: a.width, height: a.height } : {}),
            })),
          },
        );
      }
      if (hits.length === 1) id = hits[0]!.id;
    }
  }
  const live = await liveRead(pd, mctx, tool, 'getAsset', { path: { assetId: id ?? q } });
  if (!live.ok) {
    // A 404 on a name that is no id: say what was looked for.
    return id === null && !treeReady
      ? refuse(
          pd,
          'ASSET_TREE_NOT_READY',
          `No asset has the id “${q}”, and the asset tree is not built, so a name cannot be looked up. Pass an asset id (list_assets), or ask the owner to build the asset tree.`,
        )
      : id === null
        ? refuse(
            pd,
            'ASSET_NOT_FOUND',
            `No asset is named or numbered “${q}”. list_assets shows the library.`,
          )
        : live;
  }
  const a = (live.value ?? {}) as Obj;
  if (a.type !== 'IMAGE' && a.type !== 'MAP') {
    return refuse(
      pd,
      'NOT_AN_IMAGE',
      `“${typeof a.name === 'string' ? a.name : q}” is a ${typeof a.type === 'string' ? a.type : 'unknown'} asset, not an image.`,
    );
  }
  return {
    ok: true,
    id: typeof a.id === 'string' ? a.id : (id ?? q),
    name: typeof a.name === 'string' ? a.name : q,
    url: typeof a.url === 'string' ? a.url : null,
    width: typeof a.width === 'number' ? a.width : null,
    height: typeof a.height === 'number' ? a.height : null,
  };
}
