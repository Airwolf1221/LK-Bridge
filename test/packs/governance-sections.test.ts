/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F3b (ADR 0052; design section 5): governance drift still fails closed, and the pinned set now includes Source
 * Formatting's Page Names and Templates, Nation-Centred Territorial Navigation, Approved Hierarchy and Active Template
 * Suite sections and the Tagging Standard's Exact Tag Grammar and Closed Primary Categories: the approval records each
 * section's digest (and refuses a pinned section it cannot find); a changed pinned section refuses every package of
 * every pack tool, naming the section; a job planned before the change stops before it writes. And the new seed is
 * offered to a pack stored from F3a's seed as a new version, the owner's token maps kept, until the owner approves it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedFictionGovernance } from './fiction-governance.js';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { packRulesSchema } from '../../src/packs/types.js';
import { fixture } from '../images/world.js';
import { approve, compactPackage } from './world.js';
import { compactPolity, ownerText, ownersWorld, PINNED, PROJECT, type OwnersWorld } from './owners-world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await ownersWorld();
  // v3 F4c: the fiction Design References the new seed pins by name (found in this project's tree).
  seedFictionGovernance(w);
});
afterAll(async () => {
  await w?.close();
});

const packs = () => w.stack.runtime.packs;

/** One dry run of each of the pack's four write tools. */
async function everyTool(): Promise<{ tool: string; code: string | undefined; message: string }[]> {
  const staged = await w.call('upload_image', {
    data_base64: Buffer.concat([fixture('alpha.png'), Buffer.from([9])]).toString('base64'),
    name: 'gov',
    stage: true,
    project: 'test',
  });
  const calls: [string, Record<string, unknown>][] = [
    ['arkona_create_owner', compactPolity({ dryRun: true })],
    ['arkona_create_character', compactPackage({ name: 'Gov Check', dryRun: true })],
    [
      'arkona_create_relationship',
      {
        a: 'Nadira al-Khalid',
        b: 'Mehrana I al-Khalid',
        scope: 'x',
        markdown: ownerText('x'),
        dryRun: true,
        project: 'test',
      },
    ],
    [
      'arkona_add_character_art',
      {
        character: 'Nadira al-Khalid',
        images: [
          {
            staged_id: String(staged.body.staged_id),
            label: 'Primary Reference - Portrait',
            interpretation: 'x',
          },
        ],
        dryRun: true,
        project: 'test',
      },
    ],
  ];
  const out = [];
  for (const [tool, args] of calls) {
    const r = await w.call(tool, args);
    out.push({
      tool,
      code: (r.body.error as { code?: string } | undefined)?.code,
      message: String((r.body.error as { message?: string } | undefined)?.message ?? ''),
    });
  }
  return out;
}

