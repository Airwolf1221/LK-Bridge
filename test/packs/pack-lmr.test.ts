/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * v3 F3b with F3.1's rule (ADR 0051 decision 1; ADR 0052 decision 14): every pack tool that changes an EXISTING page
 * dates it by the owner's Last Major Revision rule, and takes `lastMajorRevision` ("auto", the default; "set"; "skip");
 * the pages a package makes are always dated, whatever it asks. One case per kind of existing-page change:
 *
 * - `arkona_create_character` with `target`: a gated fact filled (a real fact change: dated), a Compact Reference renamed
 *   to its Core and moved under its new index (a new name, a housekeeping key and a move: not dated), a partner's Related
 *   Sources (a link collection other than Dependencies: not dated);
 * - `arkona_create_relationship`: both participants' Related Sources (not dated under auto; dated with "set");
 * - `arkona_add_character_art` extending an Art page (new headings: dated under auto; left with "skip");
 * - `promoteNation`'s move of the Reference (a move: not dated under auto; dated with "set", or when the owner switched
 *   names and moves on for the project).
 *
 * An existing page's date is aged to 2026-11-01 first, so "left" and "set" can be told apart. Against the mock only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture } from '../images/world.js';
import { approve, C } from './world.js';
import { compactPolity, ownerText, ownersWorld, PROJECT, type OwnersWorld } from './owners-world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await ownersWorld();
});
afterAll(async () => {
  await w?.close();
});

const OLD = '2026-11-01';
const LMR = 'Last Major Revision';
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
const rowsOf = (id: string) => Object.fromEntries(w.sidebars.rows(id).map((r) => [r.key, r.text]));
const pageNamed = (name: string) =>
  [...w.repo.res.values()].find((r) => r.deletedAt === null && r.name === name);
/** Sets a page's Last Major Revision to an older date, as an edit in the app would. */
const age = (id: string) =>
  w.sidebars.outside(id, (sb) => {
    const row = sb.props.find((p) => p.title === 'PROPERTIES')!.rows!.find((r) => r.key === LMR)!;
    row.content = [{ text: OLD }];
  });
const decisions = (body: {
  lastMajorRevision?: { existing?: { page: string; set: boolean; why: string }[] };
}) => body.lastMajorRevision?.existing ?? [];
const run = async (tool: string, args: Record<string, unknown>) => {
  const p = await w.call(tool, { project: 'test', ...args });
  expect(p.body.status, p.text).toBe('proposal_captured');
  const done = await approve(w, String(p.body.proposalId));
  expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
  expect((done.job?.result as { verified?: boolean }).verified, JSON.stringify(done.job?.result)).toBe(true);
  return { p, done, proposal: w.stack.runtime.policy.proposals.get(String(p.body.proposalId))! };
};
const stage = async (salt: number) => {
  const s = await w.call('upload_image', {
    data_base64: Buffer.concat([fixture('alpha.png'), Buffer.from([salt, 7, salt])]).toString('base64'),
    name: `lmr ${salt}`,
    stage: true,
    project: 'test',
  });
  expect(s.body.status, s.text).toBe('staged');
  return String(s.body.staged_id);
};
const bio = (title: string, tag: string, referenceType: string) => ({
  role: 'specialist',
  title,
  specialistTag: tag,
  referenceType,
  scope: `Her ${title.toLowerCase()}`,
  markdown: `## Purpose\n\nHer ${title.toLowerCase()}.\n\n## Detail\n\nMore about it.\n`,
});

