/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- parsed JSON */
/**
 * CR-2026-11-R4 pass 3, depth on three bypasses of the reading (AS-39: rule A takes "the daughter of <name>" as
 * <name>; AS-53: rule B's scan takes another date of the clause; AS-50: an alias that is another character's given name
 * takes that character's own pages): what each does downstream. The nightly audit reports it as Contradictory (a
 * `warning`), `arkona_brief` tells agents not to write on the value, and the owner's "Pick the right value" (ADR 0064
 * D6: "ONE proposal of items, one per page that disagrees with the pick … editing only the restated value") proposes
 * rewriting a sentence that was never the character's restatement. The SAFE behaviour: no finding exists, so no pick
 * ever proposes editing those sentences. The REAL stack on the mock LegendKeeper (F4b.1's live-run world), the owner's
 * dashboard API with the step-up, as test/consistency/audit-pick.test.ts drives it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approve } from '../../packs/world.js';
import { ownerClient, PROJECT } from '../../consistency/world.js';
import { K, L, liveRunWorld, O, page, para, person, refresh, setRows, type LiveWorld } from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

const P = {
  annals: 'r4p92ann',
  city: 'r4p93cty',
  hoshinoIdx: 'r4p94idx',
  hoshino: 'r4p94chr',
  hoshinoBio: 'r4p94bio',
};
const S = {
  daughter: 'The daughter of Rashad al-Khalid was born on Camue 1st, 4A 401.',
  city: 'Murad al-Khalid was born in Falkenau, which fell in 4A 250.',
  yamato: 'Yamato was born on Isar 3rd, 4A 600 in the Empire of Fujimatsu.',
};

let w: LiveWorld;
beforeAll(async () => {
  w = await liveRunWorld();
  page(w, {
    id: P.annals,
    name: '[BSRC] Al-Khalid Court Annals',
    parentId: O.alTibr,
    body: [para('p92a', S.daughter)],
  });
  page(w, {
    id: P.city,
    name: '[BSRC] Falkenau - City Reference',
    parentId: O.alTibr,
    body: [para('p93a', S.city)],
  });
  setRows(w, K.katsu, {
    Aliases: 'Rita von Katzen (4A 99-192); Yamato (from 4A 192); Katsuragi Yamato (from 4A 193)',
  });
  person(w, {
    id: P.hoshino,
    core: P.hoshinoIdx,
    name: 'Hoshino Yamato',
    given: 'Yamato',
    family: 'Hoshino',
    v: { 'Naming Culture': 'Fujimatsuan', 'Temporal Scope': 'Born Isar 3rd, 4A 600' },
  });
  page(w, {
    id: P.hoshinoBio,
    name: '[BSRC] Hoshino Yamato - Biography',
    parentId: P.hoshinoIdx,
    sidebar: { Subject: 'Hoshino Yamato' },
    body: [para('p94a', S.yamato)],
  });
  await refresh(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const audits = () => w.stack.runtime.audits;
const textOf = (pageId: string) => JSON.stringify(w.repo.blocks.get(w.mainOf(pageId))!.blocks);
const findingOn = (subject: string, pageId: string) =>
  audits()
    .list(PROJECT, { category: ['consistency'], acknowledged: 'include', limit: 500 })
    .findings.find(
      (f) =>
        f.code === 'consistency_birth' &&
        f.evidence.subject === subject &&
        f.state === 'open' &&
        JSON.stringify(f.evidence.restatements).includes(pageId),
    );

/**
 * The SAFE assertion: no open Contradictory finding names the sentence's page as the subject's restatement. When one
 * does, the failure message records what follows: the brief's line, the owner's pick of the identity page's own value,
 * and the page's sentence after the pick's proposal is approved.
 */
async function noFindingNorPick(
  subject: string,
  identityPage: string,
  pageId: string,
  sentence: string,
  re: RegExp,
) {
  const f = findingOn(subject, pageId);
  if (f) {
    const brief = await w.call('arkona_brief', { project: 'test', subject });
    const o = ownerClient(w);
    const v = await o.get(`/audits/findings/${f.id}/consistency?project=test`);
    o.reauth();
    const side = (v.json.values as any[]).find((x) => x.page.id === identityPage);
    const r = await o.post(`/audits/findings/${f.id}/consistency-pick?project=test`, {
      confirm: true,
      side: side.key,
    });
    const items = (r.json.items ?? []) as any[];
    let after = '';
    if (r.status === 200 && items.some((i) => i.page?.id === pageId)) {
      const done = await approve(w, r.json.proposalId);
      after = `job ${done.job?.status}; the page now reads: ${re.exec(textOf(pageId))?.[0] ?? '?'}`;
    }
    expect.fail(
      JSON.stringify({
        audit: { code: f.code, severity: f.severity, label: f.evidence.label, message: f.message },
        brief: brief.body?.consistency?.note,
        pick: { status: r.status, items: items.map((i) => i.page?.id) },
        afterApproval: after,
      }),
    );
  }
  expect(textOf(pageId)).toContain(sentence);
}

describe('a false reading never reaches the nightly audit, the brief or the owner’s pick', () => {
  it('AS-92 (AS-39 downstream): a sentence about Rashad al-Khalid’s daughter is never his Contradictory birth, so no pick rewrites it', async () => {
    await noFindingNorPick(
      'Rashad al-Khalid',
      K.rashad,
      P.annals,
      S.daughter,
      /The daughter of Rashad al-Khalid was born on [^."]+/,
    );
  });

  it('AS-93 (AS-53 downstream): "…born in Falkenau, which fell in 4A 250" is never Murad al-Khalid’s Contradictory birth, so no pick rewrites the city’s fall', async () => {
    await noFindingNorPick(
      'Murad al-Khalid',
      L.murad,
      P.city,
      S.city,
      /Murad al-Khalid was born in Falkenau, which fell in [^."]+/,
    );
  });

  it('AS-94 (AS-50 downstream): Hoshino Yamato’s own Biography is never Katsuragi Yamato’s Contradictory birth, so no pick rewrites Hoshino’s birth', async () => {
    await noFindingNorPick('Katsuragi Yamato', K.katsu, P.hoshinoBio, S.yamato, /Yamato was born on [^."]+/);
  });
});
