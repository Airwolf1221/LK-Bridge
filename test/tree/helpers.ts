/**
 * Harness for the repository-tree tests (v2 A2): SQLite in a temp file, chunk 1's FakeClock, one mock LegendKeeper per
 * project (each with its own key, rate windows and `TreeModel`), the real job engine over every project, and the tree
 * service attached to it. The transport can hold requests (before they reach the mock) or responses (after the mock
 * answered, so the answer describes the state at the time it was sent), and an instance can be abandoned like a
 * crashed process and a new one started on the same database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { defaultJobsSettings } from '../../src/config/jobs.js';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import { createJobEngine, type JobEngine } from '../../src/jobs/index.js';
import { createLkClient, type LkClient } from '../../src/lk/client.js';
import { FakeClock, flushMicrotasks } from '../../src/lk/governor/clock.js';
import { ProjectStore, StaticProjects } from '../../src/projects/index.js';
import { createTree, type TreeService, type TreeServiceOptions } from '../../src/tree/index.js';
import { MockLk, type CountedTier } from '../contract/mock-lk.js';
import { TreeModel } from './model.js';

const realDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Wire {
  readonly method: string;
  readonly url: string;
}

export interface ProjectRig {
  readonly name: string;
  readonly id: string;
  readonly key: string;
  readonly model: TreeModel;
  readonly mock: MockLk;
}

export interface Instance {
  readonly db: Db;
  readonly engine: JobEngine;
  readonly tree: TreeService;
  readonly projects: StaticProjects;
  readonly clients: Record<string, LkClient>;
  /** Requests this instance sent. */
  readonly sent: Wire[];
}

