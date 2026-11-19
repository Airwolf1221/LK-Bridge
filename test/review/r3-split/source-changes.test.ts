/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- tool JSON */
/**
 * CR-2026-11-R3 (splits, pass 1): the source edited after the plan, after the approval, and while phase 1 runs. Each test
 * asserts the SAFE behaviour: a pass means the attempt HELD, a failure is a bypass (a finding).
 *
 * The claims under attack (ADR 0059 decision 3.1, 3.5): the first check refuses unless "each approved item's blocks
 * are either all there exactly as planned or all gone with the item's own new blocks in their place (moved by this job);
 * no block was added since"; a source edit is "a core rebase: the blocks must be exactly as planned, or the job stops".
 *
 * - SP-16: a block added inside a moving section after the plan.
 * - SP-17: a whole moving section deleted from the source after the plan (retire, no interface summary).
 * - SP-18: the same section moved by hand to another page (new ids) after the plan.
 * - SP-19: a block that STAYS deleted after the plan: caught before any write?
 * - SP-20: a moving block changed by an outside edit while phase 1 runs (after its destination got its copy).
 * - SP-21: a nested child of a moving block changed while phase 1 runs.
 * - SP-22: blocks dragged between a staying and a moving section after the plan.
 * - SP-23: a block added inside a moving section while phase 1 runs (after the first check).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { splitWorld, statutesBody, type SplitWorld } from '../../packs/split-world.js';
import { statutesSplit } from '../../packs/split-inputs.js';
import { approveSplit, bodyOf, intercept, recordOf, type Obj } from '../../packs/split-helpers.js';
import { editBody, holders, para, propose, S, setBody, textHolders } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const LAW = ['sh3', 'sl1', 'sl2', 'sl3', 'sl4', 'sl5', 'sl6'];
const ALL = statutesBody().map((b) => b.id);

/**
 * Where each block of the statutes is now (live pages holding it), among the pages a split of the statutes can touch
 * (the fixture world reuses a few short ids on other pages: the Sorcery page also has a block `so1`).
 */
const where = (w: SplitWorld, ids: readonly string[], pages: readonly string[]) =>
  Object.fromEntries(
    ids.map((id) => [
      id,
      holders(w, id)
        .map((h) => h.pageId)
        .filter((x) => pages.includes(x)),
    ]),
  );

describe('SP-16..SP-19: the source changed between the plan and the approval', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-16 a block added inside a moving section after the plan stops the job before any write', async () => {
    setBody(w, S.statutes, statutesBody());
    const p = await propose(w, statutesSplit());
    editBody(w, S.statutes, (b) => {
      b.splice(b.findIndex((x) => x.id === 'sl3') + 1, 0, para('slnew', 'A statute added after the plan.'));
    });
    const writes = w.requests().writes;
    const done = await approveSplit(w, p.proposalId);
    expect(done.job.lastError).toMatchObject({ code: 'SPLIT_SOURCE_CHANGED' });
    expect(w.requests().writes).toBe(writes);
  });

  it('SP-17 a moving section deleted from the source after the plan stops the job (it is not re-created)', async () => {
    // A fresh source (the previous split's job stopped at its first check; its pages were never made).
    setBody(w, S.statutes, statutesBody());
    const p = await propose(w, statutesSplit(lawOnly()));
    // The owner deletes Law and Courts from the page in the app, after the plan and before approving.
    editBody(w, S.statutes, (b) => {
      for (const id of LAW)
        b.splice(
          b.findIndex((x) => x.id === id),
          1,
        );
    });
    const writes = w.requests().writes;
    const done = await approveSplit(w, p.proposalId);
    const law = p.pages.get('law')!;
    const rec =
      done.job.status === 'succeeded' ? await recordOf(w, done.jobId, (x) => x.state !== 'running') : null;
    // SAFE: the source no longer holds what the owner approved moving: nothing is written, nothing re-created.
    expect(
      {
        status: done.job.status,
        code: done.job.lastError?.code ?? null,
        writes: w.requests().writes - writes,
        lawPageMade: w.repo.live(law.id) !== undefined,
      },
      `split ${rec?.state ?? '-'}${rec?.phase2?.proposalId ? ' (phase 2 proposed: archive the source)' : ''}; ` +
        `the deleted statute sl1 is now held by ${
          holders(w, 'sl1')
            .map((h) => h.name)
            .join(', ') || 'no page'
        }`,
    ).toEqual({ status: 'failed', code: 'SPLIT_SOURCE_CHANGED', writes: 0, lawPageMade: false });
  });
});

