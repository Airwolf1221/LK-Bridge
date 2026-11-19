/**
 * CR-2026-11 round 3 (approval), ADR 0058 decision 2.5 ("Propose these again") on a package (F3a's developed
 * character): the items left out are proposed again "captured afresh", their steps filtered with `filterSteps(steps,
 * omitted)`. The attempts check that the reproposal, once approved, leaves the project as the whole package would have:
 * the left-out page routed from its index, placed where the plan put it, its read-back clean; and that it cannot be
 * made twice, nor before the approved part has run, nor by anyone but the owner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { packWorld, approve, type PackWorld } from '../../packs/world.js';
import { PROJECT, finished, itemsOf, reproposeOrigin, rejection } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

type Obj = Record<string, unknown>;

const text = (s: string) =>
  `## Purpose\n\n${s}\n\n## Identity\n\nA shrine archer.\n\n` +
  '## Source Boundaries\n\nIdentity only.\n\n## Unresolved Material\n\nNone yet.\n';

const character = (name: string, given: string) => ({
  name,
  depth: 'developed',
  identity: {
    givenName: given,
    surname: name.split(' ')[0],
    race: 'Foxian',
    namingCulture: 'Fujimatsuan',
    lifeState: 'Alive at 5A 931',
    temporalScope: '5A 905 - 5A 931',
  },
  pages: [
    { role: 'core', scope: 'Identity and routing', markdown: text(`The identity of ${name}.`) },
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
});

let open: PackWorld | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const named = (w: PackWorld, name: string) =>
  [...w.repo.res.values()].find((r) => r.name === name && !r.deletedAt);

/** The ids mentioned in an index's Main document (its routing lines). */
function routedFrom(w: PackWorld, indexId: string): string[] {
  const out: string[] = [];
  const main = w.repo.liveDocs(w.repo.live(indexId)!).find((d) => d.name === 'Main')!;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Obj;
      const m = o.mention as Obj | undefined;
      if (m && typeof m.resourceId === 'string') out.push(m.resourceId);
      Object.values(o).forEach(walk);
    }
  };
  walk(w.repo.blocks.get(main.id)?.blocks ?? []);
  return out;
}

/** The children of a page in rank order. */
const childrenOf = (w: PackWorld, parentId: string): string[] => w.repo.children(parentId).map((r) => r.id);

async function leaveOutPersonality(w: PackWorld, name: string, given: string) {
  const p = await w.call('arkona_create_character', character(name, given));
  expect(p.body.status, p.text).toBe('proposal_captured');
  const id = String(p.body.proposalId);
  const plan = itemsOf(w, id);
  const personality = plan.items.find((i) => i.label.includes('Personality'))!;
  const keep = plan.items.filter((i) => i.id !== personality.id).map((i) => i.id);
  await w.stack.runtime.policy.commands.approve('owner', id, { items: keep });
  const first = await finished(w, id);
  expect(first.job?.status, JSON.stringify(first.job?.lastError)).toBe('succeeded');
  return { id, personality, first };
}

