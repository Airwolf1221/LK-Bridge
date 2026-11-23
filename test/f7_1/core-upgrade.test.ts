/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- parsed JSON tool results */
/**
 * v3 F7.1 (ADR 0072): a character with an index and several owners has a Character Core, whichever tool gives it the
 * index (the owner's bug of 23 November 2026: arkona_add_character_art made Kamigawa Shirahime's and Emine al-Noor's
 * index and Art page and left their Compact Character Reference at the head). Against the mock LegendKeeper.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture } from '../images/world.js';
import { approve, LIFECYCLE, TPL } from '../packs/world.js';
import { ownerText, PROJECT, type OwnersWorld } from '../packs/owners-world.js';
import { automationWorld } from '../automation/world.js';
import { biography, coreWorld, F, URL_EMINE, URL_SHIRA } from './world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await coreWorld();
});
afterAll(async () => {
  await w?.close();
});

const pageNamed = (name: string) =>
  [...w.repo.res.values()].find((r) => r.deletedAt === null && r.name === name);
const rowsOf = (id: string) => Object.fromEntries(w.sidebars.rows(id).map((r) => [r.key, r.text]));
const mainOf = (id: string) => {
  const main = w.repo.liveDocs(w.repo.res.get(id)!).find((d) => d.name === 'Main')!;
  return w.repo.blocks.get(main.id)!.blocks as any[];
};
const mainOfIn = (x: OwnersWorld, id: string) => {
  const main = x.repo.liveDocs(x.repo.res.get(id)!).find((d) => d.name === 'Main')!;
  return x.repo.blocks.get(main.id)!.blocks as any[];
};
const textOf = (b: any): string =>
  Array.isArray(b.content) ? b.content.map((r: any) => r.text ?? '').join('') : '';
const templateOf = (id: string) => w.stack.runtime.tree.queries.node(PROJECT, id).data?.templateId;
const stage = async (file: string) => {
  const r = await w.call('upload_image', {
    data_base64: fixture(file).toString('base64'),
    name: `stage ${file}`,
    stage: true,
    project: 'test',
  });
  expect(r.isError, r.text).toBe(false);
  return String(r.body.staged_id);
};
const portrait = (staged_id: string) => ({
  staged_id,
  label: 'Expression Reference - Smile',
  interpretation: 'Her smile.',
});
/** The proposal approved (as canon when it is), or the direct job waited for. */
async function settle(r: { body: any; text: string }) {
  if (r.body.status === 'proposal_captured') {
    const d = await approve(w, String(r.body.proposalId));
    return { job: d.job, jobId: d.jobId };
  }
  const jobId = String(r.body.jobId ?? r.body.job?.id);
  for (let i = 0; i < 500; i++) {
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, jobId);
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return { job, jobId };
    await new Promise((x) => setTimeout(x, 20));
  }
  throw new Error(`job ${jobId} did not finish: ${r.text}`);
}

