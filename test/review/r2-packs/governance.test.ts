/**
 * R2-PACKS: governance fails closed (expected HELD; listed so the table covers the brief):
 *
 * - ATK-06: a governance document that cannot be read (deleted, 404) refuses every package (PACK_NOT_CURRENT,
 *   'unreadable'), the direct path at scope write included, and cannot be approved;
 * - ATK-03: a pending pack version does not let a creation tool run: the package tools refuse a pack waiting for
 *   approval (PACK_NOT_CURRENT, 'rules_changed');
 * - ATK-04: a generic pack tool (a type defined in data only) follows the agent's scope like every pack tool (v3 F12,
 *   ADR 0081: the pack's "always propose" switches are gone): ONE direct job at scope write, on Review.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture } from '../../images/world.js';
import { packWorld, type PackWorld } from '../../packs/world.js';
import type { TypeRules } from '../../../src/packs/types.js';
import { body, developed, err, PROJECT, writeAgent } from './helpers.js';

let w: PackWorld;
let agent: Awaited<ReturnType<typeof writeAgent>>;
beforeAll(async () => {
  w = await packWorld({ toolModes: 'seed' });
  agent = await writeAgent(w);
});
afterAll(async () => {
  await w?.close();
});

const packs = () => w.stack.runtime.packs;

describe('ATK-06 (HELD expected): a governance document that cannot be read', () => {
  it('refuses every package (dry run and the direct art path) and cannot be approved', async () => {
    const gone = new RegExp(`/docs/${w.governanceDocs.tagging}/blocks$`);
    w.overrides.set(gone, (req) =>
      req.method === 'GET' ? { status: 404, body: { code: 'NOT_FOUND', message: 'mock: gone' } } : undefined,
    );
    try {
      const dry = await agent('arkona_create_character', { ...developed('Gone Gov'), dryRun: true });
      const up = await agent('upload_image', {
        data_base64: Buffer.concat([fixture('alpha.png'), Buffer.from([61, 6])]).toString('base64'),
        name: 'gov gone',
        stage: true,
        project: 'test',
      });
      const art = await agent('arkona_add_character_art', {
        character: 'Tamsin Reed',
        images: [
          {
            staged_id: String(up.body.staged_id),
            label: 'Primary Reference - Portrait',
            interpretation: 'x',
          },
        ],
        project: 'test',
      });
      let approval: string | null = null;
      try {
        await packs().commands.approve('owner', 'arkona');
      } catch (e) {
        approval = (e as { code?: string }).code ?? 'refused';
      }
      expect({
        dry: err(dry).code,
        art: err(art).code,
        state: (await packs().governance('arkona')).state,
        approval,
      }).toEqual({
        dry: 'PACK_NOT_CURRENT',
        art: 'PACK_NOT_CURRENT',
        state: 'unreadable',
        approval: 'GOVERNANCE_UNREADABLE',
      });
    } finally {
      w.overrides.delete(gone);
    }
  });
});

describe('ATK-03 (HELD expected): a pending version', () => {
  it('arkona_create_character with a pack version waiting for approval: refused, nothing written', async () => {
    const p = packs().get('arkona')!;
    packs().commands.replaceRules('owner', 'arkona', structuredClone(p.rules), 'r2: a pending version');
    const before = w.stack.mock.calls.filter((c) => c.method !== 'GET').length;
    const r = await agent('arkona_create_character', developed('Pending Loosened'));
    expect(err(r).code, r.text).toBe('PACK_NOT_CURRENT');
    expect(w.stack.mock.calls.filter((c) => c.method !== 'GET').length).toBe(before);
    // Approved again.
    await packs().commands.approve('owner', 'arkona');
  });
});

describe('ATK-04 (HELD expected): a generic pack tool', () => {
  it('a generic pack tool (a type in data only) follows the scope: ONE direct job at scope write, on Review', async () => {
    const WARD: TypeRules = {
      name: 'Ward',
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
          name: '{Name} - Ward Core',
          referenceType: 'Ward Core',
          tags: ['$status', 'Ward'],
          facts: 'identity',
          body: 'required',
          warnMissing: [],
          max: 1,
        },
      ],
      identity: [],
      unestablished: 'Unestablished',
      placeholders: [],
      fixedFacts: { 'Continuity Type': 'CANON', Continuity: 'Main', Inheritance: 'None' },
      generalKeys: ['Status', 'Subject', 'Reference Type', 'Scope'],
      specialistTags: [],
      suggestedReferenceTypes: {},
      assets: {
        displayName: '{Subject} - {Label}',
        section: 'Reference Images',
        role: 'core',
      },
      index: {
        role: 'index',
        purpose: 'Routes to {Name}.',
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
    const p = packs().get('arkona')!;
    packs().commands.replaceRules('owner', 'arkona', { ...p.rules, types: [...p.rules.types, WARD] }, 'r2');
    await packs().commands.approve('owner', 'arkona');
    const r = await agent('arkona_create_ward', {
      type: 'Ward',
      name: 'Lantern Ward',
      pages: [{ role: 'core', scope: 'A ward', markdown: body('A ward.') }],
      project: 'test',
    });
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    expect(typeof r.body.jobId, r.text).toBe('string');
    const job = await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 30_000);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(
      w.stack.runtime.review.list(PROJECT, { state: 'all', limit: 500 }).some((i) => i.jobId === job.id),
    ).toBe(true);
  });
});
