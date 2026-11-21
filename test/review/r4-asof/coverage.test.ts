/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * CR-2026-11-R4 pass 3: `arkona_as_of_coverage` agrees with `arkona_as_of` (ADR 0064 amendment 2, 1: "a character is in
 * 'readable birth' exactly when arkona_as_of finds a birth"; "a recorded death is flagged by the same resolver; attested
 * bounds are the identity page's, as as-of reads them"). F4.1's property, tried on F4b.1's live-run world plus the
 * hardest characters of this pass: a death only on another page, deaths that disagree, a birth taken through an alias,
 * a birth under a heading naming the marker, "Deceased (by …)", a Temporal Scope negation, a rebirth worded "born again".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  brief,
  heading,
  K,
  L,
  liveRunWorld,
  O,
  page,
  para,
  person,
  refresh,
  setRows,
  tools,
  type LiveWorld,
} from './helpers.js';

vi.setConfig({ testTimeout: 180_000 });

let w: LiveWorld;
let t: ReturnType<typeof tools>;

beforeAll(async () => {
  w = await liveRunWorld();
  const p = (
    id: string,
    name: string,
    v: Record<string, string>,
    extra: Partial<Parameters<typeof person>[1]> = {},
  ) => person(w, { id, name, given: name.split(' ')[0]!, family: 'Stand-in', v, ...extra });
  p('r4j01chr', 'Berengar Stand-in', { 'Temporal Scope': 'Born 4A 100', 'Life State': 'Alive' });
  page(w, {
    id: 'r4j01ann',
    name: '[BSRC] House of Berengar - Annals',
    parentId: O.alTibr,
    body: [para('j01p', 'Berengar Stand-in died in Falkenau in 4A 300.')],
  });
  p('r4j02chr', 'Cuthbert Stand-in', { 'Temporal Scope': '', 'Life State': 'Deceased' });
  page(w, {
    id: 'r4j02an1',
    name: '[BSRC] Falkenau Annals',
    parentId: O.alTibr,
    body: [
      para('j02p', 'Cuthbert Stand-in died in Falkenau in 4A 300.'),
      para('j02q', 'Cuthbert Stand-in was born in 4A 200.'),
    ],
  });
  page(w, {
    id: 'r4j02an2',
    name: '[BSRC] Northern Chronicle',
    parentId: O.alTibr,
    body: [para('j02r', 'Cuthbert Stand-in died in the north in 4A 310.')],
  });
  setRows(w, K.katsu, {
    Aliases: 'Rita von Katzen (4A 99-192); Yamato (from 4A 192); Katsuragi Yamato (from 4A 193)',
    'Temporal Scope': '',
  });
  person(w, {
    id: 'r4j03chr',
    core: 'r4j03idx',
    name: 'Hoshino Yamato',
    given: 'Yamato',
    family: 'Hoshino',
    v: { 'Temporal Scope': 'Born Isar 3rd, 4A 600' },
  });
  page(w, {
    id: 'r4j03bio',
    name: '[BSRC] Hoshino Yamato - Biography',
    parentId: 'r4j03idx',
    sidebar: { Subject: 'Hoshino Yamato' },
    body: [para('j03p', 'Yamato was born on Isar 3rd, 4A 600 in the Empire of Fujimatsu.')],
  });
  page(w, {
    id: 'r4j04ann',
    name: '[BSRC] House of Hohenfalk - Chronicle',
    parentId: O.alTibr,
    body: [para('j04p', 'Karl Tobias von Hohenfalk was born in 3A 150.')],
  });
  person(w, {
    id: 'r4j05chr',
    core: 'r4j05idx',
    name: 'Ostara Stand-in',
    given: 'Ostara',
    family: 'Stand-in',
    v: { 'Temporal Scope': '' },
  });
  page(w, {
    id: 'r4j05bio',
    name: '[BSRC] Ostara Stand-in - Biography',
    parentId: 'r4j05idx',
    sidebar: { Subject: 'Ostara Stand-in' },
    body: [
      heading('j05h', 'Birth and Upbringing (Current Canon, superseding the Pre-Rewrite History)'),
      para('j05p', 'Ostara Stand-in was born on Camue 1st, 4A 120 in the winter palace.'),
    ],
  });
  page(w, {
    id: 'r4j05old',
    name: '[BSRC] Winter Palace - Household Register',
    parentId: O.alTibr,
    body: [para('j05q', 'Ostara Stand-in was born in 4A 100.')],
  });
  p('r4j06chr', 'Notker Stand-in', { 'Temporal Scope': 'Born 4A 100', 'Life State': 'Deceased (by 5A 931)' });
  p('r4j07chr', 'Ulrike Stand-in', {
    'Temporal Scope': 'Born 4A 100; no longer alive in 5A 931',
    'Life State': '',
  });
  p('r4j08chr', 'Xaver Stand-in', {
    'Temporal Scope': 'Born 4A 100; born again 4A 300',
    'Life State': 'Alive',
  });
  p('r4j09chr', 'Liesel Stand-in', {
    'Temporal Scope': 'Born 4A 100',
    'Life State': 'Deceased by c. 5A 931',
  });
  void L;
  await refresh(w);
  t = tools(w);
}, 240_000);
afterAll(async () => {
  await w?.close();
});

