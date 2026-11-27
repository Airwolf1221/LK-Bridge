/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * v3 F3a (ADR 0050): `arkona_create_character` against the mock LegendKeeper with Arkona-shaped fixtures: the package's
 * validation (the gate, names, dashes, links, images), the planning (compact, developed, an index only when wanted, the
 * fallback race), the tags (the Controlled Native Tagging Standard's own examples), the sidebar (template order, native
 * rows kept, Last Major Revision), links, assets, the one proposal and its one job, and the verify step.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeTags } from '../../src/packs/engine/tags.js';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { fixture } from '../images/world.js';
import { PROJECT, type ToolCall } from '../tools/helpers.js';
import { approve, C, compactPackage, IDENTITY_KEYS, LIFECYCLE, packWorld, type PackWorld } from './world.js';

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
const ident = (over: Record<string, unknown> = {}) => ({
  givenName: 'Ren',
  surname: 'Asagiri',
  race: 'Foxian',
  namingCulture: 'Fujimatsuan',
  lifeState: 'Alive at 5A 931',
  temporalScope: '5A 900 - 5A 931',
  ...over,
});
const call = (args: Record<string, unknown>): Promise<ToolCall> => w.call(TOOL, { project: 'test', ...args });
const err = (r: ToolCall) => r.body.error as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const pageNamed = (name: string) =>
  [...w.repo.res.values()].find((r) => r.deletedAt === null && r.name === name);
const parentName = (name: string) => w.repo.res.get(pageNamed(name)!.parentId!)?.name;
const rows = (id: string) => w.sidebars.rows(id).map((r) => `${r.key}=${r.text}`);
const blocksOf = (id: string) => {
  const r = w.repo.live(id)!;
  const d = w.repo.liveDocs(r).find((x) => x.name === 'Main')!;
  return (w.repo.blocks.get(d.id)?.blocks ?? []) as Record<string, unknown>[];
};
const today = () => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};

