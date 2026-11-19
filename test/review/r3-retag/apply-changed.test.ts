/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- tool JSON */
/**
 * R3-RETAG (pass 3): "a page changed after the audit is conflicted (or held), never rebased" (ADR 0060 decision 3.3;
 * the tool's description: "a fresh read (a page whose tags differ in any way from the audit's current array is
 * conflicted ...; facts changed since: held ...)", and decision 3.3.3: the in-lock rebaser gives "the same three
 * answers, so nothing that changed between the check and the write is overwritten").
 *
 * Every page here is a plain Polity Reference whose only defect is its order (`Polity, CANON` → `CANON, Polity`), so
 * a write is exactly the stale verdict being applied. Each test changes the page AFTER the audit (as an edit in the
 * LegendKeeper app: the mock's `outside`), then the owner approves the batch. SAFE: the page is not written.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LIFECYCLE } from '../../resources/world.js';
import {
  approve,
  audit,
  batchOf,
  byId,
  LEGACY_INDEX,
  PROJECT,
  propose,
  r3World,
  settle,
  tagsOf,
  type R3World,
} from './helpers.js';

vi.setConfig({ testTimeout: 180_000 });

const P = {
  renameArc: 'r3ren001',
  rename: 'r3ren002',
  move: 'r3mov001',
  restore: 'r3rst001',
  del: 'r3del001',
  tags: 'r3tag001',
  ct: 'r3ct0001',
  status: 'r3st0001',
  archived: 'r3arc001',
  lock: 'r3lck001',
  resumeA: 'r3rsA001',
  resumeB: 'r3rsB001',
} as const;

const NAMES: Record<string, string> = {
  [P.renameArc]: 'Aaa Rename',
  [P.rename]: 'Aab Rename Plain',
  [P.move]: 'Abb Move',
  [P.restore]: 'Acc Restore',
  [P.del]: 'Add Delete',
  [P.tags]: 'Aee Tags',
  [P.ct]: 'Aff Continuity',
  [P.status]: 'Agg Status',
  [P.archived]: 'Ahh Archived',
  [P.lock]: 'Bbb Lock',
  [P.resumeA]: 'Ccc Resume A',
  [P.resumeB]: 'Ccd Resume B',
};

let w: R3World;
let runId: string;
beforeAll(async () => {
  w = await r3World(
    Object.entries(NAMES).map(([id, n]) => ({
      id,
      name: `[BSRC] ${n} - Polity Reference`,
      tags: ['Polity', 'CANON'],
    })),
  );
  await w.snapshot();
  const body = await audit(w, { under: w.desk });
  runId = body.runId;
  const pages = byId(body);
  for (const id of Object.keys(NAMES)) expect(pages.get(id)?.disposition, id).toBe('correction');
});
afterAll(async () => w?.close());

const ORIGINAL = ['Polity', 'CANON'];

/** Proposes one page, makes the change, approves; returns what the batch recorded and the page's tags. */
async function changedThenApproved(id: string, change: () => void) {
  const p = await propose(w, runId, [id]);
  change();
  const done = await approve(w, p.proposalId);
  const b = batchOf(w, p.proposalId)!;
  return { job: done.job?.status, disposition: b.dispositions?.[id] ?? null, tags: w.repo.res.get(id)?.tags };
}

