/**
 * v3 F5c (ADR 0069, H6 to H8) with CR-2026-11-R3's memory rule: repeated identity reconciles (a dry run and a real run
 * each time), `query_facts` over every character and workstream reports come back to their baseline: nothing a call
 * makes is kept beyond its records.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identityWorld, type IdentityWorld } from './identity-world.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const heapMb = async (): Promise<number> => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 20));
    gc();
  }
  return process.memoryUsage().heapUsed / 1048576;
};

let w: IdentityWorld;
beforeAll(async () => {
  w = await identityWorld();
  await w.snapshot();
});
afterAll(async () => w?.close());

describe('memory', () => {
  it('repeated reconciles, queries and reports return to their baseline', async () => {
    const round = async (i: number) => {
      const life = i % 2 === 0 ? 'Alive' : 'Resting';
      const items = [
        { character: 'Arin al-Jamail', facts: { 'Life State': life } },
        { character: 'Daryan Sefet', facts: { 'Life State': life } },
        { character: 'Khepri Nadu', facts: { 'Life State': life } },
      ];
      const dry = await w.call('arkona_identity_reconcile', {
        project: 'test',
        items,
        dryRun: true,
        workstream: 'mem',
      });
      expect(dry.isError, dry.text).toBe(false);
      const run = await w.call('arkona_identity_reconcile', { project: 'test', items, workstream: 'mem' });
      expect(run.isError, run.text).toBe(false);
      const q = await w.callRead('query_facts', {
        project: 'test',
        characters: true,
        fields: ['id', 'name', 'Race / Species', 'Naming Culture', 'Life State', 'tags', 'parent'],
        limit: 500,
      });
      expect(q.isError, q.text).toBe(false);
      const rep = await w.callRead('bridge_workstream_report', { project: 'test', workstream: 'mem' });
      expect(rep.isError, rep.text).toBe(false);
    };
    for (let i = 0; i < 2; i++) await round(i);
    const base = await heapMb();
    for (let i = 2; i < 10; i++) await round(i);
    const after = await heapMb();
    console.info(
      `[F5c] reconciles, queries, reports: heap ${base.toFixed(1)} MB after 2 rounds, ${after.toFixed(1)} MB after 10`,
    );
    expect(after - base).toBeLessThan(8);
  });
});
