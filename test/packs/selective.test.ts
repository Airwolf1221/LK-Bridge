/**
 * v3 F3d (renames), ADR 0058 (the design's section 2, decision D5): selective approval of a proposal made of items,
 * against the mock LegendKeeper. A package (F3a's developed character): its pages are items; everything ticked approves
 * exactly as before; a page left out is not made, the omission is recorded, and "propose these again" makes a proposal of
 * exactly what was left out. A rename: unticking a page's new name drops the items that need it (its facts and its
 * alias), the approval refuses a selection that is not closed, and only the approved set runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { packWorld, approve, type PackWorld } from './world.js';
import { C, P, renameWorld, type RenameWorld } from './rename-world.js';
import { PolicyError } from '../../src/policy/errors.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const text = (s: string) =>
  `## Purpose\n\n${s}\n\n## Identity\n\nA shrine archer.\n\n## Source Boundaries\n\nIdentity only.\n\n## Unresolved Material\n\nNone yet.\n`;

const ayame = {
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
  ],
  project: 'test',
};

async function finished(w: PackWorld | RenameWorld, proposalId: string) {
  const policy = w.stack.runtime.policy;
  for (let i = 0; i < 500; i++) {
    const p = policy.proposals.get(proposalId)!;
    const job = p.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : undefined;
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the job did not finish');
}

describe('selective approval: a package', () => {
  let w: PackWorld;
  beforeAll(async () => {
    w = await packWorld();
  });
  afterAll(() => w?.close());

  const named = (name: string) => [...w.repo.res.values()].find((r) => r.name === name && !r.deletedAt);

  it('everything ticked approves exactly as before (no selection recorded as partial)', async () => {
    const p = await w.call('arkona_create_character', { ...ayame, name: 'Mizuhara Kaede', identity: { ...ayame.identity, givenName: 'Kaede' } });
    expect(p.body.status, p.text).toBe('proposal_captured');
    const id = String(p.body.proposalId);
    const view = w.stack.runtime.policy.proposals.get(id)!;
    expect(view.items!.total).toBeGreaterThanOrEqual(3);
    const done = await approve(w, id);
    expect(done.job?.status).toBe('succeeded');
    const after = w.stack.runtime.policy.proposals.get(id)!;
    expect(after.items).toMatchObject({ approved: view.items!.total, omitted: 0 });
    expect(named('[BWRK] Mizuhara Kaede - Personality')).toBeTruthy();
    expect(
      w.stack.runtime.policy.store.listAudit({ action: 'proposal.approve_selected' }).filter((a) => a.target === id),
    ).toHaveLength(0);
  });

  it('a page left out is not made; the omission is recorded; "propose these again" proposes exactly it', async () => {
    const p = await w.call('arkona_create_character', ayame);
    const id = String(p.body.proposalId);
    const plan = w.stack.runtime.policy.proposals.itemsOf(id)!;
    const personality = plan.items.find((i) => String(i.label).includes('Personality'))!;
    expect(personality).toBeTruthy();
    // Nothing else needs the Personality page; it needs the character's identity page.
    expect(personality.dependsOn.length).toBeGreaterThan(0);
    const keep = plan.items.filter((i) => i.id !== personality.id).map((i) => i.id);
    await w.stack.runtime.policy.commands.approve('owner', id, { items: keep });
    const job = await finished(w, id);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(named('[BWRK] Mizuhara Ayame - Character Core')).toBeTruthy();
    expect(named('[BWRK] Mizuhara Ayame - Biography')).toBeTruthy();
    expect(named('[BWRK] Mizuhara Ayame - Personality')).toBeUndefined();
    const view = w.stack.runtime.policy.proposals.get(id)!;
    expect(view.items).toMatchObject({ omitted: 1, approved: plan.items.length - 1 });
    const audit = w.stack.runtime.policy.store
      .listAudit({ action: 'proposal.approve_selected' })
      .find((a) => a.target === id)!;
    expect(audit.after).toMatchObject({ items: { omitted: [personality.id] } });

    // "Propose these again": one proposal of exactly the page left out, which the owner approves as usual.
    const again = await w.stack.runtime.policy.commands.reproposeOmitted('owner', id, {
      kind: 'ui',
      client: 'owner',
      tool: 'proposal.repropose',
      detail: `repropose:${id}`,
    } as never);
    const second = String((again as { proposalId: string }).proposalId);
    expect(w.stack.runtime.policy.proposals.get(id)!.reproposedAs).toBe(second);
    const items2 = w.stack.runtime.policy.proposals.itemsOf(second)!.items.map((i) => i.id);
    expect(items2).toEqual([personality.id]);
    const done = await approve(w, second);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(named('[BWRK] Mizuhara Ayame - Personality')).toBeTruthy();
  });
});

describe('selective approval: a rename', () => {
  let w: RenameWorld;
  beforeAll(async () => {
    w = await renameWorld();
  });
  afterAll(() => w?.close());

  it('unticking a page’s new name drops what needs it; only the approved set runs', async () => {
    const r = await w.call('arkona_rename', { subject: C.nadira, newName: 'Laila al-Khalid', given: 'Laila' });
    const id = String(r.body.proposalId);
    const plan = w.stack.runtime.policy.proposals.itemsOf(id)!;
    const ticked = plan.items.filter((i) => i.selected).map((i) => i.id);
    // Unticking only the Art page's name leaves its facts and its alias needing it: refused, naming them.
    const open = ticked.filter((x) => x !== `name:${P.nadiraArt}`);
    const refused = await w.stack.runtime.policy.commands
      .approveAsCanon('owner', id, { items: open })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PolicyError);
    expect((refused as PolicyError).code).toBe('SELECTION_NOT_CLOSED');
    const dropped = ((refused as PolicyError).details as { dropped: { id: string }[] }).dropped.map((d) => d.id).sort();
    expect(dropped).toEqual([`aliases:${P.nadiraArt}`, `facts:${P.nadiraArt}`]);
    // The proposal stays pending: nothing was approved.
    expect(w.stack.runtime.policy.proposals.get(id)!.state).toBe('pending');

    const closed = open.filter((x) => !dropped.includes(x));
    await w.stack.runtime.policy.commands.approveAsCanon('owner', id, { items: closed });
    const job = await finished(w, id);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(w.repo.live(C.nadira)!.name).toBe('[BSRC] Laila al-Khalid - Character Core');
    expect(w.repo.live(P.nadiraBio)!.name).toBe('[BSRC] Laila al-Khalid - Biography');
    // The Art page, its facts and its alias, as they were.
    expect(w.repo.live(P.nadiraArt)!.name).toBe('[BSRC] Nadira al-Khalid - Character Art');
    expect(w.repo.live(P.nadiraArt)!.aliases).not.toContain('Nadira al-Khalid - Character Art');
    const view = w.stack.runtime.policy.proposals.get(id)!;
    expect(view.items!.omitted).toBe(plan.items.length - closed.length);
    expect(
      w.stack.runtime.policy.store
        .listAudit({ action: 'proposal.approve_selected_as_canon' })
        .some((a) => a.target === id),
    ).toBe(true);
  });
});
