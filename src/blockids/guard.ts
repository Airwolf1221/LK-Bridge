/**
 * The canon guard's one exception for the block-id sweep (ADR 0056 decision 6). `assignBlockIds` changes no content, so
 * the sweep's jobs pass the protected-canonical-facts guard (src/facts/canonical.ts) on Authoritative pages without a
 * canonical approval. The exception is explicit and narrow: the request must be the system principal's, from the
 * maintenance origin of this very job, and hold nothing but `assignBlockIds` and the bridge's own check and verify
 * steps. Anything else (an agent's `assignBlockIds` through `lk_api_write` included) is judged as before.
 */
import { SYSTEM_PRINCIPAL } from '../jobs/types.js';
import { EXPECT_STEP, VERIFY_STEP } from '../jobs/internal-steps.js';
import { SWEEP_JOB_ID } from './statement.js';

/** The operations a block-id sweep job holds. */
const SWEEP_OPS: ReadonlySet<string> = new Set(['assignBlockIds', EXPECT_STEP, VERIFY_STEP]);

export interface SweepRequestLike {
  readonly principal: { readonly principalId: string };
  readonly origin: { readonly kind: string; readonly tool?: string; readonly approval?: unknown };
  readonly items: readonly { readonly op: string }[];
}

/** True only for the block-id sweep's own request (see the module comment). */
export function isBlockIdSweepRequest(input: SweepRequestLike): boolean {
  return (
    input.principal.principalId === SYSTEM_PRINCIPAL.principalId &&
    input.origin.kind === 'maintenance' &&
    input.origin.tool === SWEEP_JOB_ID &&
    input.origin.approval === undefined &&
    input.items.length > 0 &&
    input.items.some((it) => it.op === 'assignBlockIds') &&
    input.items.every((it) => SWEEP_OPS.has(it.op))
  );
}
