/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- mock LK JSON */
/**
 * CR-2026-11-R4 (the owner's request S): routes of LegendKeeper the mock models only with its faithful setting on
 * (test/sandbox-mock/faithful.ts), each as the spec (`spec/legendkeeper-openapi.json`) describes it. Without them the
 * mock answered these with a generic body, and the smoke check's (b), d.blocks, d.infobox, d.calendars and (f) could
 * not run there; the owner's smoke run of 11 November 2026 passed every family on LegendKeeper (d.blocks, d.infobox,
 * d.calendars and f among them), so what they rely on is LegendKeeper's established behaviour:
 *
 * - a key-value block's rows (listBlockRows, createBlockRow, updateBlockRow, deleteBlockRow) and an infobox's
 *   properties and their rows (listBlockProperties, getBlockProperty, createBlockProperty, updateBlockProperty,
 *   deleteBlockProperty, listBlockPropertyRows and the row writes), stored in the document's blocks; every read and
 *   write answers the document's `version` (in the body and, for a write, as the `ETag`), and a stale If-Match answers
 *   412 VERSION_MISMATCH and changes nothing;
 * - moveBlock (exactly one of `after`, `before`, `parent`; the block keeps its subtree and ids; into itself 400
 *   INVALID_CONTENT);
 * - the project's custom calendars (listCalendars, createCalendar, updateCalendar with its If-Match, deleteCalendar),
 *   the test world's Kumikan Epochal among them;
 * - saveResourceAsTemplate (a top-level template copying the page's fields, tags, sidebar and documents with their
 *   content, its children with `includeChildren`), listed by listTemplates; and a copy made with `includeChildren`
 *   taking each child's sidebar too (H1, which the owner's assumptions run of 11 November 2026 passed);
 * - search (name, aliases and page text; every word of the query, a quoted phrase as written; one hit per matching
 *   document; the resource with its name, tags and path; a deleted page gone at once: F29, which that run passed);
 * - getProject, listMembers and listTags answered from the model rather than with a generic body.
 */
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { newId, type TreeModel } from '../tree/model.js';

type Obj = Record<string, any>;
type Route = (req: MockRequest) => MockResponse | undefined;

const err = (status: number, code: string, message = `faithful mock ${code}`): MockResponse => ({
  status,
  body: { message, code, requestId: `faithful-${code}` },
});

// The tree model's rank form (`r` and ten base-36 digits), so rows it gave ranks to and rows placed here sort together.
const rankOf = (n: number) => `r${Math.max(1, Math.round(n)).toString(36).padStart(10, '0')}`;
const rankNum = (r: unknown) =>
  typeof r === 'string' && /^r[0-9a-z]+$/.test(r) ? parseInt(r.slice(1), 36) : 0;
const byRank = (a: Obj, b: Obj) =>
  String(a.rank ?? '') < String(b.rank ?? '') ? -1 : String(a.rank ?? '') > String(b.rank ?? '') ? 1 : 0;

/** A rank between an anchor and its neighbour (`after` / `before`), or after the last; 400 if the anchor is not there. */
function placeIn(list: Obj[], after: unknown, before: unknown): string | MockResponse {
  const sorted = [...list].sort(byRank);
  if (typeof after === 'string' || typeof before === 'string') {
    const anchor = (typeof after === 'string' ? after : before) as string;
    const i = sorted.findIndex((x) => x.id === anchor);
    if (i < 0)
      return err(400, 'VALIDATION_ERROR', `${typeof after === 'string' ? 'after' : 'before'}: no such id`);
    const lo =
      typeof after === 'string' ? rankNum(sorted[i]!.rank) : i > 0 ? rankNum(sorted[i - 1]!.rank) : 0;
    const hi =
      typeof after === 'string'
        ? i + 1 < sorted.length
          ? rankNum(sorted[i + 1]!.rank)
          : lo + 2000
        : rankNum(sorted[i]!.rank);
    return rankOf((lo + hi) / 2);
  }
  return rankOf((sorted.length > 0 ? rankNum(sorted.at(-1)!.rank) : 0) + 1000);
}

