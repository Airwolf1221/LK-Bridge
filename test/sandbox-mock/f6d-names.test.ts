/**
 * v3 F6d (ADR 0082; R4's rule: every sandbox check runs in the ordinary suite against the mock): the `f6d-names` sandbox
 * check (test/sandbox/f6d-names.ts, N0 to N6) against the faithful mock, through the same runtime and harness as the
 * owner's run: every item passes, the world's own governance is never written, and the throwaway index is gone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatNamesReport, runNamesCheck } from '../sandbox/f6d-names.js';
import { retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';
import { PINNED } from '../packs/owners-world.js';
import { PROJECT } from '../tools/helpers.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });

describe('f6d-names on the mock', () => {
  let w: RetagWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = makeFaithful(await retagWorld({ bulk: 20 }));
    on = await sandboxOnMock(w.stack);
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes (N0 to N6); the world’s governance untouched; the throwaway index gone', async () => {
    const governance = w.stack.runtime.packs.get('arkona')!.governance;
    const before = governance.map((g) => JSON.stringify(w.repo.blocks.get(g.documentId)?.blocks ?? null));
    const items = await runNamesCheck(on.sb, on.raw, 'test', { bridgeDbPath: on.bridgeDbPath });
    const report = formatNamesReport(items);
    expectEveryItemPasses(items, report);
    expect(
      items.map((i) => `${i.id} ${i.verdict}`),
      report,
    ).toEqual(['N0 pass', 'N1 pass', 'N2 pass', 'N3 pass', 'N4 pass', 'N5 pass', 'N6 pass']);
    expect(governance.map((g) => JSON.stringify(w.repo.blocks.get(g.documentId)?.blocks ?? null))).toEqual(
      before,
    );
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && /lk-bridge f6d/.test(r.name)),
      report,
    ).toEqual([]);
  });
});

/**
 * The owner's case: the project's vocabulary is published and approved already, so the copied pack reads `published`
 * before the check publishes anything. The check's own specialist type must still reach the APPROVED rules (N1), or N3
 * reads the specialist page as held_type.
 */
describe('f6d-names on the mock, the vocabulary published already', () => {
  let w: RetagWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = makeFaithful(await retagWorld({ bulk: 20 }));
    const rt = w.stack.runtime;
    const packs = rt.packs;
    const pack = packs.get('arkona')!;
    const src = pack.governance.find((g) => g.key === 'source-formatting')!;
    const doc = w.repo.blocks.get(src.documentId)!;
    doc.blocks.push(
      { id: 'f6dsm001', kind: 'heading', level: 2, content: [{ text: 'Sidebar Metadata' }] },
      { id: 'f6dsm002', kind: 'paragraph', content: [{ text: 'Every page carries PROPERTIES.' }] },
    );
    doc.version++;
    packs.store.setGovernance(
      'arkona',
      pack.governance.map((g) =>
        g.key === 'source-formatting'
          ? { ...g, sections: [...PINNED.formatting, 'Reference Type Vocabulary'] }
          : g,
      ),
    );
    await packs.commands.approve('owner', 'arkona');
    await w.snapshot();
    const pub = await rt.referenceTypes.publish('owner', PROJECT);
    await rt.engine.wait(PROJECT, pub.jobId!, 30_000);
    await rt.referenceTypes.settled();
    await packs.governance('arkona');
    await packs.commands
      .approve('owner', 'arkona')
      .catch(async () => packs.commands.approve('owner', 'arkona'));
    expect(packs.approvedRules('arkona')!.referenceTypes!.status).toBe('published');
    on = await sandboxOnMock(w.stack);
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes: the check’s specialist type reaches the approved rules, N3 reads it exempt', async () => {
    const items = await runNamesCheck(on.sb, on.raw, 'test', { bridgeDbPath: on.bridgeDbPath });
    const report = formatNamesReport(items);
    expectEveryItemPasses(items, report);
    expect(items.find((i) => i.id === 'N3')?.detail, report).toMatch(/status=exempt_specialist/);
  });
});