describe('arkona_add_character_art', () => {
  it('a standalone Compact character: ONE proposal makes its index, upgrades it to its Core and makes its Art page', async () => {
    const id = await stage('alpha.png');
    const args = { character: 'Emine al-Noor', images: [portrait(id)], project: 'test' };
    const dry = await w.call('arkona_add_character_art', { ...args, dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.tree.map((t: any) => t.page)).toEqual([
      '[INDEX] Emine al-Noor',
      '[BSRC] Emine al-Noor - Character Art',
    ]);
    const changes = dry.body.existing.map((x: any) => `${x.page}: ${x.change}`).join(' | ');
    expect(changes).toMatch(/renamed to \[BSRC\] Emine al-Noor - Character Core/);
    expect(changes).toMatch(/moved under \[INDEX\] Emine al-Noor/);
    // The note says why; every replacement is shown; the sentence the rules do not cover is listed, not edited.
    expect(dry.body.notes.join('\n')).toContain(
      'Emine al-Noor - Character Reference becomes Emine al-Noor - Character Core (the character now has an index and several owners',
    );
    const core = dry.body.existing.find(
      (x: any) => x.page === '[BSRC] Emine al-Noor - Character Reference' && x.replacements,
    );
    expect(core.replacements.map((r: any) => r.after)).toEqual([
      'Main CANON Character Core for Emine al-Noor, a courier of the Noor house.',
      'This Character Core embeds the image below.',
      'This Character Core owns her identity. A compact build, light on her feet.',
    ]);
    expect(dry.body.warnings).toContainEqual(
      expect.objectContaining({
        code: 'COMPACT_WORDING_LEFT',
        sentences: [expect.objectContaining({ sentence: 'A compact build, light on her feet.' })],
      }),
    );
    expect(dry.body.warnings).toContainEqual(
      expect.objectContaining({ code: 'UPGRADE_OVERLAP', section: 'Visual Disposition' }),
    );

    const p = await w.call('arkona_add_character_art', args);
    expect(p.body.status, p.text).toBe('proposal_captured');
    const prop = w.stack.runtime.policy.proposals.get(String(p.body.proposalId))!;
    expect(prop.requiresCanonicalApproval).toBe(true);
    const { job } = await settle(p);
    expect(job?.status, JSON.stringify(job?.lastError)).toBe('succeeded');
    expect((job?.result as { verified?: boolean }).verified, JSON.stringify(job?.result).slice(0, 3000)).toBe(
      true,
    );
    const index = pageNamed('[INDEX] Emine al-Noor')!;
    const ref = w.repo.live(F.emine)!;
    expect(ref.name).toBe('[BSRC] Emine al-Noor - Character Core');
    expect(ref.parentId).toBe(index.id);
    expect(rowsOf(F.emine)['Reference Type']).toBe('Character Core');
    expect(templateOf(F.emine)).toBe(TPL.core);
    // The Core: its wording, its portrait gone (moved), its prose kept.
    const blocks = mainOf(F.emine);
    expect(blocks.filter((b) => b.kind === 'image')).toEqual([]);
    expect(blocks.map(textOf)).toEqual([
      'Purpose',
      'Main CANON Character Core for Emine al-Noor, a courier of the Noor house.',
      'Visual Disposition',
      'This Character Core embeds the image below.',
      'Her green scarf and the courier’s satchel.',
      'Source Boundaries',
      'This Character Core owns her identity. A compact build, light on her feet.',
    ]);
    // The Art page: the new image and the moved portrait with its interpretation.
    const art = pageNamed('[BSRC] Emine al-Noor - Character Art')!;
    expect(art.parentId).toBe(index.id);
    const artBlocks = mainOf(art.id);
    const images = artBlocks.filter((b) => b.kind === 'image');
    expect(images.map((b) => b.url)).toContain(URL_EMINE);
    expect(images).toHaveLength(2);
    const at = artBlocks.findIndex((b) => b.kind === 'image' && b.url === URL_EMINE);
    expect(textOf(artBlocks[at + 1])).toBe('Her green scarf and the courier’s satchel.');
  });

  it('a Compact character already in its index (beside a Chronicle, no Core): upgraded, no index made', async () => {
    const id = await stage('orientation-6.jpg');
    const dry = await w.call('arkona_add_character_art', {
      character: 'Kamigawa Aya',
      images: [portrait(id)],
      dryRun: true,
      project: 'test',
    });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.tree.map((t: any) => `${t.page} ← ${t.parent}`)).toEqual([
      '[BSRC] Kamigawa Aya - Character Art ← [INDEX] Kamigawa Aya',
    ]);
    const changes = dry.body.existing.map((x: any) => x.change).join(' | ');
    expect(changes).toMatch(/renamed to \[BSRC\] Kamigawa Aya - Character Core/);
  });

  it('a developed character with a Core: no upgrade', async () => {
    const id = await stage('already.webp');
    const dry = await w.call('arkona_add_character_art', {
      character: 'Nadira al-Khalid',
      images: [portrait(id)],
      dryRun: true,
      project: 'test',
    });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.existing.map((x: any) => x.change).join(' | ')).not.toMatch(/renamed/);
    expect(dry.body.notes.join('\n')).not.toMatch(/becomes .* Character Core/);
  });
});