/** Every Main CANON character's as-of answer (25 at a time) at a date. */
async function everyone(ids: readonly string[], date: string): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 25) {
    const b = await t.call('arkona_as_of', { characters: ids.slice(i, i + 25), date });
    (b.characters as any[]).forEach((a, j) => out.set(ids[i + j]!, a));
  }
  return out;
}
const bornText = (a: any): string | null =>
  a?.born && typeof a.born === 'object' && a.born.precision ? (a.born.value as string) : null;

describe('coverage agrees with as-of (F4.1’s property)', () => {
  it('AS-75: every Main CANON character is in "readable birth" exactly when arkona_as_of finds a birth, with the same value', async () => {
    const cov = await t.call('arkona_as_of_coverage', { detail: 'full' });
    const all = cov.byCharacter as any[];
    expect(all.length).toBe(cov.counts.characters);
    const asOf = await everyone(
      all.map((x) => x.identityPage as string),
      'now',
    );
    const disagree = all.filter((x) => {
      const b = bornText(asOf.get(x.identityPage));
      return (b !== null) !== (x.bucket === 'readableBirth') || (b !== null && x.birth.value !== b);
    });
    expect(
      disagree.map(
        (x) =>
          `${x.character}: coverage ${x.bucket} ${x.birth?.value ?? ''}; as-of ${brief(asOf.get(x.identityPage))}`,
      ),
    ).toEqual([]);
  });

  it('AS-77: the recorded-death flag counts exactly the characters arkona_as_of gives a death', async () => {
    const cov = await t.call('arkona_as_of_coverage', { detail: 'full' });
    const all = cov.byCharacter as any[];
    const asOf = await everyone(
      all.map((x) => x.identityPage as string),
      'now',
    );
    const withDeath = all.filter((x) => asOf.get(x.identityPage)?.died !== undefined).length;
    expect(cov.flags.recordedDeath).toBe(withDeath);
  });

  it('AS-76: a character coverage puts under "attested bounds only" (Jahan-Timur: "Attested through 5A 900", no birth) is read by arkona_as_of inside those bounds', async () => {
    const cov = await t.call('arkona_as_of_coverage', { detail: 'full' });
    const jahan = (cov.byCharacter as any[]).find((x) => x.identityPage === L.jahan);
    expect(jahan.bucket).toBe('attestedBoundsOnly');
    const a = await t.asOf(L.jahan, '5A 900');
    expect(a.state.value, brief(a)).toBe('Alive (recorded)');
  });
});
