/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F3b (ADR 0052; design section 6, the F3a fix found in evaluation scenario 32): at scope `propose`, `upload_image`
 * with a destination stages the image AND proposes its placement; a package that then names that staged image takes the
 * placement over: the image's own pending placement proposal is withdrawn ("superseded by package prop_…") and the
 * package places the image itself. Any other pending activity still refuses (STAGED_IMAGE_BUSY), and the job checks
 * again, before it writes, that the image is still its to place. Plus the owner tool's run-time re-check: two packages
 * for one owner name end with one page and one clean refusal.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture } from '../images/world.js';
import { approve } from './world.js';
import { compactPolity, ownersWorld, PROJECT, type OwnersWorld } from './owners-world.js';

let w: OwnersWorld;
let proposer: Client;
beforeAll(async () => {
  w = await ownersWorld();
  proposer = await w.stack.connect(w.stack.newToken('chatgpt-like', 'propose').token);
});
afterAll(async () => {
  await w?.close();
});

const asProposer = (name: string, args: Record<string, unknown>) =>
  w.stack.call(proposer, name, { project: 'test', ...args });
const bytes = (salt: number) =>
  Buffer.concat([fixture('alpha.png'), Buffer.from([salt, salt])]).toString('base64');
const proposals = () => w.stack.runtime.policy.proposals;
const art = (stagedId: string, label = 'Primary Reference - Character Portrait') => ({
  character: 'Nadira al-Khalid',
  images: [{ staged_id: stagedId, label, interpretation: 'Her face and her archivist’s robes.' }],
});

