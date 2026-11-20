/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON */
/**
 * The owner's run of assumptions-r4 (20 November 2026): Y2 failed before testing anything ("Invalid params for
 * replaceDocumentBlocks: body.blocks.2: Invalid input"): its table was built with `rows` and `cells` arrays. Against the
 * mock LegendKeeper, through the bridge's job engine and governor: that malformed shape is refused by the registry
 * before anything is sent, and the shape Y2 now sends (test/sandbox/r4-blocks.ts, assumptions-r3 X2's: `tableRow` and
 * `tableCell` children) is accepted and reads back as sent. Keeps the sandbox case from drifting again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintClientId } from '../../src/jobs/index.js';
import { operationInputSchema } from '../../src/lk/registry.js';
import { pagesWorld, FIXTURE_PAGES, type PagesWorld } from '../pages/world.js';
import { y2Blocks } from '../sandbox/r4-blocks.js';
import { PROJECT } from '../tools/helpers.js';

let w: PagesWorld;
beforeAll(async () => {
  w = await pagesWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const page = FIXTURE_PAGES.article;
const origin = { kind: 'test' as const, client: 'contract', tool: 'sandbox-table-shape' };

/** The table as Y2 first built it: `rows` and `cells` (what LegendKeeper's schema does not have). */
function malformed(pageId: string): Record<string, unknown>[] {
  const blocks = y2Blocks(pageId, () => mintClientId());
  blocks[2] = {
    id: mintClientId(),
    kind: 'table',
    rows: [
      {
        id: mintClientId(),
        cells: [
          {
            id: mintClientId(),
            children: [{ id: mintClientId(), kind: 'paragraph', content: [{ text: 'in a cell' }] }],
          },
        ],
      },
    ],
  };
  return blocks;
}

describe('contract: the sandbox check Y2’s table shape (assumptions-r4)', () => {
  it('the registry refuses `rows` and `cells` at body.blocks.2, and takes `tableRow` and `tableCell` children', () => {
    const schema = operationInputSchema('replaceDocumentBlocks');
    const path = { resourceId: page, documentId: 'd1' };
    const bad = schema.safeParse({ path, body: { blocks: malformed(page) }, ifMatch: 'v1' });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.some((i) => i.path.join('.').startsWith('body.blocks.2'))).toBe(true);
    const good = schema.safeParse({
      path,
      body: { blocks: y2Blocks(page, () => mintClientId()) },
      ifMatch: 'v1',
    });
    expect(good.success, JSON.stringify(good.error?.issues.slice(0, 3))).toBe(true);
  });

  it('through the engine: the malformed table is refused before any request; Y2’s blocks are written and read back', async () => {
    const doc = w.doc(page);
    w.setPage(page, [{ id: 'start001', kind: 'paragraph', content: [{ text: 'Before Y2.' }] }] as never);
    const params = (blocks: unknown[]) => ({ path: { resourceId: page, documentId: doc }, body: { blocks } });
    const before = w.blockRequests(page).filter((r) => r.method === 'PUT').length;
    await expect(
      w.stack.runtime.engine.run('replaceDocumentBlocks', params(malformed(page)), {
        project: PROJECT,
        origin,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: expect.stringMatching(/body\.blocks\.2/) });
    expect(w.blockRequests(page).filter((r) => r.method === 'PUT').length).toBe(before);

    const blocks = y2Blocks(page, () => mintClientId());
    const r = await w.stack.runtime.engine.run('replaceDocumentBlocks', params(blocks), {
      project: PROJECT,
      origin,
    });
    expect(r.status).toBe('succeeded');
    const stored = w.stored(page).blocks as any[];
    const table = stored.find((b) => b.kind === 'table');
    expect(table.children[0].kind).toBe('tableRow');
    expect(table.children[0].children.map((c: any) => c.kind)).toEqual(['tableCell', 'tableCell']);
    expect(JSON.stringify(stored)).toContain('in a cell');
  });
});
