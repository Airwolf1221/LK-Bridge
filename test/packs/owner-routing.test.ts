/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * v3 F3d (ADR 0053 part C): `arkona_create_owner` adds a routing line to the home index it files into, as F3a's character
 * tool does (C2's routing lines): one line, F3a's pattern, appended to the home's "How to Use This Index" section in the
 * same proposal. A home with no such section gets nothing, and the preview says so. With `promoteNation`, the Polities
 * index's line for the nation now points to the nation's new index (the rest of the line kept). ADR 0051's rule decides
 * Last Major Revision for the edited index; nothing forces it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approve } from './world.js';
import { O, ownerText, ownersWorld, compactPolity, type OwnersWorld } from './owners-world.js';

let w: OwnersWorld;
const call = (args: Record<string, unknown>) => w.call('arkona_create_owner', { project: 'test', ...args });
const mainDoc = (id: string) => w.repo.liveDocs(w.repo.live(id)!).find((d) => d.name === 'Main')!.id;
const pageNamed = (name: string) =>
  [...w.repo.res.values()].find((r) => r.deletedAt === null && r.name === name);
const docText = (id: string) => JSON.stringify(w.repo.blocks.get(mainDoc(id))!.blocks);

/** An index's Main text: Purpose, a routing section with one line per page (a mention and its Scope), boundaries. */
function routing(index: string, lines: readonly { id: string; name: string; scope: string }[]) {
  w.repo.blocks.set(mainDoc(index), {
    version: 1,
    blocks: [
      { id: `${index}h1`, kind: 'heading', level: 2, content: [{ text: 'Purpose' }] },
      { id: `${index}p1`, kind: 'paragraph', content: [{ text: 'Routes to the pages of this index.' }] },
      { id: `${index}h2`, kind: 'heading', level: 2, content: [{ text: 'How to Use This Index' }] },
      {
        id: `${index}l1`,
        kind: 'bulletList',
        children: lines.map((l, i) => ({
          id: `${index}i${i}`,
          kind: 'listItem',
          children: [
            {
              id: `${index}i${i}p`,
              kind: 'paragraph',
              content: [{ mention: { resourceId: l.id, text: l.name } }, { text: `: ${l.scope}` }],
            },
          ],
        })),
      },
      { id: `${index}h3`, kind: 'heading', level: 2, content: [{ text: 'Index Boundaries' }] },
      { id: `${index}p3`, kind: 'paragraph', content: [{ text: 'Routing only.' }] },
    ],
  });
}

beforeAll(async () => {
  w = await ownersWorld();
});
afterAll(async () => {
  await w?.close();
});