export interface TreeRig {
  readonly clock: FakeClock;
  readonly p: Record<string, ProjectRig>;
  readonly dbPath: string;
  i: Instance;
  /** Starts a new instance on the same database (after `crash()` or `stopInstance()`). */
  start(o?: Partial<TreeServiceOptions>): Instance;
  /** Abandons the current instance like a crashed process: nothing more leaves it; no clean shutdown. */
  crash(): void;
  /** Stops the current instance cleanly. */
  stopInstance(): Promise<void>;
  /** Holds requests matching `match` before they reach the mock, until the returned function is called. */
  holdRequest(match: (w: Wire) => boolean): () => void;
  /** Lets the mock answer requests matching `match`, but holds the answer until the returned function is called. */
  holdResponse(match: (w: Wire) => boolean, times?: number): { release: () => void; arrived: () => boolean };
  setRoot(name: string, rootId: string | null): void;
  setSetting(name: string, key: string, value: unknown): void;
  /** Moves fake time only when no request is in flight, until `done()`. */
  drive(done: () => boolean, maxVirtualMs?: number): Promise<void>;
  /** Settles a promise while driving the clock. */
  settle<T>(p: Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const origin = { kind: 'test' as const, client: 'vitest' };

export async function treeRig(
  o: {
    projects?: readonly string[];
    limits?: Partial<Record<CountedTier, number>>;
    tree?: Partial<TreeServiceOptions>;
  } = {},
): Promise<TreeRig> {
  const clock = new FakeClock();
  const names = o.projects ?? ['alpha'];
  const p: Record<string, ProjectRig> = {};
  const urls: Record<string, string> = {};
  for (const name of names) {
    const model = new TreeModel(() => clock.now());
    const key = `mock-key-${name}-not-real`;
    const id = `lkp_${name}`;
    const mock = new MockLk({
      clock,
      apiKey: key,
      projectId: id,
      respond: model.respond,
      ...(o.limits ? { limits: o.limits } : {}),
    });
    urls[name] = await mock.start();
    p[name] = { name, id, key, model, mock };
  }
  const dir = mkdtempSync(join(tmpdir(), 'lkb-tree-'));
  const dbPath = join(dir, 'bridge.db');

  const reqHolds: { match: (w: Wire) => boolean; gate: Promise<void> }[] = [];
  const resHolds: { match: (w: Wire) => boolean; gate: Promise<void>; left: number; arrived: boolean }[] = [];
  let killed: { value: boolean } = { value: false };
  /** Requests parked at a hold: in flight for the governor, but nothing a test should wait for. */
  let parked = 0;
  const instances: Instance[] = [];

  const start = (to: Partial<TreeServiceOptions> = {}): Instance => {
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
    const tree = createTree({ db, engine, projects, clock, autoSuggestRoot: false, ...o.tree, ...to });
    tree.attach();
    tree.start();
    const inst: Instance = { db, engine, tree, projects, clients, sent };
    instances.push(inst);
    rig.i = inst;
    return inst;
  };

  const inFlight = () =>
    Object.values(rig.i.clients).reduce((n, c) => n + c.governor.snapshot().inFlight, 0) - parked;

  const rig: TreeRig = {
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
    setRoot(name, rootId) {
      rig.setSetting(name, 'aiRepositoryRootId', rootId);
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

/** Builds the tree of `name` (prepare, confirm, wait for it to finish). */
export async function build(rig: TreeRig, name: string): Promise<void> {
  const id = rig.p[name]!.id;
  rig.i.tree.prepareBuild(id, { trigger: 'test', autoConfirm: true });
  await rig.drive(() => {
    const a = rig.i.tree.store.activePass(id);
    return a === undefined;
  });
  await rig.settle(rig.i.tree.whenIdle());
  const last = rig.i.tree.store.lastPass(id, 'build');
  expect(last?.status, last?.error ?? '').toBe('succeeded');
}

/** Requests the mock of `name` saw for a method and path pattern (after the project prefix). */
export function seenAt(rig: TreeRig, name: string, method: string, path: RegExp): number {
  return rig.p[name]!.mock.calls.filter(
    (c) =>
      c.method === method && path.test(c.path.replace(/^\/api\/v3\/projects\/[^/]+/, '').replace(/\/$/, '')),
  ).length;
}

/**
 * The tree of `name` must equal the model's subtree under the root: the same nodes, and for each its name, parent,
 * rank, tags, aliases, documents, flags, catalogue fields, depth and path. Properties are compared only where the tree
 * has read them (`withProps`: every node must have them).
 */
export function expectTreeMatchesModel(rig: TreeRig, name: string, o: { withProps?: boolean } = {}): void {
  const { id: projectId, model } = rig.p[name]!;
  const rootId = rig.i.tree.settings(projectId).rootId!;
  const expected = model.subtree(rootId);
  const rows = rig.i.db
    .prepare('SELECT id FROM tree_nodes WHERE project_id = ? ORDER BY id')
    .all(projectId) as {
    id: string;
  }[];
  expect(rows.map((r) => r.id).sort()).toEqual(expected.map((r) => r.id).sort());
  const depthOf = new Map<string, number>([[rootId, 0]]);
  for (const r of expected) if (r.id !== rootId) depthOf.set(r.id, depthOf.get(r.parentId!)! + 1);
  for (const r of expected) {
    const n = rig.i.tree.queries.node(projectId, r.id).data!;
    expect(n, r.id).not.toBeNull();
    expect(
      {
        name: n.rawName,
        parent: n.parentId,
        rank: n.rank,
        tags: n.tags,
        aliases: n.aliases,
        docs: [...n.documents].map((d) => d.id).sort(),
        hidden: n.isHidden,
        depth: n.depth,
        pathEnd: n.path.ids.at(-1),
        pathLen: n.path.ids.length,
      },
      r.id,
    ).toEqual({
      name: r.name,
      parent: r.id === rootId ? null : r.parentId,
      rank: r.rank,
      tags: r.tags,
      aliases: r.aliases,
      docs: model
        .liveDocs(r)
        .map((d) => d.id)
        .sort(),
      hidden: r.isHidden,
      depth: depthOf.get(r.id),
      pathEnd: r.id,
      pathLen: depthOf.get(r.id)! + 1,
    });
    if (o.withProps || !n.propertiesPending) {
      expect(n.propertiesPending, r.id).toBe(false);
      const kv = r.props.find((x) => x.kind === 'keyValue' && x.title === 'PROPERTIES');
      const row = (k: string) => kv?.rows.find((x) => x.key === k)?.text || null;
      expect(
        {
          locked: n.isLocked,
          ref: n.referenceType,
          scope: n.scope,
          canonical: n.canonicalDisplayName,
          found: n.propertiesFound,
        },
        r.id,
      ).toEqual({
        locked: r.isLocked,
        ref: row('Reference Type'),
        scope: row('Scope'),
        canonical: row('Canonical Display Name'),
        found: kv !== undefined,
      });
    }
  }
}

/** Waits for the instance's engine and tree to be idle (inline writes return after their re-read anyway). */
export async function idle(rig: TreeRig): Promise<void> {
  await rig.settle(rig.i.tree.whenIdle());
}
