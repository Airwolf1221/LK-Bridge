/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * v3 F4a (ADR 0063): `arkona_name_check` and the namesake part of `arkona_create_character` and `arkona_rename`, against
 * the REAL stack on the mock LegendKeeper (test/packs/f4a-world.ts). Namesakes by full name (in either order), given
 * name, surname and alias, normalised for case, accents and prefixes; `exclude`; the naming culture through the culture
 * map to its owner under Arkonan Cultures, its naming section (cut with a handle) and its members; an unmapped culture;
 * and never an inference from a name. Free: no LegendKeeper read.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { matchNames, nameKeyOf } from '../../src/packs/naming/namesakes.js';
import { C, F, f4aWorld, type F4aWorld } from './f4a-world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: F4aWorld;
beforeAll(async () => {
  w = await f4aWorld();
  await w.snapshot();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const check = async (args: Record<string, unknown>) => {
  const r = await w.call('arkona_name_check', { project: 'test', ...args });
  expect(r.isError, r.text).toBe(false);
  return r.body;
};
const names = (body: Record<string, any>) => (body.namesakes as any[]).map((n) => n.character);
const one = (body: Record<string, any>, character: string) =>
  (body.namesakes as any[]).find((n) => n.character === character);

describe('arkona_name_check: namesakes', () => {
  it('an exact full-name match is a warning; the surname another character shares is info', async () => {
    const before = w.reads();
    const b = await check({ name: 'Nadira al-Khalid' });
    expect(w.reads()).toBe(before);
    const nadira = one(b, 'Nadira al-Khalid');
    expect(nadira).toMatchObject({
      severity: 'warning',
      lifecycle: 'Authoritative',
      labels: ['Authoritative'],
      identityPage: {
        id: C.nadira,
        name: '[BSRC] Nadira al-Khalid - Character Core',
        role: 'Character Core',
      },
      namingCulture: 'Menkheti',
      lifeState: 'Alive at 5A 931',
      matched: [
        { part: 'full name', yours: 'Nadira al-Khalid', theirs: 'Nadira al-Khalid', severity: 'warning' },
      ],
    });
    // Mehrana I and II share the surname (a word of the name): info, never a warning.
    for (const m of ['Mehrana I al-Khalid', 'Mehrana II al-Khalid'])
      expect(one(b, m)).toMatchObject({
        severity: 'info',
        matched: [{ part: 'surname', theirs: 'al-Khalid' }],
      });
    expect(b.counts).toMatchObject({ warning: 1, info: 2, total: 3 });
    expect(b.rule).toMatch(/never suggests or infers a naming culture/);
  });

  it('a given name and a surname each match as info (punctuation and case aside)', async () => {
    const given = await check({ givenName: 'mehrana' });
    expect(names(given).sort()).toEqual(['Mehrana I al-Khalid', 'Mehrana II al-Khalid']);
    expect(given.namesakes[0].matched).toEqual([
      { part: 'given name', yours: 'mehrana', theirs: 'Mehrana', severity: 'info' },
    ]);
    const surname = await check({ surname: 'Al Khalid' });
    expect(names(surname).sort()).toEqual([
      'Mehrana I al-Khalid',
      'Mehrana II al-Khalid',
      'Nadira al-Khalid',
    ]);
    expect((surname.namesakes as any[]).every((n) => n.severity === 'info')).toBe(true);
  });

  it('an alias: a full name that is another character’s alias is a warning; an alias in common is info', async () => {
    const b = await check({ name: 'Mehrana al-Khalid' });
    for (const m of ['Mehrana I al-Khalid', 'Mehrana II al-Khalid'])
      expect(one(b, m)).toMatchObject({
        severity: 'warning',
        matched: [
          {
            part: 'alias',
            theirs: 'Mehrana al-Khalid',
            how: 'your full name is their alias',
            severity: 'warning',
          },
        ],
      });
    const alias = await check({ name: 'Hoshi Tsuru', aliases: ['the silver crane'] });
    expect(one(alias, 'Tsubame Hoshizora')).toMatchObject({
      severity: 'info',
      matched: [{ part: 'alias', yours: 'the silver crane', theirs: 'The Silver Crane' }],
    });
  });

  it('East Asian order both ways: “Miyabi Asagiri” finds Asagiri Miyabi; “Hoshizora Tsubame” and “Miyuki Kamigawa” the reverse', async () => {
    // Asagiri Miyabi is written family name first, with no name parts recorded: the two words in the other order.
    const a = await check({ name: 'Miyabi Asagiri' });
    expect(one(a, 'Asagiri Miyabi')).toMatchObject({
      severity: 'warning',
      matched: [
        {
          part: 'full name',
          yours: 'Miyabi Asagiri',
          theirs: 'Asagiri Miyabi',
          how: 'the same two names in the other order',
        },
      ],
    });
    // Tsubame Hoshizora is written given name first; Kamigawa Miyuki family name first: their recorded parts, reversed.
    const b = await check({ name: 'Hoshizora Tsubame' });
    expect(one(b, 'Tsubame Hoshizora')).toMatchObject({
      severity: 'warning',
      matched: [{ part: 'full name', theirs: 'Tsubame Hoshizora', how: 'the same names in the other order' }],
    });
    const c = await check({ name: 'Miyuki Kamigawa' });
    expect(one(c, 'Kamigawa Miyuki')).toMatchObject({
      severity: 'warning',
      matched: [{ part: 'full name', theirs: 'Kamigawa Miyuki', how: 'the same names in the other order' }],
    });
    // The parts alone find it as written, whichever order the name is presented in.
    const parts = await check({ givenName: 'Tsubame', surname: 'Hoshizora' });
    expect(one(parts, 'Tsubame Hoshizora').matched[0]).toMatchObject({
      part: 'full name',
      theirs: 'Tsubame Hoshizora',
    });
    expect(one(parts, 'Tsubame Hoshizora').matched[0].how).toBeUndefined();
    // The answer points to the presentation standard; the bridge never decides an order.
    expect(a.presentation).toMatchObject({ standard: 'East Asian Personal Name Presentation Standard' });
    expect(a.presentation.note).toMatch(/both orders/);
  });

  it('accents and prefixes are ignored', async () => {
    const b = await check({ name: '[BSRC] Eloise FERRE' });
    expect(one(b, 'Éloïse Ferré')).toMatchObject({
      severity: 'warning',
      matched: [{ part: 'full name', theirs: 'Éloïse Ferré' }],
    });
    expect(nameKeyOf('[BWRK] Éloïse  Ferré')).toBe('eloise ferre');
  });

  it('exclude leaves a character out (the one being renamed is not its own namesake)', async () => {
    for (const exclude of [[C.nadira], ['Nadira al-Khalid']]) {
      const b = await check({ name: 'Nadira al-Khalid', exclude });
      expect(names(b)).not.toContain('Nadira al-Khalid');
      expect(b.query.excluded).toEqual([C.nadira]);
    }
  });

  it('labels each namesake (Working, AU) and never lists an Archived character', async () => {
    expect(one(await check({ givenName: 'Kaito' }), 'Kaito of the Shattered Sky')).toMatchObject({
      lifecycle: 'Authoritative',
      labels: ['Authoritative', 'AU'],
    });
    expect(one(await check({ givenName: 'Tamsin' }), 'Tamsin Reed')).toMatchObject({
      lifecycle: 'Working',
      labels: ['Working'],
    });
    const archived = await check({ name: 'Seren Vale' });
    expect(archived.namesakes).toEqual([]);
    expect(archived.inspected.leftOut.archived).toBeGreaterThanOrEqual(1);
  });
});

describe('arkona_name_check: the naming culture', () => {
  it('resolves through the culture map to its owner under Arkonan Cultures: its naming section (cut, with a handle) and its members', async () => {
    const before = w.reads();
    const b = await check({ namingCulture: 'fujimatsuan' });
    expect(w.reads()).toBe(before);
    const c = b.namingCulture;
    expect(c).toMatchObject({ value: 'fujimatsuan', mapped: true, token: 'Fujimatsuan' });
    expect(c.owners).toHaveLength(1);
    const owner = c.owners[0];
    expect(owner).toMatchObject({ id: F.fujimatsuan, name: '[BSRC] Fujimatsuan - Culture Reference' });
    expect(owner.namingSections).toHaveLength(1);
    const section = owner.namingSections[0];
    expect(section.heading).toBe('Naming Conventions');
    expect(section.cut).toBe(true);
    expect(section.markdown).toMatch(
      /^## Naming Conventions\n\nA Fujimatsuan name is given family name first/,
    );
    expect(typeof section.handle).toBe('string');
    // The whole section (its "Given Names" subsection included) is behind the handle.
    const page = await w.call('bridge_result_page', { handle: section.handle, project: 'test' });
    expect(page.isError, page.text).toBe(false);
    expect(page.text).toContain('Given names are two syllables');
    // The characters recorded with it, with their names (an AU one labelled).
    const members = c.members.characters.map((m: any) => m.character).sort();
    expect(members).toEqual(['Kaito of the Shattered Sky', 'Kamigawa Miyuki', 'Tsubame Hoshizora']);
    expect(
      c.members.characters.find((m: any) => m.character === 'Kaito of the Shattered Sky').labels,
    ).toEqual(['Authoritative', 'AU']);
    // No name was asked about: no namesakes are listed.
    expect(b.namesakes).toBeUndefined();
  });

  it('reports an unmapped culture as such, and looks for no owner', async () => {
    const b = await check({ namingCulture: 'Lunarian' });
    expect(b.namingCulture).toMatchObject({ value: 'Lunarian', mapped: false });
    expect(b.namingCulture.note).toMatch(/not in the pack’s culture map/);
    expect(b.namingCulture.owners).toBeUndefined();
  });
});

describe('arkona_name_check: never an inference', () => {
  it('a surname with an obvious etymology suggests no culture, race or nationality', async () => {
    const b = await check({ name: 'Hiroshi Takahashi', surname: 'Takahashi' });
    expect(b.namesakes).toEqual([]);
    expect(b.namingCulture).toBeUndefined();
    const text = JSON.stringify(b);
    // No culture or race token of the pack's maps appears anywhere, and nothing is offered as a guess.
    for (const token of ['Fujimatsuan', 'Menkheti', 'Velaran', 'Human', 'Foxian', 'Japanese'])
      expect(text, token).not.toContain(token);
    expect(text).not.toMatch(/suggest(ed|ion)s?"|likely|probabl|infer(red)?"/i);
    expect(b.rule).toMatch(/never suggests or infers/);
  });

  it('matches only what is written: the order of a name is never decided by its culture', () => {
    const usable = (v: string) => v.trim() !== '';
    const theirs = { full: ['Miyabi Asagiri'], given: 'Miyabi', surname: 'Asagiri', aliases: [] };
    expect(matchNames({ name: 'Asagiri Miyabi' }, theirs, usable)[0]).toMatchObject({
      part: 'full name',
      how: 'the same names in the other order',
    });
    // Two words in the other order with no parts recorded on either side still match.
    expect(
      matchNames(
        { name: 'Ren Asagiri' },
        { full: ['Asagiri Ren'], given: null, surname: null, aliases: [] },
        usable,
      )[0],
    ).toMatchObject({ part: 'full name', how: 'the same two names in the other order' });
    // A deliberate gap is never a name.
    expect(
      matchNames(
        { surname: 'Unestablished' },
        { full: ['Kaito'], given: 'Kaito', surname: 'Unestablished', aliases: [] },
        (v) => v !== 'Unestablished',
      ),
    ).toEqual([]);
  });
});

describe('the namesake part of arkona_create_character and arkona_rename', () => {
  it('arkona_create_character: an exact full-name match is a warning in the preview and in the proposal’s summary; never a refusal', async () => {
    const pkg = {
      name: 'Hoshizora Tsubame',
      depth: 'compact',
      identity: {
        givenName: 'Tsubame',
        surname: 'Hoshizora',
        race: 'Human',
        namingCulture: 'Fujimatsuan',
        lifeState: 'Alive at 5A 931',
        temporalScope: '5A 910 - 5A 931',
      },
      pages: [
        {
          role: 'compact',
          scope: 'A shrine dancer',
          markdown:
            '## Purpose\n\nThe compact reference for Hoshizora Tsubame, a shrine dancer.\n\n## Source Boundaries\n\nIdentity only.\n\n## Unresolved Material\n\nNone yet.\n',
        },
      ],
      project: 'test',
    };
    const dry = await w.call('arkona_create_character', { ...pkg, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    const warning = (dry.body.warnings as any[]).find((x) => x.code === 'NAMESAKE');
    expect(warning.message).toMatch(
      /Tsubame Hoshizora \(Authoritative; Naming Culture Fujimatsuan; Life State Alive at 5A 931\)/,
    );
    // The parts the package gives (Tsubame, Hoshizora) are that character's name as written.
    expect(warning.message).toMatch(/full name “Tsubame Hoshizora”/);
    expect(warning.message).toMatch(/nothing is refused/);
    expect(dry.body.namesakes.warning).toBe(1);
    const real = await w.call('arkona_create_character', pkg);
    expect(real.isError, real.text).toBe(false);
    expect(real.body.status).toBe('proposal_captured');
    const p = w.stack.runtime.policy.proposals.get(real.body.proposalId)!;
    expect(p.summary).toMatch(/namesake: Tsubame Hoshizora \(Authoritative\) already goes by this name/);
    expect(JSON.stringify(real.body.warnings)).toMatch(/NAMESAKE/);
  });

  it('arkona_rename: the new name’s namesakes (the subject left out) warn in the preview and the proposal', async () => {
    const args = {
      subject: C.working,
      newName: 'Miyuki Kamigawa',
      given: 'Miyuki',
      family: 'Kamigawa',
      project: 'test',
    };
    const dry = await w.call('arkona_rename', { ...args, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    const warning = (dry.body.warnings as any[]).find((x) => x.code === 'NAMESAKE');
    expect(warning.message).toMatch(/Kamigawa Miyuki \(Authoritative; Naming Culture Fujimatsuan/);
    expect(dry.body.namesakes.map((n: any) => n.character)).toContain('Kamigawa Miyuki');
    expect(dry.body.namesakes.map((n: any) => n.character)).not.toContain('Tamsin Reed');
    const real = await w.call('arkona_rename', args);
    expect(real.isError, real.text).toBe(false);
    const p = w.stack.runtime.policy.proposals.get(real.body.proposalId)!;
    expect(p.summary).toMatch(/namesake: Kamigawa Miyuki \(Authoritative\) already goes by this name/);
    // The proposal's operation, as the owner reviews it, carries the warning and the namesakes.
    const detail = w.stack.runtime.policy.proposals.detail(real.body.proposalId)!;
    expect(detail.operationDetail).toMatchObject({
      warnings: [expect.stringMatching(/Kamigawa Miyuki/)],
      namesakes: expect.arrayContaining([expect.objectContaining({ character: 'Kamigawa Miyuki' })]),
    });
  });
});
