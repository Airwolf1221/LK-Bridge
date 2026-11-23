/**
 * v3 F3a (ADR 0050): the setting packs service. The Arkona pack is seeded once as DATA and attached to the projects its
 * seed names; its template ids are worked out per project from the home project's template names (never names in code);
 * the owner's approval records each governance source's document version; a changed source (or rules edited since the
 * approval) fails closed; the token maps are edited as a new version, audited.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { packRulesSchema } from '../../src/packs/types.js';
import { PROJECT } from '../tools/helpers.js';
import { packWorld, type PackWorld } from './world.js';

let w: PackWorld;
beforeAll(async () => {
  w = await packWorld();
});
afterAll(async () => {
  await w?.close();
});

const audit = (action: string) => w.stack.runtime.policy.commands.listAudit('owner', { action });

describe('the Arkona pack, as data', () => {
  it('is seeded once from valid data with the governance sources it was derived from', () => {
    expect(() => packRulesSchema.parse(ARKONA_PACK.rules)).not.toThrow();
    const pack = w.stack.runtime.packs.get('arkona')!;
    expect(pack.prefix).toBe('arkona_');
    expect(pack.seed).toBe(ARKONA_PACK.seed);
    expect(ARKONA_PACK.governance.map((g) => `${g.resourceId}/${g.documentId}`)).toEqual([
      'cn8v87hh/p5rcvxze',
      'cn8v87hh/l41y28c8',
      'cn8v87hh/bfrv43jr',
      // v3 F5b (ADR 0068): Repository Automation, the governance root's tab xd9gzkel.
      'cn8v87hh/xd9gzkel',
      // v3 F4c (ADR 0065, design E9): the fiction Design References, found by their page names (any dash).
      '/',
      '/',
    ]);
    expect(ARKONA_PACK.governance.slice(4).map((g) => [g.page, g.sections])).toEqual([
      [
        'Arkona - Narrative Story Planning & Drafting Workflow',
        ['LegendKeeper Planning and Manuscript Structure'],
      ],
      ['Arkona - Fiction Writing Reference', ['32B. Durable Chapter Persistence in LegendKeeper']],
    ]);
    expect(ARKONA_PACK.projects.find((p) => p.name === 'arkona')?.templates).toEqual({
      core: 'bffw83fb',
      compact: 'exl4dzki',
      art: 'g7gdpoe6',
      relationship: 'krkreawl',
      general: 'ie08m47o',
      index: 'zaomdr49',
    });
    // Seeding again changes nothing.
    w.stack.runtime.packs.ensureSeeded();
    expect(w.stack.runtime.packs.list()).toHaveLength(1);
    expect(audit('pack.seed')).toHaveLength(1);
  });

  it('is attached to the test project (the tool is listed) with its template ids', () => {
    const a = w.stack.runtime.packs.attachment('arkona', PROJECT)!;
    expect(a.templates.core).toBe('tplcore1');
    expect(w.stack.runtime.packs.toolListed('arkona')).toBe(true);
    const view = w.stack.runtime.packs.view('arkona')!;
    // v3 F3b (ADR 0052): the character hook's own tools and the owners' tool beside the character tool.
    expect(view.tools).toEqual([
      'arkona_create_character',
      'arkona_create_relationship',
      'arkona_add_character_art',
      'arkona_character_brief',
      'arkona_get_art',
      'arkona_create_owner',
    ]);
    expect(view.attachments.map((x) => x.projectName)).toEqual(['test']);
  });

  it('records each source’s version on approval (audited), and fails closed on drift until approved again', async () => {
    const packs = w.stack.runtime.packs;
    const approved = packs.get('arkona')!.approved!;
    expect(approved.by).toBe('owner');
    expect(approved.sources.map((s) => s.key)).toEqual([
      'character-architecture',
      'source-formatting',
      'tagging-standard',
    ]);
    expect(audit('pack.approve').length).toBeGreaterThan(0);
    expect((await packs.governance('arkona')).state).toBe('current');
    w.editGovernance('architecture');
    const drift = await packs.governance('arkona');
    expect(drift.state).toBe('changed');
    expect(drift.sources.find((s) => s.key === 'character-architecture')!.state).toBe('changed');
    expect(packs.get('arkona')!.drift?.changed.map((c) => c.key)).toEqual(['character-architecture']);
    expect(audit('pack.drift').length).toBeGreaterThan(0);
    await packs.commands.approve('owner', 'arkona');
    expect((await packs.governance('arkona')).state).toBe('current');
    expect(packs.get('arkona')!.drift).toBeNull();
  });

  it('only the owner approves; an unreadable source cannot be approved', async () => {
    const packs = w.stack.runtime.packs;
    await expect(packs.commands.approve('agent', 'arkona')).rejects.toMatchObject({ code: 'NOT_OWNER' });
    const pack = packs.get('arkona')!;
    packs.store.setGovernance('arkona', [{ ...pack.governance[0]!, documentId: 'nosuchdoc' }]);
    try {
      await expect(packs.commands.approve('owner', 'arkona')).rejects.toMatchObject({
        code: 'GOVERNANCE_UNREADABLE',
      });
      expect((await packs.governance('arkona')).state).not.toBe('current');
    } finally {
      packs.store.setGovernance('arkona', pack.governance);
    }
  });

  it('the token maps are edited as a new version (audited), which waits for approval', async () => {
    const packs = w.stack.runtime.packs;
    const v = packs.get('arkona')!.version;
    const after = packs.commands.setTokens('owner', 'arkona', {
      race: { ...packs.get('arkona')!.rules.tags.race, Starborn: 'Starborn' },
    });
    expect(after.version).toBe(v + 1);
    expect(after.rules.tags.race.Starborn).toBe('Starborn');
    expect(audit('pack.set_tokens')[0]).toMatchObject({ target: 'arkona' });
    expect((await packs.governance('arkona')).state).toBe('rules_changed');
    expect(() => packs.commands.setTokens('owner', 'arkona', { culture: { Foo: 'Unknown' } })).toThrow(
      /never a tag/,
    );
    expect(() => packs.commands.setTokens('owner', 'arkona', { culture: { 'Foo — Bar': 'Foo' } })).toThrow(
      /dashes/,
    );
    await packs.commands.approve('owner', 'arkona');
    expect(packs.get('arkona')!.approved!.version).toBe(v + 1);
    expect(packs.store.versions('arkona')[0]).toMatchObject({
      version: v + 1,
      reason: 'token maps edited on the Packs page',
    });
  });
});

describe('template ids worked out per project', () => {
  it('from the home project’s template names, exactly; unset with a note when they cannot be', () => {
    const packs = w.stack.runtime.packs;
    // The test world is its own home here: a project named "arkona" is not registered, so nothing can be worked out.
    const a = packs.commands.attach('owner', 'arkona', PROJECT);
    expect(Object.values(a.templates).every((v) => v === null)).toBe(true);
    expect(a.notes.join(' ')).toMatch(/home project/);
    // Put back as the world had it.
    packs.commands.attach('owner', 'arkona', PROJECT, {
      index: 'tplindex',
      core: 'tplcore1',
      compact: 'tplcomp1',
      general: 'tplgen01',
      art: 'tplart01',
      relationship: 'tplrel01',
    });
  });
});
