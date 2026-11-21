/**
 * CR-2026-11-R4 (the owner's request S): the `assumptions-r5` sandbox check (`test/sandbox/assumptions-r5.ts`) run against
 * the mock LegendKeeper in the ordinary suite, through the same runtime as the owner's run: every item must pass (or be
 * NOTED). The mock is made faithful (`makeFaithful`), and a template copy holds each of the template's documents with
 * its content, listed in an order other than the template's.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatAssumptionsR5Report, runAssumptionsR5 } from '../sandbox/assumptions-r5.js';
import { narrativeWorld, type NarrativeWorld } from '../narrative/world.js';
import { makeFaithful } from './faithful.js';
import { expectEveryItemPasses, sandboxOnMock, type OnMock } from './harness.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

type Repo = NarrativeWorld['repo'] & {
  readonly res: Map<string, { id: string; name: string; docs: string[]; deletedAt: string | null }>;
  readonly docs: Map<string, { id: string; name: string; type: string; deletedAt: string | null }>;
  resourceView(r: unknown): unknown;
};

describe('assumptions-r5 on the mock', () => {
  let w: NarrativeWorld;
  let on: OnMock;
  beforeAll(async () => {
    w = await narrativeWorld();
    // LegendKeeper as the owner's runs established it (`makeFaithful`): `createResource` makes the documents it is given,
    // a page saved as a template becomes a template of its documents with their content, blocks are given ids.
    makeFaithful(w);
    // A template copy holds each of the template's documents with its content, listed in another order (ADR 0050).
    w.repo.copyTemplateDocuments = 'reversed';
    on = await sandboxOnMock(w.stack);
  });
  afterAll(async () => {
    await on?.close();
    await w?.close();
  });

  it('every item passes (Z1 to Z3; the documents’ order NOTED), and nothing is left behind', async () => {
    const items = await runAssumptionsR5(on.sb);
    expectEveryItemPasses(items, formatAssumptionsR5Report(items));
    // Z1's NOTED line shows the copy's documents listed in another order than the template's (as modelled).
    expect(items.find((i) => i.id === 'Z1' && i.verdict === 'noted')?.detail).toMatch(
      /^Notes \(page\), Main \(page\)$/,
    );
    const left = [...(w.repo as Repo).res.values()]
      .filter((r) => r.deletedAt === null && /lk-bridge r5/.test(r.name))
      .map((r) => r.name);
    expect(left).toEqual([]);
  });
});