describe('pinned sections', () => {
  it('the approval records each pinned section’s digest', () => {
    const approved = packs().get('arkona')!.approved!;
    const formatting = approved.sources.find((s) => s.key === 'source-formatting')!;
    expect(formatting.sections?.map((s) => s.heading)).toEqual([...PINNED.formatting]);
    expect(formatting.sections?.every((s) => /^[0-9a-f]{64}$/.test(s.digest))).toBe(true);
    const tagging = approved.sources.find((s) => s.key === 'tagging-standard')!;
    expect(tagging.sections?.map((s) => s.heading)).toEqual([...PINNED.tagging]);
    // The seed pins the same sections on Arkona's own documents.
    // v3 F6a (ADR 0076): and the Reference Type Vocabulary (unpublished while the vocabulary is a draft).
    expect(ARKONA_PACK.governance.find((g) => g.key === 'source-formatting')!.sections).toEqual([
      ...PINNED.formatting,
      'Reference Type Vocabulary',
    ]);
    // v3 F6b (ADR 0079): and the Navigation and Subject Index Tags (unpublished while the index tag rule is a draft).
    expect(ARKONA_PACK.governance.find((g) => g.key === 'tagging-standard')!.sections).toEqual([
      ...PINNED.tagging,
      'Navigation and Subject Index Tags',
    ]);
  });

  it('a changed pinned section refuses every package, naming the section; approved again, all work', async () => {
    expect((await everyTool()).every((x) => x.code === undefined)).toBe(true);
    w.editSection('formatting', 'Approved Hierarchy and Standardised Navigation');
    const status = await packs().governance('arkona');
    expect(status.state).toBe('changed');
    const formatting = status.sources.find((s) => s.key === 'source-formatting')!;
    expect(
      formatting.sections?.find((s) => s.heading === 'Approved Hierarchy and Standardised Navigation')?.state,
    ).toBe('changed');
    expect(formatting.sections?.filter((s) => s.state === 'same')).toHaveLength(3);
    expect(status.message).toMatch(/pinned section “Approved Hierarchy and Standardised Navigation”/);
    expect(packs().get('arkona')!.drift?.changed[0]?.sections).toEqual([
      'Approved Hierarchy and Standardised Navigation',
    ]);
    const refused = await everyTool();
    expect(refused.map((x) => [x.tool, x.code])).toEqual([
      ['arkona_create_owner', 'PACK_NOT_CURRENT'],
      ['arkona_create_character', 'PACK_NOT_CURRENT'],
      ['arkona_create_relationship', 'PACK_NOT_CURRENT'],
      ['arkona_add_character_art', 'PACK_NOT_CURRENT'],
    ]);
    for (const x of refused)
      expect(x.message, x.tool).toMatch(/Approved Hierarchy and Standardised Navigation/);
    await packs().commands.approve('owner', 'arkona');
    expect((await everyTool()).every((x) => x.code === undefined)).toBe(true);
  });

  it('a change outside the pinned sections still fails closed (the document’s version decides), and says so', async () => {
    w.editOutsidePinned('tagging');
    const status = await packs().governance('arkona');
    expect(status.state).toBe('changed');
    expect(status.message).toMatch(/Controlled Native Tagging Standard \(outside its pinned sections\)/);
    const r = await w.call('arkona_create_owner', compactPolity({ dryRun: true }));
    expect(r.body.error.code).toBe('PACK_NOT_CURRENT');
    await packs().commands.approve('owner', 'arkona');
  });

  it('a package planned before a pinned section changed stops before it writes', async () => {
    const p = await w.call('arkona_create_owner', compactPolity({ name: 'Kingdom of Awsan' }));
    expect(p.body.status, p.text).toBe('proposal_captured');
    w.editSection('tagging', 'Closed Primary Categories and Specialist Functions');
    const writes = w.seen.filter((l) => !l.startsWith('GET')).length;
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status).toBe('failed');
    expect(done.job?.lastError?.code).toBe('PACK_GOVERNANCE_CHANGED');
    expect(done.job?.lastError?.message).toMatch(/Closed Primary Categories and Specialist Functions/);
    expect(w.seen.filter((l) => !l.startsWith('GET')).length).toBe(writes);
    await packs().commands.approve('owner', 'arkona');
  });

  it('refuses an approval when a pinned section cannot be found, listing the document’s headings', async () => {
    const doc = w.repo.blocks.get(w.governanceDocs.formatting)!;
    const saved = structuredClone(doc.blocks);
    const at = (doc.blocks as { kind: string; content?: { text: string }[] }[]).findIndex(
      (b) => b.kind === 'heading' && b.content?.[0]?.text === 'Active Template Suite and Sidebar Collections',
    );
    (doc.blocks as { content: { text: string }[] }[])[at]!.content = [{ text: 'Template Catalogue' }];
    doc.version++;
    try {
      await expect(packs().commands.approve('owner', 'arkona')).rejects.toMatchObject({
        code: 'GOVERNANCE_SECTION_MISSING',
      });
      await packs()
        .commands.approve('owner', 'arkona')
        .catch((e: { details: { headings: Record<string, string[]> } }) => {
          expect(e.details.headings['source-formatting']).toContain('Template Catalogue');
        });
    } finally {
      doc.blocks = saved;
      doc.version++;
    }
    // A heading renumbered or recased is still found.
    (doc.blocks as { kind: string; content?: { text: string }[] }[])[at]!.content = [
      { text: '4. ACTIVE TEMPLATE SUITE & SIDEBAR COLLECTIONS' },
    ];
    doc.version++;
    await packs().commands.approve('owner', 'arkona');
    expect((await packs().governance('arkona')).state).toBe('current');
  });
});

