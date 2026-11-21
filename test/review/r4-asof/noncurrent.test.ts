/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * CR-2026-11-R4 pass 3: the non-current exclusion (ADR 0064 amendment 1, F: "Pre-Rewrite" and "Author-Facing" sections
 * and rows, switched on by the owner's ruling) never hides current canon, and never lets pre-rewrite material through as
 * current. Modelled on the owner's live headings ("Key Life Transitions - Author-Facing Pre-Rewrite History", "Birth,
 * Upbringing and Magical Reputation - Pre-Rewrite", "Birth and Upbringing") and the row "(author-facing pre-rewrite
 * provenance)". Each test asserts the SAFE answer; failing means current canon was hidden (and the tool answered on what
 * was left), or pre-rewrite material was read as current.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  brief,
  chronologyRows,
  heading,
  L,
  liveRunWorld,
  O,
  page,
  para,
  person,
  refresh,
  tools,
  type LiveWorld,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

const Q = {
  ostaraIdx: 'r4g59idx',
  ostara: 'r4g59chr',
  ostaraBio: 'r4g59bio',
  ostaraOld: 'r4g59old',
  ostCtrlIdx: 'r4g59cix',
  ostCtrl: 'r4g59cch',
  ostCtrlBio: 'r4g59cbi',
  ostCtrlOld: 'r4g59cod',
  pankrazIdx: 'r4g60idx',
  pankraz: 'r4g60chr',
  pankrazBio: 'r4g60bio',
  quirinIdx: 'r4g61idx',
  quirin: 'r4g61chr',
  quirinBio: 'r4g61bio',
  quiCtrlIdx: 'r4g61cix',
  quiCtrl: 'r4g61cch',
  quiCtrlBio: 'r4g61cbi',
  ulfIdx: 'r4g78idx',
  ulf: 'r4g78chr',
  ulfBio: 'r4g78bio',
  reinhild: 'r4g62chr',
  reinCtrl: 'r4g62cch',
  rowMarked: 'r4g62row',
  rowPlain: 'r4g62crw',
  siegIdx: 'r4g63idx',
  sieg: 'r4g63chr',
  siegBio: 'r4g63bio',
  siegCtrlIdx: 'r4g63cix',
  siegCtrl: 'r4g63cch',
  siegCtrlBio: 'r4g63cbi',
  theodoIdx: 'r4g64idx',
  theodo: 'r4g64chr',
  theodoBio: 'r4g64bio',
} as const;

let w: LiveWorld;
let t: ReturnType<typeof tools>;

/** A Core with its own index and a Biography under it (its own page) holding `body`. */
function withBio(
  idx: string,
  id: string,
  bio: string,
  name: string,
  v: Record<string, string>,
  body: unknown[],
) {
  const given = name.split(' ')[0]!;
  person(w, { id, core: idx, name, given, family: 'Stand-in', v });
  page(w, { id: bio, name: `[BSRC] ${name} - Biography`, parentId: idx, sidebar: { Subject: name }, body });
}

