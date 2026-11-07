/**
 * A small stateful model of LegendKeeper for the job tests, plugged into chunk 1's mock (`MockLk({ respond })`), so
 * rate limiting, idempotency replay and fault injection stay the mock's. It models just enough for the engine:
 * resources (client ids, DUPLICATE_ID, soft delete, HAS_CHILDREN, move), documents with versioned block trees
 * (412 on a stale If-Match, unsupported blocks deleted unless echoed), timelines, map features, boards and members.
 *
 * `mutations` logs every state change actually applied, so tests can assert "no duplicates at the mock".
 */
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';

export interface Block {
  id?: string;
  kind: string;
  children?: Block[];
  [key: string]: unknown;
}

interface Resource {
  id: string;
  name: string;
  parentId?: string;
  tags: string[];
  deletedAt?: string;
  documents: string[];
}

interface Doc {
  id: string;
  resourceId: string;
  name: string;
  type: string;
  version: number;
  blocks: Block[];
  lanes: Map<string, Record<string, unknown>>;
  events: Map<string, Record<string, unknown>>;
  features: Map<string, Record<string, unknown>>;
  shapes: Record<string, unknown>[];
  deletedAt?: string;
}

export interface Mutation {
  readonly op: string;
  readonly id: string;
}

const err = (status: number, code: string, message = `model ${code}`): MockResponse => ({
  status,
  body: { message, code, requestId: `model-${code}` },
});

let serverSeq = 0;
const serverId = (prefix: string) => `${prefix}${(++serverSeq).toString(36).padStart(6, '0')}`;

export class LkModel {
  readonly resources = new Map<string, Resource>();
  readonly docs = new Map<string, Doc>();
  readonly members = new Map<string, Record<string, unknown>>();
  readonly mutations: Mutation[] = [];

  constructor(private readonly now: () => number) {}

  /** Seeds a resource with its `Main` document. */
  seedResource(
    id: string,
    opts: { parentId?: string; name?: string; blocks?: Block[] } = {},
  ): { resourceId: string; documentId: string } {
    const docId = `d_${id}`;
    this.resources.set(id, {
      id,
      name: opts.name ?? id,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      tags: [],
      documents: [docId],
    });
    this.docs.set(docId, {
      id: docId,
      resourceId: id,
      name: 'Main',
      type: opts.blocks ? 'page' : 'blank',
      version: 1,
      blocks: structuredClone(opts.blocks ?? []),
      lanes: new Map(),
      events: new Map(),
      features: new Map(),
      shapes: [],
    });
    return { resourceId: id, documentId: docId };
  }

  count(op: string): number {
    return this.mutations.filter((m) => m.op === op).length;
  }

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

  private log(op: string, id: string) {
    this.mutations.push({ op, id });
  }

  private resourceView(r: Resource) {
    return {
      id: r.id,
      name: r.name,
      tags: r.tags,
      ...(r.parentId ? { parentId: r.parentId } : {}),
      ...(r.deletedAt ? { deletedAt: r.deletedAt } : {}),
      documents: r.documents.map((d) => ({ id: d, name: this.docs.get(d)?.name ?? 'Main' })),
    };
  }

  private liveResource(id: string): Resource | undefined {
    const r = this.resources.get(id);
    return r && !r.deletedAt ? r : undefined;
  }

  private createResource(body: Record<string, unknown>): MockResponse {
    const id = typeof body.id === 'string' ? body.id : serverId('r');
    if (this.resources.has(id)) return err(409, 'DUPLICATE_ID');
    if (typeof body.parentId === 'string' && !this.liveResource(body.parentId)) return err(404, 'NOT_FOUND');
    this.seedResource(id, {
      name: typeof body.name === 'string' ? body.name : 'Untitled',
      ...(typeof body.parentId === 'string' ? { parentId: body.parentId } : {}),
    });
    this.resources.get(id)!.tags = Array.isArray(body.tags) ? (body.tags as string[]) : [];
    this.log('createResource', id);
    return { status: 201, body: this.resourceView(this.resources.get(id)!) };
  }

