/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
/**
 * v3 F3a (ADR 0050): the four Arkona evaluation scenarios (docs/reviews/scenarios.json, 31 to 34), each with the package
 * a good run sends, against the mock LegendKeeper in the order the owner runs them: the compact character approved and
 * looked at; the developed character with its staged image, previewed and proposed; the missing Naming Culture refused
 * until the owner leaves it open with a reason; the compact character extended with a Biography and upgraded to a Core.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadScenarios } from '../../src/evaluation/scenarios.js';
import type { ToolCall } from '../tools/helpers.js';
import { approve, packWorld, type PackWorld } from './world.js';

const TOOL = 'arkona_create_character';
let w: PackWorld;
beforeAll(async () => {
  w = await packWorld();
});
afterAll(async () => {
  await w?.close();
});

const call = (args: Record<string, unknown>): Promise<ToolCall> => w.call(TOOL, { project: 'test', ...args });
const pageNamed = (name: string) =>
  [...w.repo.res.values()].find((r) => r.deletedAt === null && r.name === name);
const parentOf = (name: string) => w.repo.res.get(pageNamed(name)!.parentId!)?.name;
const rowsOf = (id: string) => Object.fromEntries(w.sidebars.rows(id).map((r) => [r.key, r.text]));
const scenario = (id: number) => loadScenarios().scenarios.find((s) => s.id === id)!;
const pngOf = (prompt: string) => /([A-Za-z0-9+/]{60,}={0,2})\s*$/.exec(prompt)![1]!;
const text = (purpose: string, more = '') =>
  `## Purpose\n\n${purpose}\n\n${more}## Source Boundaries\n\nThis page only.\n\n## Unresolved Material\n\nNone yet.\n`;

describe('the Arkona evaluation scenarios, as a good run sends them', () => {
  const sae = {
    name: 'Hoshino Sae',
    depth: 'compact',
    identity: {
      givenName: 'Sae',
      surname: 'Hoshino',
      race: 'Foxian',
      namingCulture: 'Fujimatsuan',
      lifeState: 'Alive at 5A 931',
      temporalScope: '5A 920 - 5A 931',
    },
    pages: [
      {
        role: 'compact',
        scope: 'Lantern-keeper of the Hollow Court shrine',
        markdown: text(
          'The compact reference for Hoshino Sae.',
          '## Role\n\nShe keeps the shrine’s lanterns.\n\n',
        ),
      },
    ],
  };

  it('31: a compact background character, previewed, proposed once, approved and as the owner checks it', async () => {
    expect(scenario(31).pack).toBe('arkona');
    const dry = await call({ ...sae, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.tree).toEqual([
      expect.objectContaining({
        page: '[BWRK] Hoshino Sae - Character Reference',
        parent: '[INDEX] Working',
      }),
    ]);
    expect(dry.body.pages[0].tags).toEqual(['Working', 'Character', 'Foxian', 'Fujimatsuan']);
    const p = await call(sae);
    expect(p.body.status, p.text).toBe('proposal_captured');
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    const page = pageNamed('[BWRK] Hoshino Sae - Character Reference')!;
    expect(parentOf(page.name)).toBe('[INDEX] Working');
    expect(page.tags).toEqual(['Working', 'Character', 'Foxian', 'Fujimatsuan']);
    expect(rowsOf(page.id)).toMatchObject({
      Status: 'Working',
      'Personal / Given Name': 'Sae',
      'Family / Surname': 'Hoshino',
      'Race / Species': 'Foxian',
      'Naming Culture': 'Fujimatsuan',
      'Reference Type': 'Compact Character Reference',
    });
  });

  it('32: a developed character with a staged image and a relationship: previewed, then one proposal', async () => {
    const staged = await w.call('upload_image', {
      data_base64: pngOf(scenario(32).prompts[0]!),
      name: 'Mizuhara Ayame portrait',
      stage: true,
      project: 'test',
    });
    expect(staged.isError, staged.text).toBe(false);
    const pkg = {
      name: 'Mizuhara Ayame',
      depth: 'developed',
      identity: {
        givenName: 'Ayame',
        surname: 'Mizuhara',
        race: 'Foxian',
        namingCulture: 'Fujimatsuan',
        lifeState: 'Alive at 5A 931',
        temporalScope: '5A 905 - 5A 931',
      },
      pages: [
        { role: 'core', scope: 'Identity and routing', markdown: text('The identity of Mizuhara Ayame.') },
        {
          role: 'specialist',
          title: 'Biography',
          specialistTag: 'Biography',
          scope: 'Her life to 5A 931',
          markdown: '## Purpose\n\nHer life.\n\n## Early Life\n\nRaised at the shrine; the bow at twelve.\n',
        },
        {
          role: 'specialist',
          title: 'Personality',
          specialistTag: 'Personality',
          scope: 'Her temperament',
          markdown: '## Purpose\n\nHer temperament.\n\n## Temperament\n\nPatient, with a dry humour.\n',
        },
        {
          role: 'art',
          scope: 'Her approved visual references',
          markdown: '## Purpose\n\nHer approved visual references.\n',
          images: [
            {
              staged_id: String(staged.body.staged_id),
              label: 'Primary Reference - Character Portrait',
              interpretation: 'Her face, her hair and her archer’s robes.',
            },
          ],
        },
        { role: 'relationship', with: 'Asagiri Miyabi', scope: 'Her teacher', markdown: text('Their bond.') },
      ],
    };
    const dry = await call({ ...pkg, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect((dry.body.tree as { page: string }[]).map((t) => t.page)).toEqual([
      '[INDEX] Mizuhara Ayame',
      '[BWRK] Mizuhara Ayame - Biography',
      '[BWRK] Mizuhara Ayame - Character Art',
      '[BWRK] Mizuhara Ayame - Character Core',
      '[BWRK] Mizuhara Ayame - Personality',
      '[BWRK] Mizuhara Ayame & Asagiri Miyabi - Relationship',
    ]);
    expect(dry.body.tree[0].parent).toBe('[INDEX] Working');
    expect(dry.body.warnings.map((x: { code: string }) => x.code)).toContain('PARTNER_LINK_DEFERRED');
    expect(dry.body.assets).toHaveLength(1);
    const p = await call(pkg);
    expect(p.body.status, p.text).toBe('proposal_captured');
    // The owner rejects it in the scenario; here it simply waits.
    expect(w.stack.runtime.policy.proposals.get(String(p.body.proposalId))!.state).toBe('pending');
  });

  it('33: a missing Naming Culture is refused, saying to ask the owner; left open with a reason it previews', async () => {
    const tomas = {
      name: 'Tomas Reyk',
      depth: 'compact',
      identity: {
        givenName: 'Tomas',
        surname: 'Reyk',
        race: 'Human',
        lifeState: 'Alive at 5A 931',
        temporalScope: '5A 925 - 5A 931',
      },
      pages: [
        { role: 'compact', scope: 'Ferryman on the Hollow River', markdown: text('Tomas Reyk, a ferryman.') },
      ],
      dryRun: true,
    };
    const refused = await call(tomas);
    expect(refused.body.error.code).toBe('IDENTITY_INCOMPLETE');
    expect(refused.body.error.fields).toEqual(['Naming Culture']);
    expect(refused.body.error.message).toMatch(/ask the owner/);
    const noReason = await call({
      ...tomas,
      identity: { ...tomas.identity, namingCulture: 'Unestablished' },
    });
    expect(noReason.body.error.code).toBe('UNESTABLISHED_NEEDS_REASON');
    const open = await call({
      ...tomas,
      identity: {
        ...tomas.identity,
        namingCulture: {
          value: 'Unestablished',
          reason: 'The owner has not decided his naming culture yet.',
        },
      },
    });
    expect(open.isError, open.text).toBe(false);
    expect(open.body.pages[0].tags).not.toContain('Unestablished');
    expect(open.body.pages[0].facts).toContainEqual({ key: 'Naming Culture', value: 'Unestablished' });
  });

  it('34: the compact character extended with a Biography and upgraded to its Core, never made twice', async () => {
    const again = await call({ ...sae, dryRun: true });
    expect(again.body.error.code).toBe('CHARACTER_EXISTS');
    const reference = pageNamed('[BWRK] Hoshino Sae - Character Reference')!;
    const pkg = {
      name: 'Hoshino Sae',
      target: 'Hoshino Sae',
      upgradeToCore: true,
      pages: [
        {
          role: 'specialist',
          title: 'Biography',
          specialistTag: 'Biography',
          scope: 'Her life',
          markdown: '## Purpose\n\nHer life.\n\n## Early Life\n\nFound as a child at the shrine gate.\n',
        },
      ],
    };
    const dry = await call({ ...pkg, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.tree[0]).toMatchObject({ page: '[INDEX] Hoshino Sae', parent: '[INDEX] Working' });
    const p = await call(pkg);
    expect(p.body.status, p.text).toBe('proposal_captured');
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified).toBe(true);
    const core = w.repo.res.get(reference.id)!;
    expect(core.name).toBe('[BWRK] Hoshino Sae - Character Core');
    expect(parentOf(core.name)).toBe('[INDEX] Hoshino Sae');
    expect(parentOf('[INDEX] Hoshino Sae')).toBe('[INDEX] Working');
    expect(parentOf('[BWRK] Hoshino Sae - Biography')).toBe('[INDEX] Hoshino Sae');
    expect(rowsOf(core.id)['Reference Type']).toBe('Character Core');
  });
});