describe('the package: validation', () => {
  it.each([
    ['givenName', 'Personal / Given Name'],
    ['surname', 'Family / Surname'],
    ['race', 'Race / Species'],
    ['namingCulture', 'Naming Culture'],
    ['lifeState', 'Life State'],
    ['temporalScope', 'Temporal Scope'],
  ])(
    'a missing %s is IDENTITY_INCOMPLETE, naming the field and telling the agent to ask the owner',
    async (field, key) => {
      const identity = ident();
      delete (identity as Record<string, unknown>)[field];
      const r = await call(compactPackage({ name: `Gate ${field}`, identity, dryRun: true }));
      expect(r.isError).toBe(true);
      expect(err(r).code).toBe('IDENTITY_INCOMPLETE');
      expect(err(r).refusals[0].fields).toEqual([key]);
      expect(err(r).message).toMatch(/ask the owner/i);
    },
  );

  // v3 F12 follow-up (ADR 0081 amendment 1, decision 4): a package's dry run says what it will be at the caller's scope.
  it('the dry run says what the package will be at each scope: a proposal at propose, a direct job on Review at write', async () => {
    const atPropose = await call(compactPackage({ name: 'Scope Check', identity: ident(), dryRun: true }));
    expect(atPropose.body.status, atPropose.text).toBe('dry_run');
    expect(String(atPropose.body.message)).toMatch(/scope \(propose\) ONE proposal for the owner/);
    const writer = await w.stack.connect(w.stack.newToken('pack-dry-writer', 'write').token);
    const atWrite = await w.stack.call(writer, TOOL, {
      project: 'test',
      ...compactPackage({ name: 'Scope Check', identity: ident(), dryRun: true }),
    });
    expect(atWrite.body.status, atWrite.text).toBe('dry_run');
    expect(String(atWrite.body.message)).toMatch(/runs directly and appears on the owner’s Review page/);
    expect(String(atWrite.body.message)).not.toMatch(/approv/i);
  });

  it('a blank, whitespace or placeholder value is refused too', async () => {
    for (const v of ['', '   ', 'TBD', '[Naming culture]', 'Unknown']) {
      const r = await call(
        compactPackage({ name: 'Gate blank', identity: ident({ namingCulture: v }), dryRun: true }),
      );
      expect(err(r).code, v).toBe('IDENTITY_INCOMPLETE');
    }
  });

  it('Unestablished needs a reason, which goes into Unresolved Material', async () => {
    const bare = await call(
      compactPackage({
        name: 'Gate open',
        identity: ident({ namingCulture: 'Unestablished' }),
        dryRun: true,
      }),
    );
    expect(err(bare).code).toBe('UNESTABLISHED_NEEDS_REASON');
    const ok = await call(
      compactPackage({
        name: 'Gate open',
        identity: ident({
          namingCulture: { value: 'Unestablished', reason: 'The owner has not chosen her clan yet.' },
        }),
        dryRun: true,
      }),
    );
    expect(ok.isError, ok.text).toBe(false);
    const page = ok.body.pages[0];
    expect(page.facts).toContainEqual({ key: 'Naming Culture', value: 'Unestablished' });
    expect(page.text.headings).toContain('Unresolved Material');
    // The culture slot is held (Unestablished is never a tag).
    expect(page.tags).toEqual(['Working', 'Character', 'Foxian']);
    expect(ok.body.heldTags).toContainEqual(
      expect.objectContaining({ slot: 'culture', value: 'Unestablished' }),
    );
  });

  it('CANON or a date in a page name is refused', async () => {
    const canon = await call(compactPackage({ name: 'Ren CANON', dryRun: true }));
    expect(err(canon).code).toBe('NAME_HAS_FORBIDDEN_WORD');
    for (const name of ['Ren 2026-11-16', 'Ren (November 2026)', 'Ren of 4A 881']) {
      const r = await call(compactPackage({ name, dryRun: true }));
      expect(err(r).code, name).toBe('NAME_HAS_DATE');
    }
    const title = await call({
      ...compactPackage({ name: 'Dated Titles', depth: 'developed' }),
      pages: [
        { role: 'core', scope: 'x', markdown: body('Core.') },
        {
          role: 'specialist',
          title: 'Biography 2025',
          referenceType: 'Character Biography',
          scope: 'x',
          markdown: body('Bio.'),
        },
      ],
      dryRun: true,
    });
    expect(err(title).code).toBe('NAME_HAS_DATE');
  });

  it('em dashes (and en dashes used as separators) are replaced in a name, a heading and the body, and listed', async () => {
    const r = await call({
      ...compactPackage({ name: 'Ren — of the Shrine' }),
      pages: [
        {
          role: 'compact',
          scope: 'Guard – shrine',
          markdown:
            '## Purpose\n\nThe reference — for now.\n\n## Duty — and Honour\n\nRange 1990–1995 stays.\n\n## Source Boundaries\n\nOnly.\n\n## Unresolved Material\n\nNone.\n',
        },
      ],
      dryRun: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.subject).toBe('Ren - of the Shrine');
    expect(r.body.pages[0].name).toBe('[BWRK] Ren - of the Shrine - Character Reference');
    expect(r.body.pages[0].text.headings).toContain('Duty - and Honour');
    const fields = r.body.replacements.map((x: { field: string }) => x.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'Scope', 'body', 'heading']));
    expect(r.body.replacements.find((x: { field: string }) => x.field === 'name')).toMatchObject({
      before: 'Ren — of the Shrine',
      after: 'Ren - of the Shrine',
    });
    // An en dash inside a range is not a separator: it stays.
    expect(JSON.stringify(r.body.replacements)).not.toContain('1990');
  });

  it('an unknown link target is refused, and a Working target for a CANON page', async () => {
    const unknown = await call(
      compactPackage({
        name: 'Linker',
        pages: [
          { role: 'compact', scope: 'x', markdown: body('x'), dependencies: ['No Such Page Anywhere'] },
        ],
        dryRun: true,
      }),
    );
    expect(err(unknown).code).toBe('LINK_TARGET_NOT_FOUND');
    const working = await call(
      compactPackage({
        name: 'Linker',
        status: 'authoritative',
        pages: [{ role: 'compact', scope: 'x', markdown: body('x'), related: ['Draft Notes'] }],
        dryRun: true,
      }),
    );
    expect(err(working).code).toBe('LINK_TARGET_NOT_CURRENT');
    // A Working page may link a Working page.
    const ok = await call(
      compactPackage({
        name: 'Linker',
        pages: [{ role: 'compact', scope: 'x', markdown: body('x'), related: ['Draft Notes'] }],
        dryRun: true,
      }),
    );
    expect(ok.isError, ok.text).toBe(false);
    expect(ok.body.pages[0].relatedSources).toEqual(['[BWRK] Draft Notes']);
  });

  it('a bare image is refused', async () => {
    const s = await w.call('upload_image', {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'bare',
      stage: true,
      project: 'test',
    });
    const r = await call({
      ...compactPackage({ name: 'Bare Image', depth: 'developed' }),
      pages: [
        { role: 'core', scope: 'x', markdown: body('Core.') },
        {
          role: 'art',
          scope: 'x',
          markdown: body('Art.'),
          images: [{ staged_id: s.body.staged_id, label: 'Primary Reference - Portrait' }],
        },
      ],
      dryRun: true,
    });
    expect(err(r).code).toBe('BARE_IMAGE');
  });

  it('the body: Purpose first, never the page title or a metadata header, no empty section', async () => {
    const md = (text: string) =>
      call(
        compactPackage({
          name: 'Body Rules',
          pages: [{ role: 'compact', scope: 'x', markdown: text }],
          dryRun: true,
        }),
      );
    expect(err(await md('## Body Rules\n\nx\n\n## Purpose\n\ny\n')).code).toBe('BODY_REPEATS_TITLE');
    expect(err(await md('Status: Working\nReference Type: Compact\n\n## Purpose\n\ny\n')).code).toBe(
      'BODY_HAS_METADATA_HEADER',
    );
    expect(err(await md('## Overview\n\nx\n')).code).toBe('PURPOSE_NOT_FIRST');
    expect(err(await md('## Purpose\n\nx\n\n## Life\n\n## Source Boundaries\n\ny\n')).code).toBe(
      'EMPTY_SECTION',
    );
    const warned = await md('## Purpose\n\nx\n');
    expect(warned.isError).toBe(false);
    expect(warned.body.warnings.map((x: { code: string }) => x.code)).toContain('SECTION_MISSING');
  });

  it('agent tags are never accepted: a specialist tag must be one of the closed list', async () => {
    const r = await call({
      ...compactPackage({ name: 'Taggy', depth: 'developed' }),
      pages: [
        { role: 'core', scope: 'x', markdown: body('Core.') },
        {
          role: 'specialist',
          title: 'Lore',
          referenceType: 'Character Biography',
          specialistTag: 'Lore',
          scope: 'x',
          markdown: body('Lore.'),
        },
      ],
      dryRun: true,
    });
    expect(err(r).code).toBe('TAG_NOT_ALLOWED');
  });
});

