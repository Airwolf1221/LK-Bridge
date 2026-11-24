/**
 * Harness regression (the f7-1-core live run of 23 November 2026): on the server the Arkona pack attached to `test`
 * reads its governance sources from project `arkona`, which a sandbox runtime never registers, so a pack check that
 * leaves the copied sources as they are fails every tag computation with PACK_NOT_CURRENT ("project arkona is not
 * registered"). The owners world keeps its governance in `test`, which hid it; here the bridge's database is made to
 * look like the server's (governance in `arkona`) before the check copies it.
 *
 * - The copy reports the unreachable governance project, and f7-1-core without its opt-in fails at C0 (before any
 *   write), naming the project.
 * - Opted in (the default, as the owner runs it), every item passes on the throwaway governance page, which is deleted.
 * - Every sandbox check that copies the bridge's state and calls a tool that computes a pack's tags must opt in (or
 *   point the governance itself, as identity-f5c, tagging-f5a and automation-f5b do).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatCoreUpgradeReport, runCoreUpgradeCheck } from '../sandbox/f7-1-core.js';
import { copyBridgeState } from '../sandbox/write-scope.js';
import { ownersWorld, type OwnersWorld } from '../packs/owners-world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses } from './harness.js';
import { sandboxOnMockWithHosts } from './hosts.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

describe('a pack check whose governance project is not registered in the sandbox runtime', () => {
  let w: OwnersWorld;
  beforeAll(async () => {
    w = makeFaithful(await ownersWorld());
    // As on the server: the pack attached to `test` reads its governance from project `arkona`.
    const packs = w.stack.runtime.packs;
    packs.store.setGovernance(
      'arkona',
      packs.get('arkona')!.governance.map((g) => ({ ...g, project: 'arkona' })),
    );
  });
  afterAll(async () => {
    await w?.close();
  });

  const on = () => sandboxOnMockWithHosts(w.stack, { uploadGuard: w.guard, assetHosts: ['assets.test'] });
  const probes = () =>
    [...w.repo.res.values()].filter(
      (r) => r.deletedAt === null && /^\[(BWRK|INDEX)\] Probe |^lk-bridge f7\.1 governance /.test(r.name),
    );

  it('the copy names the unreachable project, and f7-1-core without its opt-in fails at C0, before any write', async () => {
    const sb = await on();
    try {
      const copied = copyBridgeState({
        bridgeDbPath: sb.bridgeDbPath,
        target: sb.sb.db,
        projectId: sb.sb.projectId,
        runtime: sb.sb.runtime,
      });
      expect(copied.governanceMissing).toEqual([{ pack: 'arkona', projects: ['arkona'] }]);
      const g = await sb.sb.runtime.packs.governance('arkona');
      expect(g.state).not.toBe('current');
      expect(JSON.stringify(g.sources)).toMatch(/project arkona is not registered/);

      const items = await runCoreUpgradeCheck(sb.sb, sb.raw, 'test', {
        bridgeDbPath: sb.bridgeDbPath,
        wait: { waitMs: 2_000, maxWaits: 30 },
        governance: 'as-copied',
      });
      const report = formatCoreUpgradeReport(items);
      expect(
        items.map((i) => `${i.id} ${i.verdict}`),
        report,
      ).toEqual(['C0 fail', 'cleanup pass']);
      expect(items[0]!.detail, report).toMatch(/PACK_NOT_CURRENT.*project arkona/);
      expect(probes(), report).toEqual([]);
    } finally {
      await sb.close();
    }
  });

  it('opted in (the owner’s run): every item passes on a throwaway governance page, which is then deleted', async () => {
    const sb = await on();
    try {
      const items = await runCoreUpgradeCheck(sb.sb, sb.raw, 'test', {
        bridgeDbPath: sb.bridgeDbPath,
        wait: { waitMs: 2_000, maxWaits: 30 },
      });
      const report = formatCoreUpgradeReport(items);
      expectEveryItemPasses(items, report);
      expect(
        items.map((i) => `${i.id} ${i.verdict}`),
        report,
      ).toEqual(['C0 pass', 'C1 pass', 'C2 pass', 'C3 pass', 'cleanup pass']);
      expect(items[0]!.detail, report).toMatch(
        /read from arkona, not registered here\) pointed at the throwaway page/,
      );
      expect(probes(), report).toEqual([]);
      // The bridge's own database is untouched: its pack still reads `arkona`.
      expect(w.stack.runtime.packs.get('arkona')!.governance.every((g) => g.project === 'arkona')).toBe(true);
    } finally {
      await sb.close();
    }
  });
});

describe('every sandbox check that computes a pack’s tags opts in to its governance', () => {
  /** Tools that read the pack's governance and refuse PACK_NOT_CURRENT when it is not current. */
  const GOVERNED = [
    'arkona_create_character',
    'arkona_create_owner',
    'arkona_create_relationship',
    'arkona_identity_reconcile',
    'arkona_rename',
    'arkona_split_owner',
    'arkona_retag_apply',
  ];
  it('copies the bridge’s state ⇒ ensureSandboxGovernance, or its own setGovernance', () => {
    const dir = new URL('../sandbox/', import.meta.url);
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      if (!/copyBridgeState\(/.test(text) || f === 'write-scope.ts') continue;
      const uses = GOVERNED.filter((t) => text.includes(`'${t}'`));
      if (uses.length === 0) continue;
      if (!/ensureSandboxGovernance\(|setGovernance\(/.test(text)) offenders.push(`${f}: ${uses.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
