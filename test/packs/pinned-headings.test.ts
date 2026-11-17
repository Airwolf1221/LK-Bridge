/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * ADR 0052 amendment (16 November 2026): the pinned headings are Arkona's exact headings, matched whole (never by
 * prefix), and the owner can re-map a pin without a code session.
 *
 * - Approving with the six real headings succeeds against fixture pages that use exactly those headings.
 * - A pack stored from F3b's seed (the three abbreviated headings) is refused, naming them, and is offered the new seed,
 *   which then approves first time.
 * - A renamed heading fails with GOVERNANCE_SECTION_MISSING, with the page's outline (in order, with levels); re-mapping
 *   the pin makes a new version holding the mapping, audited with the old and the new heading, and approval succeeds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import type { PackError } from '../../src/packs/types.js';
import { compactPolity, ownersWorld, PINNED, type OwnersWorld } from './owners-world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await ownersWorld();
});
afterAll(async () => {
  await w?.close();
});

const packs = () => w.stack.runtime.packs;
const audit = (action: string) => w.stack.runtime.policy.commands.listAudit('owner', { action });
type Block = { kind: string; level?: number; content?: { text: string }[] };
const blocksOf = (doc: 'formatting' | 'tagging') =>
  w.repo.blocks.get(w.governanceDocs[doc])!.blocks as Block[];
/** Renames a heading on a governance page (its version moves on). */
const rename = (doc: 'formatting' | 'tagging', from: string, to: string) => {
  const d = w.repo.blocks.get(w.governanceDocs[doc])!;
  const b = (d.blocks as Block[]).find((x) => x.kind === 'heading' && x.content?.[0]?.text === from)!;
  b.content = [{ text: to }];
  d.version++;
};
const rejection = async (p: Promise<unknown>): Promise<PackError> => {
  try {
    await p;
  } catch (e) {
    return e as PackError;
  }
  throw new Error('expected a refusal');
};

describe('the six exact headings', () => {
  it('the seed pins them exactly, and approving against pages with exactly those headings succeeds', async () => {
    const seeded = (key: string) => ARKONA_PACK.governance.find((g) => g.key === key)!.sections;
    expect(seeded('source-formatting')).toEqual([
      'Page Names and Templates',
      'Nation-Centred Territorial Navigation',
      'Approved Hierarchy and Standardised Navigation',
      'Active Template Suite and Sidebar Collections',
    ]);
    expect(seeded('tagging-standard')).toEqual([
      'Exact Tag Grammar',
      'Closed Primary Categories and Specialist Functions',
    ]);
    expect(seeded('source-formatting')).toEqual([...PINNED.formatting]);
    expect(seeded('tagging-standard')).toEqual([...PINNED.tagging]);
    await packs().commands.approve('owner', 'arkona');
    const status = await packs().governance('arkona');
    expect(status.state).toBe('current');
    const found = status.sources.flatMap((s) => (s.sections ?? []).map((x) => [x.heading, x.found, x.state]));
    expect(found).toHaveLength(6);
    for (const [heading, at, state] of found) {
      expect(at).toBe(heading);
      expect(state).toBe('same');
    }
  });

  it('F3b’s abbreviated pins are not found (no prefix match); the new seed is offered and approves first time', async () => {
    const p = packs();
    const before = p.get('arkona')!;
    // As F3b left it on the owner's bridge: the F3b seed, its abbreviated pins, a version waiting for approval.
    p.store.setGovernance(
      'arkona',
      before.governance.map((g) =>
        g.key === 'source-formatting'
          ? {
              ...g,
              sections: [
                'Page Names and Templates',
                'Nation-Centred Territorial Navigation',
                'Approved Hierarchy',
                'Active Template Suite',
              ],
            }
          : g.key === 'tagging-standard'
            ? { ...g, sections: ['Exact Tag Grammar', 'Closed Primary Categories'] }
            : g,
      ),
    );
    w.stack.db.prepare("UPDATE packs SET seed = 'arkona-2026-11-16-f3b' WHERE id = 'arkona'").run();
    p.commands.replaceRules('owner', 'arkona', before.rules, 'test: F3b’s version, waiting');
    const e = await rejection(p.commands.approve('owner', 'arkona'));
    expect(e.code).toBe('GOVERNANCE_SECTION_MISSING');
    // The owner's run of 16 November 2026, word for word.
    expect(e.message).toContain(
      'The pack cannot be approved: Source Formatting has no section “Approved Hierarchy”; Source Formatting has no section “Active Template Suite”; Controlled Native Tagging Standard has no section “Closed Primary Categories”.',
    );
    // The bridge starts with the new seed: a new version with the exact headings, approved first time.
    const v = p.get('arkona')!.version;
    p.ensureSeeded();
    const after = p.get('arkona')!;
    expect(after.version).toBe(v + 1);
    expect(after.seed).toBe(ARKONA_PACK.seed);
    expect(after.governance.find((g) => g.key === 'source-formatting')!.sections).toEqual([
      ...PINNED.formatting,
    ]);
    expect(after.governance.find((g) => g.key === 'tagging-standard')!.sections).toEqual([...PINNED.tagging]);
    expect(after.rules.owners?.tags.working).toEqual(['$status', '$primary', '$specialist']);
    expect((await p.governance('arkona')).state).toBe('rules_changed');
    await p.commands.approve('owner', 'arkona');
    expect((await p.governance('arkona')).state).toBe('current');
    const ok = await w.call('arkona_create_owner', compactPolity({ dryRun: true }));
    expect(ok.isError, ok.text).toBe(false);
  });
});