/** The statutes split with only the Law destination (Faith and Worship stays), the source retired. */
function lawOnly() {
  const s = statutesSplit();
  return {
    destinations: (s.destinations as Obj[]).filter((d) => d.key === 'law'),
    map: (s.map as Obj[]).map((e) => (e.section === 'Faith and Worship' ? { ...e, to: 'stays' } : e)),
  };
}

describe('SP-18: a moving section moved by hand to another page after the plan', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-18 the split does not re-create a section that was moved elsewhere meanwhile (it would own it twice)', async () => {
    const p = await propose(w, statutesSplit(lawOnly()));
    // Between the plan and the approval, Law and Courts is cut from the source and pasted into the Polity page (the
    // app gives pasted blocks new ids).
    const moved: Obj[] = [];
    editBody(w, S.statutes, (b) => {
      for (const id of LAW)
        moved.push(
          ...b.splice(
            b.findIndex((x) => x.id === id),
            1,
          ),
        );
    });
    editBody(w, S.ostrandPolity, (b) => {
      b.push(...moved.map((m, i) => ({ ...m, id: `pasted${i}` })));
    });
    const done = await approveSplit(w, p.proposalId);
    const statute = String(
      ((statutesBody() as Obj[]).find((x) => x.id === 'sl1')!.content as Obj[])[0]!.text,
    );
    const owners = textHolders(w, statute);
    const rec =
      done.job.status === 'succeeded' ? await recordOf(w, done.jobId, (x) => x.state !== 'running') : null;
    // SAFE: the statute text is owned once (by the Polity page it was moved to), or the job stopped.
    expect(
      { holders: owners.length },
      `job ${done.job.status}; split ${rec?.state ?? '-'}${rec?.phase2?.proposalId ? ' (phase 2 proposed)' : ''}; held by ${owners.join(', ')}`,
    ).toEqual({ holders: 1 });
  });
});

describe('SP-19: a block that stays, deleted after the plan', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-19 a staying block deleted after the plan is caught by the first check, before anything is written', async () => {
    const p = await propose(w, statutesSplit());
    editBody(w, S.statutes, (b) => {
      b.splice(
        b.findIndex((x) => x.id === 'so1'),
        1,
      );
    });
    const writes = w.requests().writes;
    const done = await approveSplit(w, p.proposalId);
    const left = bodyOf(w, S.statutes).map((b) => b.id);
    // SAFE: refused before any write (the page is no longer the page the owner approved splitting).
    expect(
      { status: done.job.status, writes: w.requests().writes - writes },
      `stopped with ${done.job.lastError?.code ?? '-'}; the source now holds ${left.join(', ')}`,
    ).toEqual({ status: 'failed', writes: 0 });
  });
});

