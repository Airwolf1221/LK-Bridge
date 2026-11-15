/**
 * RV4: the audit's paragraph split (src/audits/fixes.ts, ADR 0044) stopped after its inserts and before its
 * `replaceBlock` ("a failure after the inserts leaves the text twice, never less"). The finding stays open (the
 * original paragraph is unchanged), so "Propose a fix" again is the owner's obvious next step. That second proposal is
 * planned from the original paragraph alone, with new ids, and inserts the parts AGAIN: the text ends up duplicated.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { A, auditsWorld, type AuditsWorld, type MockBlock } from '../audits/world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: AuditsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});
const audits = () => w!.stack.runtime.audits;
const pol = () => w!.stack.runtime.policy;
const text = (b: MockBlock) => (b.content ?? []).map((r) => r.text ?? '').join('');

async function approve(proposalId: string) {
  await pol().commands.approve('owner', proposalId);
  for (
    let i = 0;
    i < 400 && !['executed', 'failed', 'conflicted'].includes(pol().proposals.get(proposalId)!.state);
    i++
  )
    await new Promise((r) => setTimeout(r, 20));
  return pol().proposals.get(proposalId)!.state;
}

it('a split stopped after its inserts, proposed again, does not duplicate the paragraph’s text', async () => {
  w = await auditsWorld();
  await w.snapshotAndAudit();
  const find = () =>
    audits()
      .list(PROJECT, { limit: 1000 })
      .findings.find(
        (x) => x.code === 'line_break_paragraph' && x.pageId === A.breaks && x.blockId === 'bp1',
      );
  const f = find()!;
  const r = await audits().proposeFix('owner', PROJECT, f.id);
  if (r.status !== 'proposal_captured') throw new Error('not captured');
  // The cut-down of the original (the replaceBlock) fails: LegendKeeper answers 500, nothing applied.
  w.stack.mock.inject((c) => c.method === 'PUT' && /\/blocks\/bp1\/?$/.test(c.path), {
    kind: 'status',
    status: 500,
    code: 'INTERNAL',
  });
  expect(await approve(r.proposalId)).toBe('failed');
  const once = w.blocksOf(A.breaks).map(text);
  // As documented: the text is there twice (the original whole, then its parts), never less.
  expect(once.filter((t) => t === 'second line')).toHaveLength(1);
  // The owner proposes the fix again for the same, still open, finding (or the next audit's).
  const f2 = find() ?? f;
  const again = await audits().proposeFix('owner', PROJECT, f2.id);
  if (again.status === 'proposal_captured') await approve(again.proposalId);
  const after = w.blocksOf(A.breaks).map(text);
  // Safe: each line appears once (the finished split), or the second proposal is refused.
  expect(
    after.filter((t) => t === 'second line'),
    after.join(' | '),
  ).toHaveLength(1);
  expect(
    after.filter((t) => t === 'third line'),
    after.join(' | '),
  ).toHaveLength(1);
});
