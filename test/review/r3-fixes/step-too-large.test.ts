/**
 * CR-2026-11-R3 (R3-01): a setting-pack plan whose check or read-back step holds more entries than one job checks
 * (MAX_STEP_CHECKS) is refused plainly before it is submitted or proposed (`STEP_TOO_LARGE`), never with the engine's
 * internal INVALID_PARAMS after its reads were spent. The limit itself was raised from 400 to 5,000 (a 700-page rename
 * was refused at 400).
 */
import { describe, expect, it, vi } from 'vitest';
import { EXPECT_STEP, MAX_STEP_CHECKS, VERIFY_STEP } from '../../../src/jobs/internal-steps.js';
import type { StepSpec } from '../../../src/jobs/types.js';
import { runWriteJob } from '../../../src/mcp/tools/write-job.js';

const pd = (submit: (...a: unknown[]) => unknown) =>
  ({
    project: { id: 'p1', name: 'Test' },
    projects: { anyClient: () => undefined },
    engine: { submit },
  }) as never;
const mctx = { principal: { principalId: 'pat_x', profile: 'prof_x', label: 'agent' } } as never;

const expectStep = (n: number): StepSpec => ({
  op: EXPECT_STEP,
  params: {
    body: {
      checks: Array.from({ length: n }, (_, i) => ({
        label: `c${i}`,
        kind: 'block',
        resourceId: 'r1',
        documentId: 'd1',
        blockId: `b${i}`,
      })),
    },
  },
});

describe('R3-01: one check step holds at most MAX_STEP_CHECKS entries', () => {
  it('is 5,000 (the whole of Arkona, about 3,500 pages), not 400', () => {
    expect(MAX_STEP_CHECKS).toBe(5_000);
  });

  it('a plan beyond it is refused STEP_TOO_LARGE before anything is submitted', async () => {
    const submit = vi.fn();
    const out = await runWriteJob(pd(submit), mctx, 'arkona_rename', {
      steps: [
        expectStep(MAX_STEP_CHECKS + 1),
        { op: VERIFY_STEP, params: { body: { targets: [] } } },
      ] as StepSpec[],
      labels: ['check', 'verify'],
      title: 'a rename too large for one job',
      head: {},
      preview: () => null,
    } as never);
    expect(submit).not.toHaveBeenCalled();
    expect(out.result.isError).toBe(true);
    expect(out.body).toMatchObject({ error: { code: 'STEP_TOO_LARGE', checks: MAX_STEP_CHECKS + 1 } });
  });
});