  private route(req: MockRequest, p: string[]): MockResponse | undefined {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ifMatch = req.headers['if-match'];
    const M = req.method;

    // /members
    if (p[0] === 'members') {
      if (M === 'GET')
        return { status: 200, body: { data: [...this.members.values()], hasMore: false, nextCursor: null } };
      if (M === 'POST') {
        const id = serverId('m');
        this.members.set(id, { id, email: body.email });
        this.log('inviteMember', id);
        return { status: 200, body: { id } };
      }
      return undefined;
    }
    if (p[0] !== 'resources') return undefined;

    // /resources
    if (p.length === 1) {
      if (M === 'POST') return this.createResource(body);
      if (M === 'GET') {
        const parentId = req.query.parentId;
        const all = [...this.resources.values()]
          .filter((r) => !r.deletedAt && (parentId === undefined || r.parentId === parentId))
          .sort((a, b) => a.id.localeCompare(b.id));
        const limit = Number(req.query.limit ?? 50);
        const offset = Number(req.query.cursor ?? 0);
        const data = all.slice(offset, offset + limit).map((r) => this.resourceView(r));
        const more = offset + limit < all.length;
        return {
          status: 200,
          body: { data, hasMore: more, nextCursor: more ? String(offset + limit) : null },
        };
      }
    }
    if (p.length === 2 && p[1] === 'batch' && M === 'POST') {
      const items = (body.resources ?? []) as Record<string, unknown>[];
      for (const i of items)
        if (typeof i.id === 'string' && this.resources.has(i.id)) return err(409, 'DUPLICATE_ID');
      const out = items.map((i) => this.createResource(i).body);
      return { status: 201, body: { resources: out } };
    }

    const rid = p[1]!;
    const res = this.liveResource(rid);
    if (p.length === 2) {
      if (!res) return err(404, 'NOT_FOUND');
      if (M === 'GET') return { status: 200, body: this.resourceView(res) };
      if (M === 'PATCH') {
        if (typeof body.name === 'string') res.name = body.name;
        if (Array.isArray(body.tags)) res.tags = body.tags as string[];
        this.log('updateResource', rid);
        return { status: 200, body: this.resourceView(res) };
      }
      if (M === 'DELETE') {
        const children = [...this.resources.values()].filter((r) => r.parentId === rid && !r.deletedAt);
        if (children.length > 0 && req.query.cascade !== 'true') return err(409, 'HAS_CHILDREN');
        const at = new Date(this.now()).toISOString();
        res.deletedAt = at;
        for (const c of children) c.deletedAt = at;
        this.log('deleteResource', rid);
        return { status: 204 };
      }
    }
    if (!res) return err(404, 'NOT_FOUND');
    if (p.length === 3 && p[2] === 'move' && M === 'POST') {
      if (typeof body.parentId === 'string') res.parentId = body.parentId;
      this.log('moveResource', rid);
      return { status: 200, body: this.resourceView(res) };
    }
    if (p[2] !== 'docs') return undefined;
    if (p.length === 3 && M === 'POST') {
      const id = serverId('d');
      this.docs.set(id, {
        id,
        resourceId: rid,
        name: typeof body.name === 'string' ? body.name : 'Doc',
        type: typeof body.type === 'string' ? body.type : 'page',
        version: 1,
        blocks: [],
        lanes: new Map(),
        events: new Map(),
        features: new Map(),
        shapes: [],
      });
      res.documents.push(id);
      this.log('createDocument', id);
      return { status: 201, body: { id, name: body.name, type: body.type, rank: 'a', isHidden: false } };
    }
    const did = p[3]!;
    const doc = this.docs.get(did);
    if (!doc || doc.resourceId !== rid || doc.deletedAt) return err(404, 'NOT_FOUND');
    const version = () => `v${doc.version}`;
    const stale = () => ifMatch !== undefined && ifMatch !== '*' && ifMatch !== version();
    const bump = () => {
      doc.version++;
    };
    if (p.length === 4) {
      if (M === 'GET')
        return {
          status: 200,
          body: { id: doc.id, name: doc.name, type: doc.type, rank: 'a', isHidden: false },
        };
      if (M === 'PATCH') {
        if (typeof body.name === 'string') doc.name = body.name;
        this.log('updateDocument', did);
        return {
          status: 200,
          body: { id: doc.id, name: doc.name, type: doc.type, rank: 'a', isHidden: false },
        };
      }
    }
    const sub = p[4];
    if (sub === 'blocks') {
      if (p.length === 5) {
        if (M === 'GET') return { status: 200, body: this.blocksView(doc) };
        if (M === 'PUT') {
          if (stale()) return err(412, 'VERSION_MISMATCH');
          doc.blocks = assignIds(structuredClone((body.blocks ?? []) as Block[]));
          doc.type = 'page';
          bump();
          this.log('replaceDocumentBlocks', did);
          return { status: 200, body: this.blocksView(doc) };
        }
        if (M === 'POST') {
          if (stale()) return err(412, 'VERSION_MISMATCH');
          const block = assignIds([structuredClone(body.block as Block)])[0]!;
          if (block.id && findBlock(doc.blocks, block.id)) return err(409, 'DUPLICATE_ID');
          doc.blocks.push(block);
          bump();
          this.log('insertBlock', block.id!);
          return { status: 201, body: { ...block, version: version() } };
        }
      }
      const bid = p[5]!;
      const found = findBlock(doc.blocks, bid);
      if (!found) return err(404, 'NOT_FOUND');
      if (M === 'GET') return { status: 200, body: { ...structuredClone(found.block), version: version() } };
      if (stale()) return err(412, 'VERSION_MISMATCH');
      if (M === 'PUT') {
        found.list[found.index] = assignIds([{ ...structuredClone(body as Block), id: bid }])[0]!;
        bump();
        this.log('replaceBlock', bid);
        return { status: 200, body: { ...found.list[found.index]!, version: version() } };
      }
      if (M === 'PATCH') {
        Object.assign(found.block, structuredClone(body));
        bump();
        this.log('updateBlock', bid);
        return { status: 200, body: { ...found.block, version: version() } };
      }
      if (M === 'DELETE') {
        found.list.splice(found.index, 1);
        bump();
        this.log('deleteBlock', bid);
        return { status: 204 };
      }
    }
    if (sub === 'lanes' || sub === 'events' || sub === 'features') {
      const store = doc[sub];
      const op = { lanes: 'Lane', events: 'Event', features: 'Feature' }[sub];
      if (p.length === 5 && M === 'POST') {
        const id = typeof body.id === 'string' ? body.id : serverId('x');
        if (store.has(id)) return err(409, 'DUPLICATE_ID');
        store.set(id, { ...body, id });
        this.log(`create${op}`, id);
        return { status: 201, body: store.get(id) };
      }
      if (p.length === 5 && M === 'GET')
        return { status: 200, body: { data: [...store.values()], hasMore: false, nextCursor: null } };
      const eid = p[5]!;
      const ent = store.get(eid);
      if (!ent) return err(404, 'NOT_FOUND');
      if (M === 'GET') return { status: 200, body: ent };
      if (M === 'PATCH') {
        Object.assign(ent, body);
        this.log(`update${op}`, eid);
        return { status: 200, body: ent };
      }
      if (M === 'DELETE') {
        store.delete(eid);
        this.log(`delete${op}`, eid);
        return { status: 204 };
      }
    }
    if (sub === 'board' && p.length === 5) {
      const view = () => ({
        schema: { schemaVersion: 2, sequences: {} },
        pages: [],
        shapes: doc.shapes,
        bindings: [],
        assets: [],
        version: version(),
      });
      if (M === 'GET') return { status: 200, body: view() };
      if (M === 'PUT') {
        if (stale()) return err(412, 'VERSION_MISMATCH');
        doc.shapes = structuredClone((body.shapes ?? []) as Record<string, unknown>[]);
        bump();
        this.log('replaceBoardContent', did);
        return { status: 200, body: view() };
      }
    }
    return undefined;
  }

  private blocksView(doc: Doc) {
    return {
      id: doc.id,
      version: `v${doc.version}`,
      schema: 1,
      text: '',
      blocks: structuredClone(doc.blocks),
    };
  }

  /** Test helper: an edit made "in the LK app" (bumps the version, as any outside change would). */
  outsideEdit(documentId: string, edit: (blocks: Block[]) => void): void {
    const doc = this.docs.get(documentId)!;
    edit(doc.blocks);
    doc.version++;
  }
}

function assignIds(blocks: Block[]): Block[] {
  for (const b of blocks) {
    if (!b.id) b.id = serverId('b');
    if (b.children) assignIds(b.children);
  }
  return blocks;
}

function findBlock(list: Block[], id: string): { block: Block; list: Block[]; index: number } | undefined {
  for (let i = 0; i < list.length; i++) {
    const b = list[i]!;
    if (b.id === id) return { block: b, list, index: i };
    if (b.children) {
      const f = findBlock(b.children, id);
      if (f) return f;
    }
  }
  return undefined;
}
