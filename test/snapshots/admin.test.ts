/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- JSON replies of the admin API in tests */
/**
 * v2 E1a (ADR 0042): the Snapshots page's API (src/admin/routes/snapshots.ts) against the mock: the store's numbers
 * (size, deduplication, free space against the 10 GB minimum, the next full snapshot's estimate), a full snapshot from
 * the dashboard, a page's history and its diff with now, "Propose a restore" (always a proposal; dry run first), the
 * rehearsal's refusals, the daily pass switch and the nightly database copies with their age.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_CSRF_PURPOSE } from '../../src/admin/guard.js';
import { PROJECT, PUBLIC_URL } from '../tools/helpers.js';
import { S, snapshotsWorld, type SnapshotsWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: SnapshotsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- JSON replies

function owner(world: SnapshotsWorld) {
  const s = world.stack.services;
  const session = s.owner.createSession('127.0.0.1', 'vitest');
  // ADR 0062: the owner has stepped up (every settings change asks for it within 10 minutes).
  s.store.setReauth(s.sessionHash(session), Math.floor(Date.now() / 1000));
  const cookie = `${s.owner.sessionCookie}=${session}`;
  const csrf = s.owner.csrfToken(session, ADMIN_CSRF_PURPOSE);
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${world.stack.base}/api/admin${path}`, {
      method,
      headers: {
        cookie,
        origin: PUBLIC_URL,
        ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Json };
  };
  return {
    get: (path: string) => request('GET', path),
    post: (path: string, body: unknown = {}) => request('POST', path, body),
    put: (path: string, body: unknown = {}) => request('PUT', path, body),
  };
}

const audits = (action: string) =>
  w!.stack.db.prepare('SELECT target, after FROM audit_log WHERE action = ? ORDER BY id').all(action) as {
    target: string;
    after: string;
  }[];

describe('the Snapshots page API', () => {
  it('shows the store against the disk, takes a full snapshot from the dashboard, and lists it', async () => {
    w = await snapshotsWorld();
    const o = owner(w);
    const before = await o.get('/snapshots?project=test');
    expect(before.status).toBe(200);
    // The world keeps no minimum (a test machine's disk); the bridge's default is 10 GB (test/config).
    const min = w.stack.runtime.snapshots.o.settings.minFreeBytes;
    expect(before.json.overview).toMatchObject({ minFreeBytes: min, exists: expect.any(Boolean) });
    expect(before.json.overview.disk.free).toBeGreaterThan(0);
    expect(before.json.overview.nextFullEstimate).toBeGreaterThan(0);
    expect(before.json.snapshots).toEqual([]);
    expect(before.json.jobs.map((j: Json) => j.id)).toEqual([
      'snapshot-full',
      'snapshot-prune',
      'snapshot-verify',
    ]);
    expect(before.json.jobs[0].scheduleText).toBe('Daily at 00:30 (London time)');

    const started = await o.post('/snapshots/full?project=test');
    expect(started.status).toBe(202);
    expect(started.json.run).toMatchObject({ kind: 'full', trigger: 'manual' });
    await w.stack.runtime.snapshots.settled();
    // The run continues in the background: wait for it to end.
    for (let i = 0; i < 200 && w.stack.runtime.snapshots.index.runningRun(PROJECT, 'full'); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(audits('snapshots.full')).toHaveLength(1);

    const after = await o.get('/snapshots?project=test');
    expect(after.json.snapshots).toHaveLength(1);
    expect(after.json.snapshots[0]).toMatchObject({ kind: 'full', state: 'complete' });
    const ov = after.json.overview;
    expect(ov.store.bytes).toBeGreaterThan(0);
    expect(ov.dedupRatio).toBeGreaterThanOrEqual(1);
    expect(ov.runs[0]).toMatchObject({ state: 'succeeded', kind: 'full' });
    expect(ov.headroom).toBe(ov.disk.free - min);
  });

  it('a page’s history, its diff with now, and a restore from the dashboard (dry run first, then confirmed)', async () => {
    w = await snapshotsWorld();
    const o = owner(w);
    await w.stack.runtime.snapshots.full(PROJECT, 'test');
    const pages = await o.get('/snapshots/pages?project=test&q=Atlas');
    expect(pages.json.pages).toEqual([
      expect.objectContaining({ pageId: S.atlas, name: '[BSRC] Atlas of Snapshots', deleted: false }),
    ]);
    const hist = await o.get(`/snapshots/pages/${S.atlas}?project=test`);
    expect(hist.status).toBe(200);
    expect(hist.json.page).toMatchObject({ id: S.atlas, live: true });
    expect(hist.json.history.count).toBe(1);
    expect(hist.json.documents.map((d: Json) => d.name)).toEqual(
      expect.arrayContaining(['Main', 'Map', 'Chronicle', 'Plot', 'Notes']),
    );
    const snap = hist.json.history.snapshots[0].snapshot as string;

    // The page changes in the app (the mock's model): the diff with now shows it.
    const main = w.repo.blocks.get(w.d.main)!;
    const blocks = structuredClone(main.blocks) as Json[];
    blocks.find((b) => b.id === 'ap2')!.content = [{ text: 'Notes rewritten in the app.' }];
    w.repo.blocks.set(w.d.main, { ...main, version: main.version + 1, blocks });
    const diff = await o.get(
      `/snapshots/diff?project=test&page=${S.atlas}&piece=document&ref=${w.d.main}&from=${snap}`,
    );
    expect(diff.status).toBe(200);
    expect(diff.json.identical).toBe(false);
    expect(diff.json.text).toContain('-First notes.');
    expect(diff.json.text).toContain('+Notes rewritten in the app.');
    expect(diff.json.reads).toBe(2); // the resource and the document's blocks

    const dry = await o.post('/snapshots/restore?project=test', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: w.d.main,
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    expect(dry.json.status).toBe('dry_run');
    expect(dry.json.plan.pieces[0].diff).toContain('+First notes.');
    expect(w.repo.blocks.get(w.d.main)!.version).toBe(main.version + 1); // nothing written

    // v3 F12 (ADR 0081): the owner's restore needs the dialog's confirmation, then runs at once as one job.
    const unconfirmed = await o.post('/snapshots/restore?project=test', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: w.d.main,
    });
    expect(unconfirmed.status).toBe(400);
    expect(w.repo.blocks.get(w.d.main)!.version).toBe(main.version + 1); // nothing written
    const confirmed = await o.post('/snapshots/restore?project=test', {
      page: S.atlas,
      snapshot: snap,
      scope: 'document',
      document: w.d.main,
      confirm: true,
    });
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
    expect(confirmed.json).toMatchObject({ status: 'submitted', jobId: expect.stringMatching(/^j/) });
    const jobId = String(confirmed.json.jobId);
    expect((await w.stack.runtime.engine.wait(PROJECT, jobId, 30_000)).status).toBe('succeeded');
    expect(JSON.stringify(w.repo.blocks.get(w.d.main)!.blocks)).toContain('First notes.');
    expect(audits('snapshots.restore')[0]!.target).toBe(jobId);
    const listed = await o.get('/snapshots?project=test');
    expect(listed.json.restores[0]).toMatchObject({
      id: confirmed.json.restoreId,
      jobId,
      state: 'executed',
      scope: 'document',
      requestedBy: 'owner',
    });
  });

  it('refuses what it should, with a code', async () => {
    w = await snapshotsWorld();
    const o = owner(w);
    const r = await w.stack.runtime.snapshots.full(PROJECT, 'test');
    // A rehearsal never goes into the project the snapshot came from.
    const same = await o.post('/snapshots/rehearsals/plan', {
      target: 'test',
      snapshot: r.snapshotId,
      mode: 'sampled',
    });
    expect(same.status).toBe(409);
    expect(same.json.error.code).toBe('REHEARSAL_SAME_PROJECT');
    // Start needs the confirmation.
    const unconfirmed = await o.post('/snapshots/rehearsals', {
      target: 'test',
      snapshot: r.snapshotId,
      mode: 'sampled',
    });
    expect(unconfirmed.status).toBe(400);
    // A restore to a snapshot that does not exist.
    const missing = await o.post('/snapshots/restore?project=test', {
      page: S.atlas,
      snapshot: '20200101T000000Z-full-abc',
      scope: 'page',
      dryRun: true,
    });
    expect(missing.status).toBe(409);
    expect(missing.json.error.code).toBe('SNAPSHOT_NOT_FOUND');
    // A bad id is a 400, not a 500.
    expect((await o.get('/snapshots/pages/NOT-AN-ID?project=test')).status).toBe(400);
    expect((await o.post('/snapshots/runs/run_0000000000000000/abandon', { confirm: true })).status).toBe(
      409,
    );
  });

  it('has no daily-pass setting any more (the two keys are refused), and lists the nightly database copies', async () => {
    w = await snapshotsWorld();
    const o = owner(w);
    for (const key of ['snapshotDailyPass', 'snapshotDailyPassDocuments'])
      expect((await o.put('/projects/test/settings', { key, value: true })).status).toBe(400);
    const ov = (await o.get('/snapshots?project=test')).json.overview;
    expect(ov.dailyPass).toBeUndefined();
    expect(ov.retention).toEqual({ keepFullDays: 30, keepWeekly: 8, keepDays: 30, softDeleteDays: 30 });

    const dir = join(dirname(w.stack.dbPath), 'backups');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'nightly-20261110T023000Z.db.gz'), Buffer.alloc(100));
    writeFileSync(join(dir, 'nightly-20261111T023000Z.db.gz'), Buffer.alloc(200));
    writeFileSync(join(dir, 'pre-deploy-20261111T120000Z.db.gz'), Buffer.alloc(50));
    writeFileSync(join(dir, 'notes.txt'), 'not a copy');
    const b = (await o.get('/snapshots?project=test')).json.backups;
    expect(b.dir).toBe(dir);
    expect(b.files.map((f: Json) => [f.label, f.size])).toEqual([
      ['pre-deploy', 50],
      ['nightly', 200],
      ['nightly', 100],
    ]);
    expect(b.files[1].at).toBe(Date.parse('2026-11-11T02:30:00Z'));
  });
});