describe('a staged image’s own pending placement is taken over', () => {
  it('at scope propose: upload_image proposes the placement; the package withdraws it and places the image itself', async () => {
    const up = await asProposer('upload_image', {
      data_base64: bytes(1),
      name: 'Nadira portrait',
      destination: { for_character: { name: 'Nadira al-Khalid', race: 'Qishen' } },
    });
    expect(up.body.status, up.text).toBe('proposal_captured');
    const own = String(up.body.proposalId);
    const staged = String(up.body.staged_id);
    // The preview says it takes the placement over (no STAGED_IMAGE_BUSY any more).
    const dry = await asProposer('arkona_add_character_art', { ...art(staged), dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.body.takesOver).toEqual([expect.objectContaining({ staged_id: staged, proposalId: own })]);
    expect(proposals().get(own)!.state).toBe('pending');
    // The package: one proposal; the image's own one withdrawn, naming it.
    const p = await asProposer('arkona_add_character_art', art(staged));
    expect(p.body.status, p.text).toBe('proposal_captured');
    const pkg = String(p.body.proposalId);
    expect(p.body.takenOver).toEqual([
      expect.objectContaining({
        staged_id: staged,
        proposalId: own,
        withdrawn: true,
        note: `superseded by package ${pkg}`,
      }),
    ]);
    const old = proposals().get(own)!;
    expect(old).toMatchObject({
      state: 'rejected',
      rejectReason: `superseded by package ${pkg}`,
      decidedBy: 'system',
    });
    expect(
      w.stack.runtime.policy.store.listAudit({ action: 'proposal.superseded' }).map((a) => a.target),
    ).toContain(own);
    expect(w.stack.runtime.images.staged(PROJECT, staged)!.placementProposalId).toBe(pkg);
    // Approved, the package places the image once.
    const done = await approve(w, pkg);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const row = w.stack.runtime.images.staged(PROJECT, staged)!;
    expect(row.staged).toBe(false);
    expect(w.assets.byName('Nadira al-Khalid - Primary Reference - Character Portrait')).toHaveLength(1);
  });

  it('scenario 32’s path: the character tool takes it over too', async () => {
    const up = await asProposer('upload_image', {
      data_base64: bytes(2),
      name: 'Kaede portrait',
      destination: { for_character: { name: 'Nadira al-Khalid', race: 'Qishen' } },
    });
    expect(up.body.status, up.text).toBe('proposal_captured');
    const staged = String(up.body.staged_id);
    const p = await asProposer('arkona_create_character', {
      name: 'Asagiri Rin',
      depth: 'developed',
      identity: {
        givenName: 'Rin',
        surname: 'Asagiri',
        race: 'Foxian',
        namingCulture: 'Fujimatsuan',
        lifeState: 'Alive at 5A 931',
        temporalScope: '5A 910 - 5A 931',
      },
      pages: [
        {
          role: 'core',
          scope: 'A shrine archer',
          markdown:
            '## Purpose\n\nRin.\n\n## Source Boundaries\n\nOnly.\n\n## Unresolved Material\n\nNone.\n',
        },
        {
          role: 'art',
          scope: 'Her references',
          markdown: '## Purpose\n\nHer references.\n',
          images: [
            {
              staged_id: staged,
              label: 'Primary Reference - Character Portrait',
              interpretation: 'Her face.',
            },
          ],
        },
      ],
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    expect(proposals().get(String(up.body.proposalId))!.rejectReason).toBe(
      `superseded by package ${String(p.body.proposalId)}`,
    );
    w.stack.runtime.policy.commands.reject('owner', String(p.body.proposalId), 'test');
  });

  it('refuses any other pending activity: an image in another package’s proposal is STAGED_IMAGE_BUSY', async () => {
    const up = await w.call('upload_image', {
      data_base64: bytes(3),
      name: 'busy',
      stage: true,
      project: 'test',
    });
    const staged = String(up.body.staged_id);
    const first = await w.call('arkona_add_character_art', { ...art(staged), project: 'test' });
    expect(first.body.status, first.text).toBe('proposal_captured');
    const second = await w.call('arkona_add_character_art', {
      ...art(staged, 'Detail Reference - Hands'),
      dryRun: true,
      project: 'test',
    });
    expect(second.body.error.code).toBe('STAGED_IMAGE_BUSY');
    expect(second.body.error.hint).toMatch(/stage: true \} and no destination/);
    // The first package's proposal is untouched.
    expect(proposals().get(String(first.body.proposalId))!.state).toBe('pending');
    w.stack.runtime.policy.commands.reject('owner', String(first.body.proposalId), 'test');
  });

  it('the job checks again before it writes: an image no longer its to place stops it, nothing written', async () => {
    const up = await w.call('upload_image', {
      data_base64: bytes(4),
      name: 'late',
      stage: true,
      project: 'test',
    });
    const staged = String(up.body.staged_id);
    const p = await w.call('arkona_add_character_art', {
      ...art(staged, 'Detail Reference - Ink Stains'),
      project: 'test',
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    // Something else claims the image meanwhile (as a direct placement would).
    w.stack.runtime.images.store.updateUpload(PROJECT, staged, { placementProposalId: 'prop_someoneelse' });
    const writes = w.seen.filter((l) => !l.startsWith('GET')).length;
    const done = await approve(w, String(p.body.proposalId));
    expect(done.job?.status).toBe('failed');
    expect(done.job?.lastError?.code).toBe('STAGED_IMAGE_BUSY');
    expect(w.seen.filter((l) => !l.startsWith('GET')).length).toBe(writes);
  });
});

describe('the owner tool’s run-time re-check (design section 5)', () => {
  it('two packages for one owner name, approved one after the other: one page and one clean refusal', async () => {
    const pkg = compactPolity({ name: 'Kingdom of Hadra', status: 'authoritative' });
    const one = await w.call('arkona_create_owner', pkg);
    const two = await w.call('arkona_create_owner', pkg);
    expect(one.body.status, one.text).toBe('proposal_captured');
    expect(two.body.status, two.text).toBe('proposal_captured');
    const a = await approve(w, String(one.body.proposalId));
    expect(a.job?.status, JSON.stringify(a.job?.lastError)).toBe('succeeded');
    const writes = w.seen.filter((l) => !l.startsWith('GET')).length;
    const b = await approve(w, String(two.body.proposalId));
    expect(b.job?.status).toBe('failed');
    expect(b.job?.lastError?.code).toBe('OWNER_EXISTS');
    expect(w.seen.filter((l) => !l.startsWith('GET')).length).toBe(writes);
    const pages = [...w.repo.res.values()].filter(
      (r) => r.deletedAt === null && r.name === '[BSRC] Kingdom of Hadra - Historical Polity Reference',
    );
    expect(pages).toHaveLength(1);
  });

  it('approved together: the reservation lets one job make it; the other stops before writing', async () => {
    const pkg = compactPolity({ name: 'Kingdom of Marib', status: 'authoritative' });
    const one = await w.call('arkona_create_owner', pkg);
    const two = await w.call('arkona_create_owner', pkg);
    const [a, b] = await Promise.all([
      approve(w, String(one.body.proposalId)),
      approve(w, String(two.body.proposalId)),
    ]);
    const statuses = [a.job?.status, b.job?.status].sort();
    expect(statuses).toEqual(['failed', 'succeeded']);
    const failed = [a, b].find((x) => x.job?.status === 'failed')!;
    expect(failed.job?.lastError?.code).toBe('OWNER_EXISTS');
    expect(
      [...w.repo.res.values()].filter(
        (r) => r.deletedAt === null && r.name === '[BSRC] Kingdom of Marib - Historical Polity Reference',
      ),
    ).toHaveLength(1);
  });
});
