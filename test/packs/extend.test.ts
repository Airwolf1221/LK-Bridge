/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
/**
 * v3 F3a (ADR 0050), section C2: `arkona_create_character` with `target`, adding new pages to an existing character.
 * The new pages copy the target's standing (Status, Continuity Type, Continuity, Inheritance, read live) and lifecycle
 * area; an ambiguous name is refused with each candidate and its role; an Archived target is refused; a Compact
 * Reference with no index gets one in its place (the Reference moved under it, id kept); `upgradeToCore` renames a
 * Reference to its Core (text untouched, overlaps warned about); the existing index's routing section gains lines; the
 * target's gate debt is warned about, and fixed when the package gives the values.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT, type ToolCall } from '../tools/helpers.js';
import { approve, C, packWorld, TPL, type PackWorld } from './world.js';

const TOOL = 'arkona_create_character';
let w: PackWorld;
beforeAll(async () => {
  w = await packWorld();
});
afterAll(async () => {
  await w?.close();
});

const body = (md: string, more = '') =>
  `## Purpose\n\n${md}\n\n${more}## Source Boundaries\n\nThis page only.\n\n## Unresolved Material\n\nNone.\n`;
const call = (args: Record<string, unknown>): Promise<ToolCall> => w.call(TOOL, { project: 'test', ...args });
const err = (r: ToolCall) => r.body.error as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const pageNamed = (name: string) =>
  [...w.repo.res.values()].find((r) => r.deletedAt === null && r.name === name);
const rowsOf = (id: string) => Object.fromEntries(w.sidebars.rows(id).map((r) => [r.key, r.text]));
const bio = (title = 'Biography') => ({
  role: 'specialist',
  title,
  specialistTag: 'Biography',
  referenceType: 'Character Biography',
  scope: 'Her life',
  markdown: body('Her life.', '## Early Life\n\nThe house.\n\n'),
});
const today = () => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const v = (k: string) => p.find((x) => x.type === k)!.value;
  return `${v('year')}-${v('month')}-${v('day')}`;
};
const mainBlocks = (id: string) => {
  const d = w.repo.liveDocs(w.repo.live(id)!).find((x) => x.name === 'Main')!;
  return { id: d.id, ...(w.repo.blocks.get(d.id) ?? { version: 0, blocks: [] }) };
};

describe('targeting an existing character', () => {
  it('an ambiguous name is refused with each candidate and its role (Mehrana I and II)', async () => {
    const r = await call({ name: 'x', target: 'Mehrana al-Khalid', pages: [bio()], dryRun: true });
    expect(err(r).code).toBe('TARGET_AMBIGUOUS');
    const names = err(r).refusals[0].candidates.map(
      (c: { name: string; role: string }) => `${c.name} (${c.role})`,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        '[BSRC] Mehrana I al-Khalid - Character Core (Character Core)',
        '[BSRC] Mehrana II al-Khalid - Character Core (Character Core)',
      ]),
    );
  });

  it('without target, a name that exists is CHARACTER_EXISTS, suggesting target', async () => {
    const r = await call({
      name: 'Mehrana II al-Khalid',
      depth: 'developed',
      identity: {
        givenName: 'M',
        surname: 'K',
        race: 'Qishen',
        namingCulture: 'Menkheti',
        lifeState: 'Alive',
        temporalScope: '5A 931',
      },
      pages: [{ role: 'core', scope: 'x', markdown: body('x') }],
      dryRun: true,
    });
    expect(err(r).code).toBe('CHARACTER_EXISTS');
    expect(err(r).hint).toMatch(/target/);
  });

  it('an Archived target is refused (unarchive first)', async () => {
    const r = await call({ name: 'x', target: 'Seren Vale', pages: [bio()], dryRun: true });
    expect(err(r).code).toBe('TARGET_ARCHIVED');
    expect(err(r).message).toMatch(/unarchive/);
  });

  it('an Authoritative target: new [BSRC] pages in its own index, one canonical proposal, its standing copied', async () => {
    const dry = await call({ name: 'ignored', target: 'Mehrana I al-Khalid', pages: [bio()], dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.mode).toBe('extend');
    expect(dry.body.subject).toBe('Mehrana I al-Khalid');
    const page = dry.body.pages[0];
    expect(page.name).toBe('[BSRC] Mehrana I al-Khalid - Biography');
    expect(page.parent).toBe('[INDEX] Mehrana I al-Khalid');
    expect(page.facts).toEqual(
      expect.arrayContaining([
        { key: 'Status', value: 'Authoritative' },
        { key: 'Continuity Type', value: 'CANON' },
        { key: 'Continuity', value: 'Main' },
        { key: 'Inheritance', value: 'None' },
        { key: 'Subject', value: 'Mehrana I al-Khalid' },
      ]),
    );
    // A specialist page gets no race or culture token.
    expect(page.tags).toEqual(['CANON', 'Character', 'Biography']);
    // The target's blank Naming Culture is existing debt: warned, not refused.
    expect(dry.body.warnings.map((x: { code: string }) => x.code)).toContain('IDENTITY_DEBT');
    // The index's routing section gains the new page's line.
    expect(dry.body.existing).toContainEqual(
      expect.objectContaining({
        page: '[INDEX] Mehrana I al-Khalid',
        change: 'How to Use This Index: +1 line(s)',
      }),
    );
    const p = await call({ name: 'ignored', target: 'Mehrana I al-Khalid', pages: [bio()] });
    expect(p.body.status).toBe('proposal_captured');
    expect(p.body.requiresCanonicalApproval).toBe(true);
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    const made = pageNamed('[BSRC] Mehrana I al-Khalid - Biography')!;
    expect(made.parentId).toBe(C.mehrana1Index);
    expect(rowsOf(made.id)).toMatchObject({
      Status: 'Authoritative',
      'Continuity Type': 'CANON',
      Subject: 'Mehrana I al-Khalid',
    });
    // The routing line was appended (never a rewrite): the old line and the new one.
    const idx = mainBlocks(C.mehrana1Index);
    const text = JSON.stringify(idx.blocks);
    expect(text).toContain(C.mehrana1);
    expect(text).toContain(made.id);
    expect(text).toContain('Routes to Mehrana I al-Khalid');
  });

  it('a page of the same domain is refused (DOMAIN_EXISTS) naming the existing page', async () => {
    const r = await call({ name: 'ignored', target: 'Mehrana I al-Khalid', pages: [bio()], dryRun: true });
    expect(err(r).code).toBe('DOMAIN_EXISTS');
    expect(err(r).refusals[0].existing.name).toBe('[BSRC] Mehrana I al-Khalid - Biography');
  });

  it('an explicit "working" override drafts [BWRK] pages in the Working area, for promote_page later', async () => {
    const r = await call({
      name: 'ignored',
      target: 'Mehrana II al-Khalid',
      status: 'working',
      pages: [bio()],
      dryRun: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.tree).toEqual([
      expect.objectContaining({ page: '[BWRK] Mehrana II al-Khalid - Biography', parent: '[INDEX] Working' }),
    ]);
    expect(r.body.pages[0].tags).toEqual(['Working', 'Character', 'Biography']);
    expect(r.body.notes.join(' ')).toMatch(/promote_page/);
  });

  it('an AU target: its pages go in its AU branch with its Continuity', async () => {
    const r = await call({
      name: 'ignored',
      target: 'Kaito of the Shattered Sky',
      pages: [bio()],
      dryRun: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.tree[0]).toMatchObject({
      page: '[BSRC] Kaito of the Shattered Sky - Biography',
      parent: '[INDEX] Kaito of the Shattered Sky',
    });
    expect(r.body.pages[0].facts).toEqual(
      expect.arrayContaining([
        { key: 'Continuity Type', value: 'AU' },
        { key: 'Continuity', value: 'Shattered Sky' },
      ]),
    );
    // The status tag is the lifecycle's (Authoritative: CANON); the continuity is in the facts.
    expect(r.body.pages[0].tags).toEqual(['CANON', 'Character', 'Biography']);
  });

  it('a Working target: its new pages go inside its Working set', async () => {
    const r = await call({ name: 'ignored', target: 'Tamsin Reed', pages: [bio()], dryRun: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.lifecycleStatus).toBe('working');
    expect(r.body.tree[0]).toMatchObject({
      page: '[BWRK] Tamsin Reed - Biography',
      parent: '[INDEX] Tamsin Reed',
    });
  });

  it('existing gate debt is fixed by the package’s values in the same proposal', async () => {
    const r = await call({
      name: 'ignored',
      target: 'Mehrana I al-Khalid',
      identity: { namingCulture: 'Menkheti' },
      pages: [
        {
          ...bio('Personality'),
          specialistTag: 'Personality',
          referenceType: 'Character Personality & Lifestyle Reference',
        },
      ],
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    const done = await approve(w, String(r.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(rowsOf(C.mehrana1)['Naming Culture']).toBe('Menkheti');
    // A substantial change: the Core's Last Major Revision is the day the job ran.
    expect(rowsOf(C.mehrana1)['Last Major Revision']).toBe(today());
  });

  it('with the project’s lmrPackTools switch off, existing pages keep their date; new pages still get today', async () => {
    // Existing gate debt on Nadira (a blank Temporal Scope), fixed by the package: a substantial change.
    w.sidebars.outside(C.nadira, (sb) => {
      const row = sb.props
        .find((p) => p.title === 'PROPERTIES')!
        .rows!.find((r) => r.key === 'Temporal Scope')!;
      row.content = [];
    });
    w.stack.runtime.projects.setSetting(PROJECT, 'lmrPackTools', false);
    try {
      const pkg = {
        name: 'ignored',
        target: 'Nadira al-Khalid',
        identity: { temporalScope: '5A 880 - 5A 931' },
        pages: [
          { ...bio('Wardrobe'), specialistTag: 'Wardrobe', referenceType: 'Character Wardrobe Reference' },
        ],
      };
      const dry = await call({ ...pkg, dryRun: true });
      expect(dry.body.notes.join(' ')).toMatch(/not changed on the existing pages.*lmrPackTools/);
      const r = await call(pkg);
      expect(r.body.status, r.text).toBe('proposal_captured');
      const done = await approve(w, String(r.body.proposalId));
      expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
      expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
      expect(rowsOf(C.nadira)['Temporal Scope']).toBe('5A 880 - 5A 931');
      expect(rowsOf(C.nadira)['Last Major Revision']).toBe('2026-11-01');
      expect(rowsOf(pageNamed('[BSRC] Nadira al-Khalid - Wardrobe')!.id)['Last Major Revision']).toBe(
        today(),
      );
    } finally {
      w.stack.runtime.projects.setSetting(PROJECT, 'lmrPackTools', null);
    }
  });
});

describe('a Compact Reference with no index (the Kamigawa Miyuki pattern), and upgradeToCore (scenario 4)', () => {
  it('index made in its place, the Reference moved under it with its id kept; upgraded to a Core, its text untouched', async () => {
    const before = mainBlocks(C.miyuki);
    const pkg = {
      name: 'ignored',
      target: 'Kamigawa Miyuki',
      upgradeToCore: true,
      pages: [bio()],
    };
    const dry = await call({ ...pkg, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.tree.map((t: { page: string; parent: string }) => `${t.page} ← ${t.parent}`)).toEqual([
      '[INDEX] Kamigawa Miyuki ← [INDEX] Humans',
      '[BSRC] Kamigawa Miyuki - Biography ← [INDEX] Kamigawa Miyuki',
    ]);
    const changes = dry.body.existing.map((x: { change: string }) => x.change).join(' | ');
    expect(changes).toMatch(/renamed to \[BSRC\] Kamigawa Miyuki - Character Core/);
    expect(changes).toMatch(/moved under \[INDEX\] Kamigawa Miyuki \(id kept\)/);
    // The Reference's Biography section is now the new page's domain: a follow-up trim is due.
    expect(dry.body.warnings).toContainEqual(
      expect.objectContaining({ code: 'UPGRADE_OVERLAP', section: 'Biography' }),
    );
    const p = await call(pkg);
    expect(p.body.status, p.text).toBe('proposal_captured');
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const res = done.job?.result as { verified?: boolean; verification?: unknown };
    expect(res.verified, JSON.stringify(res.verification).slice(0, 3000)).toBe(true);
    const ref = w.repo.live(C.miyuki)!;
    expect(ref.name).toBe('[BSRC] Kamigawa Miyuki - Character Core');
    const idx = pageNamed('[INDEX] Kamigawa Miyuki')!;
    expect(ref.parentId).toBe(idx.id);
    expect(idx.parentId).toBe(C.humans);
    expect(rowsOf(C.miyuki)['Reference Type']).toBe('Character Core');
    // Tags unchanged; the body untouched; the Core template recorded on its tree node.
    expect(ref.tags).toEqual(['CANON', 'Character', 'Human', 'Fujimatsuan']);
    expect(mainBlocks(C.miyuki).blocks).toEqual(before.blocks);
    expect(w.stack.runtime.tree.queries.node(PROJECT, C.miyuki).data?.templateId).toBe(TPL.core);
    // The new index's routing lists both pages; the Biography is under it.
    const bioPage = pageNamed('[BSRC] Kamigawa Miyuki - Biography')!;
    expect(bioPage.parentId).toBe(idx.id);
    const text = JSON.stringify(mainBlocks(idx.id).blocks);
    expect(text).toContain(C.miyuki);
    expect(text).toContain(bioPage.id);
    // The moved page and the new one stand in sibling order under the index.
    const kids = [...w.repo.res.values()]
      .filter((r) => r.parentId === idx.id && r.deletedAt === null)
      .sort((a, b) => (a.rank < b.rank ? -1 : 1))
      .map((r) => r.name);
    expect(kids).toEqual(['[BSRC] Kamigawa Miyuki - Biography', '[BSRC] Kamigawa Miyuki - Character Core']);
  });

  it('upgradeToCore needs a Compact Reference target', async () => {
    const r = await call({
      name: 'x',
      target: 'Nadira al-Khalid',
      upgradeToCore: true,
      pages: [bio('History')],
      dryRun: true,
    });
    expect(err(r).code).toBe('UPGRADE_NOT_COMPACT');
  });

  it('the two templates must have the same rows (refused if they ever differ)', async () => {
    const kv = w.sidebars.pages.get(TPL.compact)!.props.find((p) => p.kind === 'keyValue')!;
    const saved = kv.rows!;
    kv.rows = saved.slice(0, -1);
    try {
      const r = await call({
        name: 'x',
        target: 'Asagiri Kaede',
        upgradeToCore: true,
        pages: [bio('Notes')],
        dryRun: true,
      });
      expect(err(r).code).toBe('TEMPLATES_DIFFER');
    } finally {
      kv.rows = saved;
    }
  });
});
