/**
 * LK client factory (PLAN §3.1). The `@legendkeeper/sdk` client is built with the governor's fetch, no SDK
 * retries and no SDK-generated idempotency keys: the governor owns retries, pacing, header capture and keys.
 */
import { LegendKeeper } from '@legendkeeper/sdk';
import type { LkSettings } from '../config/lk.js';
import { costSpecFor } from './costs.js';
import { formatBudgetFooter } from './governor/footer.js';
import { Governor, type Transport } from './governor/governor.js';
import type { GovernorPersistence } from './governor/persist.js';
import type { Clock } from './governor/clock.js';
import type { PriorityClass, VerifyResult } from './governor/types.js';
import type { BridgeLkError } from './errors.js';
import { requireOperation } from './registry.js';

export interface LkClientConfig extends LkSettings {
  readonly clock?: Clock;
  /** Network transport underneath the governor (tests point it at a mock LK). */
  readonly transport?: Transport;
  readonly random?: () => number;
  /** Share an existing governor instead of building one from `governor` settings. */
  readonly governorInstance?: Governor;
  /** v1.0.1 (F-14): keep the governor's recent counts across restarts (the bridge passes its SQLite store). */
  readonly persistence?: GovernorPersistence;
}

export interface LkCallRequest<T> {
  /** Registry operation id; its kind and tier costs come from the registry. */
  readonly operationId: string;
  readonly priority: PriorityClass;
  readonly jobId?: string;
  readonly idempotencyKey?: string;
  /** Caller-facing input `{ path?, query?, ifMatch?, body? }`; used here only to cost `createManyResources`. */
  readonly input?: unknown;
  readonly signal?: AbortSignal;
  readonly verify?: (ctx: {
    readonly error: BridgeLkError;
    readonly signal: AbortSignal;
  }) => Promise<VerifyResult<T>>;
  /** One SDK call. Pass `signal` through to the SDK (`{ signal }` in its options). */
  readonly run: (sdk: LegendKeeper, signal: AbortSignal) => Promise<T>;
}

export interface LkClient {
  /** The typed SDK. Every call on it must happen inside `governor.execute` (or `call`); otherwise it throws. */
  readonly sdk: LegendKeeper;
  readonly governor: Governor;
  readonly projectId: string;
  /** Governed fetch for non-SDK requests inside `execute` (for example the signed upload PUT). */
  readonly fetch: Governor['fetch'];
  /** Registry-aware `governor.execute`: derives `kind` and `costs` from the operation registry. */
  call<T>(req: LkCallRequest<T>): Promise<T>;
  /** `formatBudgetFooter(governor.snapshot(), project)`: with `project`, the line names it (v2 A1). */
  budgetFooter(project?: string): string;
}

/** SDK's own timeout sits just above the governor's, so the governor's (clock-driven) one fires first. */
const SDK_TIMEOUT_MARGIN_MS = 5_000;

export function createLkClient(config: LkClientConfig): LkClient {
  const governor =
    config.governorInstance ??
    new Governor({
      settings: config.governor,
      ...(config.clock ? { clock: config.clock } : {}),
      ...(config.transport ? { transport: config.transport } : {}),
      ...(config.random ? { random: config.random } : {}),
      ...(config.persistence ? { persistence: config.persistence } : {}),
    });
  const sdk = new LegendKeeper({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    fetch: governor.fetch,
    maxRetries: 0,
    idempotencyKeys: false,
    timeoutMs: governor.settings.requestTimeoutMs + SDK_TIMEOUT_MARGIN_MS,
  });

  return {
    sdk,
    governor,
    projectId: config.projectId,
    fetch: governor.fetch,
    call<T>(req: LkCallRequest<T>): Promise<T> {
      const op = requireOperation(req.operationId);
      return governor.execute<T>({
        opId: op.operationId,
        kind: op.kind,
        costs: costSpecFor(op, req.input),
        priority: req.priority,
        ...(req.jobId !== undefined ? { jobId: req.jobId } : {}),
        ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.verify ? { verify: req.verify } : {}),
        run: (signal) => req.run(sdk, signal),
      });
    },
    budgetFooter: (project?: string) => formatBudgetFooter(governor.snapshot(), project),
  };
}
