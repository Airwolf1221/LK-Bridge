/** Cost of a registry operation for the governor (PLAN §4 `costs`). */
import { BridgeLkError } from './errors.js';
import type { CostSpec } from './governor/types.js';
import type { OperationDef } from './registry-types.js';

function at(input: unknown, dotted: string): unknown {
  let cur: unknown = input;
  for (const key of dotted.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * The tiers an operation draws on and, for `createManyResources`, the item count read from `itemsFrom`
 * (`body.resources.length`) in the caller-facing input `{ path?, query?, ifMatch?, body? }`.
 */
export function costSpecFor(op: OperationDef, input?: unknown): CostSpec {
  if (!op.itemsFrom) return { tiers: op.costs };
  const list = at(input, op.itemsFrom);
  if (!Array.isArray(list) || list.length === 0) {
    throw new BridgeLkError({
      message: `${op.operationId} needs a non-empty ${op.itemsFrom} to cost the items tiers`,
      code: 'INVALID_REQUEST',
      retryable: false,
      classification: 'bridge',
      opId: op.operationId,
    });
  }
  return { tiers: op.costs, items: list.length };
}
