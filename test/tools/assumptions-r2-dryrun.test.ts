/**
 * Round 2 of the sandbox assumptions (test/sandbox/assumptions-r2.ts, W1–W12) run as a dry run against the mock, never a
 * real LegendKeeper, the way the opt-in test runs it: its own runtime on a temporary database (createSoakRuntime: no
 * repository or asset tree, the requests counted at the transport), against the mock of the D3 image world
 * (test/images/world.ts): the asset library model (test/assets/model.ts: listings per folder, paged; updateAsset partial;
 * a folder delete takes everything inside it), the signed-URL storage host and the asset host (a stored file downloads
 * as the bytes PUT), the resources and blocks model (test/tree/model.ts: replaceDocumentBlocks, and insertBlock,
 * getBlock, replaceBlock, updateBlock and deleteBlock at any depth with If-Match), and the discover world's calendar.
 *
 * What that mock does not model, and this file adds as the spec describes it (each switchable, below):
 * - moveBlock (the blocks model has none; the chronology world's has it for its own documents only);
 * - the lanes and events of a NEW timeline document (the worlds model only their own timelines): listEvents ordered by
 *   start, then id, and paged by an opaque cursor.
 *
 * It checks that the script refuses another project (SandboxGuardError, nothing written), runs every check to an
 * answer, and deletes everything it made (no new asset, no live page), in two runs:
 * 1. LegendKeeper as the spec describes it: every check PASSes but W4, NOTED (informational: a folder delete takes its
 *    sub-folder). Where the mock is not LegendKeeper: W2 notes that getAsset answers no version and no ETag and that a
 *    made-up If-Match is ignored (the mock ignores the header); W5 notes that the deleted image's old file URL still
 *    answers (the mock's asset host keeps serving it); W6 notes the root's children only (the asset model's listing).
 *    The cost printed is the run's, as the sandbox runtime counts it (the header of assumptions-r2.ts).
 * 2. LegendKeeper answering otherwise, so the checks are seen to fail where they must and still clean up: a made-up
 *    If-Match on updateAsset refused 412 (W2 NOTED), a non-empty folder's delete refused 409 (W4 NOTED, its sub-folder
 *    deleted first), no moveBlock (the mock's generic 201: W8 FAIL), getBlock without a version (W10 FAIL; W11 then
 *    sends the document's version and PASSes), no lanes for a new timeline (W12 INCONCLUSIVE).
 */
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockResponse } from '../contract/mock-lk.js';
import { imagesWorld, type ImagesWorld } from '../images/world.js';
import { formatAssumptionsR2Report, runAssumptionsR2 } from '../sandbox/assumptions-r2.js';
import { SandboxGuardError, type Finding, type SmokeTarget } from '../sandbox/smoke.js';
import { createSoakRuntime, type SoakRuntime } from '../sandbox/soak.js';
import { API_KEY } from './helpers.js';

type Obj = Record<string, unknown>;

const LIMITS = { 'key-min': 5000, 'write-min': 2000 } as const;
const IDS = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12'];

/** How the mock answers where LegendKeeper's behaviour is in question (default: as the spec describes it). */
const lk = {
  moveBlock: true,
  timelines: true,
  assetIfMatch: 'ignored' as 'ignored' | '412',
  folderDelete: 'cascade' as 'cascade' | 'refuse-non-empty',
  blockVersion: true,
};

let w: ImagesWorld;
let rt: SoakRuntime;

/** The temporary runtime's own log lines (kept out of the test output). */
const quiet = new Writable({
  write(_chunk: Buffer, _enc, done) {
    done();
  },
});

const err = (status: number, code: string): MockResponse => ({
  status,
  body: { message: `model ${code}`, code, requestId: `r2-${code}` },
});

function locate(list: unknown, id: string): { list: Obj[]; at: number; block: Obj } | null {
  const l = Array.isArray(list) ? (list as Obj[]) : [];
  for (let i = 0; i < l.length; i++) {
    if (l[i]!.id === id) return { list: l, at: i, block: l[i]! };
    const hit = locate(l[i]!.children, id);
    if (hit) return hit;
  }
  return null;
}

