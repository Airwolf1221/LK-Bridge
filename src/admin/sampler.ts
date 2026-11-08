/**
 * INTERIM budget sampler (chunk 5). Every 10 seconds it stores one budget sample for the Request Budgets sparklines:
 * `engine.recordBudgetSample(governor.snapshot())`.
 *
 * CHUNK 6: replace this with the maintenance scheduler's `budget-sampler` job (PLAN §8 page 6) and delete this file
 * and its single call in `src/runtime.ts`. Both would write the same rows, so run only one of them.
 */
import type { JobEngine } from '../jobs/index.js';
import type { LkClient } from '../lk/index.js';

export function startInterimBudgetSampler(
  engine: JobEngine,
  lk: LkClient,
  intervalMs: number,
  onError: (err: unknown) => void = () => undefined,
): () => void {
  if (intervalMs <= 0) return () => undefined;
  const timer = setInterval(() => {
    try {
      engine.recordBudgetSample(lk.governor.snapshot());
    } catch (err) {
      onError(err); // a failed sample must never take the bridge down
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