beforeAll(async () => {
  w = await liveRunWorld();
  // AS-59: the current birth under a current heading that names the marker; a page not updated since keeps the old one.
  withBio(
    Q.ostaraIdx,
    Q.ostara,
    Q.ostaraBio,
    'Ostara Stand-in',
    { 'Temporal Scope': '', 'Life State': 'Alive' },
    [
      heading('g59a', 'Birth and Upbringing (Current Canon, superseding the Pre-Rewrite History)'),
      para('g59b', 'Ostara Stand-in was born on Camue 1st, 4A 120 in the winter palace.'),
    ],
  );
  page(w, {
    id: Q.ostaraOld,
    name: '[BSRC] Winter Palace - Household Register',
    parentId: O.alTibr,
    body: [para('g59c', 'Ostara Stand-in was born in 4A 100.')],
  });
  // Its control: the same with the owner's plain current heading.
  withBio(
    Q.ostCtrlIdx,
    Q.ostCtrl,
    Q.ostCtrlBio,
    'Osric Stand-in',
    { 'Temporal Scope': '', 'Life State': 'Alive' },
    [
      heading('g59d', 'Birth and Upbringing'),
      para('g59e', 'Osric Stand-in was born on Camue 1st, 4A 120 in the winter palace.'),
    ],
  );
  page(w, {
    id: Q.ostCtrlOld,
    name: '[BSRC] Summer Palace - Household Register',
    parentId: O.alTibr,
    body: [para('g59f', 'Osric Stand-in was born in 4A 100.')],
  });
  // AS-60: the marker only in the sentence's own words.
  withBio(
    Q.pankrazIdx,
    Q.pankraz,
    Q.pankrazBio,
    'Pankraz Stand-in',
    { 'Temporal Scope': 'Born 4A 100; attested through 4A 500' },
    [
      heading('g60a', 'Death'),
      para('g60b', 'Pankraz Stand-in died in Falkenau in 4A 300 (as the pre-rewrite draft also had it).'),
    ],
  );
  // AS-61: an "Author-Facing Notes" heading inside an expand, then the current death below it at the top level.
  withBio(
    Q.quirinIdx,
    Q.quirin,
    Q.quirinBio,
    'Quirin Stand-in',
    { 'Temporal Scope': 'Born 4A 100; attested through 4A 500' },
    [
      heading('g61a', 'Life'),
      {
        id: 'g61b',
        kind: 'expand',
        title: 'Notes for the author',
        children: [
          heading('g61c', 'Author-Facing Notes', 3),
          para('g61d', 'The first draft had him live on.'),
        ],
      },
      para('g61e', 'Quirin Stand-in died in the siege of Falkenau in 4A 300.'),
    ],
  );
  withBio(
    Q.quiCtrlIdx,
    Q.quiCtrl,
    Q.quiCtrlBio,
    'Quintus Stand-in',
    { 'Temporal Scope': 'Born 4A 100; attested through 4A 500' },
    [heading('g61f', 'Life'), para('g61g', 'Quintus Stand-in died in the siege of Falkenau in 4A 300.')],
  );
  // AS-78: the same through a two-column layout (the author's notes, with their heading, in the first column).
  withBio(
    Q.ulfIdx,
    Q.ulf,
    Q.ulfBio,
    'Ulf Stand-in',
    { 'Temporal Scope': 'Born 4A 100; attested through 4A 500' },
    [
      heading('g78a', 'Life'),
      {
        id: 'g78b',
        kind: 'layout',
        children: [
          {
            id: 'g78c',
            kind: 'layoutColumn',
            children: [
              heading('g78d', 'Author-Facing Notes', 3),
              para('g78e', 'The first draft had him live on.'),
            ],
          },
          {
            id: 'g78f',
            kind: 'layoutColumn',
            children: [para('g78g', 'Ulf Stand-in died in the siege of Falkenau in 4A 300.')],
          },
        ],
      },
    ],
  );
  // AS-62: a Universal Chronology row whose note quotes the marker, and its control.
  person(w, {
    id: Q.reinhild,
    name: 'Reinhild Stand-in',
    given: 'Reinhild',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; attested through 4A 500', 'Life State': 'Deceased' },
  });
  person(w, {
    id: Q.reinCtrl,
    name: 'Reinmar Stand-in',
    given: 'Reinmar',
    family: 'Stand-in',
    v: { 'Temporal Scope': 'Born 4A 100; attested through 4A 500', 'Life State': 'Deceased' },
  });
  chronologyRows(w, [
    {
      id: Q.rowMarked,
      event: [
        { text: 'Reinhild Stand-in dies at Falkenau (date confirmed; the pre-rewrite date is retired)' },
      ],
      date: 'Selyros 19th, 4A 300',
    },
    { id: Q.rowPlain, event: [{ text: 'Reinmar Stand-in dies at Falkenau' }], date: 'Selyros 19th, 4A 300' },
  ]);
  // AS-63: a pre-rewrite heading written with a non-breaking hyphen (U+2011), and its control (ASCII hyphen).
  withBio(
    Q.siegIdx,
    Q.sieg,
    Q.siegBio,
    'Sieglinde Stand-in',
    { 'Temporal Scope': '', 'Life State': 'Alive' },
    [
      heading('g63a', 'Birth and Upbringing - Pre\u2011Rewrite'),
      para('g63b', 'Sieglinde Stand-in was born in 4A 100 in the first telling.'),
    ],
  );
  withBio(
    Q.siegCtrlIdx,
    Q.siegCtrl,
    Q.siegCtrlBio,
    'Siegrun Stand-in',
    { 'Temporal Scope': '', 'Life State': 'Alive' },
    [
      heading('g63c', 'Birth and Upbringing - Pre-Rewrite'),
      para('g63d', 'Siegrun Stand-in was born in 4A 100 in the first telling.'),
    ],
  );
  // AS-64: a marked heading, then a current heading at the same level (it does not govern what follows).
  withBio(
    Q.theodoIdx,
    Q.theodo,
    Q.theodoBio,
    'Theodo Stand-in',
    { 'Temporal Scope': 'Born 4A 100; attested through 4A 500' },
    [
      heading('g64a', 'Author-Facing Notes'),
      para('g64b', 'Drafting notes only.'),
      heading('g64c', 'Death'),
      para('g64d', 'Theodo Stand-in died in Falkenau in 4A 300.'),
    ],
  );
  void L;
  await refresh(w);
  t = tools(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

/** What the subject's run left out as non-current (the evidence that the marking, not the reading, decided). */
const leftOut = async (subject: string) =>
  ((await t.consistency({ subject })).inspected.leftOut as string[]).find((x) => /marked/.test(x)) ?? '';

describe('the exclusion never hides current canon', () => {
  it('control: under the owner’s plain current heading, the current birth and an old register disagree: no birth is given (never the old 4A 100)', async () => {
    const a = await t.asOf(Q.ostCtrl, 'now');
    expect(a.born?.value ?? a.born, brief(a)).not.toBe('4A 100');
  });

  it('AS-59: a current heading that names the marker ("Birth and Upbringing (Current Canon, superseding the Pre-Rewrite History)") does not hide its birth: never the old register’s 4A 100 as the birth', async () => {
    const a = await t.asOf(Q.ostara, 'now');
    const why = `${brief(a)} | left out: ${await leftOut(Q.ostara)}`;
    expect(a.born?.value ?? a.born, why).not.toBe('4A 100');
  });

  it('AS-60: the marker in the sentence’s own words ("…(as the pre-rewrite draft also had it)") does not hide it: Deceased after 4A 300', async () => {
    const a = await t.asOf(Q.pankraz, '4A 400');
    expect(a.state.value, brief(a)).toBe('Deceased (recorded)');
  });

  it('control: the death under a plain heading is read: Deceased (recorded) at 4A 400', async () => {
    const a = await t.asOf(Q.quiCtrl, '4A 400');
    expect(a.state.value, brief(a)).toBe('Deceased (recorded)');
  });

  it('AS-61: an "Author-Facing Notes" heading inside an expand does not govern the top-level paragraph after the expand: the death is read, never "Alive (recorded)" at 4A 400', async () => {
    const a = await t.asOf(Q.quirin, '4A 400');
    const why = `${brief(a)} | left out: ${await leftOut(Q.quirin)}`;
    expect(a.state.value, why).not.toBe('Alive (recorded)');
  });

  it('AS-78: an "Author-Facing Notes" heading in a layout’s first column does not govern the second column: the death is read, never "Alive (recorded)" at 4A 400', async () => {
    const a = await t.asOf(Q.ulf, '4A 400');
    const why = `${brief(a)} | left out: ${await leftOut(Q.ulf)}`;
    expect(a.state.value, why).not.toBe('Alive (recorded)');
  });

  it('control: a chronology row with no marker gives the death: Deceased (recorded) at 4A 400', async () => {
    const a = await t.asOf(Q.reinCtrl, '4A 400');
    expect(a.state.value, brief(a)).toBe('Deceased (recorded)');
  });

  it('AS-62: a row whose note quotes the marker ("…(date confirmed; the pre-rewrite date is retired)") is current: the death is read, never "Alive (recorded)" at 4A 400', async () => {
    const a = await t.asOf(Q.reinhild, '4A 400');
    const why = `${brief(a)} | left out: ${await leftOut(Q.reinhild)}`;
    expect(a.state.value, why).not.toBe('Alive (recorded)');
  });

  it('AS-64: control: a marked heading followed by a current heading at the same level does not govern it: Deceased after 4A 300', async () => {
    const a = await t.asOf(Q.theodo, '4A 400');
    expect(a.state.value, brief(a)).toBe('Deceased (recorded)');
  });
});

describe('the exclusion never lets pre-rewrite material through as current', () => {
  it('control: under "Birth and Upbringing - Pre-Rewrite" (ASCII hyphen) the first telling’s birth is left out: birth unestablished', async () => {
    const a = await t.asOf(Q.siegCtrl, 'now');
    expect(a.born, brief(a)).toBe('birth unestablished');
  });

  it('AS-63: the same heading written with a non-breaking hyphen ("Pre‑Rewrite", U+2011) is still a pre-rewrite section: birth unestablished, never 4A 100', async () => {
    const a = await t.asOf(Q.sieg, 'now');
    const why = `${brief(a)} | left out: ${await leftOut(Q.sieg)}`;
    expect(a.born, why).toBe('birth unestablished');
  });
});