/** moveBlock, the lanes and events of a new timeline, and the switchable answers of run 2 (see the header). */
function modelWhatIsMissing(world: ImagesWorld): void {
  const seeded = new Set(world.repo.docs.keys());
  const liveDoc = (rid: string, did: string) => {
    const doc = world.repo.docs.get(did);
    return world.repo.live(rid) && doc && doc.resourceId === rid && doc.deletedAt === null ? doc : null;
  };

  // moveBlock (spec: exactly one of after, before, parent; the block keeps its subtree and ids; a block into itself
  // answers 400 INVALID_CONTENT; the document's version in the body and as the ETag).
  const move = /\/resources\/([^/]+)\/docs\/([^/]+)\/blocks\/([^/]+)\/move$/;
  world.overrides.set(move, (req) => {
    if (req.method !== 'POST' || !lk.moveBlock) return undefined;
    const [, rid, did, bid] = move.exec(req.path.replace(/\/$/, '')) as unknown as [
      string,
      string,
      string,
      string,
    ];
    const b = liveDoc(rid, did) ? world.repo.blocks.get(did) : undefined;
    if (!b) return err(404, 'NOT_FOUND');
    const ifMatch = req.headers['if-match'];
    if (ifMatch !== undefined && ifMatch !== `v${b.version}`) return err(412, 'VERSION_MISMATCH');
    const hit = locate(b.blocks, bid);
    if (!hit) return err(404, 'NOT_FOUND');
    const body = (req.body ?? {}) as Obj;
    const how = (['after', 'before', 'parent'] as const).filter((k) => typeof body[k] === 'string');
    if (how.length !== 1) return err(400, 'VALIDATION_ERROR');
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
    return {
      status: 200,
      body: { ...structuredClone(hit.block), version: `v${b.version}` },
      headers: { etag: `"v${b.version}"` },
    };
  });

  // getBlock with no version in its body (run 2 only).
  const oneBlock = /\/resources\/[^/]+\/docs\/[^/]+\/blocks\/[^/]+$/;
  world.overrides.set(oneBlock, (req) => {
    if (req.method !== 'GET' || lk.blockVersion) return undefined;
    const r = world.repo.respond(req);
    if (!r || r.status !== 200) return r;
    const { version: _dropped, ...rest } = r.body as Obj;
    return { status: 200, body: rest };
  });

  // The lanes and events of a timeline document made by the run (spec: listEvents ordered by start, then id, so events
  // sharing a start keep a stable order across pages; `nextCursor` passed back as `cursor`).
  const lanes = new Map<string, Obj[]>();
  const events = new Map<string, Obj[]>();
  const timeline = /\/resources\/([^/]+)\/docs\/([^/]+)\/(lanes|events)(?:\/([^/]+))?$/;
  world.overrides.set(timeline, (req) => {
    if (!lk.timelines) return undefined;
    const [, rid, did, what, sub] = timeline.exec(req.path.replace(/\/$/, '')) as unknown as [
      string,
      string,
      string,
      'lanes' | 'events',
      string | undefined,
    ];
    if (seeded.has(did)) return undefined; // the world's own timelines answer as before
    const doc = liveDoc(rid, did);
    if (!doc) return err(404, 'NOT_FOUND');
    if (doc.type !== 'time') return err(400, 'KIND_MISMATCH');
    const ls = lanes.get(did) ?? [];
    lanes.set(did, ls);
    const es = events.get(did) ?? [];
    events.set(did, es);
    const body = (req.body ?? {}) as Obj;
    const list = what === 'lanes' ? ls : es;
    if (sub !== undefined) {
      const one = list.find((x) => x.id === sub);
      if (req.method === 'GET')
        return one ? { status: 200, body: structuredClone(one) } : err(404, 'NOT_FOUND');
      return undefined;
    }
    if (req.method === 'POST') {
      if (typeof body.id !== 'string') return err(400, 'VALIDATION_ERROR');
      if (list.some((x) => x.id === body.id)) return err(409, 'DUPLICATE_ID');
      if (what === 'events' && !ls.some((l) => l.id === body.laneId)) return err(400, 'VALIDATION_ERROR');
      const made = {
        ...structuredClone(body),
        ...(what === 'events' ? { rank: `a${es.length}`, startDate: {} } : {}),
      };
      list.push(made);
      return { status: 201, body: structuredClone(made) };
    }
    if (req.method !== 'GET') return undefined;
    if (what === 'lanes')
      return { status: 200, body: { data: structuredClone(ls), hasMore: false, nextCursor: null } };
    const limit = Number(req.query.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return err(400, 'VALIDATION_ERROR');
    const key = (e: Obj): [number, string] => [Number(e.start), String(e.id)];
    const cmp = (a: [number, string], b: [number, string]) =>
      a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    let from = [...es].sort((a, b) => cmp(key(a), key(b)));
    if (req.query.cursor !== undefined) {
      const c = /^ev:(-?\d+(?:\.\d+)?):(.+)$/.exec(req.query.cursor);
      if (!c) return err(400, 'VALIDATION_ERROR');
      const after: [number, string] = [Number(c[1]), c[2]!];
      from = from.filter((e) => cmp(key(e), after) > 0);
    }
    const page = from.slice(0, limit);
    const more = from.length > limit;
    const last = page[page.length - 1];
    return {
      status: 200,
      body: {
        data: structuredClone(page),
        hasMore: more,
        nextCursor: more && last ? `ev:${String(last.start)}:${String(last.id)}` : null,
      },
    };
  });

  // updateAsset with an If-Match refused (run 2), and a folder that is not empty refused a delete (run 2).
  const asset = /\/assets\/([^/]+)$/;
  world.overrides.set(asset, (req) => {
    const id = asset.exec(req.path.replace(/\/$/, ''))![1]!;
    if (id === 'uploads' || id === 'images') return undefined;
    if (req.method === 'PATCH' && lk.assetIfMatch === '412' && req.headers['if-match'] !== undefined)
      return err(412, 'VERSION_MISMATCH');
    if (req.method === 'DELETE' && lk.folderDelete === 'refuse-non-empty') {
      const a = world.assets.assets.get(id);
      if (a?.type === 'FOLDER' && world.assets.inside(id).length > 0) return err(409, 'CONFLICT');
    }
    return undefined;
  });
}

beforeAll(async () => {
  w = await imagesWorld({ bulk: 6, env: { LK_TIER_LIMITS: JSON.stringify(LIMITS) }, limits: LIMITS });
  modelWhatIsMissing(w);
  // The sandbox test's own runtime, against the mock (the write-scope rehearsal's dry run does the same).
  rt = await createSoakRuntime({
    logStream: quiet,
    apiKey: API_KEY,
    project: 'test',
    baseUrl: w.stack.mock.url,
    env: { WRITE_SPACING_MS: '0', WRITE_SPACING_STRETCHED_MS: '0', LK_TIER_LIMITS: JSON.stringify(LIMITS) },
    uploadGuard: w.guard,
    images: { assetHosts: ['assets.test'] },
  });
}, 120_000);
afterAll(async () => {
  await rt?.close();
  await w?.close();
});

const target = (): SmokeTarget => ({
  engine: rt.runtime.engine,
  lk: rt.lk,
  projectId: rt.projectId,
  baseUrl: w.stack.mock.url,
  apiKey: API_KEY,
});

/** Runs the script; returns its findings by id and what it cost, and checks it left nothing behind. */
async function dryRun(): Promise<{
  by: Record<string, Finding>;
  report: string;
  cost: string;
  writes: number;
  reads: number;
  downloads: number;
}> {
  const assetsBefore = new Set(w.assets.assets.keys());
  const resourcesBefore = new Set(w.repo.res.keys());
  const before = { reads: rt.counters.reads, writes: rt.counters.writes };
  const tally = { downloads: 0, puts: 0 };
  const findings = await runAssumptionsR2(target(), rt.projectId, {
    assetHosts: rt.runtime.images.settings.images.assetHosts,
    tally,
    sleep: async () => {},
  });
  const reads = rt.counters.reads - before.reads;
  const writes = rt.counters.writes - before.writes;
  const report = formatAssumptionsR2Report(findings);
  const cost = `requests against the mock: ${reads} reads, ${writes} writes (counted at the transport); ${tally.downloads} downloads from the asset host and ${tally.puts} PUT to the upload host`;
  process.stdout.write(`${report}${cost}\n`);
  const by = Object.fromEntries(findings.map((f) => [f.id, f]));
  // Every check ran to an answer, in the order of the ids, and the clean-up last.
  expect(
    findings.map((f) => f.id),
    report,
  ).toEqual([...IDS, 'cleanup']);
  expect(by.cleanup!.verdict, report).toBe('pass');
  // Nothing the run made is left: no asset it made, no live page (the root and both pages deleted).
  const newAssets = [...w.assets.assets.values()].filter((a) => !assetsBefore.has(a.id));
  expect(
    newAssets.map((a) => `${a.type} ${a.name}`),
    report,
  ).toEqual([]);
  const newLive = [...w.repo.res.values()].filter((r) => !resourcesBefore.has(r.id) && r.deletedAt === null);
  expect(
    newLive.map((r) => r.name),
    report,
  ).toEqual([]);
  expect(
    [...w.repo.res.values()].filter((r) => !resourcesBefore.has(r.id)).length,
    'the root and its two pages were made (and deleted)',
  ).toBe(3);
  expect(tally.puts).toBe(1);
  return { by, report, cost, writes, reads, downloads: tally.downloads };
}

describe('sandbox assumptions, round 2 (dry run)', () => {
  it('refuses to run against any project other than the one it was given, and writes nothing', async () => {
    const writes = w.stack.mock.calls.filter((c) => c.method !== 'GET').length;
    const counted = rt.counters.writes;
    await expect(runAssumptionsR2(target(), 'proj_somebody_else')).rejects.toBeInstanceOf(SandboxGuardError);
    expect(w.stack.mock.calls.filter((c) => c.method !== 'GET').length).toBe(writes);
    expect(rt.counters.writes).toBe(counted);
  });

  it('as the spec describes LegendKeeper: every check passes but W4 (noted), and nothing is left', async () => {
    const { by, report, writes, reads, downloads } = await dryRun();
    for (const id of IDS.filter((x) => x !== 'W4')) expect(by[id]!.verdict, `${id}\n${report}`).toBe('pass');
    expect(by.W4!.verdict, report).toBe('noted');
    expect(by.W4!.detail).toMatch(/F3 and its sub-folder F4 are both gone/);
    expect(by.W4!.detail).toMatch(/nothing left to delete$/);
    expect(by.W1!.detail).toMatch(/stored as uploaded/);
    expect(by.W1!.detail).toMatch(/the file URL unchanged/);
    expect(by.W2!.detail).toMatch(/getAsset answers no version and no ETag/);
    expect(by.W2!.detail).toMatch(/a made-up If-Match was ignored \(204; the write applied\)/);
    expect(by.W5!.detail).toMatch(/NOTED: the old file URL still answers with the file/);
    expect(by.W6!.detail).toMatch(/NOTED: the root's children only/);
    expect(by.W7!.detail).toMatch(/rows R1, R4, R2, R3/);
    expect(by.W8!.detail).toMatch(/rows R1, R3, R4, R2/);
    expect(by.W8!.detail).toMatch(/a stale If-Match answered 412 VERSION_MISMATCH and changed nothing/);
    expect(by.W9!.detail).toMatch(/deleting R4: a stale If-Match answered 412/);
    expect(by.W9!.detail).toMatch(/rows now R1, R3, R2/);
    expect(by.W10!.detail).toMatch(/the document's/);
    expect(by.W11!.detail).toMatch(/sent with If-Match from getBlock/);
    expect(by.W12!.detail).toMatch(/in start order/);
    // The cost the header of assumptions-r2.ts states for the owner (the sandbox runtime's own count: 33 writes, 56
    // reads, 3 downloads and the PUT on 17 November 2026), with a little room.
    expect(writes).toBeLessThanOrEqual(36);
    expect(reads).toBeLessThanOrEqual(64);
    expect(downloads).toBe(3);
  }, 120_000);

  it('as LegendKeeper might answer otherwise: the checks fail or note it where they must, and still clean up', async () => {
    Object.assign(lk, {
      moveBlock: false,
      timelines: false,
      assetIfMatch: '412',
      folderDelete: 'refuse-non-empty',
      blockVersion: false,
    });
    try {
      const { by, report } = await dryRun();
      expect(by.W2!.verdict, report).toBe('noted');
      expect(by.W2!.detail).toMatch(
        /a made-up If-Match answered 412 VERSION_MISMATCH: LegendKeeper versions assets/,
      );
      expect(by.W4!.verdict, report).toBe('noted');
      expect(by.W4!.detail).toMatch(/answered 409 CONFLICT; F3 is still there and F4 still there/);
      expect(by.W4!.detail).toMatch(/then deleted here: F4, F3$/);
      expect(by.W8!.verdict, report).toBe('fail');
      expect(by.W8!.detail).toMatch(/the rows read R1, R4, R2, R3, not R1, R3, R4, R2/);
      expect(by.W8!.detail).toMatch(/a moveBlock with a stale If-Match answered 201/);
      expect(by.W10!.verdict, report).toBe('fail');
      expect(by.W10!.detail).toMatch(/no version in its body/);
      expect(by.W11!.verdict, report).toBe('pass');
      expect(by.W11!.detail).toMatch(/from the document \(getBlock gave no version\)/);
      expect(by.W12!.verdict, report).toBe('inconclusive');
      for (const id of ['W1', 'W3', 'W5', 'W6', 'W7', 'W9'])
        expect(by[id]!.verdict, `${id}\n${report}`).toBe('pass');
    } finally {
      Object.assign(lk, {
        moveBlock: true,
        timelines: true,
        assetIfMatch: 'ignored',
        folderDelete: 'cascade',
        blockVersion: true,
      });
    }
  }, 120_000);
});