describe('re-mapping a pinned heading', () => {
  it('a renamed heading fails with GOVERNANCE_SECTION_MISSING and the page’s outline (in order, with levels)', async () => {
    rename('tagging', 'Exact Tag Grammar', 'Exact Tag Grammar and Order');
    // A governance check shows the drift with the missing heading and the outline (the Packs page's picker).
    const status = await packs().governance('arkona');
    expect(status.state).toBe('changed');
    const tagging = status.sources.find((s) => s.key === 'tagging-standard')!;
    expect(tagging.sections?.find((x) => x.heading === 'Exact Tag Grammar')?.state).toBe('missing');
    const outline = blocksOf('tagging')
      .filter((b) => b.kind === 'heading')
      .map((b) => ({ heading: b.content![0]!.text, level: b.level ?? 1 }));
    expect(tagging.outline).toEqual(outline);
    expect(tagging.outline?.[0]).toEqual({ heading: 'Controlled Native Tagging Standard', level: 1 });
    expect(tagging.outline).toContainEqual({ heading: 'Exact Tag Grammar and Order', level: 2 });
    // A source with nothing missing carries no outline.
    expect(status.sources.find((s) => s.key === 'source-formatting')!.outline).toBeUndefined();
    const e = await rejection(packs().commands.approve('owner', 'arkona'));
    expect(e.code).toBe('GOVERNANCE_SECTION_MISSING');
    expect(e.message).toMatch(/Controlled Native Tagging Standard has no section “Exact Tag Grammar”/);
    expect(e.details.missing).toEqual([
      { source: 'Controlled Native Tagging Standard', key: 'tagging-standard', heading: 'Exact Tag Grammar' },
    ]);
    expect((e.details.outline as Record<string, unknown>)['tagging-standard']).toEqual(outline);
    expect((e.details.governance as { state: string }).state).toBe('changed');
  });

  it('refuses a re-map that is not the owner’s, of a heading not pinned, or to a heading the page lacks or already pins', async () => {
    const c = packs().commands;
    const change = {
      source: 'tagging-standard',
      from: 'Exact Tag Grammar',
      to: 'Exact Tag Grammar and Order',
    };
    expect((await rejection(c.remapSection('agent', 'arkona', change))).code).toBe('NOT_OWNER');
    expect((await rejection(c.remapSection('owner', 'arkona', { ...change, source: 'nope' }))).code).toBe(
      'SOURCE_NOT_FOUND',
    );
    expect((await rejection(c.remapSection('owner', 'arkona', { ...change, from: 'Exact Tag' }))).code).toBe(
      'SECTION_NOT_PINNED',
    );
    // Matched whole: a prefix of a real heading is not a heading.
    const prefix = await rejection(
      c.remapSection('owner', 'arkona', { ...change, to: 'Exact Tag Grammar and' }),
    );
    expect(prefix.code).toBe('HEADING_NOT_FOUND');
    expect(prefix.details.outline).toContainEqual({ heading: 'Exact Tag Grammar and Order', level: 2 });
    const taken = await rejection(
      c.remapSection('owner', 'arkona', {
        ...change,
        to: 'Closed Primary Categories and Specialist Functions',
      }),
    );
    expect(taken.code).toBe('SECTION_ALREADY_PINNED');
    expect(audit('pack.remap_section')).toEqual([]);
  });

  it('re-mapping makes a new version holding the mapping, audited old → new; approving it succeeds', async () => {
    const p = packs();
    const v = p.get('arkona')!.version;
    const r = await p.commands.remapSection('owner', 'arkona', {
      source: 'tagging-standard',
      from: 'Exact Tag Grammar',
      to: 'exact tag grammar and order', // matched as a whole heading; stored as the page has it
    });
    expect(r.pack.version).toBe(v + 1);
    expect(r.pack.governance.find((g) => g.key === 'tagging-standard')!.sections).toEqual([
      'Exact Tag Grammar and Order',
      'Closed Primary Categories and Specialist Functions',
    ]);
    // The mapping waits for the owner with the version.
    expect(r.governance.state).toBe('rules_changed');
    expect(p.store.versions('arkona')[0]!.reason).toMatch(
      /re-mapped on the Packs page: “Exact Tag Grammar” → “Exact Tag Grammar and Order”/,
    );
    const refused = await w.call('arkona_create_owner', compactPolity({ dryRun: true }));
    expect(refused.body.error.code).toBe('PACK_NOT_CURRENT');
    const rows = audit('pack.remap_section');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'owner',
      target: 'arkona',
      before: { version: v, source: 'tagging-standard', heading: 'Exact Tag Grammar' },
      after: { version: v + 1, source: 'tagging-standard', heading: 'Exact Tag Grammar and Order' },
    });
    await p.commands.approve('owner', 'arkona');
    const status = await p.governance('arkona');
    expect(status.state).toBe('current');
    expect(p.get('arkona')!.approved!.sources.find((s) => s.key === 'tagging-standard')!.sections).toEqual([
      expect.objectContaining({ heading: 'Exact Tag Grammar and Order' }),
      expect.objectContaining({ heading: 'Closed Primary Categories and Specialist Functions' }),
    ]);
    const ok = await w.call('arkona_create_owner', compactPolity({ dryRun: true }));
    expect(ok.isError, ok.text).toBe(false);
  });
});
