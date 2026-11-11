/**
 * A stateful model of LegendKeeper's resource tree for the repository-tree tests (v2 A2), plugged into chunk 1's mock
 * (`MockLk({ respond })`), so rate limiting, faults and idempotency stay the mock's. It models what the tree reads and
 * every write the tree follows: resources (ids, names, parents, fractional ranks, tags, aliases, hidden and locked
 * flags, soft delete with cascade and restore by shared `deletedAt`, moves with `after` / `before`, template copies
 * with children), documents (create, rename, delete, restore), and sidebar properties (key-value properties with
 * versioned rows).
 *
 * `outside` changes the model as an edit in the LegendKeeper app would: the bridge does not see them until it reads.
 */
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';

export interface Row {
  id: string;
  key: string;
  text: string;
  rank: string;
}

export interface Prop {
  id: string;
  kind: 'keyValue' | 'resourceCollection' | 'unsupported';
  title: string;
  rows: Row[];
}

export interface Res {
  id: string;
  name: string;
  parentId: string | null;
  rank: string;
  tags: string[];
  aliases: string[];
  isHidden: boolean;
  isLocked: boolean;
  deletedAt: string | null;
  docs: string[];
  props: Prop[];
  /** Bumped by any row write (the version the rows' If-Match checks). */
  propsVersion: number;
}

export interface Doc {
  id: string;
  resourceId: string;
  name: string;
  type: string;
  rank: string;
  isHidden: boolean;
  deletedAt: string | null;
}

const err = (status: number, code: string, message = `model ${code}`): MockResponse => ({
  status,
  body: { message, code, requestId: `model-${code}` },
});

const RANK_WIDTH = 10;
const rankOf = (n: number) => `r${Math.max(1, Math.round(n)).toString(36).padStart(RANK_WIDTH, '0')}`;
const rankNum = (r: string) => parseInt(r.slice(1), 36);

let seq = 0;
/** A cuid2-shaped id (a letter, then 7 letters or digits). */
export const newId = (prefix = 'x'): string =>
  `${prefix}${(++seq).toString(36).padStart(7, '0')}`.slice(0, 8);

export class TreeModel {
  readonly res = new Map<string, Res>();
  readonly docs = new Map<string, Doc>();
  /** Every state change actually applied (op, id). */
  readonly mutations: { op: string; id: string }[] = [];
  /** Page content per document (blocks), with a version for If-Match. */
  readonly blocks = new Map<string, { version: number; blocks: unknown[] }>();
  /**
   * What LegendKeeper does to a written name (default: nothing). Tests set it to show that the tree stores what
   * LegendKeeper answers, not what the request asked for.
   */
  nameFilter: (name: string) => string = (n) => n;
  /** Resources a listing leaves out (as a listing paged during changes can skip one); reads still find them. */
  readonly hiddenFromListing = new Set<string>();

  constructor(private readonly now: () => number) {}

  // ============================================================================================ seeding

  /** Adds a live resource directly (no request), with a PROPERTIES key-value property and a Main document. */
  seed(r: {
    id?: string;
    name: string;
    parentId?: string | null;
    tags?: string[];
    aliases?: string[];
    referenceType?: string | null;
    scope?: string | null;
    canonical?: string | null;
    props?: boolean;
    isHidden?: boolean;
  }): Res {
    const id = r.id ?? newId('s');
    const parentId = r.parentId ?? null;
    const res: Res = {
      id,
      name: r.name,
      parentId,
      rank: this.rankAtEnd(parentId),
      tags: r.tags ?? [],
      aliases: r.aliases ?? [],
      isHidden: r.isHidden ?? false,
      isLocked: false,
      deletedAt: null,
      docs: [],
      props: [],
      propsVersion: 1,
    };
    if (r.props !== false) {
      const rows: Row[] = [];
      const add = (key: string, text: string | null | undefined) => {
        if (text === null || text === undefined) return;
        rows.push({ id: newId('w'), key, text, rank: rankOf((rows.length + 1) * 1000) });
      };
      add('Reference Type', r.referenceType ?? (r.name.startsWith('[INDEX] ') ? 'Index' : 'General Source'));
      add('Scope', r.scope ?? 'Arkona');
      add('Index Scope', r.name.startsWith('[INDEX] ') ? 'Characters' : null);
      add('Canonical Display Name', r.canonical ?? null);
      res.props.push({ id: newId('p'), kind: 'keyValue', title: 'PROPERTIES', rows });
      res.props.push({ id: newId('p'), kind: 'resourceCollection', title: 'Dependencies', rows: [] });
      res.props.push({ id: newId('p'), kind: 'unsupported', title: 'TAGS', rows: [] });
    }
    this.res.set(id, res);
    this.addDoc(id, 'Main', 'page');
    return res;
  }

