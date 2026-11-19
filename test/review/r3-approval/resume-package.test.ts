/**
 * CR-2026-11 round 3 (approval), ADR 0058 decision 3.2 on a package (F3a's developed character) approved in part:
 * Resume runs its own check again first (the pack's governance and "nothing of its name appeared", counting the pages
 * this job already made as its own), never makes a page twice, and stops again when the pack changed meanwhile.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { packWorld, type PackWorld } from '../../packs/world.js';
import { OWNER_ORIGIN, PROJECT, finished, intercept, itemsOf, settle } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

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

const live = (w: PackWorld, name: string) =>
  [...w.repo.res.values()].filter((r) => r.name === name && r.deletedAt === null);

/** Approves the package without Personality; its job stops at the Core's text (a 400, not retried). */
async function stopped(w: PackWorld, name: string, given: string) {
  const p = await w.call('arkona_create_character', character(name, given));
  expect(p.body.status, p.text).toBe('proposal_captured');
  const id = String(p.body.proposalId);
  const plan = itemsOf(w, id);
  const personality = plan.items.find((i) => i.label.includes('Personality'))!;
  const keep = plan.items.filter((i) => i.id !== personality.id).map((i) => i.id);
  // The second whole-body write (the Core's text) is refused once.
  intercept(w, 'PUT', /\/docs\/[^/]+\/blocks$/, (n) =>
    n === 1
      ? {
          status: 400,
          body: { message: 'model VALIDATION_ERROR (injected)', code: 'VALIDATION_ERROR', requestId: 'x' },
        }
      : undefined,
  );
  await w.stack.runtime.policy.commands.approve('owner', id, { items: keep });
  const first = await finished(w, id);
  expect(first.job?.status).toBe('failed');
  return { id, jobId: first.job!.id, personality };
}

describe('Resume: a package approved in part', () => {
  it('AP-27 resumed, it makes no page twice and never the page the owner left out', async () => {
    const w = (open = await packWorld());
    const { jobId } = await stopped(w, 'Mizuhara Hana', 'Hana');
    expect(live(w, '[BWRK] Mizuhara Hana - Character Core')).toHaveLength(1);
    const out = await w.stack.runtime.resume.resume(PROJECT, jobId, { kind: 'owner' }, OWNER_ORIGIN);
    expect(out.status).toBe('resumed');
    const job = await settle(w, jobId);
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect({
      index: live(w, '[INDEX] Mizuhara Hana').length,
      core: live(w, '[BWRK] Mizuhara Hana - Character Core').length,
      bio: live(w, '[BWRK] Mizuhara Hana - Biography').length,
      personality: live(w, '[BWRK] Mizuhara Hana - Personality').length,
    }).toEqual({ index: 1, core: 1, bio: 1, personality: 0 });
  });

  it('AP-28 a pack version made after the stop stops the resumed job before any write', async () => {
    const w = (open = await packWorld());
    const { jobId } = await stopped(w, 'Mizuhara Nao', 'Nao');
    // The owner changes a switch on the Packs page: a new version, waiting for approval.
    w.stack.runtime.packs.commands.setToolModes('owner', 'arkona', { arkona_create_character: 'scope' });
    const writes = w.stack.mock.calls.filter((c) => c.method !== 'GET').length;
    await w.stack.runtime.resume.resume(PROJECT, jobId, { kind: 'owner' }, OWNER_ORIGIN);
    const job = await settle(w, jobId);
    expect(job.status).toBe('failed');
    expect(JSON.stringify(job.lastError)).toContain('PACK_GOVERNANCE_CHANGED');
    expect(w.stack.mock.calls.filter((c) => c.method !== 'GET').length).toBe(writes);
  });
});
