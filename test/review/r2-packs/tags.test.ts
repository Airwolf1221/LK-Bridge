/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * R2-PACKS: tag grammar. The pack's AU ruling makes `AU` a guarded status tag of the Authoritative state on a project
 * whose APPROVED pack carries it (ADR 0053 Part B; src/lifecycle/guard.ts:152-180 `statusTagKeys`/`statusTagStates`),
 * compared through `factKey`'s fold (src/facts/rules.ts:222-280: NFKC, default-ignorables removed, case, and a map of
 * Cyrillic and Greek look-alikes ONLY). Pack-computed tags come only from the pack's own data (src/packs/engine/tags.ts),
 * so an agent's attack on tags goes through the general tools against the guard the pack configures.
 *
 * - ATK-20a (HELD expected): AU spelt with case, fullwidth, Cyrillic, zero-width and soft-hyphen look-alikes;
 * - ATK-20b: AU and CANON spelt with look-alikes OUTSIDE the fold's map (Cherokee letters, Latin small capitals), which
 *   read as AU / CANON: added to a Working page at scope write;
 * - ATK-21 (HELD expected): CANON swapped for AU on an Authoritative page;
 * - ATK-22 (HELD expected): the AU ruling and `lifecycleTagPosition` come from the APPROVED version only;
 * - ATK-23 (probe): the owner tool's AU decision (src/packs/engine/owner.ts:322, textKey: NFKC and case only) reads a
 *   `continuity` of "Main" with a zero-width space as an alternate universe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C, packWorld, type PackWorld } from '../../packs/world.js';
import { PROJECT, writeAgent } from './helpers.js';

let w: PackWorld;
let agent: Awaited<ReturnType<typeof writeAgent>>;
beforeAll(async () => {
  w = await packWorld();
  agent = await writeAgent(w);
});
afterAll(async () => {
  await w?.close();
});

const tagsOf = (id: string) => [...w.repo.res.get(id)!.tags];
const addTag = (page: string, tag: string) =>
  agent('update_resource', { page, tags: { add: [tag] }, project: 'test' });

describe('ATK-20: status-tag look-alikes added to a Working page ([BWRK] Draft Notes)', () => {
  it('ATK-20a (HELD expected): au, ＡＵ, Cyrillic АU, A+ZWSP+U, A+soft hyphen+U are refused', async () => {
    const before = tagsOf(C.draft);
    const outcome: Record<string, string> = {};
    for (const t of ['au', 'ＡＵ', 'АU', 'A​U', 'A­U']) {
      const r = await addTag(C.draft, t);
      outcome[JSON.stringify(t)] = r.isError && /status tag/.test(r.text) ? 'refused' : 'written';
    }
    expect(
      Object.values(outcome).every((x) => x === 'refused'),
      JSON.stringify(outcome),
    ).toBe(true);
    expect(tagsOf(C.draft)).toEqual(before);
  });

  it('ATK-20b: Cherokee and small-capital look-alikes of AU and CANON are refused too', async () => {
    const before = tagsOf(C.draft);
    const outcome: Record<string, string> = {};
    // ᎪU: CHEROKEE LETTER GO (U+13AA, an "A") + U; ᴀᴜ: LATIN LETTER SMALL CAPITAL A and U (U+1D00, U+1D1C);
    // ᏟᎪNON: CHEROKEE LETTER TLI (U+13DF, a "C") and GO; ᴄᴀɴᴏɴ: small capitals.
    for (const t of ['ᎪU', 'ᴀᴜ', 'ᏟᎪNON', 'ᴄᴀɴᴏɴ']) {
      const r = await addTag(C.draft, t);
      outcome[t] = r.isError && /status tag/.test(r.text) ? 'refused' : 'written';
    }
    const after = tagsOf(C.draft);
    // Put the page back.
    w.repo.res.get(C.draft)!.tags = before;
    expect({ outcome, after }).toEqual({
      outcome: { ᎪU: 'refused', ᴀᴜ: 'refused', ᏟᎪNON: 'refused', ᴄᴀɴᴏɴ: 'refused' },
      after: before,
    });
  });
});

describe('ATK-21 (HELD expected): the AU ruling on an Authoritative page', () => {
  it('CANON swapped for AU (and AU added beside CANON) on Mehrana I’s Core is refused', async () => {
    const before = tagsOf(C.mehrana1);
    const swap = await agent('update_resource', {
      page: C.mehrana1,
      tags: { remove: ['CANON'], add: ['AU'] },
      project: 'test',
    });
    const beside = await addTag(C.mehrana1, 'AU');
    expect({ swap: swap.isError, beside: beside.isError, tags: tagsOf(C.mehrana1) }).toEqual({
      swap: true,
      beside: true,
      tags: before,
    });
  });
});

describe('ATK-22 (HELD expected): the lifecycle tag rules come from the approved version only', () => {
  it('a pending version that drops the AU ruling and asks for "lead" on the test project changes nothing yet', async () => {
    const packs = w.stack.runtime.packs;
    const p = packs.get('arkona')!;
    const { au: _au, ...tagsNoAu } = p.rules.tags;
    packs.commands.replaceRules(
      'owner',
      'arkona',
      { ...p.rules, tags: tagsNoAu, lifecycleTagPosition: { test: 'lead' } },
      'r2: a pending version',
    );
    const rules = packs.lifecycleRules(PROJECT);
    const r = await addTag(C.draft, 'AU');
    await packs.commands.approve('owner', 'arkona').catch(() => undefined);
    // Back to the seed's rules (approved) for anything after.
    packs.commands.replaceRules('owner', 'arkona', p.rules, 'r2: back');
    await packs.commands.approve('owner', 'arkona');
    expect({ position: rules.position, au: rules.au?.tag ?? null, auStillGuarded: r.isError }).toEqual({
      position: 'append',
      au: 'AU',
      auStillGuarded: true,
    });
  });
});

describe('ATK-23 (probe): an invisible character in an owner page’s continuity', () => {
  it('"Main" with a zero-width space is not read as an alternate universe', async () => {
    const r = await agent('arkona_create_owner', {
      type: 'Culture',
      name: 'Harbour Speech',
      descriptor: 'Culture Reference',
      home: C.qishen,
      homeOverride: { reason: 'r2 probe' },
      status: 'authoritative',
      continuity: 'Ma​in',
      referenceType: 'Culture Reference',
      scope: 'A guild',
      temporalScope: '4A 1 - 4A 2',
      markdown:
        '## Purpose\n\nA guild.\n\n## Source Boundaries\n\nThis page only.\n\n## Unresolved Material\n\nNone.\n',
      dryRun: true,
      project: 'test',
    });
    const page = (
      r.body.pages as { facts: { key: string; value: string }[]; tags: string[] }[] | undefined
    )?.[0];
    const ct = page?.facts.find((f) => f.key === 'Continuity Type')?.value ?? r.body.error?.code;
    expect({ continuityType: ct, firstTag: page?.tags[0] ?? null }).toEqual({
      continuityType: 'CANON',
      firstTag: 'CANON',
    });
  });
});
