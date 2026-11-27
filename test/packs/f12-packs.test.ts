/**
 * v3 F12 (ADR 0081, D1): the pack's per-tool "always propose" switches are gone. The seed carries none; a pack stored
 * from an earlier seed (with `alwaysPropose` and `tools`) is offered the F12 seed's rules without them, and a version
 * stored before F12 still parses; the Packs page lists no switches and their route is gone. At scope `write` every pack
 * tool runs directly (canon included: art for a canon character, a new character package), on the owner's Review page;
 * at scope `propose` the same call is a proposal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { packRulesSchema } from '../../src/packs/types.js';
import { PROJECT } from '../tools/helpers.js';
import { compactPackage, packWorld, type PackWorld } from './world.js';
import { fixture } from '../images/world.js';

describe('the seed (arkona-2026-11-26-f12)', () => {
  it('supersedes F6c’s and carries no switches', () => {
    expect(ARKONA_PACK.seed).toBe('arkona-2026-11-26-f12');
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-27-f6c');
    expect(ARKONA_PACK.supersedes).toContain('arkona-2026-11-17-f3-4');
    expect(ARKONA_PACK.rules.settings).toEqual({});
  });

  it('a version stored before F12, with its switches, still parses (they are ignored)', () => {
    const old = packRulesSchema.parse({
      ...ARKONA_PACK.rules,
      settings: { alwaysPropose: true, tools: { arkona_create_character: 'propose' } },
    });
    expect(old.settings.alwaysPropose).toBe(true);
  });
});

let w: PackWorld;
beforeAll(async () => {
  // `seed`: the world's agent at scope `write`.
  w = await packWorld({ toolModes: 'seed' });
});
afterAll(async () => {
  await w?.close();
});

const packs = () => w.stack.runtime.packs;

describe('every pack tool at scope write is direct, canon included', () => {
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
  const onReview = (jobId: string) =>
    w.stack.runtime.review
      .list(PROJECT, { state: 'unreviewed', limit: 500 })
      .map((i) => i.jobId)
      .includes(jobId);

  it('art for a canon character runs directly (no canonical proposal), and is on the Review page', async () => {
    const id = await stage('orientation-6.jpg');
    const r = await w.call('arkona_add_character_art', {
      character: 'Mehrana I al-Khalid',
      images: [{ staged_id: id, label: 'Primary Reference - Portrait', interpretation: 'Her face.' }],
      project: 'test',
    });
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    expect(r.body.requiresCanonicalApproval).toBeUndefined();
    const job = await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 30_000);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(job.approvedBy).toBeNull();
    expect(onReview(job.id)).toBe(true);
  });

  it('a character package (always a proposal before F12) runs directly too, on the Review page', async () => {
    const r = await w.call('arkona_create_character', compactPackage({ name: 'Asagiri Sora' }));
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    const job = await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 30_000);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(onReview(job.id)).toBe(true);
  });

  it('at scope propose the same package is a proposal', async () => {
    const { token } = w.stack.newToken('f12-propose', 'propose');
    const client = await w.stack.connect(token);
    const r = await w.stack.call(
      client,
      'arkona_create_character',
      compactPackage({ name: 'Asagiri Kaito' }),
    );
    expect(r.body.status, r.text).toBe('proposal_captured');
    w.stack.runtime.policy.commands.reject('owner', String(r.body.proposalId), 'test');
  });
});

// Last: the upgrade leaves a version waiting for approval (every package is refused until then).
describe('the pack upgrade drops the switches', () => {
  it('a pack stored from F6c’s seed, with switches, is offered the F12 rules without them, for approval', () => {
    const before = packs().get('arkona')!;
    // As a pack stored from the F6c seed was: its switches in its settings.
    packs().store.upgrade(
      'arkona',
      packRulesSchema.parse({
        ...before.rules,
        settings: {
          alwaysPropose: true,
          tools: { arkona_create_character: 'propose', arkona_add_character_art: 'scope' },
        },
      }),
      before.governance,
      'arkona-2026-11-27-f6c',
      'test: stored from the F6c seed',
    );
    const stored = packs().get('arkona')!;
    expect(stored.rules.settings.tools).toBeDefined();
    packs().ensureSeeded();
    const after = packs().get('arkona')!;
    expect(after.seed).toBe('arkona-2026-11-26-f12');
    expect(after.version).toBe(stored.version + 1);
    expect(after.rules.settings).toEqual({});
    // Offered, never approved here: the owner approves it on the Packs page.
    expect(after.approved?.version).not.toBe(after.version);
  });

  it('the Packs page lists no switches', () => {
    const v = packs().view('arkona')! as unknown as Record<string, unknown>;
    expect(v.toolModes).toBeUndefined();
    expect(Object.keys(packs().commands)).not.toContain('setToolModes');
  });
});