describe('a routing line in the home index (as F3a does for characters)', () => {
  it('an Authoritative owner: one line appended to the home’s routing section, in the same proposal', async () => {
    routing(O.salahadPolities, [
      {
        id: O.tarim,
        name: '[BSRC] Sultanate of Tarim - Historical Polity Reference',
        scope: 'A pearl sultanate',
      },
      { id: O.qasr, name: '[BSRC] Emirate of Qasr - Polity Reference', scope: 'A desert emirate' },
    ]);
    const args = compactPolity({ status: 'authoritative', scope: 'A highland kingdom' });
    const dry = await call({ ...args, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    const line = dry.body.existing.find((e: { page: string }) => e.page === '[INDEX] Salahad Polities');
    expect(line).toMatchObject({ change: 'How to Use This Index: +1 line(s)' });
    expect(line.lines).toHaveLength(1);
    expect(line.lines[0]).toMatch(
      // v3 F3f (ADR 0060, D): a plain mention, which always shows the page's current name.
      /^- \[\]\(lk:\/\/resources\/[a-z0-9]+\): A highland kingdom$/,
    );
    // ADR 0051's rule decides the index's Last Major Revision from the line's words (the job measures the routing write
    // as F3a's); nothing forces it. This fixture's index has no such row, so it is left out of the decision.
    expect(dry.body.lastMajorRevision.existing).toEqual([]);

    const p = await call(args);
    expect(p.body.status, p.text).toBe('proposal_captured');
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const made = pageNamed('[BSRC] Kingdom of Saba - Historical Polity Reference')!;
    expect(made.parentId).toBe(O.salahadPolities);
    // Appended, never a rewrite: the old lines and the new one, in that order.
    const text = docText(O.salahadPolities);
    expect(text.indexOf(O.tarim)).toBeLessThan(text.indexOf(made.id));
    expect(text).toContain(O.qasr);
    expect(text).toContain('A highland kingdom');
  });

  it('a home with no routing section: nothing is added, and the preview says so', async () => {
    const r = await call({
      ...compactPolity({ status: 'authoritative', name: 'Kingdom of Ophir', home: 'Velaria Polities' }),
      dryRun: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.existing).toEqual([]);
    expect(r.body.notes.join(' ')).toMatch(
      /\[INDEX\] Velaria Polities has no “How to Use This Index” section, so no routing lines were added/,
    );
  });

  it('a Working owner sits under [INDEX] Working: no line in the home until it is promoted', async () => {
    const r = await call({ ...compactPolity({ name: 'Kingdom of Punt', status: 'working' }), dryRun: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.existing).toEqual([]);
  });
});

describe('promoteNation: the Polities index’s line for the nation points to its new index', () => {
  const institution = {
    type: 'Institution',
    name: 'Court of Pearls',
    descriptor: 'Institution Reference',
    nation: 'Sultanate of Tarim',
    home: 'Sultanate of Tarim',
    status: 'authoritative',
    referenceType: 'Institution Reference',
    scope: 'The pearl-divers’ court of the sultanate',
    temporalScope: '4A 100 - 4A 300',
    markdown: ownerText('The pearl court of Tarim.'),
    promoteNation: true,
  };

  it('previewed as one change, then made in the same proposal: the line repointed, its Scope kept', async () => {
    const dry = await call({ ...institution, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    const nationIndex = dry.body.pages.find((x: { name: string }) => x.name === '[INDEX] Sultanate of Tarim');
    // v3 F3f (ADR 0060, D): a plain mention (the page's current name, never a custom label).
    expect(nationIndex.indexText).toContain(
      '- [](lk://resources/tarimref): A coastal sultanate of eastern Salahad',
    );
    expect(dry.body.existing).toContainEqual(
      expect.objectContaining({
        page: '[INDEX] Salahad Polities',
        change:
          'How to Use This Index: its line for [BSRC] Sultanate of Tarim - Historical Polity Reference now points to [INDEX] Sultanate of Tarim',
      }),
    );
    const p = await call(institution);
    expect(p.body.status, p.text).toBe('proposal_captured');
    expect(p.body.requiresCanonicalApproval).toBe(true);
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const index = pageNamed('[INDEX] Sultanate of Tarim')!;
    expect(w.repo.live(O.tarim)!.parentId).toBe(index.id);
    const blocks = w.repo.blocks.get(mainDoc(O.salahadPolities))!.blocks as {
      kind: string;
      children?: { children?: { content?: unknown[] }[] }[];
    }[];
    const list = blocks.find((b) => b.kind === 'bulletList')!;
    const items = list.children!.map((li) => JSON.stringify(li.children![0]!.content));
    const tarimLine = items.find((x) => x.includes('A pearl sultanate'))!;
    expect(tarimLine).toContain(index.id);
    // v3 F3f (ADR 0060, D): a plain mention (no custom label): it shows the new index's current name.
    const mention = (JSON.parse(tarimLine) as { mention?: { resourceId: string; text?: string } }[]).find(
      (r) => r.mention,
    )!.mention!;
    expect(mention).toEqual({ resourceId: index.id });
    expect(tarimLine).not.toContain(O.tarim);
    // The other lines are untouched.
    expect(items.some((x) => x.includes(O.qasr))).toBe(true);
  });

  it('a Polities index whose routing text names the nation nowhere: nothing changed, and the preview says so', async () => {
    const r = await call({
      ...institution,
      name: 'Court of Dunes',
      nation: 'Emirate of Qasr',
      home: 'Emirate of Qasr',
      dryRun: true,
    });
    expect(r.isError, r.text).toBe(false);
    // Salahad Polities still has a line for Qasr (written above), so it is repointed; drop it and ask again.
    expect(r.body.existing.some((e: { page: string }) => e.page === '[INDEX] Salahad Polities')).toBe(true);
    routing(O.salahadPolities, [{ id: O.alTibr, name: '[INDEX] Al-Tibr', scope: 'A river emirate' }]);
    const none = await call({
      ...institution,
      name: 'Court of Dunes',
      nation: 'Emirate of Qasr',
      home: 'Emirate of Qasr',
      dryRun: true,
    });
    expect(none.isError, none.text).toBe(false);
    expect(none.body.existing.some((e: { page: string }) => e.page === '[INDEX] Salahad Polities')).toBe(
      false,
    );
    expect(none.body.notes.join(' ')).toMatch(
      /no routing line links \[BSRC\] Emirate of Qasr - Polity Reference, so none was pointed to \[INDEX\] Emirate of Qasr/,
    );
  });
});