describe('planning', () => {
  it('a compact package is one page: under its race when authoritative, under [INDEX] Working when working', async () => {
    const a = await call(compactPackage({ name: 'Plan Compact', status: 'authoritative', dryRun: true }));
    expect(a.isError, a.text).toBe(false);
    expect(a.body.tree).toEqual([
      expect.objectContaining({
        page: '[BSRC] Plan Compact - Character Reference',
        parent: '[INDEX] Foxians',
      }),
    ]);
    const wk = await call(compactPackage({ name: 'Plan Compact', dryRun: true }));
    expect(wk.body.tree).toEqual([
      expect.objectContaining({
        page: '[BWRK] Plan Compact - Character Reference',
        parent: '[INDEX] Working',
      }),
    ]);
  });

  it('a compact package with a relationship gets an index, its Reference and the Relationship', async () => {
    const r = await call({
      ...compactPackage({ name: 'Plan Pair', status: 'authoritative' }),
      pages: [
        { role: 'compact', scope: 'x', markdown: body('Ref.') },
        { role: 'relationship', with: 'Nadira al-Khalid', scope: 'x', markdown: body('Rel.') },
      ],
      dryRun: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.tree.map((t: { page: string; parent: string }) => `${t.page} ← ${t.parent}`)).toEqual([
      '[INDEX] Plan Pair ← [INDEX] Foxians',
      '[BSRC] Plan Pair - Character Reference ← [INDEX] Plan Pair',
      '[BSRC] Plan Pair & Nadira al-Khalid - Relationship ← [INDEX] Plan Pair',
    ]);
  });

  it('a developed package: index, Core and only the supplied domains (no empty pages)', async () => {
    const r = await call({
      ...compactPackage({ name: 'Plan Developed', depth: 'developed' }),
      pages: [
        { role: 'core', scope: 'x', markdown: body('Core.') },
        {
          role: 'specialist',
          title: 'Biography',
          specialistTag: 'Biography',
          scope: 'x',
          markdown: body('Life.'),
        },
      ],
      dryRun: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.tree.map((t: { page: string }) => t.page)).toEqual([
      '[INDEX] Plan Developed',
      '[BWRK] Plan Developed - Biography',
      '[BWRK] Plan Developed - Character Core',
    ]);
    // The Biography's Reference Type was suggested from its title.
    expect(r.body.pages.find((x: { role: string }) => x.role === 'specialist').referenceType).toBe(
      'Character Biography',
    );
    expect(r.body.warnings.map((x: { code: string }) => x.code)).toContain('REFERENCE_TYPE_SUGGESTED');
    // The index text is drafted and shown.
    expect(r.body.pages[0].indexText).toMatch(/## How to Use This Index/);
    expect(r.body.pages[0].indexText).toMatch(/## Subpages/);
    // A page with no text is refused (no token pages).
    const empty = await call({
      ...compactPackage({ name: 'Plan Developed', depth: 'developed' }),
      pages: [
        { role: 'core', scope: 'x', markdown: body('Core.') },
        {
          role: 'specialist',
          title: 'Wardrobe',
          referenceType: 'Character Wardrobe & Personal Presentation Reference',
          scope: 'x',
        },
      ],
      dryRun: true,
    });
    expect(err(empty).code).toBe('BODY_REQUIRED');
  });

  it('an unmatched race goes to Undetermined / Unknown, with a warning, and Race / Species stays as given', async () => {
    const r = await call(
      compactPackage({
        name: 'Plan Starborn',
        status: 'authoritative',
        identity: ident({ race: 'Starborn' }),
        dryRun: true,
      }),
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.body.tree[0].parent).toBe('[INDEX] Undetermined / Unknown');
    expect(r.body.warnings.map((x: { code: string }) => x.code)).toContain('RACE_FALLBACK');
    expect(r.body.pages[0].facts).toContainEqual({ key: 'Race / Species', value: 'Starborn' });
    expect(r.body.heldTags).toContainEqual(expect.objectContaining({ slot: 'race', value: 'Starborn' }));
  });

  it('a character that exists is refused without target (CHARACTER_EXISTS, suggesting target)', async () => {
    const r = await call(compactPackage({ name: 'Nadira al-Khalid', dryRun: true }));
    expect(err(r).code).toBe('CHARACTER_EXISTS');
    expect(err(r).message).toMatch(/target/);
  });

  it('a monolith split is refused: steered to arkona_split_owner (v3 F3e)', async () => {
    const r = await call(
      compactPackage({
        name: 'Splitter',
        split: { from: 'Nadira al-Khalid - Character Core' },
        dryRun: true,
      }),
    );
    expect(err(r).code).toBe('USE_ARKONA_SPLIT');
    expect(err(r).useTool).toBe('arkona_split_owner');
  });
});

describe('tags: the Controlled Native Tagging Standard v1.8', () => {
  const rules = ARKONA_PACK.rules;
  const type = rules.types[0]!;
  const role = (r: string) => type.roles.find((x) => x.role === r)!;
  const tags = (r: string, o: Record<string, unknown>) =>
    computeTags({
      rules,
      role: role(r),
      page: 'p',
      status: 'authoritative',
      unestablished: 'Unestablished',
      ...o,
    });

  it('reproduces the standard’s own examples exactly', () => {
    expect(tags('core', { race: 'High Elf', culture: 'Menkheti' }).tags).toEqual([
      'CANON',
      'Character',
      'High Elf',
      'Menkheti',
    ]);
    expect(tags('relationship', {}).tags).toEqual(['CANON', 'Character', 'Relationship']);
    expect(tags('specialist', { specialist: 'Biography' }).tags).toEqual(['CANON', 'Character', 'Biography']);
    expect(tags('core', { race: 'Therian', culture: 'Therian' }).tags).toEqual([
      'CANON',
      'Character',
      'Therian',
    ]);
  });

  it('maps Draconic (True Dragons) to Draconic', () => {
    expect(tags('core', { race: 'True Dragon', culture: 'Draconic (True Dragons)' }).tags).toEqual([
      'CANON',
      'Character',
      'True Dragon',
      'Draconic',
    ]);
  });

  it('holds a slot with no mapping (reported, never invented) and never tags Unknown or Unestablished', () => {
    const r = tags('core', { race: 'Starborn', culture: 'Unestablished' });
    expect(r.tags).toEqual(['CANON', 'Character']);
    expect(r.held.map((h) => h.slot)).toEqual(['race', 'culture']);
    expect(tags('core', { race: 'Kami', culture: 'Menkheti' }).tags).toEqual([
      'CANON',
      'Character',
      'Kami',
      'Menkheti',
    ]);
  });

  it('a Working set: Working first, no CANON', () => {
    expect(
      computeTags({
        rules,
        role: role('core'),
        page: 'p',
        status: 'working',
        race: 'Sun Elf',
        culture: 'Menkheti',
      }).tags,
    ).toEqual(['Working', 'Character', 'Sun Elf', 'Menkheti']);
  });

  it('an index gets no tags', () => {
    expect(tags('index', {}).tags).toEqual([]);
  });
});

describe('governance drift', () => {
  it('a changed Tagging Standard stops tag computation (fail closed) until the owner approves again', async () => {
    w.editGovernance('tagging');
    const r = await call(compactPackage({ name: 'Drifty', dryRun: true }));
    expect(err(r).code).toBe('PACK_NOT_CURRENT');
    expect(err(r).preview.governance.state).toBe('changed');
    expect(err(r).preview.pages[0].tags).toEqual([]);
    expect(err(r).message).toMatch(/Controlled Native Tagging Standard/);
    const pack = w.stack.runtime.packs.get('arkona')!;
    expect(pack.drift?.changed.map((c) => c.key)).toEqual(['tagging-standard']);
    await w.stack.runtime.packs.commands.approve('owner', 'arkona');
    const again = await call(compactPackage({ name: 'Drifty', dryRun: true }));
    expect(again.isError, again.text).toBe(false);
    expect(again.body.governance.state).toBe('current');
  });
});

describe('a compact background character, end to end (scenario 1)', () => {
  it('one proposal; approved, one job; the page, its sidebar in template order, its tags and its text, verified', async () => {
    const p = await call(compactPackage({ name: 'Ashen Mori' }));
    expect(p.body.status, p.text).toBe('proposal_captured');
    expect(p.body.requiresCanonicalApproval).toBeUndefined();
    const proposal = w.stack.runtime.policy.proposals.get(String(p.body.proposalId))!;
    expect(proposal.requiresCanonicalApproval).toBe(false);
    const done = await approve(w, String(p.body.proposalId));
    expect(done.state).toBe('executed');
    expect(done.job?.status).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    const page = pageNamed('[BWRK] Ashen Mori - Character Reference')!;
    expect(parentName(page.name)).toBe('[INDEX] Working');
    expect(page.tags).toEqual(['Working', 'Character', 'Foxian', 'Fujimatsuan']);
    // Every native row kept, in template order, none added; Last Major Revision today.
    expect(w.sidebars.rows(page.id).map((r) => r.key)).toEqual(IDENTITY_KEYS);
    expect(rows(page.id)).toEqual(
      expect.arrayContaining([
        'Status=Working',
        'Continuity Type=CANON',
        'Continuity=Main',
        'Inheritance=None',
        'Subject=Ashen Mori',
        'Canonical Display Name=Ashen Mori',
        'Personal / Given Name=Ren',
        'Family / Surname=Asagiri',
        'Reference Type=Compact Character Reference',
        `Last Major Revision=${today()}`,
        'Supersedes=None',
      ]),
    );
    expect(blocksOf(page.id).map((b) => b.kind)[0]).toBe('heading');
    // The six gated fields were six separate checks.
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, done.jobId!)!;
    const steps = w.stack.runtime.engine.stepResults(PROJECT, job.id) ?? [];
    const verify = steps.find(
      (s) => (s.value as { verification?: { targets?: unknown[] } })?.verification?.targets,
    );
    const labels = (
      verify?.value as { verification: { targets: { label: string }[] } }
    ).verification.targets.map((t) => t.label);
    for (const k of [
      'Personal / Given Name',
      'Family / Surname',
      'Race / Species',
      'Naming Culture',
      'Life State',
      'Temporal Scope',
    ])
      expect(labels).toContain(`[BWRK] Ashen Mori - Character Reference: ${k}`);
    expect(labels).toContain('[BWRK] Ashen Mori - Character Reference: tags');
    expect(labels).toContain('[BWRK] Ashen Mori - Character Reference: sidebar rows');
  });
});

describe('an authoritative developed character with art and a relationship (scenario 2)', () => {
  it('a canonical proposal; the set in place; both participants link the Relationship; the images placed and verified', async () => {
    const s1 = await w.call('upload_image', {
      data_base64: fixture('alpha.png').toString('base64'),
      name: 'p1',
      stage: true,
      project: 'test',
    });
    const s2 = await w.call('upload_image', {
      data_base64: fixture('already.webp').toString('base64'),
      name: 'p2',
      stage: true,
      project: 'test',
    });
    const pkg = {
      name: 'Halime al-Sabri',
      depth: 'developed',
      status: 'authoritative',
      identity: {
        givenName: 'Halime',
        surname: 'al-Sabri',
        race: 'Sun Elf',
        namingCulture: 'Menkheti',
        lifeState: 'Alive at 5A 931',
        temporalScope: '5A 800 - 5A 931',
      },
      pages: [
        {
          role: 'core',
          scope: 'Sun elf magistrate',
          markdown: body('Identity and routing.', '## Identity\n\nA magistrate.\n\n'),
          dependencies: ['Sun Elves - Core Information'],
        },
        {
          role: 'specialist',
          title: 'Biography',
          specialistTag: 'Biography',
          scope: 'Her life',
          markdown: body('Her life.', '## Early Life\n\nThe south.\n\n'),
        },
        {
          role: 'specialist',
          title: 'Personality & Institutional Ethos',
          referenceType: 'Character Personality & Lifestyle Reference',
          specialistTag: 'Personality',
          scope: 'Her conduct',
          markdown: body('Conduct.'),
        },
        {
          role: 'art',
          scope: 'Visual references',
          markdown: body('The visual references.'),
          images: [
            {
              staged_id: s1.body.staged_id,
              label: 'Primary Reference - Character Portrait',
              interpretation: 'Her face and bearing.',
            },
            {
              staged_id: s2.body.staged_id,
              label: 'Outfit Reference - Court Robes',
              interpretation: 'Her court dress.',
            },
          ],
        },
        {
          role: 'relationship',
          with: 'Nadira al-Khalid',
          scope: 'Halime and Nadira',
          markdown: body('Colleagues.'),
        },
      ],
    };
    const dry = await call({ ...pkg, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.assets.map((a: { folder: string }) => a.folder)).toEqual([
      'Characters / Elves / Sun Elves / Halime al-Sabri',
      'Characters / Elves / Sun Elves / Halime al-Sabri',
    ]);
    expect(dry.body.assets.map((a: { name: string }) => a.name)).toEqual([
      'Halime al-Sabri - Primary Reference - Character Portrait',
      'Halime al-Sabri - Outfit Reference - Court Robes',
    ]);
    const p = await call(pkg);
    expect(p.body.status).toBe('proposal_captured');
    expect(p.body.requiresCanonicalApproval).toBe(true);
    // Nothing reached LegendKeeper's assets before approval.
    expect(w.lkUploads).toHaveLength(0);
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    const tree = [...w.repo.res.values()].filter((r) => r.name.includes('Halime'));
    expect(tree.map((r) => `${r.name} ← ${w.repo.res.get(r.parentId!)?.name}`).sort()).toEqual([
      '[BSRC] Halime al-Sabri & Nadira al-Khalid - Relationship ← [INDEX] Halime al-Sabri',
      '[BSRC] Halime al-Sabri - Biography ← [INDEX] Halime al-Sabri',
      '[BSRC] Halime al-Sabri - Character Art ← [INDEX] Halime al-Sabri',
      '[BSRC] Halime al-Sabri - Character Core ← [INDEX] Halime al-Sabri',
      '[BSRC] Halime al-Sabri - Personality & Institutional Ethos ← [INDEX] Halime al-Sabri',
      '[INDEX] Halime al-Sabri ← [INDEX] Sun Elves',
    ]);
    const core = pageNamed('[BSRC] Halime al-Sabri - Character Core')!;
    const rel = pageNamed('[BSRC] Halime al-Sabri & Nadira al-Khalid - Relationship')!;
    expect(core.tags).toEqual(['CANON', 'Character', 'Sun Elf', 'Menkheti']);
    expect(rel.tags).toEqual(['CANON', 'Character', 'Relationship']);
    expect(pageNamed('[BSRC] Halime al-Sabri - Biography')!.tags).toEqual([
      'CANON',
      'Character',
      'Biography',
    ]);
    expect(pageNamed('[BSRC] Halime al-Sabri - Character Art')!.tags).toEqual([
      'CANON',
      'Character',
      'Character Art',
    ]);
    // Both participants' identity pages list the Relationship in Related Sources.
    const related = (id: string) =>
      w.sidebars.pages
        .get(id)!
        .props.find((x) => x.title === 'Related Sources')!
        .items!.map((i) => i.resourceId);
    expect(related(core.id)).toContain(rel.id);
    expect(related(C.nadira)).toContain(rel.id);
    // The Core depends on the race's Core Information.
    expect(
      w.sidebars.pages
        .get(core.id)!
        .props.find((x) => x.title === 'Dependencies')!
        .items!.map((i) => i.resourceId),
    ).toEqual([C.sunCore]);
    // The images: in the mirrored folder (v3 F7: a new character's art page takes design pieces), verified, on the page.
    const art = pageNamed('[BSRC] Halime al-Sabri - Character Art')!;
    const imgs = blocksOf(art.id).filter((b) => b.kind === 'image');
    expect(imgs).toHaveLength(2);
    for (const id of [s1.body.staged_id, s2.body.staged_id]) {
      const row = w.stack.runtime.images.staged(PROJECT, id)!;
      expect(row).toMatchObject({ staged: false, storedVerified: true });
      expect(imgs.map((b) => b.url)).toContain(w.assets.assets.get(row.assetId!)!.url);
    }
    expect(w.stack.runtime.images.staged(PROJECT, s2.body.staged_id)!.folderId).toBe(
      w.assets.at('Characters', 'Elves', 'Sun Elves', 'Halime al-Sabri'),
    );
    // The index kept its template's collection block under Subpages.
    const idx = pageNamed('[INDEX] Halime al-Sabri')!;
    const ib = blocksOf(idx.id);
    const sub = ib.findIndex((b) => b.kind === 'heading' && JSON.stringify(b.content).includes('Subpages'));
    expect(ib[sub + 1]!.kind).toBe('resourceCollection');
    expect(JSON.stringify(ib)).not.toContain('Say what this index routes to');
  });
});

describe('the verify step', () => {
  it('records a planted difference on the job and the proposal (written, not as planned)', async () => {
    w.sidebars.mangle = (req, sb) => {
      const b = req.body as { content?: { text?: string }[] };
      if (b?.content?.[0]?.text === 'Velaran') {
        const kv = sb.props.find((p) => p.kind === 'keyValue')!;
        const row = kv.rows!.find((r) => JSON.stringify(r.content).includes('Velaran'));
        if (row) row.content = [{ text: 'Falkenreicher' }];
      }
    };
    try {
      const p = await call(
        compactPackage({ name: 'Planted Drift', identity: ident({ namingCulture: 'Velaran' }) }),
      );
      const done = await approve(w, String(p.body.proposalId));
      expect(done.job?.status).toBe('succeeded');
      const res = done.job?.result as { verified?: boolean };
      expect(res.verified).toBe(false);
      const proposal = w.stack.runtime.policy.proposals.detail(String(p.body.proposalId))!;
      expect(proposal.execution?.verified).toBe(false);
      expect(JSON.stringify(proposal.execution?.verification)).toContain('Naming Culture');
      // The page-level summary lists the new page first.
      expect(proposal.pageSummary[0]?.label).toMatch(
        /^New page \[BWRK\] Planted Drift - Character Reference/,
      );
    } finally {
      w.sidebars.mangle = null;
    }
  });
});

describe('two packages for one new name (CHARACTER_EXISTS inside the job)', () => {
  it('both proposed while it does not exist, approved in turn: one character, and one clean refusal before any write', async () => {
    const a = await call(compactPackage({ name: 'Twin Racer' }));
    const b = await call(compactPackage({ name: 'Twin Racer' }));
    expect(a.body.status, a.text).toBe('proposal_captured');
    expect(b.body.status).toBe('proposal_captured');
    const first = await approve(w, String(a.body.proposalId));
    expect(first.job?.status).toBe('succeeded');
    const writesBefore = w.stack.mock.calls.filter((c) => c.method !== 'GET').length;
    const second = await approve(w, String(b.body.proposalId));
    expect(second.job?.status).toBe('failed');
    expect(second.job?.lastError).toMatchObject({ code: 'CHARACTER_EXISTS' });
    expect(String(second.job?.lastError?.message)).toMatch(/target/);
    expect(w.stack.mock.calls.filter((c) => c.method !== 'GET').length).toBe(writesBefore);
    expect(
      [...w.repo.res.values()].filter((r) => r.deletedAt === null && r.name.includes('Twin Racer')),
    ).toHaveLength(1);
  });
});

describe('the pack and its tool', () => {
  it('refuses a project the pack is not attached to, and lists the tool only while it is attached to a served project', async () => {
    const packs = w.stack.runtime.packs;
    expect(packs.toolListed('arkona')).toBe(true);
    packs.store.detach('arkona', PROJECT);
    try {
      expect(packs.toolListed('arkona')).toBe(false);
      const client = await w.stack.connect();
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).not.toContain(TOOL);
      const r = await call(compactPackage({ name: 'Detached', dryRun: true }));
      expect(err(r).code).toBe('PACK_NOT_ATTACHED');
      await client.close();
    } finally {
      packs.commands.attach(
        'owner',
        'arkona',
        PROJECT,
        packs.attachment('arkona', PROJECT)?.templates ?? {
          index: 'tplindex',
          core: 'tplcore1',
          compact: 'tplcomp1',
          general: 'tplgen01',
          art: 'tplart01',
          relationship: 'tplrel01',
        },
      );
    }
    const client = await w.stack.connect();
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(TOOL);
    await client.close();
  });

  it('is always a proposal (the pack setting), even for a write-scope connection', async () => {
    const r = await call(compactPackage({ name: 'Always Proposed' }));
    expect(r.body.status).toBe('proposal_captured');
    expect([...w.repo.res.values()].some((x) => x.name.includes('Always Proposed'))).toBe(false);
  });

  it('the Working set is promoted later as one set (promote_page with subtree)', async () => {
    const p = await call({
      ...compactPackage({ name: 'Promote Me', depth: 'developed' }),
      pages: [
        { role: 'core', scope: 'x', markdown: body('Core.') },
        {
          role: 'specialist',
          title: 'Biography',
          specialistTag: 'Biography',
          scope: 'x',
          markdown: body('Life.'),
        },
      ],
    });
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status).toBe('succeeded');
    const idx = pageNamed('[INDEX] Promote Me')!;
    expect(idx.parentId).toBe(LIFECYCLE.working);
    const dry = await w.call('promote_page', {
      page: idx.id,
      subtree: true,
      destination: 'Foxians',
      dryRun: true,
      project: 'test',
    });
    expect(dry.isError, dry.text).toBe(false);
  });
});
