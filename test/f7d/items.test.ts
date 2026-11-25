/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F7d (ADR 0077, A3, A4): the proposal's items, approved one by one (an outfit without "Art page" refused; a subset
 * places only that subset, the rest staying staged), and a failed image withdrawn while the others are placed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import type { OwnersWorld } from '../packs/owners-world.js';
import { approveItems, blocksOf, f7dWorld, headingsOf, img, pageNamed, PROJECT, stage } from './world.js';

let w: OwnersWorld;
beforeAll(async () => {
  w = await f7dWorld();
});
afterAll(async () => {
  await w?.close();
});

const CHAR = 'Mehrana I al-Khalid';
const ART = `[BSRC] ${CHAR} - Character Art`;
const call = (args: Record<string, unknown>) =>
  w.call('arkona_add_character_art', { character: CHAR, project: 'test', ...args });
const staged = (id: string) => w.stack.runtime.images.store.upload(PROJECT, id)!;

describe('A3: items', () => {
  let proposalId = '';
  let ids: string[] = [];
  it('an outfit approved without "Art page" is refused with the reason; nothing is approved', async () => {
    ids = await Promise.all([1, 2, 3, 4].map(() => stage(w)));
    const p = await call({
      groups: [
        { images: [img(ids[0]!, 'Primary Reference - Character Portrait')] },
        { outfit: 'Velvet Cloak', images: [img(ids[1]!, 'Outfit Reference - Front')] },
        {
          outfit: 'Riding Leathers',
          images: [img(ids[2]!, 'Outfit Reference - Front'), img(ids[3]!, 'Outfit Reference - Back')],
        },
      ],
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    proposalId = String(p.body.proposalId);
    const items = w.stack.runtime.policy.proposals.itemsOf(proposalId)!.items.map((i) => i.id);
    expect(items).toEqual([
      'art:page',
      'art:design',
      'art:outfit:velvet cloak',
      'art:outfit:riding leathers',
    ]);
    const policy = w.stack.runtime.policy;
    const approve = policy.proposals.get(proposalId)!.requiresCanonicalApproval
      ? policy.commands.approveAsCanon.bind(policy.commands)
      : policy.commands.approve.bind(policy.commands);
    await expect(approve('owner', proposalId, { items: ['art:outfit:velvet cloak'] })).rejects.toThrow(
      /art:page/,
    );
    expect(policy.proposals.get(proposalId)!.state).toBe('pending');
  });

  it('a subset approved places only that subset; the unapproved images stay staged for a later call', async () => {
    const done = await approveItems(w, proposalId, ['art:page', 'art:outfit:velvet cloak']);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect((done.job?.result as { verified?: boolean }).verified, JSON.stringify(done.job?.result)).toBe(
      true,
    );
    const page = pageNamed(w, ART)!;
    const h = headingsOf(w, page.id);
    expect(h).toContain('3:Velvet Cloak');
    expect(h).not.toContain('3:Riding Leathers');
    expect(JSON.stringify(blocksOf(w, page.id))).not.toContain('Character Portrait');
    expect(w.assets.byName(`${CHAR} - Velvet Cloak - Outfit Reference - Front`)).toHaveLength(1);
    expect(w.assets.byName(`${CHAR} - Primary Reference - Character Portrait`)).toHaveLength(0);
    for (const id of [ids[0]!, ids[2]!, ids[3]!]) {
      expect(staged(id).staged).toBe(true);
      expect(staged(id).assetId).toBeNull();
    }
    const report = (
      done.job?.result as { artGroups: { key: string; placed: unknown[]; notPlaced?: { why: string }[] }[] }
    ).artGroups;
    const design = report.find((g) => g.key === 'design')!;
    expect(design.placed).toEqual([]);
    expect(design.notPlaced![0]!.why).toMatch(/not approved/);
    // "Propose these again" is refused: the left-out groups are planned afresh, by a later call.
    await expect(
      w.stack.runtime.policy.commands.reproposeOmitted('owner', proposalId, {
        kind: 'ui',
        client: 'owner',
        tool: 'proposal.repropose',
        detail: `repropose:${proposalId}`,
      } as never),
    ).rejects.toMatchObject({ code: 'REPROPOSE_REFUSED' });
    // A later call places them (they were never taken).
    const later = await call({
      groups: [
        { images: [img(ids[0]!, 'Primary Reference - Character Portrait')] },
        {
          outfit: 'Riding Leathers',
          images: [img(ids[2]!, 'Outfit Reference - Front'), img(ids[3]!, 'Outfit Reference - Back')],
        },
      ],
    });
    expect(later.body.status, later.text).toBe('proposal_captured');
    const again = await approveItems(w, String(later.body.proposalId));
    expect(again.job?.status, JSON.stringify(again.job?.lastError)).toBe('succeeded');
    expect(headingsOf(w, page.id)).toContain('3:Riding Leathers');
  });
});

describe('A4: a failed image never fails the rest', () => {
  it('its upload refused: withdrawn with why, its blocks left off the page, the others placed', async () => {
    const ids = await Promise.all([1, 2, 3].map(() => stage(w)));
    const re = [...w.overrides.keys()].find((k) => k.source === '\\/assets\\/uploads$')!;
    const base = w.overrides.get(re)!;
    let n = 0;
    w.overrides.set(re, (req: MockRequest): MockResponse | undefined => {
      if (req.method === 'POST' && ++n === 2)
        return {
          status: 400,
          body: { code: 'VALIDATION_FAILED', message: 'contentLength is too large', requestId: 'r-400' },
        };
      return base(req);
    });
    try {
      const p = await call({
        groups: [
          {
            outfit: 'Court Silks',
            images: [
              img(ids[0]!, 'Outfit Reference - One'),
              img(ids[1]!, 'Outfit Reference - Two'),
              img(ids[2]!, 'Outfit Reference - Three'),
            ],
          },
        ],
      });
      expect(p.body.status, p.text).toBe('proposal_captured');
      const done = await approveItems(w, String(p.body.proposalId));
      expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
      expect(w.assets.byName(`${CHAR} - Court Silks - Outfit Reference - One`)).toHaveLength(1);
      expect(w.assets.byName(`${CHAR} - Court Silks - Outfit Reference - Two`)).toHaveLength(0);
      expect(w.assets.byName(`${CHAR} - Court Silks - Outfit Reference - Three`)).toHaveLength(1);
      const text = JSON.stringify(blocksOf(w, pageNamed(w, ART)!.id));
      expect(text).toContain('Outfit Reference - Three');
      expect(text).not.toContain('Outfit Reference - Two');
      const result = done.job?.result as {
        verified: boolean;
        withdrawn: { reason: string }[];
        artGroups: { placed: unknown[]; notPlaced: { name: string; why: string }[] }[];
      };
      expect(result.verified, JSON.stringify(result)).toBe(true);
      expect(result.withdrawn[0]!.reason).toMatch(/VALIDATION_FAILED/);
      expect(result.artGroups[0]!.placed).toHaveLength(2);
      expect(result.artGroups[0]!.notPlaced[0]!.why).toMatch(/VALIDATION_FAILED/);
      // The record counts the two placed pieces only.
      const folder = w.assets.byName(CHAR).find((a) => a.type === 'FOLDER')!;
      const rec = w.stack.runtime.outfits
        .forCharacter(PROJECT, folder.id)
        .find((o) => o.name === 'Court Silks')!;
      expect(rec.pieces).toHaveLength(2);
      // bridge_workstream_report lists, per group, what was placed and what was not.
      const rep = await w.call('bridge_workstream_report', { jobIds: [done.job!.id], project: 'test' });
      expect(rep.isError, rep.text).toBe(false);
      expect(rep.body.groups.artSets[0].groups[0].placed).toHaveLength(2);
      expect(JSON.stringify(rep.body.stillToDo)).toMatch(
        /Not placed .*Outfit Reference - Two.*VALIDATION_FAILED/,
      );
    } finally {
      w.overrides.set(re, base);
    }
  });
});