describe('the new seed is offered to a pack stored from F3a’s seed', () => {
  it('as a new version waiting for the owner, the token maps kept, the governance places kept and the sections added', async () => {
    const p = packs();
    const before = p.get('arkona')!;
    // As F3a left it: F3a's seed name, rules without the owners, the AU ruling or the rulings; an edited token map;
    // governance with no pinned sections; approved.
    const f3a = packRulesSchema.parse({
      ...before.rules,
      owners: undefined,
      rulings: undefined,
      tags: {
        ...before.rules.tags,
        au: undefined,
        race: { ...before.rules.tags.race, Starborn: 'Starborn' },
      },
    });
    p.commands.replaceRules('owner', 'arkona', f3a, 'test: as F3a left it');
    p.store.setGovernance(
      'arkona',
      before.governance.map((g) => ({
        key: g.key,
        project: g.project,
        resourceId: g.resourceId,
        documentId: g.documentId,
        name: g.name,
        ...(g.label ? { label: g.label } : {}),
      })),
    );
    w.stack.db.prepare("UPDATE packs SET seed = 'arkona-2026-11-16' WHERE id = 'arkona'").run();
    await p.commands.approve('owner', 'arkona');
    const v = p.get('arkona')!.version;
    expect((await p.governance('arkona')).state).toBe('current');
    // The bridge starts with the new seed.
    p.ensureSeeded();
    const after = p.get('arkona')!;
    expect(after.version).toBe(v + 1);
    expect(after.seed).toBe(ARKONA_PACK.seed);
    expect(after.rules.owners?.types.length).toBe(19);
    expect(after.rules.tags.au).toEqual({ continuityType: 'AU', tag: 'AU' });
    expect(after.rules.tags.race.Starborn).toBe('Starborn');
    // The governance documents stay where they are (this world's), with the seed's pinned sections.
    expect(after.governance.slice(0, before.governance.length).map((g) => g.documentId)).toEqual(
      before.governance.map((g) => g.documentId),
    );
    // v3 F4c: the fiction Design References join, found by their page names in this world's project.
    expect(after.governance.slice(before.governance.length).map((g) => [g.key, g.project, g.page])).toEqual([
      // v3 F5b (ADR 0068): Repository Automation joins at the seed's ids, in the seed's project (only a source found by
      // its page's name goes in the project the stored sources share).
      ['repository-automation', 'arkona', undefined],
      ['narrative-workflow', 'test', 'Arkona - Narrative Story Planning & Drafting Workflow'],
      ['fiction-writing', 'test', 'Arkona - Fiction Writing Reference'],
    ]);
    expect(after.governance.find((g) => g.key === 'source-formatting')!.sections).toEqual([
      ...PINNED.formatting,
      // v3 F6a (ADR 0076).
      'Reference Type Vocabulary',
    ]);
    expect((await p.governance('arkona')).state).toBe('rules_changed');
    expect(w.stack.runtime.policy.commands.listAudit('owner', { action: 'pack.seed_upgrade' })).toHaveLength(
      1,
    );
    expect(p.store.versions('arkona')[0]!.reason).toContain(`seed ${ARKONA_PACK.seed}`);
    // Until the owner approves it, nothing is computed.
    const refused = await w.call('arkona_create_owner', compactPolity({ dryRun: true }));
    expect(refused.body.error.code).toBe('PACK_NOT_CURRENT');
    // Starting again offers nothing more.
    p.ensureSeeded();
    expect(p.get('arkona')!.version).toBe(v + 1);
    // v3 F5b (ADR 0068): Repository Automation sits on Arkona, which this world does not serve; the world keeps to its own
    // documents (as it does for the other sources) before the owner approves.
    p.store.setGovernance(
      'arkona',
      p.get('arkona')!.governance.filter((g) => g.key !== 'repository-automation'),
    );
    await p.commands.approve('owner', 'arkona');
    const ok = await w.call('arkona_create_owner', compactPolity({ dryRun: true }));
    expect(ok.isError, ok.text).toBe(false);
    expect(p.attachment('arkona', PROJECT)!.templates.polity).toBeTruthy();
  });
});