function locate(list: unknown, id: string): { list: Obj[]; at: number; block: Obj } | null {
  const l = Array.isArray(list) ? (list as Obj[]) : [];
  for (let i = 0; i < l.length; i++) {
    if (l[i]?.id === id) return { list: l, at: i, block: l[i]! };
    const hit = locate(l[i]?.children, id);
    if (hit) return hit;
  }
  return null;
}

const runsText = (c: unknown): string =>
  Array.isArray(c)
    ? (c as Obj[])
        .map((r) => (r.break === true ? '\n' : String(r.text ?? r.mention?.text ?? r.mention?.name ?? '')))
        .join('')
    : '';

/** A row as LegendKeeper's Row answers it: id, rank, key, content (runs) and text. */
function rowView(r: Obj): Obj {
  const content = Array.isArray(r.content)
    ? structuredClone(r.content)
    : typeof r.text === 'string' && r.text !== ''
      ? [{ text: r.text }]
      : [];
  return { id: r.id ?? null, rank: r.rank, key: r.key ?? '', content, text: runsText(content) };
}

/** The faithful routes for a world built on the tree model (`overrides` is consulted before the models, in order). */
export function faithfulRoutes(w: {
  readonly repo: TreeModel;
  readonly sidebars?: { readonly pages: Map<string, unknown> };
  readonly calendar: Obj;
  readonly templatesRoute: Route | undefined;
  readonly fromTemplateRoute: Route | undefined;
}): Map<RegExp, Route> {
  const { repo } = w;
  const doc = (rid: string, did: string) => {
    const d = repo.docs.get(did);
    if (!repo.live(rid) || !d || d.resourceId !== rid || d.deletedAt !== null) return null;
    const b = repo.blocks.get(did) ?? { version: 1, blocks: [] };
    repo.blocks.set(did, b);
    return b;
  };
  const stale = (req: MockRequest, b: { version: number }) =>
    req.headers['if-match'] !== undefined && req.headers['if-match'] !== `v${b.version}`;
  const versioned = (b: { version: number }, status: number, body?: Obj): MockResponse => ({
    status,
    ...(body !== undefined ? { body: { ...body, version: `v${b.version}` } } : {}),
    headers: { etag: `"v${b.version}"` },
  });
  const written = (blocks: unknown, at: string): unknown[] | MockResponse =>
    Array.isArray(blocks) ? repo.writtenBlocks(blocks, at) : [];

  /** The row writes of a list of rows (a key-value block's, or a key-value property's). */
  const rowRoutes = (req: MockRequest, b: { version: number }, rows: Obj[], rowId: string | undefined) => {
    const body = (req.body ?? {}) as Obj;
    if (req.method === 'GET' && rowId === undefined)
      return { status: 200, body: { data: [...rows].sort(byRank).map(rowView), version: `v${b.version}` } };
    if (req.method === 'GET') return undefined;
    if (stale(req, b)) return err(412, 'VERSION_MISMATCH');
    if (req.method === 'POST' && rowId === undefined) {
      if (typeof body.key !== 'string') return err(400, 'VALIDATION_ERROR', 'key: required');
      const rank = placeIn(rows, body.after, body.before);
      if (typeof rank !== 'string') return rank;
      const row: Obj = {
        id: newId('w'),
        rank,
        key: body.key,
        ...(Array.isArray(body.content)
          ? { content: structuredClone(body.content) }
          : { text: body.text ?? '' }),
      };
      rows.push(row);
      b.version++;
      return versioned(b, 201, rowView(row));
    }
    const row = rows.find((r) => r.id === rowId);
    if (!row) return err(404, 'NOT_FOUND');
    if (req.method === 'PATCH') {
      if (Object.keys(body).length === 0) return err(400, 'VALIDATION_ERROR', 'an empty body');
      if (typeof body.key === 'string') row.key = body.key;
      if (body.content === null) {
        delete row.content;
        row.text = '';
      } else if (Array.isArray(body.content)) {
        row.content = structuredClone(body.content);
        delete row.text;
      } else if (typeof body.text === 'string') {
        row.text = body.text;
        delete row.content;
      }
      b.version++;
      return versioned(b, 200, rowView(row));
    }
    if (req.method === 'DELETE') {
      rows.splice(rows.indexOf(row), 1);
      b.version++;
      return versioned(b, 204);
    }
    return undefined;
  };

  const routes = new Map<RegExp, Route>();

  // ---------------------------------------------------------------------------- a key-value block's rows
  const blockRows = /\/resources\/([^/]+)\/docs\/([^/]+)\/blocks\/([^/]+)\/rows(?:\/([^/]+))?$/;
  routes.set(blockRows, (req) => {
    const [, rid, did, bid, rowId] = blockRows.exec(req.path.replace(/\/$/, ''))!;
    const b = doc(rid!, did!);
    if (!b) return err(404, 'NOT_FOUND');
    const hit = locate(b.blocks, bid!);
    if (!hit || hit.block.kind !== 'keyValue') return err(404, 'NOT_FOUND');
    hit.block.rows = Array.isArray(hit.block.rows) ? hit.block.rows : [];
    return rowRoutes(req, b, hit.block.rows as Obj[], rowId);
  });

  // ---------------------------------------------------------------------------- an infobox's properties and rows
  const props =
    /\/resources\/([^/]+)\/docs\/([^/]+)\/blocks\/([^/]+)\/properties(?:\/([^/]+)(?:\/rows(?:\/([^/]+))?)?)?$/;
  routes.set(props, (req) => {
    const path = req.path.replace(/\/$/, '');
    const [, rid, did, bid, pid, rowId] = props.exec(path)!;
    const b = doc(rid!, did!);
    if (!b) return err(404, 'NOT_FOUND');
    const hit = locate(b.blocks, bid!);
    if (!hit || hit.block.kind !== 'infobox') return err(404, 'NOT_FOUND');
    const list = (hit.block.rows = Array.isArray(hit.block.rows) ? hit.block.rows : []) as Obj[];
    const body = (req.body ?? {}) as Obj;
    if (pid === undefined) {
      if (req.method === 'GET')
        return { status: 200, body: { data: structuredClone(list), version: `v${b.version}` } };
      if (req.method !== 'POST') return undefined;
      if (stale(req, b)) return err(412, 'VERSION_MISMATCH');
      if (typeof body.id === 'string' && list.some((x) => x.id === body.id)) return err(409, 'DUPLICATE_ID');
      const { before, after, ...spec } = body;
      const children = spec.children !== undefined ? written(spec.children, 'children') : undefined;
      if (children !== undefined && !Array.isArray(children)) return children;
      const prop: Obj = { ...structuredClone(spec), id: typeof body.id === 'string' ? body.id : newId('p') };
      if (children !== undefined) prop.children = children;
      if (prop.kind === 'keyValue')
        prop.rows = ((prop.rows ?? []) as Obj[]).map((r, i) => ({
          id: newId('w'),
          rank: rankOf((i + 1) * 1000),
          ...r,
        }));
      const anchor = typeof after === 'string' ? after : typeof before === 'string' ? before : null;
      const at = anchor === null ? list.length : list.findIndex((x) => x.id === anchor);
      if (at < 0) return err(400, 'VALIDATION_ERROR', 'before/after: no such property');
      list.splice(anchor !== null && typeof after === 'string' ? at + 1 : at, 0, prop);
      b.version++;
      return versioned(b, 201, structuredClone(prop));
    }
    const prop = list.find((x) => x.id === pid);
    if (!prop) return err(404, 'NOT_FOUND');
    if (path.endsWith('/rows') || rowId !== undefined) {
      if (prop.kind !== 'keyValue') return err(404, 'NOT_FOUND');
      prop.rows = Array.isArray(prop.rows) ? prop.rows : [];
      return rowRoutes(req, b, prop.rows as Obj[], rowId);
    }
    if (req.method === 'GET')
      return { status: 200, body: { ...structuredClone(prop), version: `v${b.version}` } };
    if (stale(req, b)) return err(412, 'VERSION_MISMATCH');
    if (req.method === 'PATCH') {
      if (Object.keys(body).length === 0) return err(400, 'VALIDATION_ERROR', 'an empty body');
      const children = body.children !== undefined ? written(body.children, 'children') : undefined;
      if (children !== undefined && !Array.isArray(children)) return children;
      Object.assign(prop, structuredClone(body), children !== undefined ? { children } : {});
      b.version++;
      return versioned(b, 200, structuredClone(prop));
    }
    if (req.method === 'DELETE') {
      list.splice(list.indexOf(prop), 1);
      b.version++;
      return versioned(b, 204);
    }
    return undefined;
  });

  // ---------------------------------------------------------------------------- moveBlock
  const move = /\/resources\/([^/]+)\/docs\/([^/]+)\/blocks\/([^/]+)\/move$/;
  routes.set(move, (req) => {
    if (req.method !== 'POST') return undefined;
    const [, rid, did, bid] = move.exec(req.path.replace(/\/$/, ''))!;
    const b = doc(rid!, did!);
    if (!b) return err(404, 'NOT_FOUND');
    if (stale(req, b)) return err(412, 'VERSION_MISMATCH');
    const hit = locate(b.blocks, bid!);
    if (!hit) return err(404, 'NOT_FOUND');
    const body = (req.body ?? {}) as Obj;
    const how = (['after', 'before', 'parent'] as const).filter((k) => typeof body[k] === 'string');
    if (how.length !== 1) return err(400, 'VALIDATION_ERROR', 'exactly one of after, before, parent');
    const anchorId = body[how[0]!] as string;
    if (anchorId === bid || locate(hit.block.children, anchorId)) return err(400, 'INVALID_CONTENT');
    if (!locate(b.blocks, anchorId)) return err(404, 'NOT_FOUND');
    hit.list.splice(hit.at, 1);
    const anchor = locate(b.blocks, anchorId)!;
    if (how[0] === 'parent') {
      const kids = Array.isArray(anchor.block.children) ? (anchor.block.children as Obj[]) : [];
      kids.push(hit.block);
      anchor.block.children = kids;
    } else anchor.list.splice(anchor.at + (how[0] === 'after' ? 1 : 0), 0, hit.block);
    b.version++;
    return versioned(b, 200, structuredClone(hit.block));
  });

  // ---------------------------------------------------------------------------- the project's calendars
  let cv = 1;
  const calendars: Obj[] = [
    { ...structuredClone(w.calendar), version: String(w.calendar.version ?? `cv${cv}`) },
  ];
  const cal = /\/calendars(?:\/([^/]+))?$/;
  routes.set(cal, (req) => {
    const [, id] = cal.exec(req.path.replace(/\/$/, ''))!;
    const body = (req.body ?? {}) as Obj;
    if (id === undefined) {
      if (req.method === 'GET')
        return { status: 200, body: { data: structuredClone(calendars), hasMore: false, nextCursor: null } };
      if (req.method !== 'POST') return undefined;
      if (typeof body.name !== 'string' || body.name === '')
        return err(400, 'VALIDATION_ERROR', 'name: required');
      const cid = typeof body.id === 'string' ? body.id : newId('c');
      if (calendars.some((c) => c.id === cid)) return err(409, 'DUPLICATE_ID');
      const made = { ...structuredClone(body), id: cid, version: `cv${++cv}` };
      calendars.push(made);
      return { status: 201, body: structuredClone(made) };
    }
    const c = calendars.find((x) => x.id === id);
    if (!c) return err(404, 'NOT_FOUND');
    if (req.method === 'PUT') {
      if (req.headers['if-match'] !== undefined && req.headers['if-match'] !== c.version)
        return err(412, 'VERSION_MISMATCH');
      if (body.id !== undefined && body.id !== id)
        return err(400, 'VALIDATION_ERROR', 'id: must equal the path id');
      if (typeof body.name !== 'string' || body.name === '')
        return err(400, 'VALIDATION_ERROR', 'name: required');
      const next = { ...structuredClone(body), id, version: `cv${++cv}` };
      calendars.splice(calendars.indexOf(c), 1, next);
      return { status: 200, body: structuredClone(next) };
    }
    if (req.method === 'DELETE') {
      calendars.splice(calendars.indexOf(c), 1);
      return { status: 204 };
    }
    return undefined;
  });

  // ---------------------------------------------------------------------------- templates saved from a page
  const saved = new Set<string>();
  const copyPage = (
    src: ReturnType<TreeModel['live']> & object,
    id: string,
    name: string,
    parentId: string | null,
  ) => {
    const t = repo.seed({ id, name, parentId, tags: [...src.tags], aliases: [...src.aliases], props: false });
    t.props = structuredClone(src.props);
    for (const d of t.docs) repo.docs.delete(d);
    t.docs = [];
    for (const d of repo.liveDocs(src)) {
      const copy = repo.outside.addDocument(t.id, d.name, d.type);
      const body = repo.blocks.get(d.id);
      if (body) repo.blocks.set(copy.id, { version: 1, blocks: structuredClone(body.blocks) });
    }
    const sidebar = w.sidebars?.pages.get(src.id);
    if (sidebar !== undefined) w.sidebars!.pages.set(t.id, structuredClone(sidebar));
    return t;
  };
  const save = /\/resources\/([^/]+)\/save-as-template$/;
  routes.set(save, (req) => {
    if (req.method !== 'POST') return undefined;
    const src = repo.live(save.exec(req.path.replace(/\/$/, ''))![1]!);
    if (!src) return err(404, 'NOT_FOUND');
    const body = (req.body ?? {}) as { id?: string; name?: string; includeChildren?: boolean };
    if (body.id && repo.res.has(body.id)) return err(409, 'DUPLICATE_ID');
    const t = copyPage(src, body.id ?? newId('t'), body.name ?? src.name, null);
    saved.add(t.id);
    if (body.includeChildren === true) {
      const under = (from: string, to: string) => {
        for (const c of repo.children(from)) under(c.id, copyPage(c, newId('c'), c.name, to).id);
      };
      under(src.id, t.id);
    }
    return { status: 201, body: repo.resourceView(t) };
  });
  routes.set(/^\/api\/v3\/projects\/[^/]+\/templates$/, (req) => {
    if (req.method !== 'GET') return undefined;
    const base = w.templatesRoute?.(req);
    const mine = [...saved]
      .map((id) => repo.live(id))
      .filter((t) => t !== undefined)
      .map((t) => ({ id: t.id, name: t.name, parentId: 'templates' }));
    if (!base && mine.length === 0) return undefined;
    const data = [...(((base?.body as Obj | undefined)?.data ?? []) as Obj[]), ...mine];
    return { status: 200, body: { data, hasMore: false, nextCursor: null } };
  });

  // A copy with `includeChildren`: the world's own copy (the page, its sidebar), then each child's sidebar, the template's
  // children and the copy's paired in their rank order (the model copies them in that order).
  routes.set(/\/resources\/from-template$/, (req) => {
    if (req.method !== 'POST') return undefined;
    const made = w.fromTemplateRoute?.(req) ?? repo.respond(req);
    const body = (req.body ?? {}) as { templateId?: string; includeChildren?: boolean };
    if (!made || made.status !== 201 || body.includeChildren !== true || !w.sidebars) return made;
    const pages = w.sidebars.pages;
    const pair = (from: string, to: string) => {
      const a = repo.children(from);
      const b = repo.children(to);
      a.forEach((c, i) => {
        const copy = b[i];
        if (!copy || copy.name !== c.name) return;
        const sidebar = pages.get(c.id);
        if (sidebar !== undefined) pages.set(copy.id, structuredClone(sidebar));
        pair(c.id, copy.id);
      });
    };
    pair(String(body.templateId), String((made.body as Obj).id));
    return made;
  });

  // ---------------------------------------------------------------------------- search
  const textOf = (blocks: unknown): string => {
    const out: string[] = [];
    const walk = (x: unknown) => {
      if (Array.isArray(x)) for (const y of x) walk(y);
      else if (x && typeof x === 'object') {
        const o = x as Obj;
        if (typeof o.text === 'string') out.push(o.text);
        if (o.mention && typeof o.mention === 'object')
          out.push(String(o.mention.text ?? o.mention.name ?? ''));
        for (const [k, v] of Object.entries(o)) if (k !== 'mention' && typeof v === 'object') walk(v);
      }
    };
    walk(blocks);
    return out.join(' ');
  };
  routes.set(/\/search$/, (req) => {
    if (req.method !== 'GET') return undefined;
    const q = String(req.query.q ?? '').trim();
    if (q === '') return { status: 200, body: { data: [], hasMore: false, nextCursor: null } };
    const phrases = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.toLowerCase());
    const words = q
      .replace(/"[^"]*"/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const matches = (text: string) => {
      const t = text.toLowerCase();
      return words.every((x) => t.includes(x)) && phrases.every((x) => t.includes(x));
    };
    const pathOf = (id: string) => {
      const out: { id: string; name: string }[] = [];
      for (let c = repo.res.get(id)?.parentId ?? null; c !== null; c = repo.res.get(c)?.parentId ?? null) {
        const p = repo.res.get(c);
        if (!p) break;
        out.unshift({ id: p.id, name: p.name });
      }
      return out;
    };
    const hits: Obj[] = [];
    const byName: Obj[] = [];
    for (const r of repo.res.values()) {
      if (r.deletedAt !== null) continue;
      const path = pathOf(r.id);
      const resource = {
        id: r.id,
        name: r.name,
        iconGlyph: r.iconGlyph ?? null,
        iconColor: r.iconColor ?? null,
        parentId: r.parentId,
        tags: [...r.tags],
        ...(path.length > 0 ? { path } : {}),
      };
      if (matches([r.name, ...r.aliases].join(' '))) byName.push({ resource });
      const docs = repo.liveDocs(r).filter((d) => matches(textOf(repo.blocks.get(d.id)?.blocks ?? [])));
      for (const d of docs)
        hits.push({ resource, document: { id: d.id, name: d.name, isSolo: docs.length === 1 } });
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 32)));
    return {
      status: 200,
      body: { data: [...byName, ...hits].slice(0, limit), hasMore: false, nextCursor: null },
    };
  });

  // ---------------------------------------------------------------------------- the project's own reads
  routes.set(/^\/api\/v3\/projects\/[^/]+$/, (req) =>
    req.method === 'GET'
      ? {
          status: 200,
          body: {
            id: req.path.replace(/\/$/, '').split('/').at(-1),
            name: 'Mock project',
            isPublic: false,
            createdAt: '2026-11-01T00:00:00.000Z',
          },
        }
      : undefined,
  );
  routes.set(/\/members$/, (req) =>
    req.method === 'GET'
      ? {
          status: 200,
          body: {
            data: [{ id: 'user_owner', name: 'The owner', email: null, role: 'OWNER', image: null }],
            hasMore: false,
            nextCursor: null,
          },
        }
      : undefined,
  );
  routes.set(/\/tags$/, (req) => {
    if (req.method !== 'GET') return undefined;
    const count = new Map<string, number>();
    for (const r of repo.res.values())
      if (r.deletedAt === null) for (const t of r.tags) count.set(t, (count.get(t) ?? 0) + 1);
    const data = [...count]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([tag, n]) => ({ tag, count: n }));
    return { status: 200, body: { data, hasMore: false, nextCursor: null } };
  });
  return routes;
}