describe('a page changed after the audit is never written with the stale verdict', () => {
  it('RT-30: renamed [BSRC] → [BARC] in the app, tags and facts unchanged: not written', async () => {
    const seen = await changedThenApproved(P.renameArc, () =>
      w.repo.outside.rename(P.renameArc, `[BARC] ${NAMES[P.renameArc]} - Polity Reference`),
    );
    expect(seen.tags, JSON.stringify(seen)).toEqual(ORIGINAL);
  });

  it('RT-31: renamed in the app (prefix kept), tags and facts unchanged: not written', async () => {
    const seen = await changedThenApproved(P.rename, () =>
      w.repo.outside.rename(P.rename, '[BSRC] Aab Renamed Elsewhere - Polity Reference'),
    );
    expect(seen.tags, JSON.stringify(seen)).toEqual(ORIGINAL);
  });

  it('RT-32: moved into the Legacy Canon Archive (an excluded area) after the audit: not written', async () => {
    const seen = await changedThenApproved(P.move, () => w.repo.outside.move(P.move, LEGACY_INDEX));
    expect(seen.tags, JSON.stringify(seen)).toEqual(ORIGINAL);
  });

  it('RT-33: deleted, then restored at the top level (its parent gone) after the audit: not written', async () => {
    const seen = await changedThenApproved(P.restore, () => {
      w.repo.outside.delete(P.restore);
      const r = w.repo.res.get(P.restore)!;
      r.deletedAt = null;
      r.parentId = null; // restoreResource: "a resource whose parent no longer exists is restored at the root"
    });
    expect(seen.tags, JSON.stringify(seen)).toEqual(ORIGINAL);
  });

  it('RT-34: deleted after the audit: inaccessible, nothing written', async () => {
    const seen = await changedThenApproved(P.del, () => w.repo.outside.delete(P.del));
    expect(seen.disposition).toMatchObject({ outcome: 'inaccessible' });
    expect(seen.tags).toEqual(ORIGINAL);
  });

  it('RT-35: its tags changed after the audit (a case change of one tag): conflicted, never rebased', async () => {
    const seen = await changedThenApproved(P.tags, () => w.repo.outside.setTags(P.tags, ['polity', 'CANON']));
    expect(seen.disposition).toMatchObject({ outcome: 'conflicted' });
    expect(seen.tags).toEqual(['polity', 'CANON']);
  });

  it('RT-36: its Continuity Type changed (CANON → AU) in the app: held', async () => {
    const seen = await changedThenApproved(P.ct, () => w.repo.outside.setRow(P.ct, 'Continuity Type', 'AU'));
    expect(seen.disposition).toMatchObject({ outcome: 'held' });
    expect(seen.tags).toEqual(ORIGINAL);
  });

  it('RT-37: its Status changed to a Cyrillic look-alike of Authoritative: held (exact comparison)', async () => {
    const seen = await changedThenApproved(P.status, () =>
      w.repo.outside.setRow(P.status, 'Status', 'Authoritаtive'),
    );
    expect(seen.disposition).toMatchObject({ outcome: 'held' });
    expect(seen.tags).toEqual(ORIGINAL);
  });

  it('RT-38: archived in the app (prefix, Status, tags, place): held, nothing written', async () => {
    const seen = await changedThenApproved(P.archived, () => {
      w.repo.outside.rename(P.archived, `[BARC] ${NAMES[P.archived]} - Polity Reference`);
      w.repo.outside.setRow(P.archived, 'Status', 'Archived');
      w.repo.outside.setTags(P.archived, ['Archived', 'Polity']);
      w.repo.outside.move(P.archived, LIFECYCLE.archived);
    });
    expect(seen.disposition?.outcome).toMatch(/^(held|conflicted)$/);
    expect(seen.tags).toEqual(['Archived', 'Polity']);
  });
});

describe('a change between the fresh read and the write, and across a Resume', () => {
  it('RT-39: a classification fact changed between the fresh read and the write is caught in the lock', async () => {
    const p = await propose(w, runId, [P.lock]);
    const item = `page:${P.lock}`;
    let fired = false;
    w.overrides.set(new RegExp(`/resources/${P.lock}$`), (req) => {
      if (fired || req.method !== 'GET') return undefined;
      const jobId = w.stack.runtime.policy.proposals.get(p.proposalId)?.jobId;
      if (!jobId) return undefined;
      const steps = w.stack.runtime.engine.stepRecords(PROJECT, jobId) ?? [];
      const mine = steps.filter((s) => (s.options.items ?? []).includes(item));
      const check = mine.find((s) => s.opId === 'bridge.expect');
      const write = mine.find((s) => s.opId === 'updateResource');
      if (check?.status === 'succeeded' && write && write.status !== 'succeeded') {
        fired = true; // the in-lock read of the write: the Reference Type changes just before it is answered
        w.repo.outside.setRow(P.lock, 'Reference Type', 'Historical Polity Reference');
      }
      return undefined;
    });
    const done = await approve(w, p.proposalId);
    const b = batchOf(w, p.proposalId)!;
    const seen = {
      fired,
      job: done.job?.status,
      disposition: b.dispositions?.[P.lock],
      tags: tagsOf(w, P.lock),
    };
    expect(fired).toBe(true);
    // SAFE: the facts changed before the write: the page is held, its stale array never written.
    expect(seen.tags, JSON.stringify(seen)).toEqual(ORIGINAL);
  });

  it('RT-40: Resume: a page whose facts changed while the job was stopped is held, not written', async () => {
    const p = await propose(w, runId, [P.resumeA, P.resumeB]);
    w.failNext('PATCH', new RegExp(`/resources/${P.resumeB}$`), 0);
    const done = await approve(w, p.proposalId);
    expect(done.job?.status).toBe('failed');
    expect(tagsOf(w, P.resumeA)).toEqual(['CANON', 'Polity']);
    expect(tagsOf(w, P.resumeB)).toEqual(ORIGINAL);
    // While the job is stopped, the owner changes B's Reference Type in the app (a classification input).
    w.repo.outside.setRow(P.resumeB, 'Reference Type', 'Historical Polity Reference');
    const rt = w.stack.runtime;
    const out = await rt.resume.resume(PROJECT, done.jobId!, { kind: 'owner' }, {
      kind: 'ui',
      client: 'owner',
      tool: 'job.resume',
      principal: { principalId: 'system', profile: 'owner', label: 'owner' },
    } as never);
    expect(out.status).toBe('resumed');
    await settle(w, done.jobId!);
    const b = batchOf(w, p.proposalId)!;
    const seen = { job: rt.engine.queries.getJob(PROJECT, done.jobId!)?.status, disposition: b.dispositions };
    // SAFE: B's classification inputs changed since the audit: held, never written with the stale verdict.
    expect(tagsOf(w, P.resumeB), JSON.stringify(seen)).toEqual(ORIGINAL);
  });
});
