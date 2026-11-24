/**
 * Sends one registry operation through the governor (`lk.governor.execute` via `lk.call`): exactly one LK request
 * per call, using the SDK's raw `request` on the governed fetch. The engine never builds URLs to LK any other way.
 *
 * Request ids: the bridge supplies its own `x-request-id` (`{prefix}.{attempt}`, LK echoes it), so a step can record
 * the ids of successful calls too; failed calls record the id LK returned.
 */
import type { LkClient } from '../lk/client.js';
import { BridgeLkError, BudgetWaitError } from '../lk/errors.js';
import type { VerifyResult } from '../lk/governor/types.js';
import type { OperationDef } from '../lk/registry-types.js';
import { InvalidParamsError } from './errors.js';
import type { GovernorPriorityClass, OpParams } from './types.js';

const LOCAL_CODES = new Set([
  'GOVERNOR_BYPASS',
  'ONE_REQUEST_PER_CALL',
  'IF_MATCH_REQUIRED',
  'INVALID_REQUEST',
  'OPERATION_NOT_ALLOWED',
]);

export interface CallStats {
  /** Times `run` was invoked (each is one request attempt). */
  attempts: number;
  readonly requestIds: string[];
  /** True once an attempt may have reached LK and changed something (success, transport failure, 5xx). */
  maybeSent: boolean;
  /** The `ETag` (unquoted) of the last successful write's response, when it sent one (v2 D1.1, ADR 0039). */
  etag?: string;
}

export function newCallStats(): CallStats {
  return { attempts: 0, requestIds: [], maybeSent: false };
}

export interface CallOptions {
  readonly priority: GovernorPriorityClass;
  readonly jobId?: string | undefined;
  readonly idempotencyKey?: string | null | undefined;
  readonly ifMatch?: string | null | undefined;
  readonly signal?: AbortSignal | undefined;
  /** CR-2026-11-R3 (R3-62): waits for the budget in its queue (`ExecuteRequest.patient`). */
  readonly patient?: boolean | undefined;
  /** v3 F9: first claim within its class (`ExecuteRequest.firstClaim`): the full snapshot's reads. */
  readonly firstClaim?: boolean | undefined;
  readonly requestIdPrefix: string;
  readonly verify?:
    ((ctx: { error: BridgeLkError; signal: AbortSignal }) => Promise<VerifyResult<unknown>>) | undefined;
  readonly stats?: CallStats;
  /** Called with every failure (for the errors table), before it is thrown. */
  readonly onError?: ((error: BridgeLkError) => void) | undefined;
}

/** `/api/v3/projects/{projectId}/…` with path params filled in. */
export function buildPath(op: OperationDef, params: OpParams, projectId: string): string {
  const filled = op.pathTemplate.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = name === 'projectId' ? projectId : params.path?.[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new InvalidParamsError(op.operationId, [{ path: `path.${name}`, message: 'Required' }]);
    }
    return encodeURIComponent(value);
  });
  return `/api/v3${filled}`;
}

/** Whether an error thrown by `run` proves the request did not change anything at LK. */
function provablyNotApplied(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof BridgeLkError && cur.code && LOCAL_CODES.has(cur.code)) return true;
    const status = (cur as { status?: unknown }).status;
    if (typeof status === 'number') return status >= 400 && status < 500 && status !== 408;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export async function callOp(
  lk: LkClient,
  op: OperationDef,
  params: OpParams,
  o: CallOptions,
): Promise<unknown> {
  const path = buildPath(op, params, lk.projectId);
  const stats = o.stats ?? newCallStats();
  try {
    return await lk.call<unknown>({
      operationId: op.operationId,
      priority: o.priority,
      input: params,
      ...(o.jobId !== undefined ? { jobId: o.jobId } : {}),
      ...(o.idempotencyKey && op.method === 'POST' ? { idempotencyKey: o.idempotencyKey } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.verify ? { verify: o.verify } : {}),
      ...(o.patient === true ? { patient: true } : {}),
      ...(o.firstClaim === true ? { firstClaim: true } : {}),
      run: async (sdk, signal) => {
        stats.attempts++;
        const requestId = `${o.requestIdPrefix}.${stats.attempts}`.slice(0, 64);
        stats.requestIds.push(requestId);
        const headers: Record<string, string> = { 'x-request-id': requestId };
        if (o.ifMatch) headers['if-match'] = o.ifMatch;
        try {
          const result = await sdk.request<unknown>({
            method: op.method,
            path,
            ...(params.query ? { query: params.query } : {}),
            ...(params.body !== undefined && op.method !== 'GET' ? { body: params.body } : {}),
            headers,
            signal,
          });
          if (op.method !== 'GET') {
            stats.maybeSent = true;
            const etag = lk.governor.currentResponse()?.etag;
            if (etag !== undefined) stats.etag = etag;
            else delete stats.etag;
          }
          return result;
        } catch (e) {
          if (op.method !== 'GET' && !provablyNotApplied(e)) stats.maybeSent = true;
          throw e;
        }
      },
    });
  } catch (e) {
    const err = e instanceof BridgeLkError ? e : undefined;
    if (err && o.onError && !(err instanceof BudgetWaitError && err.status === undefined)) {
      if (err.requestId && !stats.requestIds.includes(err.requestId)) stats.requestIds.push(err.requestId);
      o.onError(err);
    }
    throw e;
  }
}

export function isNotFound(e: unknown): boolean {
  return e instanceof BridgeLkError && (e.status === 404 || e.code === 'NOT_FOUND');
}
