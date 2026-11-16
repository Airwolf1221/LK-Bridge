/**
 * v2 E5.5 (ADR 0047) on the server: an asset call meets LegendKeeper's own asset tier (20 a minute on the mock), and
 * the Budgets page's data (`GET /api/admin/budgets`) carries the learned limit beside an untouched `write-min`; the
 * bridge logs its first sighting once, naming the project, the op and the figures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSET_ROUTE_TIERS } from '../contract/mock-lk.js';
import { PROJECT, startAdminStack, type AdminStack } from './helpers.js';

let stack: AdminStack;
beforeAll(async () => {
  stack = await startAdminStack({ opTiers: ASSET_ROUTE_TIERS, captureLogs: true });
});
afterAll(async () => {
  await stack.close();
});

describe('learned operation limits on the Budgets page', () => {
  it('GET /budgets lists the assets group’s learned limit, and write-min keeps its 120', async () => {
    const lk = stack.runtime.projects.client(PROJECT)!;
    for (let i = 0; i < 2; i++)
      await lk.call({
        operationId: 'createAssetFolder',
        priority: 'P0',
        idempotencyKey: `lkb.test-folder.${i}.0`,
        run: (sdk, signal) =>
          sdk.request({
            method: 'POST',
            path: `/api/v3/projects/${PROJECT}/assets`,
            body: { name: `f${i}` },
            signal,
          }),
      });
    const r = await stack.get('/api/admin/budgets');
    expect(r.status).toBe(200);
    const snap = (r.json as { snapshot: unknown }).snapshot as {
      tiers: Record<string, { limit: number }>;
      operationTiers: { group: string; ops: string[]; limit: number; windowMs: number; remaining: number }[];
    };
    expect(snap.tiers['write-min']!.limit).toBe(120);
    expect(snap.operationTiers).toEqual([
      expect.objectContaining({
        group: 'assets',
        ops: ['createAssetFolder'],
        limit: 20,
        windowMs: 60_000,
        remaining: 18,
      }),
    ]);
    // Logged once, at the first sighting.
    const lines = stack.logs
      .flatMap((chunk) => chunk.split('\n').filter((l) => l.trim()))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => /matches no documented tier/.test(String(l.msg)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 30, // info
      project: 'test',
      op: 'createAssetFolder',
      group: 'assets',
      limit: 20,
      remaining: 19,
      windowSeconds: 60,
    });
  });
});
