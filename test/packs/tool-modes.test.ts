/* eslint-disable @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * v3 F3.4 (ADR 0055 decision D): each pack write tool's "always propose" switch, in the pack's data. The seed's
 * defaults (the three creation tools always propose; adding art and an appraisal fix follow the agent's scope; any other
 * tool follows `alwaysPropose`), the switches on the Packs page's view, a change making a new version that waits for
 * approval (audited), and the runner: at scope `write` a tool switched to "follow the scope" runs directly while one
 * switched to "always propose" is a proposal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { packToolMode } from '../../src/packs/types.js';
import { PROJECT } from '../tools/helpers.js';
import { approve, compactPackage, packWorld, type PackWorld } from './world.js';
import { fixture } from '../images/world.js';

describe('the seed (arkona-2026-11-23-f5a, superseding F3.4’s arkona-2026-11-17-f3-4)', () => {
  it('supersedes F3.3’s seed (labelled f3d) and F3.4’s', () => {
    // v3 F3e (ADR 0059), F3f (ADR 0060), F4a (ADR 0063), F4b (ADR 0064), F4b.1 (ADR 0064 amendment 1) and F4c (ADR 0065) made new seeds; F3.4's
    // switches are unchanged in them.
    // v3 F5a (ADR 0067): the seed is now arkona-2026-11-23-f5a, superseding -r4.
    expect(ARKONA_PACK.seed).toBe('arkona-2026-11-27-f6c'); // v3 F6c (ADR 0080): -f6c supersedes -f6b
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-21-r4');
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-20-f4b1');
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-20-f4b');
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-19-f4a');
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-19-f3f');
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-18-f3e');
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-17-f3d');
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-17-f3-4');
  });

  it('the creation tools always propose; adding art and an appraisal fix follow the agent’s scope', () => {
    const r = ARKONA_PACK.rules;
    expect(packToolMode(r, 'arkona_create_character')).toBe('propose');
    expect(packToolMode(r, 'arkona_create_owner')).toBe('propose');
    expect(packToolMode(r, 'arkona_create_relationship')).toBe('propose');
    expect(packToolMode(r, 'arkona_add_character_art')).toBe('scope');
    expect(packToolMode(r, 'arkona_appraisal_fix')).toBe('scope');
    // v3 F3f (ADR 0060): the retag apply is a separately approved apply.
    expect(packToolMode(r, 'arkona_retag_apply')).toBe('propose');
    // A tool no switch names follows alwaysPropose (on in the seed).
    expect(packToolMode(r, 'arkona_create_polity')).toBe('propose');
    expect(packToolMode({ settings: { alwaysPropose: false } }, 'arkona_create_polity')).toBe('scope');
    // v3 F4c (ADR 0065, design E5): routine narrative organisation follows the scope; promotion to canon proposes.
    for (const t of [
      'arkona_story_create',
      'arkona_chapter_plan',
      'arkona_chapter_save',
      'arkona_chapter_insert',
      'arkona_chapter_move',
    ])
      expect(packToolMode(r, t), t).toBe('scope');
    expect(packToolMode(r, 'arkona_promote_from_chapter')).toBe('propose');
  });
});

let w: PackWorld;
beforeAll(async () => {
  w = await packWorld({ toolModes: 'seed' });
});
afterAll(async () => {
  await w?.close();
});

const packs = () => w.stack.runtime.packs;

describe('the Packs page’s switches', () => {
  it('lists each write tool with its switch (the read-only brief is not one)', () => {
    const v = packs().view('arkona')!;
    const modes = Object.fromEntries(v.toolModes.map((t) => [t.tool, `${t.mode}/${t.source}`]));
    expect(modes).toMatchObject({
      arkona_create_character: 'propose/switch',
      arkona_create_owner: 'propose/switch',
      arkona_create_relationship: 'propose/switch',
      arkona_add_character_art: 'scope/switch',
      arkona_appraisal_fix: 'scope/switch',
    });
    expect(v.toolModes.map((t) => t.tool)).not.toContain('arkona_character_brief');
  });

  it('a change makes a new version that waits for approval, audited; the same switch again changes nothing', async () => {
    const before = packs().get('arkona')!;
    expect(before.approved?.version).toBe(before.version);
    const after = packs().commands.setToolModes('owner', 'arkona', { arkona_add_character_art: 'propose' });
    expect(after.version).toBe(before.version + 1);
    expect(after.approved?.version).toBe(before.version);
    expect(packToolMode(after.rules, 'arkona_add_character_art')).toBe('propose');
    const audit = w.stack.runtime.policy.store.listAudit({ action: 'pack.set_tool_modes', limit: 1 })[0]!;
    expect(audit.before).toMatchObject({ version: before.version });
    expect(audit.after).toMatchObject({
      version: after.version,
      tools: expect.objectContaining({ arkona_add_character_art: 'propose' }),
    });
    expect(
      packs().commands.setToolModes('owner', 'arkona', { arkona_add_character_art: 'propose' }).version,
    ).toBe(after.version);
    expect(() => packs().commands.setToolModes('owner', 'arkona', { arkona_delete_world: 'scope' })).toThrow(
      /no write tool/,
    );
    // Until approved, every package is refused (as for any new version).
    const refused = await w.call('arkona_create_character', compactPackage({ name: 'Asagiri Kenta' }));
    expect(refused.text).toMatch(/PACK_NOT_CURRENT/);
    // Put back and approve, for the runner tests below.
    packs().commands.setToolModes('owner', 'arkona', { arkona_add_character_art: 'scope' });
    await packs().commands.approve('owner', 'arkona');
  });
});

describe('the runner at scope write', () => {
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

  it('art for a canon character is still a canonical proposal, whatever the switch says', async () => {
    const id = await stage('orientation-6.jpg');
    const r = await w.call('arkona_add_character_art', {
      character: 'Mehrana I al-Khalid',
      images: [{ staged_id: id, label: 'Primary Reference - Portrait', interpretation: 'Her face.' }],
      project: 'test',
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.requiresCanonicalApproval).toBe(true);
    w.stack.runtime.policy.commands.reject('owner', String(r.body.proposalId), 'test');
  });

  it('a creation tool (always propose) is a proposal at write scope; approved, it never reaches the Review page', async () => {
    const r = await w.call('arkona_create_character', compactPackage({ name: 'Asagiri Hiro' }));
    expect(r.body.status, r.text).toBe('proposal_captured');
    const done = await approve(w, String(r.body.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    // ADR 0055 decision A: the owner saw the package before it happened.
    const listed = w.stack.runtime.review.list(PROJECT, { state: 'all', limit: 500 }).map((i) => i.jobId);
    expect(listed).not.toContain(done.jobId);
  });

  it('adding art (follows the scope) runs directly at write scope: a job, no proposal', async () => {
    const id = await stage('alpha.png');
    // A Working character: its new Art page is Working, so nothing canonical makes it a proposal.
    const r = await w.call('arkona_add_character_art', {
      character: 'Tamsin Reed',
      images: [
        {
          staged_id: id,
          label: 'Primary Reference - Character Portrait',
          interpretation: 'Her face and her robes.',
        },
      ],
      project: 'test',
    });
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    expect(typeof r.body.jobId).toBe('string');
    const job = await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 30_000);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(job.approvedBy).toBeNull();
    // A direct write: on the Review page for the owner to look at afterwards.
    const listed = w.stack.runtime.review
      .list(PROJECT, { state: 'unreviewed', limit: 500 })
      .map((i) => i.jobId);
    expect(listed).toContain(job.id);
  });

  it('switched to "follow the scope" and approved, a creation tool runs directly too', async () => {
    packs().commands.setToolModes('owner', 'arkona', { arkona_create_character: 'scope' });
    await packs().commands.approve('owner', 'arkona');
    const r = await w.call('arkona_create_character', compactPackage({ name: 'Asagiri Sora' }));
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    const job = await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 30_000);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
  });
});
