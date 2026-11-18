/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
/**
 * v3 F3b (ADR 0052): the four new Arkona evaluation scenarios (docs/reviews/scenarios.json, 35 to 38), each with the
 * package a good run sends, against the mock LegendKeeper in the order the owner runs them: the compact polity under
 * Salahad Polities, approved as canon; the institution that needs its nation's own index (promoteNation); a relationship
 * of two existing test-world characters; art for an existing character, staged first (and, as ChatGPT does at scope
 * propose, the image's own placement proposal taken over).
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadScenarios } from '../../src/evaluation/scenarios.js';
import { SidebarModel } from '../resources/world.js';
import { approve, IDENTITY_KEYS } from './world.js';
import { O, ownerText, ownersWorld, PROJECT, type OwnersWorld } from './owners-world.js';

let w: OwnersWorld;
beforeAll(async () => {
  // The test world has one Mehrana al-Khalid, and its characters' sidebars are the AI Character Core's.
  w = await ownersWorld({ mehranaAlias: false });
  const sidebar = (id: string, rows: Record<string, string>) =>
    w.sidebars.page(id, [
      SidebarModel.kv(
        `kv${id}`.slice(0, 8),
        'PROPERTIES',
        IDENTITY_KEYS.map((k) => [k, rows[k] ?? ''] as [string, string]),
      ),
      SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
      SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  const canon = {
    Status: 'Authoritative',
    'Continuity Type': 'CANON',
    Continuity: 'Main',
    Inheritance: 'None',
  };
  sidebar(MIYABI, {
    ...canon,
    Subject: 'Asagiri Miyabi',
    'Race / Species': 'Foxian',
    'Reference Type': 'Character Core',
  });
  sidebar(MEHRANA, {
    ...canon,
    Subject: 'Mehrana al-Khalid',
    'Race / Species': 'Qishen',
    'Reference Type': 'Character Core',
  });
});
afterAll(async () => {
  await w?.close();
});

const MIYABI = 'miyabi01';
const MEHRANA = 'mehran01';
const scenario = (id: number) => loadScenarios().scenarios.find((s) => s.id === id)!;
const pngOf = (prompt: string) => /([A-Za-z0-9+/]{60,}={0,2})\s*$/.exec(prompt)![1]!;
const pageNamed = (name: string) =>
  [...w.repo.res.values()].find((r) => r.deletedAt === null && r.name === name);
const related = (id: string) =>
  (w.sidebars.pages.get(id)?.props.find((p) => p.title === 'Related Sources')?.items ?? []).map(
    (i) => i.resourceId,
  );

describe('the F3b Arkona evaluation scenarios, as a good run sends them', () => {
  it('35: a compact polity under Salahad Polities, previewed, proposed once as canon, approved', async () => {
    expect(scenario(35).pack).toBe('arkona');
    const pkg = {
      type: 'Polity',
      name: 'Kingdom of Saba',
      descriptor: 'Historical Polity Reference',
      home: 'Salahad Polities',
      status: 'authoritative',
      referenceType: 'Historical Polity Reference',
      scope: 'A highland kingdom of southern Salahad',
      temporalScope: '3A 410 - 4A 12',
      markdown: ownerText(
        'The reference for the Kingdom of Saba, a compact polity of southern Salahad.',
        '## Government\n\nA hereditary queenship advised by a council of terrace-holders.\n\n',
      ),
      project: 'test',
    };
    const dry = await w.call('arkona_create_owner', { ...pkg, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.tree).toEqual([
      expect.objectContaining({
        page: '[BSRC] Kingdom of Saba - Historical Polity Reference',
        parent: '[INDEX] Salahad Polities',
      }),
    ]);
    expect(dry.body.pages[0].tags).toEqual(['CANON', 'Polity']);
    const p = await w.call('arkona_create_owner', pkg);
    expect(p.body.status, p.text).toBe('proposal_captured');
    expect(p.body.requiresCanonicalApproval).toBe(true);
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    expect(pageNamed('[BSRC] Kingdom of Saba - Historical Polity Reference')!.parentId).toBe(
      O.salahadPolities,
    );
  });

  it('36: the institution that needs promoteNation: refused without it, previewed and proposed with it', async () => {
    const base = {
      type: 'Institution',
      name: 'Terrace Council',
      descriptor: 'Institution Reference',
      nation: 'Kingdom of Saba',
      status: 'authoritative',
      referenceType: 'Institution Reference',
      scope: 'The royal council of terrace-holders',
      temporalScope: '3A 250 - 4A 12', // inside the Third Age (it ends in 3A 31x; 3A 500 was outside it)
      markdown: ownerText('The Terrace Council of the Kingdom of Saba.'),
      project: 'test',
    };
    const first = await w.call('arkona_create_owner', {
      ...base,
      home: 'Salahad Institutions',
      dryRun: true,
    });
    expect(first.body.error.code).toBe('NATION_NEEDS_INDEX');
    const pkg = { ...base, home: 'Kingdom of Saba', promoteNation: true };
    const dry = await w.call('arkona_create_owner', { ...pkg, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.tree.map((t: { page: string; parent: string }) => [t.page, t.parent])).toEqual([
      ['[INDEX] Kingdom of Saba', '[INDEX] Salahad Polities'],
      ['[BSRC] Terrace Council - Institution Reference', '[INDEX] Kingdom of Saba'],
    ]);
    expect(dry.body.existing[0]).toEqual({
      page: '[BSRC] Kingdom of Saba - Historical Polity Reference',
      change: 'moved under [INDEX] Kingdom of Saba (id kept)',
    });
    const reference = pageNamed('[BSRC] Kingdom of Saba - Historical Polity Reference')!;
    const p = await w.call('arkona_create_owner', pkg);
    expect(p.body.status, p.text).toBe('proposal_captured');
    expect(p.body.requiresCanonicalApproval).toBe(true);
    // The owner approves it here to check the result (the scenario rejects it, or approves it to look).
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    const index = pageNamed('[INDEX] Kingdom of Saba')!;
    expect(w.repo.res.get(reference.id)!.parentId).toBe(index.id);
    expect(pageNamed('[BSRC] Terrace Council - Institution Reference')!.parentId).toBe(index.id);
  });

  it('37: a relationship of two existing test-world characters, both Related Sources updated', async () => {
    const pkg = {
      a: 'Asagiri Miyabi',
      b: 'Mehrana al-Khalid',
      scope: 'Their years of letters about the shrine archives',
      markdown: ownerText('The correspondence of Asagiri Miyabi and Mehrana al-Khalid.'),
      project: 'test',
    };
    const dry = await w.call('arkona_create_relationship', { ...pkg, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.tree[0]).toMatchObject({
      page: '[BSRC] Asagiri Miyabi & Mehrana al-Khalid - Relationship',
      parent: '[INDEX] Asagiri Miyabi',
    });
    expect(dry.body.pages[0].tags).toEqual(['CANON', 'Character', 'Relationship']);
    const p = await w.call('arkona_create_relationship', pkg);
    expect(p.body.status, p.text).toBe('proposal_captured');
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const page = pageNamed('[BSRC] Asagiri Miyabi & Mehrana al-Khalid - Relationship')!;
    expect(related(MIYABI)).toContain(page.id);
    expect(related(MEHRANA)).toContain(page.id);
  });

  it('38: art for an existing character, staged first with no destination, then one proposal', async () => {
    const staged = await w.call('upload_image', {
      data_base64: pngOf(scenario(38).prompts[0]!),
      name: 'Asagiri Miyabi ceremonial robes',
      stage: true,
      project: 'test',
    });
    expect(staged.body.status, staged.text).toBe('staged');
    const pkg = {
      character: 'Asagiri Miyabi',
      images: [
        {
          staged_id: String(staged.body.staged_id),
          label: 'Outfit Reference - Ceremonial Robes',
          interpretation: 'The white-and-vermilion robes she wears for the lantern rites.',
          subfolder: 'Outfits / Ceremonial Robes',
        },
      ],
      project: 'test',
    };
    const dry = await w.call('arkona_add_character_art', { ...pkg, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.assets).toEqual([
      expect.objectContaining({
        name: 'Asagiri Miyabi - Outfit Reference - Ceremonial Robes',
        folder: 'Characters / Beastkin / Foxians / Asagiri Miyabi / Outfits / Ceremonial Robes',
      }),
    ]);
    const p = await w.call('arkona_add_character_art', pkg);
    expect(p.body.status, p.text).toBe('proposal_captured');
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    expect(pageNamed('[BSRC] Asagiri Miyabi - Character Art')).toBeDefined();
  });

  it('38, as ChatGPT runs it at scope propose: the upload proposes the placement, the package takes it over', async () => {
    const proposer: Client = await w.stack.connect(w.stack.newToken('chatgpt', 'propose').token);
    const bytes = Buffer.concat([Buffer.from(pngOf(scenario(38).prompts[0]!), 'base64'), Buffer.from([1])]);
    const up = await w.stack.call(proposer, 'upload_image', {
      data_base64: bytes.toString('base64'),
      name: 'Asagiri Miyabi robes (back)',
      destination: { for_character: { name: 'Asagiri Miyabi', race: 'Foxian' } },
      project: 'test',
    });
    expect(up.body.status, up.text).toBe('proposal_captured');
    const p = await w.stack.call(proposer, 'arkona_add_character_art', {
      character: 'Asagiri Miyabi',
      images: [
        {
          staged_id: String(up.body.staged_id),
          label: 'Outfit Reference - Ceremonial Robes Back',
          interpretation: 'The robes from behind: the vermilion sash knot.',
          subfolder: 'Outfits / Ceremonial Robes',
        },
      ],
      project: 'test',
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    expect(w.stack.runtime.policy.proposals.get(String(up.body.proposalId))!.rejectReason).toBe(
      `superseded by package ${String(p.body.proposalId)}`,
    );
    expect(w.stack.runtime.images.staged(PROJECT, String(up.body.staged_id))!.placementProposalId).toBe(
      String(p.body.proposalId),
    );
  });
});