describe('arkona_create_character with target', () => {
  it('a gated fact filled is a major revision; with "skip" the date stays, and the new page is dated anyway', async () => {
    // Mehrana I's Naming Culture is blank (identity debt): the package fills it.
    const pkg = {
      name: 'ignored',
      target: 'Mehrana I al-Khalid',
      identity: { namingCulture: 'Menkheti' },
      pages: [bio('Wardrobe', 'Wardrobe', 'Character Wardrobe Reference')],
    };
    const dry = await w.call('arkona_create_character', { project: 'test', ...pkg, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.lastMajorRevision.mode).toBe('auto');
    expect(dry.body.lastMajorRevision.newPages).toEqual(['[BSRC] Mehrana I al-Khalid - Wardrobe']);
    expect(decisions(dry.body)).toEqual([
      {
        page: '[BSRC] Mehrana I al-Khalid - Character Core',
        set: true,
        why: expect.stringMatching(/^auto: Naming Culture: a fact (changed|added)$/),
      },
    ]);
    age(C.mehrana1);
    const { proposal } = await run('arkona_create_character', { ...pkg, lastMajorRevision: 'skip' });
    expect(proposal.summary).toMatch(/Last Major Revision skipped: lastMajorRevision "skip" was asked/);
    expect(rowsOf(C.mehrana1)['Naming Culture']).toBe('Menkheti');
    expect(rowsOf(C.mehrana1)[LMR]).toBe(OLD);
    expect(rowsOf(pageNamed('[BSRC] Mehrana I al-Khalid - Wardrobe')!.id)[LMR]).toBe(today());
  });

  it('a Compact Reference renamed to its Core and moved under its new index is not a major revision; "set" dates it', async () => {
    const pkg = {
      name: 'ignored',
      target: 'Kamigawa Miyuki',
      upgradeToCore: true,
      pages: [bio('Biography', 'Biography', 'Character Biography')],
    };
    const dry = await w.call('arkona_create_character', { project: 'test', ...pkg, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(decisions(dry.body)).toEqual([
      {
        page: '[BSRC] Kamigawa Miyuki - Character Core',
        set: false,
        why: 'a new name; Reference Type (a housekeeping key); a move, not a major revision',
      },
    ]);
    age(C.miyuki);
    const set = await w.call('arkona_create_character', {
      project: 'test',
      ...pkg,
      lastMajorRevision: 'set',
      dryRun: true,
    });
    expect(decisions(set.body)).toEqual([
      expect.objectContaining({ set: true, why: 'set: lastMajorRevision "set" was asked' }),
    ]);
    await run('arkona_create_character', { ...pkg, lastMajorRevision: 'set' });
    expect(w.repo.live(C.miyuki)!.name).toBe('[BSRC] Kamigawa Miyuki - Character Core');
    expect(rowsOf(C.miyuki)[LMR]).toBe(today());
  });

  it('a partner’s Related Sources alone is not a major revision', async () => {
    age(C.nadira);
    const { p } = await run('arkona_create_character', {
      name: 'ignored',
      target: 'Mehrana II al-Khalid',
      pages: [
        {
          role: 'relationship',
          with: 'Nadira al-Khalid',
          label: 'Rivalry',
          scope: 'Their rivalry',
          markdown: ownerText('The rivalry of Mehrana II al-Khalid and Nadira al-Khalid.'),
        },
      ],
    });
    expect(decisions(p.body)).toEqual(
      expect.arrayContaining([
        {
          page: '[BSRC] Nadira al-Khalid - Character Core',
          set: false,
          why: 'Related Sources: links only (not Dependencies), not a major revision',
        },
      ]),
    );
    expect(rowsOf(C.nadira)[LMR]).toBe(OLD);
  });
});

describe('arkona_create_relationship', () => {
  it('both participants’ Related Sources: not dated under auto; the relationship page is', async () => {
    age(C.nadira);
    age(C.mehrana1);
    const { p, proposal } = await run('arkona_create_relationship', {
      a: 'Nadira al-Khalid',
      b: 'Mehrana I al-Khalid',
      scope: 'Cousins',
      markdown: ownerText('The bond of Nadira al-Khalid and Mehrana I al-Khalid.'),
    });
    const skipped = 'Related Sources: links only (not Dependencies), not a major revision';
    expect(decisions(p.body)).toEqual(
      expect.arrayContaining([
        { page: '[BSRC] Nadira al-Khalid - Character Core', set: false, why: skipped },
        { page: '[BSRC] Mehrana I al-Khalid - Character Core', set: false, why: skipped },
      ]),
    );
    expect(proposal.summary).toMatch(/Last Major Revision skipped: Related Sources: links only/);
    expect(rowsOf(C.nadira)[LMR]).toBe(OLD);
    expect(rowsOf(C.mehrana1)[LMR]).toBe(OLD);
    const page = pageNamed('[BSRC] Nadira al-Khalid & Mehrana I al-Khalid - Relationship')!;
    expect(rowsOf(page.id)[LMR]).toBe(today());
  });

  it('with "set", both participants are dated', async () => {
    age(C.mehrana1);
    age(C.mehrana2);
    const { p } = await run('arkona_create_relationship', {
      a: 'Mehrana I al-Khalid',
      b: 'Mehrana II al-Khalid',
      label: 'Succession',
      scope: 'The succession',
      markdown: ownerText('The succession of Mehrana I al-Khalid and Mehrana II al-Khalid.'),
      lastMajorRevision: 'set',
    });
    expect(decisions(p.body)).toHaveLength(2);
    expect(decisions(p.body).every((d) => d.set && d.why === 'set: lastMajorRevision "set" was asked')).toBe(
      true,
    );
    expect(rowsOf(C.mehrana1)[LMR]).toBe(today());
    expect(rowsOf(C.mehrana2)[LMR]).toBe(today());
  });
});

describe('arkona_add_character_art extending an Art page', () => {
  it('new image sections (headings) are a major revision; with "skip" the date stays', async () => {
    // The first package makes the Art page (a new page: dated); then it is aged and extended twice.
    await run('arkona_add_character_art', {
      character: 'Nadira al-Khalid',
      images: [
        { staged_id: await stage(1), label: 'Primary Reference - Portrait', interpretation: 'Her face.' },
      ],
    });
    const art = pageNamed('[BSRC] Nadira al-Khalid - Character Art')!;
    expect(rowsOf(art.id)[LMR]).toBe(today());
    age(art.id);
    const skip = await run('arkona_add_character_art', {
      character: 'Nadira al-Khalid',
      images: [{ staged_id: await stage(2), label: 'Detail Reference - Ring', interpretation: 'Her ring.' }],
      lastMajorRevision: 'skip',
    });
    expect(decisions(skip.p.body)).toEqual([
      { page: art.name, set: false, why: 'lastMajorRevision "skip" was asked' },
    ]);
    expect(rowsOf(art.id)[LMR]).toBe(OLD);
    const auto = await run('arkona_add_character_art', {
      character: 'Nadira al-Khalid',
      images: [{ staged_id: await stage(3), label: 'Outfit Reference - Gown', interpretation: 'Her gown.' }],
    });
    expect(decisions(auto.p.body)).toEqual([
      {
        page: art.name,
        set: true,
        why: 'auto: a heading added (“Outfit Reference - Gown”)',
      },
    ]);
    // The page's line in the proposal, and its summary, say what was decided and why.
    expect(auto.proposal.pages.join('\n')).toMatch(
      /Character Art: Reference Images gains “Nadira al-Khalid - Outfit Reference - Gown”; \+ Last Major Revision → date of approval \(auto: a heading added/,
    );
    expect(auto.proposal.summary).toMatch(
      /\+ Last Major Revision → date of approval \(auto: a heading added/,
    );
    expect(rowsOf(art.id)[LMR]).toBe(today());
  });
});

describe('promoteNation’s move of the Reference', () => {
  /** A compact polity made by the owner tool (so the tree knows its sidebar), approved, then aged. */
  const compact = async (name: string) => {
    await run('arkona_create_owner', compactPolity({ name, status: 'authoritative' }));
    const ref = pageNamed(`[BSRC] ${name} - Historical Polity Reference`)!;
    age(ref.id);
    return ref;
  };
  const promote = (nation: string, court: string, more: Record<string, unknown> = {}) => ({
    type: 'Institution',
    name: court,
    descriptor: 'Institution Reference',
    nation,
    home: nation,
    promoteNation: true,
    status: 'authoritative',
    referenceType: 'Institution Reference',
    scope: 'A court',
    temporalScope: '4A',
    markdown: ownerText(`The court of ${nation}.`),
    ...more,
  });

  it('a move is not a major revision: the Reference keeps its date; the new pages are dated', async () => {
    const ref = await compact('Kingdom of Ausan');
    const { p } = await run('arkona_create_owner', promote('Kingdom of Ausan', 'Ausan Court'));
    expect(decisions(p.body)).toEqual([{ page: ref.name, set: false, why: 'a move, not a major revision' }]);
    expect(rowsOf(ref.id)[LMR]).toBe(OLD);
    expect(rowsOf(pageNamed('[BSRC] Ausan Court - Institution Reference')!.id)[LMR]).toBe(today());
  });

  it('with "set" the Reference is dated', async () => {
    const ref = await compact('Kingdom of Himyar');
    await run(
      'arkona_create_owner',
      promote('Kingdom of Himyar', 'Himyar Court', { lastMajorRevision: 'set' }),
    );
    expect(rowsOf(ref.id)[LMR]).toBe(today());
  });

  it('with names and moves switched on for the project, the move counts under auto', async () => {
    const ref = await compact('Kingdom of Qataban');
    w.stack.runtime.projects.setSetting(PROJECT, 'lmrNamesTagsMoves', true);
    try {
      const { p } = await run('arkona_create_owner', promote('Kingdom of Qataban', 'Qataban Court'));
      expect(decisions(p.body)).toEqual([
        {
          page: ref.name,
          set: true,
          why: 'auto: tags, aliases, icons, names, moves, switched on for this project',
        },
      ]);
      expect(rowsOf(ref.id)[LMR]).toBe(today());
    } finally {
      w.stack.runtime.projects.setSetting(PROJECT, 'lmrNamesTagsMoves', null);
    }
  });

  it('"skip" never touches the pages a package makes', async () => {
    const { p } = await run('arkona_create_owner', {
      ...compactPolity({ name: 'Kingdom of Maʿin', status: 'authoritative' }),
      lastMajorRevision: 'skip',
    });
    expect(p.body.lastMajorRevision).toEqual({
      mode: 'skip',
      newPages: ['[BSRC] Kingdom of Maʿin - Historical Polity Reference'],
      existing: [],
    });
    expect(rowsOf(pageNamed('[BSRC] Kingdom of Maʿin - Historical Polity Reference')!.id)[LMR]).toBe(today());
  });
});