  private addDoc(resourceId: string, name: string, type: string): Doc {
    const r = this.res.get(resourceId)!;
    const d: Doc = {
      id: newId('d'),
      resourceId,
      name,
      type,
      rank: rankOf((r.docs.length + 1) * 1000),
      isHidden: false,
      deletedAt: null,
    };
    this.docs.set(d.id, d);
    r.docs.push(d.id);
    return d;
  }

  // ============================================================================================ reading the model

  live(id: string): Res | undefined {
    const r = this.res.get(id);
    return r && r.deletedAt === null ? r : undefined;
  }

  children(parentId: string | null): Res[] {
    return [...this.res.values()]
      .filter((r) => r.deletedAt === null && r.parentId === parentId)
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id.localeCompare(b.id)));
  }

  /** Every live resource under `rootId` (the root included), parents first. */
  subtree(rootId: string): Res[] {
    const root = this.live(rootId);
    if (!root) return [];
    const out: Res[] = [root];
    for (let i = 0; i < out.length; i++) out.push(...this.children(out[i]!.id));
    return out;
  }

  liveDocs(r: Res): Doc[] {
    return r.docs.map((d) => this.docs.get(d)!).filter((d) => d.deletedAt === null);
  }

  // ============================================================================================ outside edits

  /** Edits made in the LegendKeeper app: the bridge only learns of them by reading. */
  readonly outside = {
    create: (name: string, parentId: string | null, o: { tags?: string[]; aliases?: string[] } = {}): Res =>
      this.seed({ name, parentId, ...o }),
    rename: (id: string, name: string) => {
      this.res.get(id)!.name = name;
    },
    move: (id: string, parentId: string | null) => {
      const r = this.res.get(id)!;
      r.parentId = parentId;
      r.rank = this.rankAtEnd(parentId, id);
    },
    delete: (id: string) => {
      const at = new Date(this.now()).toISOString();
      for (const r of this.subtree(id)) r.deletedAt = at;
    },
    setTags: (id: string, tags: string[]) => {
      this.res.get(id)!.tags = tags;
    },
    setAliases: (id: string, aliases: string[]) => {
      this.res.get(id)!.aliases = aliases;
    },
    addDocument: (id: string, name: string, type = 'page'): Doc => this.addDoc(id, name, type),
    deleteDocument: (docId: string) => {
      this.docs.get(docId)!.deletedAt = new Date(this.now()).toISOString();
    },
    setRow: (id: string, key: string, text: string) => {
      const r = this.res.get(id)!;
      const p = r.props.find((x) => x.kind === 'keyValue' && x.title === 'PROPERTIES')!;
      const row = p.rows.find((x) => x.key === key);
      if (row) row.text = text;
      else p.rows.push({ id: newId('w'), key, text, rank: rankOf((p.rows.length + 1) * 1000) });
      r.propsVersion++;
    },
    setLocked: (id: string, locked: boolean) => {
      this.res.get(id)!.isLocked = locked;
    },
  };

  // ============================================================================================ views

  private listItem(r: Res) {
    return {
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      iconGlyph: null,
      iconColor: null,
      tags: [...r.tags],
      aliases: [...r.aliases],
      rank: r.rank,
      isHidden: r.isHidden,
      createdAt: null,
      updatedAt: null,
      documents: this.liveDocs(r)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => ({ id: d.id, name: d.name, type: d.type })),
    };
  }

  private docView(d: Doc) {
    return { id: d.id, name: d.name, type: d.type, rank: d.rank, isHidden: d.isHidden };
  }

  private propView(p: Prop) {
    if (p.kind === 'keyValue') {
      return {
        id: p.id,
        kind: 'keyValue',
        title: p.title,
        rows: p.rows.map((r) => ({
          id: r.id,
          rank: r.rank,
          key: r.key,
          text: r.text,
          content: [{ text: r.text }],
        })),
      };
    }
    if (p.kind === 'resourceCollection')
      return { id: p.id, kind: 'resourceCollection', title: p.title, items: [] };
    return { id: p.id, kind: 'unsupported', title: p.title };
  }

  resourceView(r: Res) {
    return {
      id: r.id,
      name: r.name,
      ...(r.parentId !== null ? { parentId: r.parentId } : {}),
      tags: [...r.tags],
      aliases: [...r.aliases],
      rank: r.rank,
      isHidden: r.isHidden,
      isLocked: r.isLocked,
      permissions: {},
      documents: this.liveDocs(r).map((d) => this.docView(d)),
      properties: r.props.map((p) => this.propView(p)),
    };
  }

  // ============================================================================================ ranks

  private rankAtEnd(parentId: string | null, except?: string): string {
    const sibs = this.children(parentId).filter((s) => s.id !== except);
    const last = sibs.at(-1);
    return rankOf((last ? rankNum(last.rank) : 0) + 1000);
  }

  private place(r: Res, parentId: string | null, after?: unknown, before?: unknown): MockResponse | null {
    const sibs = this.children(parentId).filter((s) => s.id !== r.id);
    if (typeof after === 'string' || typeof before === 'string') {
      const anchorId = (typeof after === 'string' ? after : before) as string;
      const i = sibs.findIndex((s) => s.id === anchorId);
      if (i < 0) return err(400, 'VALIDATION_ERROR', 'anchor is not a sibling');
      const lo = typeof after === 'string' ? rankNum(sibs[i]!.rank) : i > 0 ? rankNum(sibs[i - 1]!.rank) : 0;
      const hi =
        typeof after === 'string'
          ? i + 1 < sibs.length
            ? rankNum(sibs[i + 1]!.rank)
            : lo + 2000
          : rankNum(sibs[i]!.rank);
      r.rank = rankOf((lo + hi) / 2);
    } else {
      r.rank = rankOf((sibs.at(-1) ? rankNum(sibs.at(-1)!.rank) : 0) + 1000);
    }
    r.parentId = parentId;
    return null;
  }

  // ============================================================================================ routing

  readonly respond = (req: MockRequest): MockResponse | undefined => {
    const m = /^\/api\/v3\/projects\/[^/]+(\/.*)?$/.exec(req.path.replace(/\/$/, ''));
    if (!m) return undefined;
    const parts = (m[1] ?? '').split('/').filter(Boolean).map(decodeURIComponent);
    try {
      return this.route(req, parts);
    } catch (e) {
      return err(500, 'INTERNAL', e instanceof Error ? e.message : String(e));
    }
  };

  private create(body: Record<string, unknown>, op: string): MockResponse {
    const id = typeof body.id === 'string' ? body.id : newId('n');
    if (this.res.has(id)) return err(409, 'DUPLICATE_ID');
    const parentId = typeof body.parentId === 'string' ? body.parentId : null;
    if (parentId !== null && !this.live(parentId)) return err(404, 'NOT_FOUND');
    const r = this.seed({
      id,
      name: typeof body.name === 'string' ? this.nameFilter(body.name) : 'Untitled',
      parentId,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
      aliases: Array.isArray(body.aliases) ? (body.aliases as string[]) : [],
      props: false,
    });
    const placed = this.place(r, parentId, body.after, body.before);
    if (placed) {
      this.res.delete(id);
      return placed;
    }
    this.mutations.push({ op, id });
    return { status: 201, body: this.resourceView(r) };
  }

  private copyTemplate(
    t: Res,
    id: string,
    name: string,
    parentId: string | null,
    withChildren: boolean,
  ): Res {
    const r = this.seed({ id, name, parentId, props: false });
    // C2d (A1): LegendKeeper reuses the template's property and row ids in a copy (unique only within a page).
    r.props = structuredClone(t.props);
    if (withChildren) {
      for (const c of this.children(t.id)) this.copyTemplate(c, newId('c'), c.name, r.id, true);
    }
    return r;
  }

  private route(req: MockRequest, p: string[]): MockResponse | undefined {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const M = req.method;
    if (p[0] !== 'resources') return undefined;

    if (p.length === 1) {
      if (M === 'GET') {
        const parentId = req.query.parentId;
        const all = [...this.res.values()]
          .filter((r) => r.deletedAt === null && (parentId === undefined || r.parentId === parentId))
          .filter((r) => !this.hiddenFromListing.has(r.id))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const limit = Number(req.query.limit ?? 50);
        const offset = Number(req.query.cursor ?? 0);
        if (req.query.cursor !== undefined && !/^\d+$/.test(req.query.cursor))
          return err(400, 'VALIDATION_ERROR');
        const data = all.slice(offset, offset + limit).map((r) => this.listItem(r));
        const more = offset + limit < all.length;
        return {
          status: 200,
          body: { data, hasMore: more, nextCursor: more ? String(offset + limit) : null },
        };
      }
      if (M === 'POST') return this.create(body, 'createResource');
    }
    if (p.length === 2 && p[1] === 'batch' && M === 'POST') {
      const items = (body.resources ?? []) as Record<string, unknown>[];
      for (const i of items)
        if (typeof i.id === 'string' && this.res.has(i.id)) return err(409, 'DUPLICATE_ID');
      const out: unknown[] = [];
      for (const i of items) {
        const r = this.create(i, 'createManyResources');
        if (r.status !== 201) return r;
        out.push(r.body);
      }
      return { status: 201, body: { resources: out } };
    }
    if (p.length === 2 && p[1] === 'from-template' && M === 'POST') {
      const t = this.live(String(body.templateId));
      if (!t) return err(404, 'NOT_FOUND');
      const id = typeof body.id === 'string' ? body.id : newId('n');
      if (this.res.has(id)) return err(409, 'DUPLICATE_ID');
      const parentId = typeof body.parentId === 'string' ? body.parentId : null;
      if (parentId !== null && !this.live(parentId)) return err(404, 'NOT_FOUND');
      const name = typeof body.name === 'string' ? body.name : t.name.replace(/\s*Template\s*/, ' ').trim();
      const r = this.copyTemplate(t, id, name, parentId, body.includeChildren === true);
      this.place(r, parentId, body.after, body.before);
      this.mutations.push({ op: 'createResourceFromTemplate', id });
      return { status: 201, body: this.resourceView(r) };
    }

    const rid = p[1]!;
    const any = this.res.get(rid);
    const res = this.live(rid);

    if (p.length === 3 && p[2] === 'restore' && M === 'POST') {
      if (!any || any.deletedAt === null) return err(409, 'NOT_DELETED');
      const at = any.deletedAt;
      for (const r of this.res.values()) {
        if (r.deletedAt === at && this.isUnder(r.id, rid)) r.deletedAt = null;
      }
      if (any.parentId !== null && !this.live(any.parentId)) {
        any.parentId = null;
        any.rank = this.rankAtEnd(null, any.id);
      }
      this.mutations.push({ op: 'restoreResource', id: rid });
      return { status: 200, body: this.resourceView(any) };
    }
    if (!res) return err(404, 'NOT_FOUND');

    if (p.length === 2) {
      if (M === 'GET') return { status: 200, body: this.resourceView(res) };
      if (M === 'PATCH') {
        if (typeof body.name === 'string') res.name = this.nameFilter(body.name);
        if (Array.isArray(body.tags)) res.tags = body.tags as string[];
        if (Array.isArray(body.aliases)) res.aliases = body.aliases as string[];
        if (typeof body.isHidden === 'boolean') res.isHidden = body.isHidden;
        if (typeof body.isLocked === 'boolean') res.isLocked = body.isLocked;
        this.mutations.push({ op: 'updateResource', id: rid });
        return { status: 200, body: this.resourceView(res) };
      }
      if (M === 'DELETE') {
        const kids = this.children(rid);
        if (kids.length > 0 && req.query.cascade !== 'true') return err(409, 'HAS_CHILDREN');
        const at = new Date(this.now()).toISOString();
        for (const r of this.subtree(rid)) r.deletedAt = at;
        this.mutations.push({ op: 'deleteResource', id: rid });
        return { status: 204 };
      }
    }
    if (p.length === 3 && p[2] === 'move' && M === 'POST') {
      const parentId = body.parentId === undefined ? res.parentId : (body.parentId as string | null);
      if (parentId !== null && !this.live(parentId)) return err(404, 'NOT_FOUND');
      if (parentId !== null && this.isUnder(parentId, rid)) return err(400, 'VALIDATION_ERROR');
      const placed = this.place(res, parentId, body.after, body.before);
      if (placed) return placed;
      this.mutations.push({ op: 'moveResource', id: rid });
      return { status: 200, body: this.resourceView(res) };
    }
    if (p[2] === 'docs') return this.routeDocs(req, p, res, body);
    if (p[2] === 'properties') return this.routeProps(req, p, res, body);
    return undefined;
  }

  private isUnder(id: string, ancestor: string): boolean {
    let cur: string | null = id;
    for (let i = 0; cur !== null && i < 100; i++) {
      if (cur === ancestor) return true;
      cur = this.res.get(cur)?.parentId ?? null;
    }
    return false;
  }

  private routeDocs(
    req: MockRequest,
    p: string[],
    res: Res,
    body: Record<string, unknown>,
  ): MockResponse | undefined {
    const M = req.method;
    if (p.length === 3) {
      if (M === 'GET') return { status: 200, body: { data: this.liveDocs(res).map((d) => this.docView(d)) } };
      if (M === 'POST') {
        const d = this.addDoc(
          res.id,
          typeof body.name === 'string' ? body.name : 'Doc',
          typeof body.type === 'string' ? body.type : 'page',
        );
        this.mutations.push({ op: 'createDocument', id: d.id });
        return { status: 201, body: this.docView(d) };
      }
    }
    const doc = this.docs.get(p[3]!);
    if (!doc || doc.resourceId !== res.id) return err(404, 'NOT_FOUND');
    if (p.length === 5 && p[4] === 'restore' && M === 'POST') {
      doc.deletedAt = null;
      this.mutations.push({ op: 'restoreDocument', id: doc.id });
      return { status: 200, body: this.docView(doc) };
    }
    if (doc.deletedAt !== null) return err(404, 'NOT_FOUND');
    if (p.length === 5 && p[4] === 'blocks') {
      const b = this.blocks.get(doc.id) ?? { version: 1, blocks: [] };
      this.blocks.set(doc.id, b);
      const view = () => ({
        id: doc.id,
        version: `v${b.version}`,
        schema: 1,
        text: '',
        blocks: structuredClone(b.blocks),
      });
      if (M === 'GET') return { status: 200, body: view() };
      if (M === 'PUT') {
        if (req.headers['if-match'] !== `v${b.version}`) return err(412, 'VERSION_MISMATCH');
        b.blocks = structuredClone((body.blocks ?? []) as unknown[]);
        b.version++;
        doc.type = 'page';
        this.mutations.push({ op: 'replaceDocumentBlocks', id: doc.id });
        return { status: 200, body: view() };
      }
      // v2 C2c: insertBlock, block-level (beside content the whole-document write cannot take back, an inline icon).
      if (M === 'POST') {
        const ifMatch = req.headers['if-match'];
        if (ifMatch !== undefined && ifMatch !== `v${b.version}`) return err(412, 'VERSION_MISMATCH');
        const block = structuredClone(body.block ?? {}) as Record<string, unknown>;
        if (typeof block.id !== 'string') block.id = newId('b');
        const ids = (b.blocks as { id?: unknown }[]).map((x) => x.id);
        if (ids.includes(block.id)) return err(409, 'DUPLICATE_ID');
        let at = b.blocks.length;
        if (typeof body.before === 'string') {
          at = ids.indexOf(body.before);
          if (at < 0) return err(404, 'NOT_FOUND');
        } else if (typeof body.after === 'string') {
          at = ids.indexOf(body.after);
          if (at < 0) return err(404, 'NOT_FOUND');
          at++;
        }
        b.blocks.splice(at, 0, block);
        b.version++;
        doc.type = 'page';
        this.mutations.push({ op: 'insertBlock', id: String(block.id) });
        return { status: 201, body: { ...structuredClone(block), version: `v${b.version}` } };
      }
    }
    // v2 C2c: one top-level block: getBlock and deleteBlock.
    if (p.length === 6 && p[4] === 'blocks') {
      const b = this.blocks.get(doc.id) ?? { version: 1, blocks: [] };
      const at = (b.blocks as { id?: unknown }[]).findIndex((x) => x.id === p[5]);
      if (at < 0) return err(404, 'NOT_FOUND');
      if (M === 'GET') {
        return {
          status: 200,
          body: { ...structuredClone(b.blocks[at] as object), version: `v${b.version}` },
        };
      }
      if (M === 'DELETE') {
        const ifMatch = req.headers['if-match'];
        if (ifMatch !== undefined && ifMatch !== `v${b.version}`) return err(412, 'VERSION_MISMATCH');
        b.blocks.splice(at, 1);
        b.version++;
        this.mutations.push({ op: 'deleteBlock', id: p[5]! });
        return { status: 204 };
      }
    }
    if (p.length === 4) {
      if (M === 'GET') return { status: 200, body: this.docView(doc) };
      if (M === 'PATCH') {
        if (typeof body.name === 'string') doc.name = body.name;
        if (typeof body.isHidden === 'boolean') doc.isHidden = body.isHidden;
        this.mutations.push({ op: 'updateDocument', id: doc.id });
        return { status: 200, body: this.docView(doc) };
      }
      if (M === 'DELETE') {
        doc.deletedAt = new Date(this.now()).toISOString();
        this.mutations.push({ op: 'deleteDocument', id: doc.id });
        return { status: 204 };
      }
    }
    return undefined;
  }

  private routeProps(
    req: MockRequest,
    p: string[],
    res: Res,
    body: Record<string, unknown>,
  ): MockResponse | undefined {
    const M = req.method;
    if (p.length === 3) {
      if (M === 'GET') return { status: 200, body: { data: res.props.map((x) => this.propView(x)) } };
      if (M === 'POST') {
        const prop: Prop = {
          id: typeof body.id === 'string' ? body.id : newId('p'),
          kind: body.kind === 'keyValue' ? 'keyValue' : 'unsupported',
          title: typeof body.title === 'string' ? body.title : '',
          rows: (Array.isArray(body.rows) ? (body.rows as Record<string, unknown>[]) : []).map((r, i) => ({
            id: newId('w'),
            key: typeof r.key === 'string' ? r.key : '',
            text: typeof r.text === 'string' ? r.text : '',
            rank: rankOf((i + 1) * 1000),
          })),
        };
        res.props.push(prop);
        res.propsVersion++;
        this.mutations.push({ op: 'createProperty', id: prop.id });
        return { status: 201, body: this.propView(prop) };
      }
    }
    const prop = res.props.find((x) => x.id === p[3]);
    if (!prop) return err(404, 'NOT_FOUND');
    if (p.length === 4) {
      if (M === 'GET') return { status: 200, body: this.propView(prop) };
      if (M === 'PATCH') {
        if (typeof body.title === 'string') prop.title = body.title;
        if (Array.isArray(body.rows)) {
          prop.rows = (body.rows as Record<string, unknown>[]).map((r, i) => ({
            id: typeof r.id === 'string' ? r.id : newId('w'),
            key: typeof r.key === 'string' ? r.key : '',
            text: typeof r.text === 'string' ? r.text : '',
            rank: rankOf((i + 1) * 1000),
          }));
        }
        res.propsVersion++;
        this.mutations.push({ op: 'updateProperty', id: prop.id });
        return { status: 200, body: this.propView(prop) };
      }
      if (M === 'DELETE') {
        res.props = res.props.filter((x) => x !== prop);
        res.propsVersion++;
        this.mutations.push({ op: 'deleteProperty', id: prop.id });
        return { status: 204 };
      }
    }
    if (p[4] !== 'rows') return undefined;
    const version = `v${res.propsVersion}`;
    const ifMatch = req.headers['if-match'];
    if (p.length === 5 && M === 'GET') {
      return {
        status: 200,
        body: {
          // listPropertyRows is sorted by rank (code-unit order), as LegendKeeper's is; the other reads give stored order.
          data: [...prop.rows]
            .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
            .map((r) => ({
              id: r.id,
              rank: r.rank,
              key: r.key,
              text: r.text,
              content: [{ text: r.text }],
            })),
          version,
        },
      };
    }
    if (M !== 'GET' && ifMatch !== version) return err(412, 'VERSION_MISMATCH');
    if (p.length === 5 && M === 'POST') {
      const row: Row = {
        id: newId('w'),
        key: typeof body.key === 'string' ? body.key : '',
        text: typeof body.text === 'string' ? body.text : '',
        rank: rankOf((prop.rows.length + 1) * 1000),
      };
      prop.rows.push(row);
      res.propsVersion++;
      this.mutations.push({ op: 'createPropertyRow', id: row.id });
      return {
        status: 201,
        body: { ...row, content: [{ text: row.text }], version: `v${res.propsVersion}` },
      };
    }
    const row = prop.rows.find((r) => r.id === p[5]);
    if (!row) return err(404, 'NOT_FOUND');
    if (M === 'PATCH') {
      if (typeof body.key === 'string') row.key = body.key;
      if (typeof body.text === 'string') row.text = body.text;
      res.propsVersion++;
      this.mutations.push({ op: 'updatePropertyRow', id: row.id });
      return {
        status: 200,
        body: { ...row, content: [{ text: row.text }], version: `v${res.propsVersion}` },
      };
    }
    if (M === 'DELETE') {
      prop.rows = prop.rows.filter((r) => r !== row);
      res.propsVersion++;
      this.mutations.push({ op: 'deletePropertyRow', id: row.id });
      return { status: 204 };
    }
    return undefined;
  }
}

