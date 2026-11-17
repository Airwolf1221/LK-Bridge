/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3.5 (ADR 0056), the knock-on: the owner appraisal (A2, `arkona_appraise_owner`) lists a page still awaiting block
 * ids as optional polish, with nothing to do but wait (`followUp` none: "waiting for the block-id sweep"). A page with
 * ids is not listed. F3c's appraisal world (the real stack against the mock); mocks and fixtures only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appraisalWorld, cleanBody, P, type AppraisalWorld } from '../appraisal/world.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const LEGACY = 'aplegcy1';

let w: AppraisalWorld;
let findings: any[];
beforeAll(async () => {
  w = await appraisalWorld({
    seed: (world) => {
      const r = world.repo;
      r.seed({
        id: LEGACY,
        name: '[BSRC] Old Quay Compact - Polity Reference',
        parentId: P.desk,
        referenceType: 'Polity Reference',
        scope: 'A coastal polity',
        tags: ['CANON', 'Polity'],
      });
      const main = r.liveDocs(r.live(LEGACY)!).find((d) => d.name === 'Main')!.id;
      // The clean body, its first heading without an id and two paragraphs sharing one: a legacy page.
      const body = cleanBody('lq').map((b, i) =>
        i === 0
          ? { kind: b.kind, level: (b as any).level, content: b.content }
          : i === 3
            ? { ...b, id: 'lqp1' }
            : b,
      );
      r.blocks.set(main, { version: 1, blocks: body });
    },
  });
  await w.snapshot();
  const r = await w.call('arkona_appraise_owner', {
    under: P.desk,
    limit: 200,
    detail: 'full',
    project: 'test',
  });
  expect(r.isError, r.text).toBe(false);
  findings = r.body.findings;
});
afterAll(async () => w?.close());

describe('the A2 line for a page awaiting block ids', () => {
  it('is optional polish, with no follow-up but waiting for the block-id sweep', () => {
    const f = findings.filter((x) => x.check === 'block_ids_pending');
    expect(f.map((x) => x.page.id)).toEqual([LEGACY]);
    expect(f[0]).toMatchObject({
      group: 'polish',
      evidence: 'Potential Maintenance Issue',
      followUp: { kind: 'none', reason: 'waiting for the block-id sweep' },
      details: { missing: 1, duplicates: ['lqp1'] },
    });
    expect(f[0].message).toMatch(/1 block has no id, 1 block id is used twice/);
  });

  it('is not listed for a page whose blocks all have their own ids', () => {
    expect(findings.some((x) => x.check === 'block_ids_pending' && x.page.id === P.clean)).toBe(false);
  });
});
