/**
 * A stateful model of LegendKeeper's asset library for the asset-tree tests (v2 A4), plugged into chunk 1's mock
 * (`MockLk({ respond })`), so rate limiting, faults and idempotency stay the mock's. It models what the asset tree
 * reads and every asset write it follows: listAssets (one folder level at a time, ordered by id, paged by an opaque
 * cursor), getAsset, createAssetFolder, createImageAsset, updateAsset (move, rename, hide) and deleteAsset (a folder
 * takes everything inside it at any depth).
 *
 * `outside*` methods change the model as an edit in the LegendKeeper app would: the bridge does not see them until it
 * reads. `testWorld()` seeds the shape the phase 0 spike found: 18 folders and 559 images.
 */
import { randomUUID } from 'node:crypto';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';

export interface ModelAsset {
  id: string;
  name: string;
  type: 'IMAGE' | 'MAP' | 'FOLDER' | 'AUDIO';
  folderId: string | null;
  isHidden: boolean;
  url?: string;
  width?: number;
  height?: number;
  createdAt: string;
}

const err = (status: number, code: string, message = `model ${code}`): MockResponse => ({
  status,
  body: { message, code, requestId: `model-${code}` },
});

let seq = 0;
/** Ids that sort in creation order (listAssets orders by id). */
export const newAssetId = (): string => `a${(++seq).toString(36).padStart(7, '0')}`;

export type WorldKey =
  | 'characters'
  | 'beastkin'
  | 'qishen'
  | 'mehrana'
  | 'foxians'
  | 'elves'
  | 'moonElves'
  | 'inae'
  | 'outsiders'
  | 'therians'
  | 'archtherians'
  | 'dwarves'
  | 'humans'
  | 'unknown'
  | 'maps'
  | 'recovery'
  | 'recoveryCharacters'
  | 'recoveryMaps';
export type World = Record<WorldKey, string>;

export class AssetModel {
  readonly assets = new Map<string, ModelAsset>();
  /** Every state change actually applied (op, id). */
  readonly mutations: { op: string; id: string }[] = [];
  /** Every listAssets request answered (the folder, the cursor and the limit). */
  readonly listCalls: { folderId: string | null; cursor: string | null; limit: number }[] = [];
  /** Ids a listing leaves out (as a listing paged during changes can skip one); getAsset still finds them. */
  readonly hiddenFromListing = new Set<string>();
  /** What LegendKeeper does to a written name (default: nothing). */
  nameFilter: (name: string) => string = (n) => n;
  /** Makes the next createAssetFolder / createImageAsset answer with no body (as an uncertain outcome would leave). */
  createWithoutBody = false;
  /** Makes the next listing request that carries a cursor answer 400 (a cursor that no longer works). */
  rejectNextCursor = false;
  /** Listings of these folders (null: the root) answer with an error this many more times (the governor retries 503s). */
  readonly listFailures = new Map<string | null, { status: number; code: string; times: number }>();

  constructor(private readonly now: () => number) {}

  // ============================================================================================ seeding

  folder(name: string, parentId: string | null = null, id?: string): string {
    return this.add({ name, type: 'FOLDER', folderId: parentId, ...(id ? { id } : {}) }).id;
  }

  image(name: string, folderId: string | null = null, o: Partial<ModelAsset> = {}): string {
    return this.add({ name, type: 'IMAGE', folderId, ...o }).id;
  }

  private add(
    a: Partial<ModelAsset> & { name: string; type: ModelAsset['type']; folderId: string | null },
  ): ModelAsset {
    const id = a.id ?? newAssetId();
    const asset: ModelAsset = {
      id,
      name: a.name,
      type: a.type,
      folderId: a.folderId,
      isHidden: a.isHidden ?? false,
      createdAt: new Date(this.now()).toISOString(),
      ...(a.type !== 'FOLDER'
        ? {
            // v3 F7 (ADR 0070): as LegendKeeper's, the file name's uuid is NOT the asset's id (live evidence, 23 November 2026).
            url: a.url ?? `https://assets.legendkeeper.com/${randomUUID()}.webp`,
            width: a.width ?? 512,
            height: a.height ?? 768,
          }
        : {}),
    };
    this.assets.set(id, asset);
    return asset;
  }

  byName(name: string, folderId?: string | null): ModelAsset[] {
    return [...this.assets.values()].filter(
      (a) => a.name === name && (folderId === undefined || a.folderId === folderId),
    );
  }