/**
 * A realistic world: an AI REPOSITORY root with `nodes` resources below it, at most `depth` levels deep (indexes
 * inside, `[BSRC]` leaves, a few unclassified pages), plus `outside` resources that are not under the root (templates
 * and their children). Deterministic.
 */
export function seedWorld(
  m: TreeModel,
  o: { nodes: number; depth: number; outside?: number; unclassified?: number; prefix?: string },
): { rootId: string; ids: string[] } {
  const pre = o.prefix ?? 'a';
  const root = m.seed({ id: `${pre}root000`, name: 'AI REPOSITORY', parentId: null });
  const ids: string[] = [];
  let made = 0;
  let k = 0;
  const id = () => `${pre}${(++k).toString(36).padStart(7, '0')}`;
  // A spine down to the full depth first, so the deepest level always exists.
  let parent = root.id;
  for (let d = 1; d <= o.depth && made < o.nodes; d++) {
    const leaf = d === o.depth;
    const r = m.seed({ id: id(), name: leaf ? `[BSRC] Spine ${d}` : `[INDEX] Spine ${d}`, parentId: parent });
    ids.push(r.id);
    made++;
    parent = r.id;
  }
  // Then a bushy tree: each index gets a few sub-indexes (while depth allows) and a run of sources.
  const indexes: { id: string; depth: number }[] = [{ id: root.id, depth: 0 }];
  let unclassified = o.unclassified ?? 0;
  for (let i = 0; made < o.nodes; i++) {
    const at = indexes[i % indexes.length]!;
    if (at.depth < o.depth - 1 && indexes.length < o.nodes / 6) {
      const r = m.seed({ id: id(), name: `[INDEX] Group ${made}`, parentId: at.id, aliases: [`G${made}`] });
      ids.push(r.id);
      indexes.push({ id: r.id, depth: at.depth + 1 });
      made++;
    }
    for (let s = 0; s < 4 && made < o.nodes; s++) {
      const name = unclassified-- > 0 ? `Loose page ${made}` : `[BSRC] Source ${made}`;
      const r = m.seed({
        id: id(),
        name,
        parentId: at.id,
        tags: made % 7 === 0 ? ['canon'] : [],
        ...(made % 11 === 0 ? { canonical: `Canonical ${made}` } : {}),
      });
      ids.push(r.id);
      made++;
    }
  }
  for (let t = 0; t < (o.outside ?? 0); t++) {
    const tpl = m.seed({
      id: `${pre}tpl${t.toString(36).padStart(4, '0')}`,
      name: `[BSRC] Template ${t}`,
      parentId: null,
    });
    if (t % 3 === 0) m.seed({ name: `[BSRC] Template child ${t}`, parentId: tpl.id });
  }
  return { rootId: root.id, ids };
}
