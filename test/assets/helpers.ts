/**
 * Harness for the asset-tree tests (v2 A4): SQLite in a temp file, chunk 1's FakeClock, one mock LegendKeeper per
 * project (each with its own key, rate windows, an `AssetModel` for the asset library and a `TreeModel` for the
 * repository), the real job engine over every project, and the repository tree and asset tree services attached to it.
 * The transport can hold requests (before they reach the mock) or responses (after the mock answered, so the answer
 * describes the state at the time it was sent), and an instance can be abandoned like a crashed process and a new one
 * started on the same database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createAssets, type AssetService, type AssetServiceOptions } from '../../src/assets/index.js';
import { defaultJobsSettings } from '../../src/config/jobs.js';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import { createJobEngine, type JobEngine } from '../../src/jobs/index.js';
import { createLkClient, type LkClient } from '../../src/lk/client.js';
import { FakeClock, flushMicrotasks } from '../../src/lk/governor/clock.js';
import { ProjectStore, StaticProjects } from '../../src/projects/index.js';
import { createTree, type TreeService } from '../../src/tree/index.js';
import { MockLk, type CountedTier } from '../contract/mock-lk.js';
import { TreeModel } from '../tree/model.js';
import { AssetModel } from './model.js';

const realDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Wire {
  readonly method: string;
  readonly url: string;
}

export interface ProjectRig {
  readonly name: string;
  readonly id: string;
  readonly key: string;
  /** The asset library. */
  readonly model: AssetModel;
  /** The repository (for placement planning against a real repository tree). */
  readonly repo: TreeModel;
  readonly mock: MockLk;
}

export interface Instance {
  readonly db: Db;
  readonly engine: JobEngine;
  readonly assets: AssetService;
  readonly tree: TreeService;
  readonly projects: StaticProjects;
  readonly clients: Record<string, LkClient>;
  /** Requests this instance sent. */
  readonly sent: Wire[];
}

