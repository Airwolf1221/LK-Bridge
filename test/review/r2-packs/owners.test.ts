/**
 * R2-PACKS on the owners world (test/packs/owners-world.ts: Salahad, the race roster, the pinned governance sections):
 *
 * - ATK-02: the lifecycle index decoy of ATK-01 through `arkona_create_owner` (createCharacterNavigation), which also
 *   records a Character taxonomy entry for the decoy;
 * - ATK-07: pinned governance sections are matched by the FIRST heading of that name (src/packs/sections.ts:57-64), so a
 *   second section under a pinned heading is neither refused at approval nor reported as a pinned change; docs/packs.md
 *   says "A pinned section must be unambiguous";
 * - ATK-10: `promoteNation` (moving an Authoritative page) at scope write is one direct job on the owner's Review page
 *   (v3 F12, ADR 0081; it was a canonical proposal), and Revert puts the Reference back;
 * - ATK-11: `promoteNation`'s run-time re-check (`present`: the Reference is still where the plan saw it) is not run
 *   again after a hold between the job's check and its first write (the root cause of ATK-05); the package comes from
 *   a connection at scope propose and is approved as canon.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest } from '../../contract/mock-lk.js';
import { LIFECYCLE } from '../../resources/world.js';
import { O, ownerText, ownersWorld, PINNED, type OwnersWorld } from '../../packs/owners-world.js';
import { approve } from '../../packs/world.js';
import type { ToolCall } from '../../tools/helpers.js';
import { PROJECT, err, liveNamed, writeAgent } from './helpers.js';

let w: OwnersWorld;
let agent: Awaited<ReturnType<typeof writeAgent>>;
let proposer: (name: string, args: Record<string, unknown>) => Promise<ToolCall>;
/** Pauses writes on the n-th read of the Tagging Standard's blocks after arming. */
let armed: { seen: number; at: number } | null = null;
beforeAll(async () => {
  w = await ownersWorld({ toolModes: 'seed' });
  agent = await writeAgent(w);
  const pc = await w.stack.connect(w.stack.newToken('r2-owners-proposer', 'propose').token);
  proposer = (name, args) => w.stack.call(pc, name, args);
  w.overrides.set(new RegExp(`/docs/${w.governanceDocs.tagging}/blocks$`), (req: MockRequest) => {
    if (armed && req.method === 'GET' && ++armed.seen === armed.at) {
      armed = null;
      w.stack.runtime.engine.controls.pauseWrites('test');
    }
    return undefined;
  });
});
afterAll(async () => {
  w?.stack.runtime.engine.controls.resumeWrites('test');
  await w?.close();
});

const packs = () => w.stack.runtime.packs;
const policy = () => w.stack.runtime.policy;
const engine = () => w.stack.runtime.engine;
const until = async (fn: () => boolean, ms = 8000) => {
  for (let t = 0; t < ms / 10 && !fn(); t++) await new Promise((r) => setTimeout(r, 10));
};

describe('ATK-02: a racial group named "Archived" with its character navigation (arkona_create_owner, seed switch)', () => {
  it('approving the ordinary proposal must not make a second [INDEX] Archived (nor a taxonomy entry for it)', async () => {
    const r = await agent('arkona_create_owner', {
      type: 'Species',
      kind: 'racialGroup',
      name: 'Archived',
      home: 'Races of Arkona',
      status: 'working',
      scope: 'A racial group',
      temporalScope: '4A 1 - 5A 931',
      createCharacterNavigation: true,
      markdown: ownerText('The racial group.'),
      project: 'test',
    });
    // Set-up corrected (CR-2026-11-R2, the guard half of R2-11): no lifecycle marker declares a page given a lifecycle
    // index's name any more, so the package is refused when it is captured (POLICY_DENIED), as the same create through
    // lk_api_write is (CR-15). Were an ordinary proposal captured, its approval is checked as before; v3 F12 (ADR 0081):
    // at scope write a package runs directly, and the job is checked the same way.
    if (r.body.status === 'proposal_captured') {
      expect(r.body.requiresCanonicalApproval ?? false).toBe(false);
      await approve(w, String(r.body.proposalId));
    } else if (typeof r.body.jobId === 'string') await engine().wait(PROJECT, r.body.jobId, 30_000);
    else expect(err(r).code, r.text).toBe('POLICY_DENIED');
    const decoys = liveNamed(w, '[INDEX] Archived')
      .filter((x) => x.id !== LIFECYCLE.archived)
      .map((x) => ({ id: x.id, parent: w.repo.res.get(x.parentId!)?.name }));
    expect(decoys).toEqual([]);
  });
});

describe('ATK-07: a pinned governance heading that appears twice', () => {
  const tagging = () => w.repo.blocks.get(w.governanceDocs.tagging)!;
  const heading = (id: string, text: string) => ({ id, kind: 'heading', level: 2, content: [{ text }] });
  const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });

  it('ATK-07a: a second “Exact Tag Grammar” section with new rules (added after the approved one) is reported as a pinned change', async () => {
    await packs().commands.approve('owner', 'arkona');
    // An agent (scope write: page text is not canon-gated) appends a second section under the pinned heading.
    const b = tagging();
    b.version++;
    b.blocks = [
      ...b.blocks,
      heading('r2dup1', 'Exact Tag Grammar'),
      para('r2dup2', 'Every page also carries the tag CANON-2, first.'),
    ];
    const status = await packs().governance('arkona');
    const src = status.sources.find((s) => s.key === 'tagging-standard')!;
    const pinned = src.sections?.find((s) => s.heading === PINNED.tagging[0]);
    expect(status.state).toBe('changed'); // the document's version decides (fail closed): held
    // Safe: the pinned section is not reported unchanged, and the owner is not told the change is outside the pins.
    expect({ state: pinned?.state, message: /outside its pinned sections/.test(status.message) }).not.toEqual(
      {
        state: 'same',
        message: true,
      },
    );
  });

  it('ATK-07b: the owner’s approval is refused while a pinned heading is ambiguous (two sections of that name)', async () => {
    let refused: string | null = null;
    try {
      await packs().commands.approve('owner', 'arkona');
    } catch (e) {
      refused = (e as { code?: string }).code ?? 'refused';
    }
    expect(refused).not.toBeNull();
    // Put the document back for the tests below and approve.
    const b = tagging();
    b.version++;
    b.blocks = b.blocks.filter((x) => !['r2dup1', 'r2dup2'].includes((x as { id: string }).id));
    await packs().commands.approve('owner', 'arkona');
  });
});