describe('"Propose these again" on a package', () => {
  it('AP-10 approved in two steps, the package ends as whole: its index routes to the page', async () => {
    const w = (open = await packWorld());
    const { id, personality } = await leaveOutPersonality(w, 'Mizuhara Ayame', 'Ayame');
    const index = named(w, '[INDEX] Mizuhara Ayame')!;
    expect(routedFrom(w, index.id)).not.toContain(personality.page!.id);
    const again = await w.stack.runtime.policy.commands.reproposeOmitted('owner', id, reproposeOrigin(id));
    const done = await approve(w, again.proposalId);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    expect(named(w, '[BWRK] Mizuhara Ayame - Personality')).toBeTruthy();
    // SAFE: the index's "How to Use This Index" routes to every page of the set, as the whole package would have.
    expect(routedFrom(w, index.id), 'the reproposed page is never routed from its index').toContain(
      personality.page!.id,
    );
  });

  it('AP-11 the reproposed page stands where the plan put it, and its read-back finds no difference', async () => {
    const w = (open = await packWorld());
    const { id, personality } = await leaveOutPersonality(w, 'Mizuhara Kaede', 'Kaede');
    const again = await w.stack.runtime.policy.commands.reproposeOmitted('owner', id, reproposeOrigin(id));
    const done = await approve(w, again.proposalId);
    expect(done.job?.status, JSON.stringify(done.job?.lastError)).toBe('succeeded');
    const index = named(w, '[INDEX] Mizuhara Kaede')!;
    const core = named(w, '[BWRK] Mizuhara Kaede - Character Core')!;
    const kids = childrenOf(w, index.id);
    // The plan: Biography, Core, Personality (Personality placed after the Core).
    expect(kids.indexOf(personality.page!.id)).toBe(kids.indexOf(core.id) + 1);
    const verify = done.job!.steps.find((s) => s.opId === 'bridge.verify')!;
    const v = (verify.resultSummary ?? {}) as { verification?: { status?: string; differences?: unknown } };
    expect(v.verification?.status ?? 'ok', JSON.stringify(v)).not.toBe('mismatch');
  });

  it('AP-12 "Propose these again" twice at once makes ONE proposal (and one page)', async () => {
    const w = (open = await packWorld());
    const { id } = await leaveOutPersonality(w, 'Mizuhara Rin', 'Rin');
    const before = w.stack.runtime.policy.commands
      .listProposals('owner', { project: PROJECT, state: ['pending'], limit: 500 })
      .map((p) => p.id);
    const [a, b] = await Promise.allSettled([
      w.stack.runtime.policy.commands.reproposeOmitted('owner', id, reproposeOrigin(id)),
      w.stack.runtime.policy.commands.reproposeOmitted('owner', id, reproposeOrigin(id)),
    ]);
    const made = w.stack.runtime.policy.commands
      .listProposals('owner', { project: PROJECT, state: ['pending'], limit: 500 })
      .filter((p) => !before.includes(p.id));
    // Whatever was made, approving all of it never makes the page twice.
    for (const p of made) await approve(w, p.id);
    const pages = [...w.repo.res.values()].filter(
      (r) => r.name === '[BWRK] Mizuhara Rin - Personality' && r.deletedAt === null,
    );
    expect(pages, 'the left-out page was made twice').toHaveLength(1);
    expect(
      made.length,
      `two concurrent clicks made ${made.length} proposals (${a.status}, ${b.status})`,
    ).toBe(1);
  });

  it('AP-13 "Propose these again" a second time (sequentially) is refused', async () => {
    const w = (open = await packWorld());
    const { id } = await leaveOutPersonality(w, 'Mizuhara Sora', 'Sora');
    await w.stack.runtime.policy.commands.reproposeOmitted('owner', id, reproposeOrigin(id));
    const e = await rejection(() =>
      w.stack.runtime.policy.commands.reproposeOmitted('owner', id, reproposeOrigin(id)),
    );
    expect(e?.code).toBe('ALREADY_REPROPOSED');
  });

  it('AP-14 an agent cannot propose the left-out items again (owner command only)', async () => {
    const w = (open = await packWorld());
    const { id } = await leaveOutPersonality(w, 'Mizuhara Yui', 'Yui');
    const e = await rejection(() =>
      w.stack.runtime.policy.commands.reproposeOmitted('agent' as never, id, reproposeOrigin(id)),
    );
    expect(e?.code).toBe('NOT_OWNER');
  });
  it('AP-18 an operation_id replayed after a partial approval starts nothing', async () => {
    const w = (open = await packWorld());
    const args = { ...character('Mizuhara Emi', 'Emi'), operation_id: 'r3-op-emi' };
    const p = await w.call('arkona_create_character', args);
    const id = String(p.body.proposalId);
    const plan = itemsOf(w, id);
    const personality = plan.items.find((i) => i.label.includes('Personality'))!;
    await w.stack.runtime.policy.commands.approve('owner', id, {
      items: plan.items.filter((i) => i.id !== personality.id).map((i) => i.id),
    });
    await finished(w, id);
    const jobs = (w.stack.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n;
    const pending = w.stack.runtime.policy.commands.listProposals('owner', {
      project: PROJECT,
      state: ['pending'],
      limit: 500,
    }).length;
    const again = await w.call('arkona_create_character', args);
    const other = await w.call('arkona_create_character', { ...args, name: 'Mizuhara Emiko' });
    // The replay answers with the same proposal, or (planned again first) a refusal; never a new proposal or job.
    expect(again.body.proposalId === id || again.isError === true, again.text).toBe(true);
    expect((other.body.error as { code?: string } | undefined)?.code, other.text).toBe('OPERATION_ID_REUSED');
    expect((w.stack.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(jobs);
    expect(
      w.stack.runtime.policy.commands.listProposals('owner', {
        project: PROJECT,
        state: ['pending'],
        limit: 500,
      }).length,
    ).toBe(pending);
    expect(named(w, '[BWRK] Mizuhara Emi - Personality')).toBeUndefined();
  });
});
