/**
 * v3 F3.4 (ADR 0055 decision G): the write-scope rehearsal (test/sandbox/write-scope.ts) run as a dry run against the
 * mock, never a real LegendKeeper, the way the script runs it: its own runtime on a temporary database (createSoakRuntime
 * against the mock), the project's settings, repository tree and pack copied READ-ONLY from "the bridge's" database (the
 * mock world's), then every step. One mock world serves every step: the pack world (pages, sidebars, the asset library
 * and the Arkona pack, approved) with the chronology added. Every step must PASS, and nothing the run made is left
 * behind. The copy refuses a project not marked as a sandbox in the bridge's database.
 */
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectStore } from '../../src/projects/index.js';
import { chronologyWorld, type ChronologyWorld } from '../chronology/world.js';
import { packWorld } from '../packs/world.js';
import { SandboxGuardError } from '../sandbox/smoke.js';
import { createSoakRuntime, type SoakRuntime } from '../sandbox/soak.js';
import {
  copyBridgeState,
  formatRehearsalReport,
  runWriteScopeRehearsal,
  type RehearsalReport,
} from '../sandbox/write-scope.js';
import type { ImagesWorld } from '../images/world.js';
import { API_KEY, PROJECT } from '../tools/helpers.js';

const LIMITS = { 'key-min': 5000, 'write-min': 2000 } as const;
let w: ChronologyWorld & ImagesWorld;
let soak: SoakRuntime | undefined;

beforeAll(async () => {
  w = (await chronologyWorld({
    base: (o) => packWorld({ ...o, toolModes: 'seed' }),
    env: { LK_TIER_LIMITS: JSON.stringify(LIMITS) },
    limits: LIMITS,
  })) as ChronologyWorld & ImagesWorld;
  // The rehearsal makes its pages as it runs: the mock models their sidebars from their first property request.
  w.sidebars.adoptNewPages = (id) => w.repo.live(id) !== undefined;
}, 120_000);
afterAll(async () => {
  await soak?.close();
  await w?.close();
});

/** The temporary runtime's own log lines (kept out of the test output). */
const quiet = new Writable({
  write(_chunk: Buffer, _enc, done) {
    done();
  },
});

async function temporaryRuntime(): Promise<SoakRuntime> {
  soak = await createSoakRuntime({
    logStream: quiet,
    apiKey: API_KEY,
    project: 'test',
    baseUrl: w.stack.mock.url,
    env: { WRITE_SPACING_MS: '0', WRITE_SPACING_STRETCHED_MS: '0', LK_TIER_LIMITS: JSON.stringify(LIMITS) },
    uploadGuard: w.guard,
    images: { assetHosts: ['assets.test'], stagingMinFreeBytes: 0 },
  });
  return soak;
}

describe('the write-scope rehearsal (dry run against the mock)', () => {
  it('refuses to copy the state of a project that is not marked as a sandbox in the bridge’s database', async () => {
    const rt = await temporaryRuntime();
    expect(() =>
      copyBridgeState({
        bridgeDbPath: w.stack.dbPath,
        target: rt.db,
        projectId: rt.projectId,
        runtime: rt.runtime,
      }),
    ).toThrow(SandboxGuardError);
    await rt.close();
    soak = undefined;
  });

  it('passes every step, and leaves nothing behind', async () => {
    new ProjectStore(w.stack.db).setSandbox(PROJECT, true);
    const rt = await temporaryRuntime();
    const copied = copyBridgeState({
      bridgeDbPath: w.stack.dbPath,
      target: rt.db,
      projectId: rt.projectId,
      runtime: rt.runtime,
    });
    expect(copied.settings).toEqual(expect.arrayContaining(['aiRepositoryRootId', 'chronology']));
    expect(copied.treeNodes).toBeGreaterThan(10);
    expect(copied.packs).toEqual(['arkona']);
    // ADR 0064 amendment 2: the calendars the bridge keeps are copied too, so the copied chronology settings find their
    // calendar (the owner's narrative-f4c run failed at N3 without them).
    const kept = (
      w.stack.db
        .prepare('SELECT COUNT(*) AS n FROM chronology_calendars WHERE project_id = ?')
        .get(PROJECT) as {
        n: number;
      }
    ).n;
    expect(kept).toBeGreaterThan(0);
    expect(copied.calendars).toBe(kept);
    expect(rt.runtime.chronology.calendar(rt.projectId)).not.toBeNull();
    const countBefore = w.count('Fourth Arkonan Age');
    const lines: string[] = [];
    const report: RehearsalReport = await runWriteScopeRehearsal(
      { runtime: rt.runtime, db: rt.db, projectId: rt.projectId, projectName: 'test', counters: rt.counters },
      { wait: { waitMs: 5_000, maxWaits: 30 }, log: (l) => lines.push(l) },
    );
    const text = formatRehearsalReport(report, rt.counters);
    process.stdout.write(text);
    const byId = Object.fromEntries(report.findings.map((f) => [f.id, f]));
    for (const id of [
      'setup',
      'setup-chronology',
      '1',
      '2',
      '3',
      '4',
      '5',
      'review',
      'R1',
      'R2',
      'R3',
      'R4',
      'rail-delete',
      'rail-bulk',
      'cleanup',
    ]) {
      expect(byId[id], id).toBeDefined();
      expect(byId[id]!.verdict, `${id}: ${byId[id]!.detail}`).toBe('pass');
    }
    expect(report.passed).toBe(true);
    expect(byId['rail-bulk']!.detail).toContain('proposed because: bulk change (11 pages > 10)');
    expect(byId['5']!.detail).toContain('arkona_create_character: always propose');
    expect(byId['5']!.detail).toContain('arkona_add_character_art: follows scope');
    // Nothing of the run is left: no page, no asset or folder, no chronology row or event; the count is as it was.
    const left = [...w.repo.res.values()].filter(
      (r) => String(r.name).startsWith('lk-bridge write-scope') && r.deletedAt === null,
    );
    expect(left).toEqual([]);
    const assets = [...w.assets.assets.values()].filter((a) => a.name.startsWith('lk-bridge write-scope'));
    expect(assets).toEqual([]);
    expect(w.rows('Fourth Arkonan Age').some((r) => r.includes('lk-bridge write-scope rehearsal'))).toBe(
      false,
    );
    expect(w.count('Fourth Arkonan Age')).toBe(countBefore);
    // R4's re-staged copy was discarded from the Staging page.
    expect(
      rt.runtime.images.store.staged(rt.projectId).filter((r) => r.name.startsWith('lk-bridge write-scope')),
    ).toEqual([]);
    // Nothing waits for the owner either: every proposal the run made was rejected.
    const pending = rt.runtime.policy.proposals.list({ project: rt.projectId, state: 'pending' });
    expect(pending).toEqual([]);
  }, 300_000);
});
