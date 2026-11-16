/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F3a (ADR 0050), A2: the engine is type-driven. A dummy second type, defined ONLY in this test's data (a "Polity"
 * with one template, a fixed placement and a primary tag, no hook), plans, previews and proposes through the same engine
 * as the Character type, with no code change: the pack's rules gain the type, the owner approves the new version, and
 * the generic pack tool its `tool` name calls for appears in the tool list. (v3 F3b: its tool is `create_ward`, since
 * `arkona_create_owner` is now the real owner tool, ADR 0052.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packRulesSchema, type TypeRules } from '../../src/packs/types.js';
import { approve, packWorld, type PackWorld } from './world.js';

let w: PackWorld;
beforeAll(async () => {
  w = await packWorld();
});
afterAll(async () => {
  await w?.close();
});

const POLITY: TypeRules = {
  name: 'Polity',
  tool: 'create_ward',
  hook: null,
  placement: { kind: 'fixed', index: 'Locations' },
  roles: [
    {
      role: 'index',
      template: 'index',
      name: '{Name}',
      referenceType: null,
      tags: [],
      facts: 'none',
      body: 'drafted',
      warnMissing: [],
      max: 1,
    },
    {
      role: 'core',
      template: 'general',
      name: '{Name} - Polity Core',
      referenceType: 'Polity Core',
      tags: ['$status', 'Polity'],
      facts: 'identity',
      body: 'required',
      warnMissing: ['Source Boundaries'],
      max: 1,
    },
  ],
  identity: [],
  unestablished: 'Unestablished',
  placeholders: [],
  fixedFacts: { 'Continuity Type': 'CANON', Continuity: 'Main', Inheritance: 'None' },
  generalKeys: [
    'Status',
    'Continuity Type',
    'Continuity',
    'Inheritance',
    'Subject',
    'Reference Type',
    'Scope',
    'Last Major Revision',
    'Supersedes',
  ],
  specialistTags: [],
  suggestedReferenceTypes: {},
  assets: {
    subfolders: { form: 'Forms', outfit: 'Outfits', details: 'Details' },
    displayName: '{Subject} - {Label}',
    section: 'Reference Images',
    role: 'core',
  },
  index: {
    role: 'index',
    purpose: 'Routes to {Name}’s sources.',
    routing: 'How to Use This Index',
    collection: 'Subpages',
    boundaries: 'Index Boundaries',
    boundariesText: 'Routing only.',
  },
  text: {
    firstHeading: 'Purpose',
    unresolved: 'Unresolved Material',
    overload: { roles: [], domains: {}, minChars: 1200 },
  },
  relationship: null,
};

describe('a type defined only in test data (the dummy Polity)', () => {
  it('plans, previews and proposes through the same engine, with no code change', async () => {
    const packs = w.stack.runtime.packs;
    const before = packs.get('arkona')!;
    const client = await w.stack.connect();
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('arkona_create_ward');
    packs.commands.replaceRules(
      'owner',
      'arkona',
      packRulesSchema.parse({ ...before.rules, types: [...before.rules.types, POLITY] }),
      'test: a Polity type',
    );
    // A new version waits for the owner's approval: until then nothing is computed (fail closed).
    const waiting = await w.call('arkona_create_ward', {
      type: 'Polity',
      name: 'Kingdom of Ash',
      pages: [
        {
          role: 'core',
          scope: 'A kingdom',
          markdown: '## Purpose\n\nA kingdom.\n\n## Source Boundaries\n\nOnly.\n',
        },
      ],
      dryRun: true,
      project: 'test',
    });
    expect(waiting.body.error.code).toBe('PACK_NOT_CURRENT');
    expect(waiting.body.error.preview.governance.state).toBe('rules_changed');
    await packs.commands.approve('owner', 'arkona');
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('arkona_create_ward');
    const pkg = {
      type: 'Polity',
      name: 'Kingdom of Ash',
      status: 'authoritative',
      pages: [
        {
          role: 'core',
          scope: 'A kingdom',
          markdown: '## Purpose\n\nA kingdom of the east.\n\n## Source Boundaries\n\nThe realm only.\n',
        },
      ],
      project: 'test',
    };
    const dry = await w.call('arkona_create_ward', { ...pkg, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.type).toBe('Polity');
    expect(dry.body.tree).toEqual([
      expect.objectContaining({ page: '[BSRC] Kingdom of Ash - Polity Core', parent: '[INDEX] Locations' }),
    ]);
    expect(dry.body.pages[0].tags).toEqual(['CANON', 'Polity']);
    expect(dry.body.pages[0].facts).toEqual(
      expect.arrayContaining([
        { key: 'Reference Type', value: 'Polity Core' },
        { key: 'Subject', value: 'Kingdom of Ash' },
        { key: 'Status', value: 'Authoritative' },
      ]),
    );
    const p = await w.call('arkona_create_ward', pkg);
    expect(p.body.status, p.text).toBe('proposal_captured');
    expect(p.body.requiresCanonicalApproval).toBe(true);
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    const page = [...w.repo.res.values()].find((r) => r.name === '[BSRC] Kingdom of Ash - Polity Core')!;
    expect(page.tags).toEqual(['CANON', 'Polity']);
    expect(w.repo.res.get(page.parentId!)!.name).toBe('[INDEX] Locations');
    // A type the tool does not make is refused with the ones it does.
    const wrong = await w.call('arkona_create_ward', { ...pkg, type: 'Creature', dryRun: true });
    expect(wrong.body.error.code).toBe('PACK_TYPE_NOT_FOUND');
    expect(wrong.body.error.types).toEqual(['Polity']);
    // The rules without the type: its tool leaves the list.
    packs.commands.replaceRules('owner', 'arkona', before.rules, 'test: the Polity type removed');
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('arkona_create_ward');
    await client.close();
  });
});