  /** The id of the folder at a path of names from the root (the first match at each level). */
  at(...names: string[]): string {
    let parent: string | null = null;
    for (const n of names) {
      const f = [...this.assets.values()].find(
        (a) => a.type === 'FOLDER' && a.name === n && a.folderId === parent,
      );
      if (!f) throw new Error(`no folder ${names.join(' / ')} (stopped at ${n})`);
      parent = f.id;
    }
    return parent!;
  }

  /** Everything inside a folder at any depth. */
  inside(folderId: string): ModelAsset[] {
    const out: ModelAsset[] = [];
    const queue = [folderId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const a of this.assets.values()) {
        if (a.folderId !== id) continue;
        out.push(a);
        if (a.type === 'FOLDER') queue.push(a.id);
      }
    }
    return out;
  }

  /** The phase 0 spike's shape: 18 folders and 559 images. Returns the ids that tests care about. */
  testWorld(): World {
    const w = {} as World;
    const imgs = (n: number, folder: string | null, prefix: string) => {
      for (let i = 1; i <= n; i++) this.image(`${prefix} ${String(i).padStart(3, '0')}`, folder);
    };
    w.characters = this.folder('Characters');
    w.beastkin = this.folder('Beastkin', w.characters);
    w.qishen = this.folder('Qishen', w.beastkin);
    w.mehrana = this.folder('Mehrana al-Khalid', w.qishen);
    w.foxians = this.folder('Foxians', w.beastkin);
    w.elves = this.folder('Elves', w.characters);
    w.moonElves = this.folder('Moon Elves', w.elves);
    w.inae = this.folder('Inae Mikumo', w.moonElves);
    w.outsiders = this.folder('Outsiders', w.characters);
    w.therians = this.folder('Therians', w.outsiders);
    w.archtherians = this.folder('Archtherians', w.therians);
    w.dwarves = this.folder('Dwarves', w.characters);
    w.humans = this.folder('Humans', w.characters);
    w.unknown = this.folder('Undetermined / Unknown', w.characters);
    w.maps = this.folder('Maps to get started');
    w.recovery = this.folder('Recovery originals 2026-11');
    w.recoveryCharacters = this.folder('Characters', w.recovery);
    w.recoveryMaps = this.folder('Maps', w.recovery);
    imgs(12, w.mehrana, 'Mehrana');
    imgs(9, w.inae, 'Inae');
    imgs(4, w.archtherians, 'Archtherian');
    imgs(3, w.qishen, 'Qishen');
    imgs(20, w.foxians, 'Foxian');
    imgs(8, w.dwarves, 'Dwarf');
    imgs(12, w.humans, 'Human');
    imgs(35, w.maps, 'Starter map');
    imgs(260, w.recovery, 'Original');
    imgs(150, w.recoveryCharacters, 'Recovered character');
    imgs(40, w.recoveryMaps, 'Recovered map');
    imgs(6, null, 'Loose image');
    return w;
  }

  // ============================================================================================ outside edits

  outsideRename(id: string, name: string): void {
    this.assets.get(id)!.name = name;
  }

  outsideMove(id: string, folderId: string | null): void {
    this.assets.get(id)!.folderId = folderId;
  }

  outsideHide(id: string, hidden = true): void {
    this.assets.get(id)!.isHidden = hidden;
  }

  /** Deletes an asset (a folder takes everything inside it). Returns how many assets went. */
  outsideDelete(id: string): number {
    const gone = [id, ...(this.assets.get(id)?.type === 'FOLDER' ? this.inside(id).map((a) => a.id) : [])];
    for (const g of gone) this.assets.delete(g);
    return gone.length;
  }

  // ============================================================================================ the API

  readonly respond = (req: MockRequest): MockResponse | undefined => {
    const m = /^\/api\/v3\/projects\/[^/]+(\/.*)?$/.exec(req.path.replace(/\/$/, ''));
    if (!m) return undefined;
    const parts = (m[1] ?? '').split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'assets') return undefined; // not ours (the repository tree's model answers)
    try {
      return this.route(req, parts.slice(1));
    } catch (e) {
      return err(500, 'INTERNAL', e instanceof Error ? e.message : String(e));
    }
  };

  private view(a: ModelAsset): Record<string, unknown> {
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      folderId: a.folderId,
      isHidden: a.isHidden,
      createdAt: a.createdAt,
      ...(a.url ? { url: a.url, width: a.width, height: a.height } : {}),
    };
  }

  private route(req: MockRequest, rest: string[]): MockResponse {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (rest.length === 0) {
      if (req.method === 'GET') return this.list(req);
      if (req.method === 'POST') return this.create(body, 'FOLDER');
    }
    if (rest.length === 1 && rest[0] === 'images' && req.method === 'POST') return this.create(body, 'IMAGE');
    if (rest.length === 1 && rest[0] !== 'uploads' && rest[0] !== 'images') {
      const id = rest[0]!;
      const a = this.assets.get(id);
      if (req.method === 'GET') return a ? { status: 200, body: this.view(a) } : err(404, 'NOT_FOUND');
      if (req.method === 'PATCH') return this.update(id, body);
      if (req.method === 'DELETE') {
        if (!a) return err(404, 'NOT_FOUND');
        const n = this.outsideDelete(id);
        this.mutations.push({ op: 'deleteAsset', id });
        void n;
        return { status: 204 };
      }
    }
    return err(404, 'NOT_FOUND', `model: no route for ${req.method} ${req.path}`);
  }

  private list(req: MockRequest): MockResponse {
    const folderId = req.query.folderId && req.query.folderId !== '' ? req.query.folderId : null;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return err(400, 'VALIDATION_ERROR', 'limit');
    const cursor = req.query.cursor ?? null;
    this.listCalls.push({ folderId, cursor, limit });
    const failure = this.listFailures.get(folderId);
    if (failure && failure.times > 0) {
      failure.times--;
      return err(failure.status, failure.code);
    }
    if (cursor !== null && this.rejectNextCursor) {
      this.rejectNextCursor = false;
      return err(400, 'VALIDATION_ERROR', 'cursor expired');
    }
    if (folderId !== null) {
      const f = this.assets.get(folderId);
      if (!f || f.type !== 'FOLDER') return err(404, 'NOT_FOUND', 'no such folder');
    }
    let after = '';
    if (cursor !== null) {
      if (!/^c:/.test(cursor)) return err(400, 'VALIDATION_ERROR', 'cursor');
      after = cursor.slice(2);
    }
    const all = [...this.assets.values()]
      .filter((a) => a.folderId === folderId && !this.hiddenFromListing.has(a.id) && a.id > after)
      .sort((x, y) => (x.id < y.id ? -1 : 1));
    const page = all.slice(0, limit);
    const hasMore = all.length > limit;
    return {
      status: 200,
      body: {
        data: page.map((a) => this.view(a)),
        hasMore,
        nextCursor: hasMore ? `c:${page.at(-1)!.id}` : null,
      },
    };
  }

  private create(body: Record<string, unknown>, type: 'FOLDER' | 'IMAGE'): MockResponse {
    const folderId = typeof body.folderId === 'string' ? body.folderId : null;
    if (folderId !== null && this.assets.get(folderId)?.type !== 'FOLDER') {
      return err(400, 'VALIDATION_ERROR', 'folderId is not a folder in this project');
    }
    if (typeof body.name !== 'string' || body.name.length === 0) return err(400, 'VALIDATION_ERROR', 'name');
    const a = this.add({ name: this.nameFilter(body.name), type, folderId });
    this.mutations.push({ op: type === 'FOLDER' ? 'createAssetFolder' : 'createImageAsset', id: a.id });
    if (this.createWithoutBody) {
      this.createWithoutBody = false;
      return { status: 201, body: {} };
    }
    return { status: 201, body: this.view(a) };
  }

  private update(id: string, body: Record<string, unknown>): MockResponse {
    const a = this.assets.get(id);
    if (!a) return err(404, 'NOT_FOUND');
    if (Object.keys(body).length === 0) return err(400, 'VALIDATION_ERROR', 'empty body');
    if ('folderId' in body) {
      const to = typeof body.folderId === 'string' ? body.folderId : null;
      if (to !== null) {
        const target = this.assets.get(to);
        if (!target || target.type !== 'FOLDER')
          return err(400, 'VALIDATION_ERROR', 'folderId is not a folder');
        if (to === id || (a.type === 'FOLDER' && this.inside(id).some((x) => x.id === to))) {
          return err(400, 'VALIDATION_ERROR', 'folderId is the asset itself or inside it');
        }
      }
      a.folderId = to;
    }
    if (typeof body.name === 'string') a.name = this.nameFilter(body.name);
    if (typeof body.isHidden === 'boolean') a.isHidden = body.isHidden;
    this.mutations.push({ op: 'updateAsset', id });
    return { status: 204 };
  }
}
