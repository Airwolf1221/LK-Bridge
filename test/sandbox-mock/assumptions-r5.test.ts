/**
 * CR-2026-11-R4 (the owner's request S): the `assumptions-r5` sandbox check (`test/sandbox/assumptions-r5.ts`) run against
 * the mock LegendKeeper in the ordinary suite, through the same runtime as the owner's run: every item must pass (or be
 * NOTED). The mock is set to behave as LegendKeeper does where this check depends on it: `createResource` makes the
 * documents it is given, a template copy holds each of the template's documents with its content (listed in an order
 * other than the template's), and a page saved as a template becomes a template of its own documents.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { formatAssumptionsR5Report, runAssumptionsR5 } from '../sandbox/assumptions-r5.js';
import { narrativeWorld, type NarrativeWorld } from '../narrative/world.js';
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
    w.sidebars.adoptNewPages = (id) => w.repo.live(id) !== undefined;
    w.repo.createDocuments = true;
    w.repo.copyTemplateDocuments = 'reversed';
    const repo = w.repo as Repo;
    // saveResourceAsTemplate (the repository model has none): a new template holding a copy of each of the page's
    // documents with its content.
    w.overrides.set(/\/resources\/[^/]+\/save-as-template$/, (req: MockRequest): MockResponse | undefined => {
      if (req.method !== 'POST') return undefined;
      const src = /\/resources\/([^/]+)\/save-as-template$/.exec(req.path.replace(/\/$/, ''))![1]!;
      const s = repo.res.get(src);
      if (!s || s.deletedAt !== null)
        return { status: 404, body: { code: 'NOT_FOUND', message: 'not found' } };
      const name = (req.body as { name?: string } | undefined)?.name ?? s.name;
      const t = w.repo.seed({ name, parentId: null, props: false });
      for (const d of [...t.docs]) w.repo.outside.deleteDocument(d);
      for (const id of s.docs) {
        const d = repo.docs.get(id)!;
        if (d.deletedAt !== null) continue;
        const copy = w.repo.outside.addDocument(t.id, d.name, d.type);
        const body = w.repo.blocks.get(d.id);
        if (body) w.repo.blocks.set(copy.id, { version: 1, blocks: structuredClone(body.blocks) });
      }
      return { status: 201, body: repo.resourceView(t) };
    });
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