describe('SP-20..SP-23: the source edited while phase 1 runs', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-20 a moving block changed after its copy was made: the job stops, the change is kept, nothing is lost', async () => {
    setBody(w, S.statutes, statutesBody());
    const p = await propose(w, statutesSplit());
    // As the Sun Rite's append is sent, sf2 is changed in the source (in the app).
    const hook = intercept(w, 'PUT', new RegExp(`/resources/${S.sunRite}/docs/[^/]+/blocks$`), (n) => {
      if (n === 0)
        editBody(w, S.statutes, (b) => {
          b.find((x) => x.id === 'sf2')!.content = [
            { text: 'The rite, revised in the app during the split.' },
          ];
        });
      return undefined;
    });
    const done = await approveSplit(w, p.proposalId);
    hook.off();
    expect(done.job.status).toBe('failed');
    const lost = ALL.filter((id) => holders(w, id).length === 0);
    expect({ lost, revised: textHolders(w, 'The rite, revised in the app during the split.') }).toEqual({
      lost: [],
      revised: [S.statutes],
    });
  });

  it('SP-21 a nested child of a moving block changed after its copy was made: the job stops before the block leaves', async () => {
    // The Sun Rite back as it was, the statutes with a list in Faith and Worship.
    const fresh = await splitWorldFresh();
    try {
      const body = statutesBody() as Obj[];
      body.splice(body.findIndex((x) => x.id === 'sf6') + 1, 0, {
        id: 'sfList',
        kind: 'bulletList',
        children: [{ id: 'sfLi', kind: 'listItem', children: [para('sfLip', 'Grain at dawn.')] }],
      });
      setBody(fresh, S.statutes, body);
      const p = await propose(fresh, statutesSplit());
      const hook = intercept(fresh, 'PUT', new RegExp(`/resources/${S.sunRite}/docs/[^/]+/blocks$`), (n) => {
        if (n === 0)
          editBody(fresh, S.statutes, (b) => {
            const li = (b.find((x) => x.id === 'sfList')!.children as Obj[])[0]!;
            (li.children as Obj[])[0]!.content = [{ text: 'Grain at dawn, and salt at dusk.' }];
          });
        return undefined;
      });
      const done = await approveSplit(fresh, p.proposalId);
      hook.off();
      expect(done.job.status).toBe('failed');
      expect(textHolders(fresh, 'Grain at dawn, and salt at dusk.')).toEqual([S.statutes]);
    } finally {
      await fresh.close();
    }
  });

  it('SP-22 blocks dragged between a staying and a moving section after the plan: each still ends in exactly one place', async () => {
    const fresh = await splitWorldFresh();
    try {
      const p = await propose(fresh, statutesSplit());
      // so1 (Overview, stays) dragged into Law and Courts; sl6 (moves to Law) dragged into Overview.
      editBody(fresh, S.statutes, (b) => {
        const so1 = b.splice(
          b.findIndex((x) => x.id === 'so1'),
          1,
        )[0]!;
        b.splice(
          b.findIndex((x) => x.id === 'sl3'),
          0,
          so1,
        );
        const sl6 = b.splice(
          b.findIndex((x) => x.id === 'sl6'),
          1,
        )[0]!;
        b.splice(b.findIndex((x) => x.id === 'sh2') + 1, 0, sl6);
      });
      const lawId = p.pages.get('law')!.id;
      const done = await approveSplit(fresh, p.proposalId);
      expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
      const at = where(fresh, ALL, [S.statutes, S.sunRite, lawId]);
      expect({ so1: at.so1, sl6: at.sl6, twice: ALL.filter((id) => at[id]!.length !== 1) }).toEqual({
        so1: [S.statutes],
        sl6: [lawId],
        twice: [],
      });
    } finally {
      await fresh.close();
    }
  });

  it('SP-23 a block added inside a moving section while phase 1 runs is kept (in the source)', async () => {
    const fresh = await splitWorldFresh();
    try {
      const p = await propose(fresh, statutesSplit());
      const lawId = p.pages.get('law')!.id;
      const hook = intercept(fresh, 'PUT', new RegExp(`/resources/${lawId}/docs/[^/]+/blocks$`), (n) => {
        if (n === 0)
          editBody(fresh, S.statutes, (b) => {
            b.splice(
              b.findIndex((x) => x.id === 'sl4') + 1,
              0,
              para('sllate', 'A statute added during the split.'),
            );
          });
        return undefined;
      });
      const done = await approveSplit(fresh, p.proposalId);
      hook.off();
      const late = holders(fresh, 'sllate').map((h) => h.pageId);
      expect(
        { late, lost: ALL.filter((id) => holders(fresh, id).length === 0) },
        `job ${done.job.status}`,
      ).toEqual({
        late: [S.statutes],
        lost: [],
      });
    } finally {
      await fresh.close();
    }
  });
});

/** A fresh split world with its snapshot (for a test that needs the fixtures untouched). */
async function splitWorldFresh(): Promise<SplitWorld> {
  const w = await splitWorld();
  await w.snapshot();
  return w;
}