const institution = (over: Record<string, unknown> = {}) => ({
  type: 'Institution',
  name: 'Court of Pearls',
  descriptor: 'Institution Reference',
  nation: 'Sultanate of Tarim',
  home: 'Sultanate of Tarim',
  status: 'authoritative',
  referenceType: 'Institution Reference',
  scope: 'The pearl-divers’ court of the sultanate',
  temporalScope: '4A 100 - 4A 300',
  markdown: ownerText('The pearl court of Tarim.'),
  promoteNation: true,
  project: 'test',
  ...over,
});

describe('promoteNation', () => {
  it('ATK-10: at scope write, a Working owner that promotes a nation is one direct job on Review; Revert puts it all back', async () => {
    const tarim = structuredClone(w.repo.res.get(O.tarim)!);
    const before = new Set([...w.repo.res.values()].filter((x) => x.deletedAt === null).map((x) => x.id));
    try {
      const r = await agent('arkona_create_owner', institution({ status: 'working', name: 'Court of Shells' }));
      expect(r.body.status, r.text).not.toBe('proposal_captured');
      const job = await engine().wait(PROJECT, String(r.body.jobId), 30_000);
      expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
      expect(
        w.stack.runtime.review.list(PROJECT, { state: 'all', limit: 500 }).some((i) => i.jobId === job.id),
      ).toBe(true);
      expect(w.repo.res.get(O.tarim)!.parentId).not.toBe(tarim.parentId);
      // The owner reverts it: the Reference back where it was, the pages the job made deleted again.
      const preview = await w.stack.runtime.reverts.preview(PROJECT, job.id);
      expect(
        preview.targets.filter((t) => t.state !== 'ready' && t.state !== 'nothing_to_do'),
        JSON.stringify(preview.targets),
      ).toEqual([]);
      const rv = await w.stack.runtime.reverts.revert('owner', PROJECT, job.id);
      expect(rv.status, JSON.stringify(rv)).toBe('submitted');
      if (rv.status === 'submitted') await engine().wait(PROJECT, rv.revertJobId, 30_000);
      expect(w.repo.res.get(O.tarim)!.parentId).toBe(tarim.parentId);
    } finally {
      // Whatever the revert left, the world as it was for ATK-11 (by hand, as in the app).
      const t = w.repo.res.get(O.tarim)!;
      if (t.parentId !== tarim.parentId) w.repo.outside.move(O.tarim, tarim.parentId);
      if (t.name !== tarim.name) w.repo.outside.rename(O.tarim, tarim.name);
      w.repo.outside.setTags(O.tarim, tarim.tags);
      const made = [...w.repo.res.values()].filter((x) => x.deletedAt === null && !before.has(x.id));
      for (const m of made.reverse()) if (w.repo.live(m.id)) w.repo.outside.delete(m.id);
      await w.stack.runtime.tree.sweep(PROJECT);
    }
  });

  it('ATK-11: the approved package is held after its check; the owner moves the Reference meanwhile: the job must stop (NATION_REFERENCE_MOVED)', async () => {
    const r = await proposer('arkona_create_owner', institution());
    expect(r.body.status, r.text).toBe('proposal_captured');
    const id = String(r.body.proposalId);
    // The owner approves as canon; the job's check reads the governance (writes are paused right after) and finds the
    // Reference where the plan saw it.
    armed = { seen: 0, at: 1 };
    await policy().commands.approveAsCanon('owner', id);
    let jobId = '';
    await until(() => {
      jobId = policy().proposals.get(id)?.jobId ?? '';
      return jobId !== '' && engine().queries.getJob(PROJECT, jobId)?.waitReason?.held === 'writes_paused';
    });
    const held = engine().queries.getJob(PROJECT, jobId);
    expect(held?.steps.find((s) => s.opId === 'bridge.expect')?.status).toBe('succeeded');
    expect(held?.steps.filter((s) => s.opKind !== 'read' && s.status !== 'pending')).toEqual([]);
    // Meanwhile the owner moves the Reference in LegendKeeper (it is no longer a compact polity in Salahad Polities).
    w.repo.outside.move(O.tarim, O.salahadInstitutions);
    engine().controls.resumeWrites('test');
    const job = await engine().wait(PROJECT, jobId, 30_000);
    const where = w.repo.res.get(O.tarim)!.parentId;
    expect({
      status: job.status,
      code: job.lastError?.code,
      tarimStillIn: w.repo.res.get(where!)?.name,
      newNationIndex: liveNamed(w, '[INDEX] Sultanate of Tarim').length,
    }).toEqual({
      status: 'failed',
      code: 'NATION_REFERENCE_MOVED',
      tarimStillIn: '[INDEX] Salahad Institutions',
      newNationIndex: 0,
    });
  });
});
