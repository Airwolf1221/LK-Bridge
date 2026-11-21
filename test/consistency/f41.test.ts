/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * ADR 0064 amendment 2 and ADR 0065 amendment 1 (v3 F4.1): what the owner's assistant found checking the live tools on
 * 20 November 2026, against the REAL stack on the mock LegendKeeper (F4b.1's live-run world) and Arkona's own calendar.
 * Every value quoted below is the owner's, verbatim:
 *
 * 1. **Coverage agrees with `arkona_as_of`**: Elias Brenner's birth in his own page's prose ("Elias Brenner was born in
 *    Falkenau on Jehet 39th, 4A 100 (1,250,407 KCY)"), Varadi Bendeguz's in a Universal Chronology row ("Varadi Bendeguz
 *    is born in Varadyn Kiralysag | Selaphos 40th, 3A 78") and Mehrana al-Khalid's through her birth name ("Yasmin
 *    Arshama is born… | Camue 1st, 4A 100"), with no birth in their sidebars; and a property: every character for whom
 *    `arkona_as_of` finds a birth is in the "readable birth" bucket, and the reverse.
 * 2. **Alive phrasings**: Rashad al-Khalid ("Living and immortal at 5A 931; …"; "…; living at 5A 931"), Katsuragi Yamato
 *    ("Alive in 5A 931") and Iuno ("Born 1A 26,119; …; present 5A 931"); the death guard kept.
 * 3. **Aliases with bracketed notes**: Katsuragi Yamato ("Rita von Katzen (4A 99-192); Yamato (from 4A 192); Katsuragi
 *    Yamato (from 4A 193)") born on "Zahras 1st, 4A 99 (1,250,406 KCY) - Rita von Katzen, later Katsuragi Yamato, is born
 *    in Varadyn Kiralysag." (Varadyn - Historical Kingdom & Personal Union); Soraya bint al-Noor, Ishikawa Rei and Farzana
 *    Abd al-Khalid in `arkona_name_check`.
 * 4. **Race references**: High Elf, Human, Foxian, Faerie and Vitra to their "… - Core Information" pages under Races of
 *    Arkona.
 *
 * `F41_REPORT=1` prints the fixture results (the ADR's before and after table).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { aliasName, splitAliases } from '../../src/packs/naming/namesakes.js';
import { numberForms } from '../../src/consistency/service.js';
import { SidebarModel } from '../resources/world.js';
import { IDENTITY_KEYS } from '../packs/world.js';
import { O } from '../packs/f4a-world.js';
import { K } from './world.js';
import { L, liveRunWorld, type LiveWorld } from './live-world.js';

vi.setConfig({ testTimeout: 120_000 });

/** This file's own pages. */
const Q = {
  iuno: 'iunoref1',
  rei: 'reiref01',
  farzana: 'farzref1',
  varadyn: 'varadyn1',
  highElves: 'rchelf01',
  faeries: 'rcfae001',
  vitra: 'rcvit001',
  elf: 'stelf001',
  fox: 'stfox001',
  fae: 'stfae001',
  vit: 'stvit001',
} as const;

const YAMATO_ALIASES = 'Rita von Katzen (4A 99-192); Yamato (from 4A 192); Katsuragi Yamato (from 4A 193)';
const SORAYA_ALIASES = 'Takamori Ayame (birth); Ayame al-Jabaal (from 4A 47); …';
const VARADYN_LINE =
  'Zahras 1st, 4A 99 (1,250,406 KCY) - Rita von Katzen, later Katsuragi Yamato, is born in Varadyn Kiralysag.';
const ELIAS_PROSE = 'Elias Brenner was born in Falkenau on Jehet 39th, 4A 100 (1,250,407 KCY).';

const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });

let w: LiveWorld;

/** Sets sidebar rows of a page already in the world (an empty text clears a row). */
function setRows(id: string, rows: Record<string, string>): void {
  w.sidebars.outside(id, (sb) => {
    const props = sb.props.find((p) => p.title === 'PROPERTIES')!;
    for (const [key, text] of Object.entries(rows)) {
      const at = props.rows!.find((r) => r.key === key);
      if (at) at.content = [{ text }];
      else props.rows!.push({ id: `${id.slice(0, 4)}${key.length}x`, rank: 'zz', key, content: [{ text }] });
    }
  });
}

/** A Compact Character Reference with its identity sidebar (Main CANON, Authoritative). */
function person(id: string, name: string, given: string, family: string, v: Record<string, string>): void {
  w.repo.seed({
    id,
    name: `[BSRC] ${name} - Character Reference`,
    parentId: L.idx,
    referenceType: 'Compact Character Reference',
    canonical: name,
    tags: ['CANON', 'Character', 'Human'],
  });
  const all: Record<string, string> = {
    Status: 'Authoritative',
    'Continuity Type': 'CANON',
    Continuity: 'Main',
    Inheritance: 'None',
    Subject: name,
    'Canonical Display Name': name,
    'Personal / Given Name': given,
    'Family / Surname': family,
    'Naming Culture': 'Velaran',
    'Reference Type': 'Compact Character Reference',
    Scope: `${name}, a person of Arkona`,
    'Race / Species': 'Human',
    'Last Major Revision': '2026-11-01',
    Supersedes: 'None',
    ...v,
  };
  w.sidebars.page(id, [
    SidebarModel.kv(
      `kv${id}`.slice(0, 8),
      'PROPERTIES',
      IDENTITY_KEYS.map((k) => [k, all[k] ?? ''] as [string, string]),
    ),
    SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
    SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
    { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
  ]);
}

beforeAll(async () => {
  w = await liveRunWorld();
  // 1. The three births live only outside the identity pages' sidebars (as on Arkona).
  setRows(L.elias, { 'Temporal Scope': '' });
  w.setBody(L.elias, [para('el1', ELIAS_PROSE)]);
  setRows(L.varadi, { 'Temporal Scope': '' });
  setRows(L.mehrana, { 'Temporal Scope': '' });
  // 2. The live alive phrasings.
  setRows(K.rashad, {
    'Life State':
      'Living and immortal at 5A 931; immortality granted by Mehrana after apotheosis, exact date unresolved',
    'Temporal Scope':
      'Born Camue 44th, 4A 360; Sultan 4A 435-630; Khedive in Devlet-i Aliyye-i Mehraniye period; living at 5A 931',
  });
  person(Q.iuno, 'Iuno', 'Iuno', 'None', {
    'Life State': '',
    'Temporal Scope': 'Born 1A 26,119; Moon Empress from 1A 35,149; ascended 1A 88,993; present 5A 931',
  });
  // 3. Katsuragi Yamato: her aliases only in the Aliases field, with their notes; her birth only on the Varadyn page.
  w.repo.live(K.katsu)!.aliases = [];
  setRows(K.katsu, { Aliases: YAMATO_ALIASES, 'Life State': 'Alive in 5A 931', 'Temporal Scope': '' });
  w.repo.seed({
    id: Q.varadyn,
    name: '[BSRC] Varadyn - Historical Kingdom & Personal Union',
    parentId: O.alTibr,
    referenceType: 'Polity Reference',
    tags: ['CANON'],
  });
  w.setBody(Q.varadyn, [para('vd1', VARADYN_LINE)]);
  // F4b's own fixture gave "Rita von Katzen" a different birth (4A 305) on its nation page: out, so the Varadyn line is
  // the one restatement (two that disagree give no birth, as before).
  const nation = w.repo.blocks.get(w.mainOf(K.nation))!;
  w.setBody(
    K.nation,
    (nation.blocks as { id: string }[]).filter((b) => b.id !== 'nv3'),
  );
  setRows(K.soraya, { Aliases: SORAYA_ALIASES });
  person(Q.rei, 'Ishikawa Rei', 'Rei', 'Ishikawa', { Aliases: 'Mizuno Rei (birth name)' });
  person(Q.farzana, 'Farzana Abd al-Khalid', 'Farzana', 'Abd al-Khalid', {
    Aliases: 'Farzana al-Ruyan (earlier birth/family name)',
  });
  // 4. Races of Arkona as the owners' world has it (Humans and Foxians - Core Information already there), with High
  // Elves under the Elves group, and Faeries and Vitra; a stand-in of each race.
  for (const [id, plural, parent] of [
    [Q.highElves, 'High Elves', O.elvesGroup],
    [Q.faeries, 'Faeries', O.races],
    [Q.vitra, 'Vitra', O.races],
  ] as const)
    w.repo.seed({
      id,
      name: `[BSRC] ${plural} - Core Information`,
      parentId: parent,
      referenceType: 'Race Core Reference',
      tags: ['CANON', 'Species'],
    });
  for (const [id, given, race] of [
    [Q.elf, 'Aelith', 'High Elf'],
    [Q.fox, 'Kohaku', 'Foxian'],
    [Q.fae, 'Briar', 'Faerie'],
    [Q.vit, 'Senna', 'Vitra'],
  ] as const)
    person(id, `${given} Stand-in`, given, 'Stand-in', { 'Race / Species': race, 'Life State': 'Alive' });
  w.rebuildTree();
  await w.snapshot();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const call = async (tool: string, args: Record<string, unknown>) => {
  const r = await w.call(tool, { project: 'test', ...args });
  expect(r.isError, r.text).toBe(false);
  return r.body;
};
const asOf = async (character: string, date: string) =>
  (await call('arkona_as_of', { characters: [character], date })).characters[0];
const bornText = (a: any): string | null =>
  a?.born && typeof a.born === 'object' && a.born.precision ? a.born.value : null;

describe('the fixture results (F41_REPORT=1 prints them)', () => {
  it('reports', async () => {
    const cov = await call('arkona_as_of_coverage', { detail: 'full' });
    const out: Record<string, unknown> = { coverage: cov.counts };
    const nothingIds = (cov.nothingReadable as any[]).map((x) => x.identityPage.id);
    for (const [c, id] of [
      ['Elias Brenner', L.elias],
      ['Varadi Bendeguz', L.varadi],
      ['Mehrana al-Khalid', L.mehrana],
    ] as const)
      out[`coverage: ${c}`] = nothingIds.includes(id) ? 'nothing readable' : 'not in nothing readable';
    for (const c of ['Rashad al-Khalid', 'Katsuragi Yamato', 'Iuno']) {
      const a = await asOf(c, '5A 931');
      out[`state: ${c} at 5A 931`] = a?.state?.value ?? a?.refused?.code;
    }
    const y = (await call('arkona_as_of', { characters: [K.katsu], date: '5A 931' })).characters[0];
    out['born: Katsuragi Yamato'] = bornText(y) ?? y.born;
    for (const n of [
      'Rita von Katzen',
      'Takamori Ayame',
      'Ayame al-Jabaal',
      'Mizuno Rei',
      'Farzana al-Ruyan',
    ]) {
      const b = await call('arkona_name_check', { name: n });
      out[`name_check: ${n}`] = (b.namesakes as any[])
        .filter((x) => (x.matched as any[]).some((m) => m.part === 'alias'))
        .map((x) => x.character);
    }
    for (const c of [
      'Aelith Stand-in',
      'Yasmin al-Naim',
      'Kohaku Stand-in',
      'Briar Stand-in',
      'Senna Stand-in',
    ]) {
      const a = await asOf(c, '5A 931');
      out[`race: ${c}`] = a.raceReference?.page?.name ?? a.raceReference?.note ?? null;
    }
    if (process.env.F41_REPORT === '1') process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    expect(out).toBeDefined();
  });
});

describe('1. coverage agrees with arkona_as_of (one resolver)', () => {
  it('Elias Brenner (his own prose), Varadi Bendeguz (a chronology row) and Mehrana al-Khalid (her birth name in a row) are readable births in both', async () => {
    const cov = await call('arkona_as_of_coverage', { detail: 'full' });
    const by = new Map((cov.byCharacter as any[]).map((x) => [x.identityPage, x]));
    for (const [id, value, source] of [
      [L.elias, 'Jehet 39th, 4A 100', 'prose'],
      [L.varadi, 'Selaphos 40th, 3A 78', 'chronology'],
      [L.mehrana, 'Camue 1st, 4A 100', 'chronology'],
    ] as const) {
      expect(by.get(id), id).toMatchObject({ bucket: 'readableBirth', birth: { value, source } });
      expect((cov.nothingReadable as any[]).map((x) => x.identityPage.id)).not.toContain(id);
      expect(bornText(await asOf(id, '5A 931')), id).toBe(value);
    }
    expect((await asOf('Elias Brenner', '5A 931')).born.excerpt).toBe(ELIAS_PROSE);
  });

  it('property: every Main CANON character with a birth in arkona_as_of is in the readable-birth bucket, and the reverse', async () => {
    const cov = await call('arkona_as_of_coverage', { detail: 'full' });
    const all = cov.byCharacter as any[];
    expect(all.length).toBe(cov.counts.characters);
    expect(all.length).toBeGreaterThan(50);
    const ids = all.map((x) => x.identityPage as string);
    const born = new Map<string, string | null>();
    for (let i = 0; i < ids.length; i += 25) {
      const b = await call('arkona_as_of', { characters: ids.slice(i, i + 25), date: 'now' });
      (b.characters as any[]).forEach((a, j) => born.set(ids[i + j]!, bornText(a)));
    }
    for (const x of all) {
      const asOfBirth = born.get(x.identityPage);
      expect(asOfBirth !== null, `${x.character}: as-of ${asOfBirth}, coverage ${x.bucket}`).toBe(
        x.bucket === 'readableBirth',
      );
      if (asOfBirth !== null) expect(x.birth.value, x.character).toBe(asOfBirth);
    }
    // The buckets still add up.
    const c = cov.counts;
    expect(c.readableBirth + c.birthUnestablished + c.attestedBoundsOnly + c.nothingReadable).toBe(
      c.characters,
    );
  });
});

describe('2. alive phrasings (pack data)', () => {
  it('Rashad al-Khalid ("Living and immortal at 5A 931; …"; "living at 5A 931"): Alive (recorded) at 5A 931', async () => {
    const a = await asOf('Rashad al-Khalid', '5A 931');
    expect(a.state.value).toBe('Alive (recorded)');
    expect(a.born).toMatchObject({ value: 'Camue 44th, 4A 360' });
    expect((await asOf('Rashad al-Khalid', '4A 500')).state.value).toBe('Alive (recorded)');
    expect((await asOf('Rashad al-Khalid', '4A 300')).state.value).toBe('Unestablished');
  });

  it('Katsuragi Yamato ("Alive in 5A 931"): Alive (recorded) at 5A 931, from her recorded birth', async () => {
    const a = await asOf('Katsuragi Yamato', '5A 931');
    expect(a.state.value).toBe('Alive (recorded)');
    expect(a.state.why).toMatch(/between the recorded birth and 5A 931 \(the date the Life State gives\)/);
    expect((await asOf('Katsuragi Yamato', '4A 90')).state.value).toBe('Unestablished');
  });

  it('Iuno ("…; present 5A 931"): Alive (recorded) at 5A 931, inside the attested span from her birth', async () => {
    const a = await asOf('Iuno', '5A 931');
    expect(a.state).toMatchObject({ value: 'Alive (recorded)', why: 'inside the attested span' });
    expect(a.born).toMatchObject({ value: '1A 26,119' });
  });

  it('the death guard is kept: a recorded death wins inside its span ("Living" after a death with no return)', async () => {
    setRows(Q.vit, { 'Life State': 'Living', 'Temporal Scope': 'Born 4A 100; died 4A 150' });
    w.rebuildTree();
    await w.snapshot();
    expect((await asOf('Senna Stand-in', '4A 120')).state.value).toBe('Alive (recorded)');
    expect((await asOf('Senna Stand-in', '4A 300')).state.value).toBe(
      'Unestablished (recorded death; current Life State Living)',
    );
    expect((await asOf('Senna Stand-in', 'now')).state.value).not.toBe('Alive (recorded)');
  });
});

describe('3. aliases with bracketed notes (one shared parser)', () => {
  it('splits on ";" and drops the trailing notes', () => {
    expect(splitAliases(YAMATO_ALIASES)).toEqual(['Rita von Katzen', 'Yamato', 'Katsuragi Yamato']);
    expect(splitAliases(SORAYA_ALIASES)).toEqual(['Takamori Ayame', 'Ayame al-Jabaal']);
    expect(splitAliases('Mizuno Rei (birth name)')).toEqual(['Mizuno Rei']);
    expect(splitAliases('Farzana al-Ruyan (earlier birth/family name)')).toEqual(['Farzana al-Ruyan']);
    // A note's date may hold a comma; a bracket that is part of a name stays.
    expect(splitAliases('Ayame (from Zahras 1st, 4A 47); Leopold (the Elder)')).toEqual([
      'Ayame',
      'Leopold (the Elder)',
    ]);
    expect(aliasName('Rita von Katzen (birth) (4A 99-192)')).toBe('Rita von Katzen');
  });

  it('Katsuragi Yamato’s birth is Zahras 1st, 4A 99, from the Varadyn line ("later Katsuragi Yamato" an appositive)', async () => {
    const a = await asOf('Katsuragi Yamato', '5A 931');
    expect(a.born).toMatchObject({
      value: 'Zahras 1st, 4A 99',
      page: { id: Q.varadyn, name: '[BSRC] Varadyn - Historical Kingdom & Personal Union' },
      source: 'prose',
    });
    // The bare alias names her too.
    expect((await asOf('Rita von Katzen', '5A 931')).character).toBe('Katsuragi Yamato');
  });

  it('each bare alias matches in arkona_name_check', async () => {
    for (const [name, who] of [
      ['Rita von Katzen', 'Katsuragi Yamato'],
      ['Yamato', 'Katsuragi Yamato'],
      ['Takamori Ayame', 'Soraya bint al-Noor'],
      ['Ayame al-Jabaal', 'Soraya bint al-Noor'],
      ['Mizuno Rei', 'Ishikawa Rei'],
      ['Farzana al-Ruyan', 'Farzana Abd al-Khalid'],
    ] as const) {
      const b = await call('arkona_name_check', { name });
      const hit = (b.namesakes as any[]).find((x) => x.character === who);
      expect(hit, name).toBeDefined();
      expect(hit.matched, name).toEqual(
        expect.arrayContaining([expect.objectContaining({ part: 'alias', theirs: name })]),
      );
    }
  });
});

describe('4. race reference links (singular and plural)', () => {
  it('High Elf, Human, Foxian, Faerie and Vitra each link their Core Information page under Races of Arkona', async () => {
    for (const [c, page] of [
      ['Aelith Stand-in', '[BSRC] High Elves - Core Information'],
      ['Yasmin al-Naim', '[BSRC] Humans - Core Information'],
      ['Kohaku Stand-in', '[BSRC] Foxians - Core Information'],
      ['Briar Stand-in', '[BSRC] Faeries - Core Information'],
      ['Senna Stand-in', '[BSRC] Vitra - Core Information'],
    ] as const)
      expect((await asOf(c, '5A 931')).raceReference, c).toMatchObject({ page: { name: page } });
  });

  it('the number forms', () => {
    expect([...numberForms('high elves')]).toContain('high elf');
    expect([...numberForms('humans')]).toContain('human');
    expect([...numberForms('faeries')]).toContain('faerie');
    expect([...numberForms('foxian')]).toContain('foxians');
    expect([...numberForms('vitra')]).toContain('vitra');
  });
});
