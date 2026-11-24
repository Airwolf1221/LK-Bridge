/**
 * v3 F9 (ADR 0074): the full snapshot is bulk (P4) and the routine work beside it is not.
 *
 * - the full snapshot (pages, documents, the library, the templates) asks for P4 only, in its own lane;
 * - a change snapshot after a bridge write is taken at the job's class (P1 or P2), never P4;
 * - integration (mock LegendKeeper): a full snapshot running while a change snapshot (an agent's write) and an
 *   automation-style fix (a P3 job as the system principal) arrive: the routine work finishes before the snapshot
 *   does, and the snapshot still finishes, complete.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_PRINCIPAL } from '../../src/jobs/index.js';
import { FULL_SNAPSHOT_PRIORITY } from '../../src/snapshots/service.js';
import { S, snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';
import { PROJECT } from '../tools/helpers.js';
import { recordClasses } from './priority-spy.js';

vi.setConfig({ testTimeout: 90_000 });

let w: SnapshotsWorld | undefined;
let c: Client | undefined;
afterEach(async () => {
  await c?.close();
  c = undefined;
  await w?.close();
  w = undefined;
});

const governorOf = (world: SnapshotsWorld) => world.stack.runtime.projects.client(PROJECT)!.governor;

describe('the full snapshot asks for P4 (bulk)', () => {
  it('every read of a full run is P4, in the run’s own lane', async () => {
    w = await snapshotsWorld();
    expect(FULL_SNAPSHOT_PRIORITY).toBe('P4');
    const spy = recordClasses(governorOf(w));
    const r = await w.stack.runtime.snapshots.full(PROJECT, 'manual');
    expect(r.changed, r.summary).toBe(true);
    const reads = spy.seen.filter((s) => s.opId !== 'snapshot.image');
    expect(reads.length).toBeGreaterThan(50);
    expect([...new Set(reads.map((s) => s.priority))]).toEqual(['P4']);
    expect([...new Set(reads.map((s) => s.jobId))]).toEqual([`snapshot:${r.runId!}`]);
    // First claim within P4 (the owner's review): every read of the run has it.
    expect(reads.every((s) => s.firstClaim)).toBe(true);
    // Its image downloads (the asset host, no request budget) are queued at the same class.
    expect(spy.classes('snapshot.image')).toEqual(
      spy.seen.some((s) => s.opId === 'snapshot.image') ? ['P4'] : [],
    );
    spy.restore();
  });

  it('a change snapshot after a bridge write is routine: the job’s class, never P4', async () => {
    w = await snapshotsWorld();
    c = await w.stack.connect();
    const spy = recordClasses(governorOf(w));
    const r = await w.stack.call(c, 'write_page', {
      project: 'test',
      page: S.atlas,
      mode: 'append',
      markdown: 'Appended by the F9 test.',
    });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    await w.stack.runtime.snapshots.settled();
    expect(w.stack.runtime.snapshots.index.snapshots(PROJECT, { kind: 'change', limit: 5 }).length).toBe(1);
    expect(spy.classes()).not.toContain('P4');
    spy.restore();
  });
});

describe('integration: routine work beside a running full snapshot', () => {
  it('a change snapshot and an automation fix finish before the snapshot does; the snapshot still completes', async () => {
    w = await snapshotsWorld();
    c = await w.stack.connect();
    const world = w;
    const client = c;
    const rt = world.stack.runtime;
    const spy = recordClasses(governorOf(world));
    const done: Record<string, number> = {};
    const pending: { routine: Promise<unknown> | null } = { routine: null };
    // Once the snapshot is two pages in, the routine work arrives.
    let pages = 0;
    (rt.snapshots.o as { afterPage?: unknown }).afterPage = () => {
      pages++;
      if (pages !== 2) return;
      const agentWrite = world.stack
        .call(client, 'write_page', {
          project: 'test',
          page: S.atlas,
          mode: 'append',
          markdown: 'Mid-snapshot.',
        })
        .then(async (r) => {
          expect(r.isError, JSON.stringify(r.body)).toBe(false);
          await rt.snapshots.settled();
          done.change = Date.now();
        });
      // An automation-style fix: a P3 job of the system principal (as the automation engine's fixes are).
      const fix = rt.engine
        .run(
          'getResource',
          { path: { resourceId: S.harbour } },
          {
            project: PROJECT,
            origin: {
              kind: 'maintenance',
              client: 'maintenance',
              tool: 'automation-run',
              detail: 'F9 test',
              principal: SYSTEM_PRINCIPAL,
            },
            priority: 'P3',
            title: 'Automation: F9 test fix',
          },
        )
        .then(() => {
          done.fix = Date.now();
        });
      pending.routine = Promise.all([agentWrite, fix]);
    };
    const full = await rt.snapshots.full(PROJECT, 'manual');
    done.full = Date.now();
    (rt.snapshots.o as { afterPage?: unknown }).afterPage = undefined;
    expect(pending.routine).not.toBeNull();
    await pending.routine;
    expect(full.changed, full.summary).toBe(true);
    const m = (await rt.snapshots.manifest(full.snapshotId!))!;
    expect(m.complete).toBe(true);
    expect(m.pages.length).toBe(world.repo.subtree('airepo01').length);
    // The routine work was not held behind the bulk pass.
    expect(done.change).toBeLessThanOrEqual(done.full);
    expect(done.fix).toBeLessThanOrEqual(done.full);
    // The classes used: the snapshot's reads P4; the fix P3; the agent's write and its change snapshot P1 or P2.
    const classes = new Set(spy.seen.map((s) => s.priority));
    expect(classes.has('P4')).toBe(true);
    expect(classes.has('P3')).toBe(true);
    expect(spy.seen.filter((s) => s.jobId?.startsWith('snapshot:')).every((s) => s.priority === 'P4')).toBe(
      true,
    );
    spy.restore();
  });
});