describe('the other callers', () => {
  it('arkona_create_character { target, pages: [specialist] } upgrades without upgradeToCore; an image the Art page holds leaves the Core', async () => {
    const dry = await w.call('arkona_create_character', {
      name: 'ignored',
      target: 'Kamigawa Shirahime',
      pages: [biography()],
      dryRun: true,
      project: 'test',
    });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.existing.map((x: any) => x.change).join(' | ')).toMatch(
      /renamed to \[BSRC\] Kamigawa Shirahime - Character Core/,
    );
    const p = await w.call('arkona_create_character', {
      name: 'ignored',
      target: 'Kamigawa Shirahime',
      pages: [biography()],
      project: 'test',
    });
    const { job } = await settle(p);
    expect(job?.status, JSON.stringify(job?.lastError)).toBe('succeeded');
    expect(w.repo.live(F.shira)!.name).toBe('[BSRC] Kamigawa Shirahime - Character Core');
    expect(rowsOf(F.shira)['Reference Type']).toBe('Character Core');
    // Its portrait was already on the Art page: removed from the Core, not added to the Art page again.
    expect(mainOf(F.shira).filter((b) => b.kind === 'image')).toEqual([]);
    expect(textOf(mainOf(F.shira)[1])).toBe('The Character Core for Kamigawa Shirahime.');
    const art = mainOf(F.shiraArt);
    expect(art.filter((b) => b.kind === 'image').map((b) => b.url)).toEqual([URL_SHIRA]);
    // The Art page's "her character reference" means the identity page; "the character reference images" does not.
    expect(textOf(art[1])).toBe('Her approved visual references; her Character Core owns her identity.');
    expect(textOf(art[7])).toBe('Visual references only; the character reference images stay here.');
  });

  it('arkona_create_owner with a home in a Compact character’s index: the upgrade joins the package', async () => {
    const dry = await w.call('arkona_create_owner', {
      type: 'Equipment',
      name: 'Aya’s Bell',
      descriptor: 'Equipment Reference',
      home: F.ayaIndex,
      homeOverride: { reason: 'The owner keeps her bell with her pages.' },
      status: 'authoritative',
      referenceType: 'Equipment Reference',
      scope: 'Her shrine bell',
      temporalScope: '5A 900 - 5A 931',
      markdown: ownerText('Her shrine bell.'),
      dryRun: true,
      project: 'test',
    });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.existing.map((x: any) => x.change).join(' | ')).toMatch(
      /renamed to \[BSRC\] Kamigawa Aya - Character Core/,
    );
    expect(dry.body.notes.join('\n')).toMatch(
      /Kamigawa Aya - Character Reference becomes its Character Core/,
    );
  });
});

describe('refusals', () => {
  it('upgradeToCore: false with an index and several owners: CORE_REQUIRED, nothing proposed', async () => {
    const r = await w.call('arkona_create_character', {
      name: 'ignored',
      target: 'Kamigawa Aya',
      upgradeToCore: false,
      pages: [
        {
          role: 'specialist',
          title: 'Powers',
          referenceType: 'Character Powers & Mechanics Reference',
          scope: 'Her shrine wards',
          markdown: ownerText('Her shrine wards.'),
        },
      ],
      project: 'test',
    });
    expect(r.body.error?.code, r.text).toBe('CORE_REQUIRED');
    expect(r.body.error.message).toContain('Leave upgradeToCore out');
    expect(r.body.proposalId).toBeUndefined();
    expect(pageNamed('[BSRC] Kamigawa Aya - Biography')).toBeUndefined();
  });

  it('TEMPLATES_DIFFER: the whole package is refused as CORE_REQUIRED, and nothing is made', async () => {
    const kv = w.sidebars.pages.get(TPL.compact)!.props.find((p) => p.kind === 'keyValue')!;
    const saved = kv.rows!;
    kv.rows = saved.slice(0, -1);
    try {
      const id = await stage('animated.gif');
      const r = await w.call('arkona_add_character_art', {
        character: 'Kamigawa Aya',
        images: [portrait(id)],
        project: 'test',
      });
      expect(r.body.error?.code, r.text).toBe('CORE_REQUIRED');
      expect(r.body.error.cause).toBe('TEMPLATES_DIFFER');
      expect(r.body.proposalId).toBeUndefined();
      expect(w.repo.live(F.aya)!.name).toBe('[BSRC] Kamigawa Aya - Character Reference');
      expect(pageNamed('[BSRC] Kamigawa Aya - Character Art')).toBeUndefined();
    } finally {
      kv.rows = saved;
    }
  });
});