export interface AssetRig {
  readonly clock: FakeClock;
  readonly p: Record<string, ProjectRig>;
  readonly dbPath: string;
  i: Instance;
  start(o?: Partial<AssetServiceOptions>): Instance;
  /** Abandons the current instance like a crashed process: nothing more leaves it; no clean shutdown. */
  crash(): void;
  stopInstance(): Promise<void>;
  holdRequest(match: (w: Wire) => boolean): () => void;
  holdResponse(match: (w: Wire) => boolean, times?: number): { release: () => void; arrived: () => boolean };
  setSetting(name: string, key: string, value: unknown): void;
  drive(done: () => boolean, maxVirtualMs?: number): Promise<void>;
  settle<T>(p: Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const origin = { kind: 'test' as const, client: 'vitest' };

export async function assetRig(
  o: {
    projects?: readonly string[];
    limits?: Partial<Record<CountedTier, number>>;
    assets?: Partial<AssetServiceOptions>;
  } = {},
): Promise<AssetRig> {
  const clock = new FakeClock();
  const names = o.projects ?? ['alpha'];
  const p: Record<string, ProjectRig> = {};
  const urls: Record<string, string> = {};
  for (const name of names) {
    const model = new AssetModel(() => clock.now());
    const repo = new TreeModel(() => clock.now());
    const key = `mock-key-${name}-not-real`;
    const id = `lkp_${name}`;
    const mock = new MockLk({
      clock,
      apiKey: key,
      projectId: id,
      respond: (req) => model.respond(req) ?? repo.respond(req),
      ...(o.limits ? { limits: o.limits } : {}),
    });
    urls[name] = await mock.start();
    p[name] = { name, id, key, model, repo, mock };
  }
  const dir = mkdtempSync(join(tmpdir(), 'lkb-assets-'));
  const dbPath = join(dir, 'bridge.db');

  const reqHolds: { match: (w: Wire) => boolean; gate: Promise<void> }[] = [];
  const resHolds: { match: (w: Wire) => boolean; gate: Promise<void>; left: number; arrived: boolean }[] = [];
  let killed: { value: boolean } = { value: false };
  let parked = 0;
  const instances: Instance[] = [];

  const start = (to: Partial<AssetServiceOptions> = {}): Instance => {
    const db = openDatabase(dbPath);
    runMigrations(db);
    const sent: Wire[] = [];
    const myKill = { value: false };
    killed = myKill;
    const never = () => new Promise<never>(() => {});
    const transport = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const w: Wire = {
        method: (init?.method ?? 'GET').toUpperCase(),
        url: input instanceof Request ? input.url : input.toString(),
      };
      if (myKill.value) return never();
      sent.push(w);
      for (const h of [...reqHolds]) {
        if (h.match(w)) {
          parked++;
          await h.gate;
          parked--;
        }
      }
      if (myKill.value) return never();
      const res = await fetch(input, init);
      for (const h of [...resHolds]) {
        if (h.left > 0 && h.match(w)) {
          h.left--;
          h.arrived = true;
          const body = await res.arrayBuffer();
          parked++;
          await h.gate;
          parked--;
          if (myKill.value) return never();
          return new Response(body, { status: res.status, headers: res.headers });
        }
      }
      return res;
    };
    const clients: Record<string, LkClient> = {};
    for (const name of names) {
      clients[name] = createLkClient({
        apiKey: p[name]!.key,
        projectId: p[name]!.id,
        baseUrl: urls[name]!,
        clock,
        random: () => 0.5,
        transport,
        governor: defaultGovernorSettings({ requestTimeoutMs: 10_000 }),
      });
    }
    const projects = new StaticProjects(
      db,
      names.map((n) => ({ client: clients[n]!, name: n })),
      () => clock.now(),
    );
    const engine = createJobEngine({
      db,
      projects,
      clock,
      settings: defaultJobsSettings({ readOnly: false }),
    });
    const tree = createTree({ db, engine, projects, clock, autoSuggestRoot: false });
    tree.attach();
    tree.start();
    const assets = createAssets({
      db,
      engine,
      projects,
      clock,
      paceMs: 0,
      tree: tree.queries,
      ...o.assets,
      ...to,
    });
    assets.attach();
    assets.start();
    const inst: Instance = { db, engine, assets, tree, projects, clients, sent };
    instances.push(inst);
    rig.i = inst;
    return inst;
  };

  const inFlight = () =>
    Object.values(rig.i.clients).reduce((n, c) => n + c.governor.snapshot().inFlight, 0) - parked;

  const rig: AssetRig = {
    clock,
    p,
    dbPath,
    i: undefined as unknown as Instance,
    start,
    crash() {
      killed.value = true;
      try {
        rig.i.db.close();
      } catch {
        // already closed
      }
    },
    async stopInstance() {
      await rig.i.assets.stop();
      await rig.i.tree.stop();
      await rig.i.engine.stop();
      for (const c of Object.values(rig.i.clients)) c.governor.close();
      rig.i.db.close();
    },
    holdRequest(match) {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const h = { match, gate };
      reqHolds.push(h);
      return () => {
        reqHolds.splice(reqHolds.indexOf(h), 1);
        release();
      };
    },
    holdResponse(match, times = 1) {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const h = { match, gate, left: times, arrived: false };
      resHolds.push(h);
      return {
        release: () => {
          resHolds.splice(resHolds.indexOf(h), 1);
          release();
        },
        arrived: () => h.arrived,
      };
    },
    setSetting(name, key, value) {
      new ProjectStore(rig.i.db, () => clock.now()).setSetting(p[name]!.id, key, value);
    },
    async drive(done, maxVirtualMs = 7 * 24 * 3600_000) {
      const limit = clock.now() + maxVirtualMs;
      let idle = 0;
      for (;;) {
        if (done()) return;
        const startedAt = performance.now();
        let quiet = 0;
        while (quiet < 3 && performance.now() - startedAt < 3000) {
          await flushMicrotasks();
          if (done()) return;
          if (inFlight() === 0) quiet++;
          else {
            quiet = 0;
            await realDelay(1);
          }
        }
        if (done()) return;
        const next = clock.nextTimerAt();
        if (next === undefined) {
          if (++idle > 400) throw new Error('drive: nothing scheduled and work not done');
          await realDelay(3);
          continue;
        }
        idle = 0;
        if (next > limit) throw new Error('drive: virtual time limit reached');
        await clock.runNext();
      }
    },
    async settle<T>(pr: Promise<T>): Promise<T> {
      const state: { done: boolean; value?: T; error?: unknown } = { done: false };
      pr.then(
        (value) => Object.assign(state, { done: true, value }),
        (error: unknown) => Object.assign(state, { done: true, error }),
      );
      await rig.drive(() => state.done);
      if ('error' in state && state.error !== undefined) {
        throw state.error instanceof Error ? state.error : new Error(JSON.stringify(state.error));
      }
      return state.value as T;
    },
    async close() {
      for (const inst of instances) {
        await Promise.race([inst.assets.stop(), realDelay(200)]);
        await Promise.race([inst.tree.stop(), realDelay(200)]);
        await Promise.race([inst.engine.stop(), realDelay(200)]);
        for (const c of Object.values(inst.clients)) c.governor.close();
        try {
          inst.db.close();
        } catch {
          // closed by crash()
        }
      }
      for (const x of Object.values(p)) await x.mock.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  start();
  return rig;
}

/** Builds the asset tree of `name` (prepare, confirm, wait for it to finish). */
export async function buildAssets(rig: AssetRig, name: string): Promise<void> {
  const id = rig.p[name]!.id;
  rig.i.assets.prepareBuild(id, { trigger: 'test', autoConfirm: true });
  await rig.drive(() => rig.i.assets.store.activePass(id) === undefined);
  await rig.settle(rig.i.assets.whenIdle());
  const last = rig.i.assets.store.lastPass(id, 'build');
  expect(last?.status, last?.error ?? '').toBe('succeeded');
}

/** Requests the mock of `name` saw for a method and path pattern (after the project prefix). */
export function seenAt(rig: AssetRig, name: string, method: string, path: RegExp): number {
  return rig.p[name]!.mock.calls.filter(
    (c) =>
      c.method === method && path.test(c.path.replace(/^\/api\/v3\/projects\/[^/]+/, '').replace(/\/$/, '')),
  ).length;
}

/**
 * The asset tree of `name` must equal the model: the same folders and assets, and for each its name, folder, type, url,
 * size of picture and hidden flag; folders also their depth and path.
 */
export function expectAssetsMatchModel(rig: AssetRig, name: string): void {
  const { id: projectId, model } = rig.p[name]!;
  const store = rig.i.assets.store;
  const folders = [...model.assets.values()].filter((a) => a.type === 'FOLDER');
  const items = [...model.assets.values()].filter((a) => a.type !== 'FOLDER');
  const storedFolders = rig.i.db
    .prepare('SELECT id FROM asset_folders WHERE project_id = ? ORDER BY id')
    .all(projectId) as { id: string }[];
  const storedItems = rig.i.db
    .prepare('SELECT id FROM asset_items WHERE project_id = ? ORDER BY id')
    .all(projectId) as { id: string }[];
  expect(storedFolders.map((r) => r.id)).toEqual(folders.map((f) => f.id).sort());
  expect(storedItems.map((r) => r.id)).toEqual(items.map((i) => i.id).sort());
  const nameOf = (id: string | null): string[] => {
    const out: string[] = [];
    let cur: string | null = id;
    while (cur) {
      const a = model.assets.get(cur)!;
      out.unshift(a.name);
      cur = a.folderId;
    }
    return out;
  };
  for (const f of folders) {
    const row = rig.i.assets.queries.folder(projectId, f.id).data!;
    expect(
      { name: row.name, parent: row.parentId, hidden: row.isHidden, path: row.path.names, depth: row.depth },
      f.id,
    ).toEqual({
      name: f.name,
      parent: f.folderId,
      hidden: f.isHidden,
      path: nameOf(f.id),
      depth: nameOf(f.id).length,
    });
  }
  for (const a of items) {
    const row = store.item(projectId, a.id)!;
    expect(
      {
        name: row.name,
        folder: row.folder_id,
        type: row.type,
        url: row.url,
        w: row.width,
        h: row.height,
        hidden: row.is_hidden === 1,
      },
      a.id,
    ).toEqual({
      name: a.name,
      folder: a.folderId,
      type: a.type,
      url: a.url ?? null,
      w: a.width ?? null,
      h: a.height ?? null,
      hidden: a.isHidden,
    });
  }
}

export async function idle(rig: AssetRig): Promise<void> {
  await rig.settle(rig.i.assets.whenIdle());
}

/** Builds the repository tree of `name` (its AI REPOSITORY root must be set): placement planning reads it. */
export async function buildRepository(rig: AssetRig, name: string): Promise<void> {
  const id = rig.p[name]!.id;
  rig.i.tree.prepareBuild(id, { trigger: 'test', autoConfirm: true });
  await rig.drive(() => rig.i.tree.store.activePass(id) === undefined);
  await rig.settle(rig.i.tree.whenIdle());
  const last = rig.i.tree.store.lastPass(id, 'build');
  expect(last?.status, last?.error ?? '').toBe('succeeded');
}