describe('Revert', () => {
  it('reverting the package puts the Compact Character Reference back: its name, Reference Type and template', async () => {
    const id = await stage('png-named.jpg');
    const r = await w.call('arkona_add_character_art', {
      character: 'Tomo Reed',
      images: [portrait(id)],
      project: 'test',
    });
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    const { job, jobId } = await settle(r);
    expect(job?.status, JSON.stringify(job?.lastError)).toBe('succeeded');
    expect(w.repo.live(F.tomo)!.name).toBe('[BWRK] Tomo Reed - Character Core');
    expect(rowsOf(F.tomo)['Reference Type']).toBe('Character Core');
    expect(templateOf(F.tomo)).toBe(TPL.core);
    // Revert never deletes what a job made (the index and the Art page stay; ADR 0055): a partial revert, confirmed.
    const preview = await w.stack.runtime.reverts.preview(PROJECT, jobId!);
    const ready = preview.targets.filter((t) => t.state === 'ready').map((t) => t.key);
    expect(ready).toEqual(
      expect.arrayContaining([`resource:${F.tomo}`, `facts:${F.tomo}`, `move:${F.tomo}`]),
    );
    const rv = await w.stack.runtime.reverts.revert('owner', PROJECT, jobId!, {
      confirmPartial: true,
      confirmed: ready,
    });
    expect(rv.status, JSON.stringify(rv)).toBe('submitted');
    if (rv.status !== 'submitted') return;
    let rj = w.stack.runtime.engine.queries.getJob(PROJECT, rv.revertJobId);
    for (let i = 0; i < 500 && rj && !['succeeded', 'failed', 'cancelled'].includes(rj.status); i++) {
      await new Promise((x) => setTimeout(x, 20));
      rj = w.stack.runtime.engine.queries.getJob(PROJECT, rv.revertJobId);
    }
    expect(rj?.status, JSON.stringify(rj?.lastError)).toBe('succeeded');
    expect(w.repo.live(F.tomo)!.name).toBe('[BWRK] Tomo Reed - Character Reference');
    expect(rowsOf(F.tomo)['Reference Type']).toBe('Compact Character Reference');
    expect(templateOf(F.tomo)).toBe(TPL.compact);
    expect(w.repo.live(F.tomo)!.parentId).toBe(LIFECYCLE.working);
    expect(textOf(mainOf(F.tomo)[1])).toBe('The compact reference for Tomo Reed.');
  });
});

/** A full snapshot, then the audits settled. */
async function fullSnapshot(x: OwnersWorld): Promise<void> {
  const r = await x.stack.runtime.snapshots.full(PROJECT, 'manual');
  expect(r.summary ?? '', r.summary).not.toMatch(/MISSING/);
  await x.stack.runtime.audits.settled();
}

describe('the audit: character_core_missing (taxonomy)', () => {
  let x: OwnersWorld;
  beforeAll(async () => {
    x = await coreWorld(
      {},
      (o) => automationWorld({ ...(o?.seed ? { seed: o.seed } : {}), artCodes: true }),
      false,
    );
    await fullSnapshot(x);
    await x.stack.runtime.audits.settled();
    const run = await x.stack.runtime.audits.run(PROJECT, 'manual');
    expect(run.state, run.summary).toBe('succeeded');
  });
  afterAll(async () => x?.close());
  const open = () =>
    x.stack.runtime.audits.store.list(PROJECT, {
      code: ['character_core_missing'],
      state: 'open',
      limit: 100,
    }).findings;

  it('finds each index headed by a Compact Character Reference beside other owners, and nothing else', () => {
    const f = open();
    expect(f.map((y) => y.pageId).sort()).toEqual([F.aya, F.shira].sort());
    expect(f.every((y) => y.category === 'taxonomy' && y.fix?.kind === 'core_upgrade')).toBe(true);
    const shira = f.find((y) => y.pageId === F.shira)!;
    expect(shira.evidence.owners).toEqual(['[BSRC] Kamigawa Shirahime - Character Art']);
  });

  it('the automation’s default is Propose, and Apply is the owner’s switch', () => {
    const code = x.stack.runtime.automation.codes(PROJECT).find((c) => c.code === 'character_core_missing');
    expect(code).toMatchObject({ mode: 'propose', modes: ['off', 'propose', 'apply'] });
  });

  it('its fix proposes the upgrade (one proposal); approving it clears the finding', async () => {
    const f = open().find((y) => y.pageId === F.shira)!;
    const r = await x.stack.runtime.audits.proposeFix('owner', PROJECT, f.id);
    expect(r.status).toBe('proposal_captured');
    if (r.status !== 'proposal_captured') return;
    const prop = x.stack.runtime.policy.proposals.get(r.proposalId)!;
    expect(prop.requiresCanonicalApproval).toBe(true);
    expect(JSON.stringify([prop.summary, prop.pages])).toMatch(/Kamigawa Shirahime - Character Core/);
    const d = await approve(x, r.proposalId);
    expect(d.job?.status, JSON.stringify(d.job?.lastError)).toBe('succeeded');
    expect(x.repo.live(F.shira)!.name).toBe('[BSRC] Kamigawa Shirahime - Character Core');
    // A second fix of the same finding is stale (the page has its Core's name now).
    await expect(x.stack.runtime.audits.proposeFix('owner', PROJECT, f.id)).rejects.toMatchObject({
      code: 'FIX_STALE',
    });
    await fullSnapshot(x);
    const again = await x.stack.runtime.audits.run(PROJECT, 'manual');
    expect(again.state, again.summary).toBe('succeeded');
    expect(open().map((y) => y.pageId)).toEqual([F.aya]);
  });

  const openWording = () =>
    x.stack.runtime.audits.store.list(PROJECT, { code: ['core_compact_wording'], state: 'open', limit: 100 })
      .findings;

  it('core_compact_wording: a Core upgraded before F7.1 is found; the other "compact" sentence is listed; a clean Core is not', () => {
    const f = openWording();
    // Hana Mori's (wording left behind); not Ren Ito's (clean), nor Kamigawa Shirahime's (upgraded by F7.1 above).
    expect(f.map((y) => y.pageId)).toEqual([F.hana]);
    const h = f[0]!;
    expect(h.category).toBe('taxonomy');
    expect(h.fix?.kind).toBe('core_wording');
    const ev = h.evidence as any;
    expect(ev.core.replacements.map((r: any) => r.after)).toEqual([
      'Main CANON Character Core for Hana Mori, a lantern maker.',
      'This Character Core owns her identity. A compact build, light on her feet.',
    ]);
    expect(ev.art.replacements.map((r: any) => r.after)).toEqual([
      'Her approved visual references; her Character Core owns her identity.',
    ]);
    expect(ev.left).toEqual([
      expect.objectContaining({
        page: '[BSRC] Hana Mori - Character Core',
        sentence: 'A compact build, light on her feet.',
      }),
    ]);
  });

  it('core_compact_wording: Propose by default, Apply the owner’s switch', () => {
    const code = x.stack.runtime.automation.codes(PROJECT).find((c) => c.code === 'core_compact_wording');
    expect(code).toMatchObject({ mode: 'propose', modes: ['off', 'propose', 'apply'] });
  });

  it('core_compact_wording: its fix is ONE proposal (Art page first), the unrelated sentence untouched; then the finding clears', async () => {
    const f = openWording()[0]!;
    const before = { core: mainOfIn(x, F.hana), art: mainOfIn(x, F.hanaArt) };
    const r = await x.stack.runtime.audits.proposeFix('owner', PROJECT, f.id);
    expect(r.status).toBe('proposal_captured');
    if (r.status !== 'proposal_captured') return;
    // Nothing written before the owner approves.
    expect(mainOfIn(x, F.hana)).toEqual(before.core);
    const d = await approve(x, r.proposalId);
    expect(d.job?.status, JSON.stringify(d.job?.lastError)).toBe('succeeded');
    const steps = x.stack.runtime.engine.queries.getJob(PROJECT, d.jobId!)!;
    expect(steps.status).toBe('succeeded');
    expect(mainOfIn(x, F.hana).map(textOf)).toEqual([
      'Purpose',
      'Main CANON Character Core for Hana Mori, a lantern maker.',
      'Source Boundaries',
      'This Character Core owns her identity. A compact build, light on her feet.',
    ]);
    expect(mainOfIn(x, F.hanaArt).map(textOf)).toEqual([
      'Purpose',
      'Her approved visual references; her Character Core owns her identity.',
      'Source Boundaries',
      'Visual references only; the character reference images stay here.',
    ]);
    // Block ids kept: only the phrases changed.
    expect(mainOfIn(x, F.hana).map((b) => b.id)).toEqual(before.core.map((b) => b.id));
    // The same finding again: its text has changed since the audit.
    await expect(x.stack.runtime.audits.proposeFix('owner', PROJECT, f.id)).rejects.toMatchObject({
      code: 'FIX_STALE',
    });
    await fullSnapshot(x);
    const again = await x.stack.runtime.audits.run(PROJECT, 'manual');
    expect(again.state, again.summary).toBe('succeeded');
    expect(openWording()).toEqual([]);
  });
});
