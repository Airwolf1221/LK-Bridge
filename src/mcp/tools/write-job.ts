/**
 * Running one high-level write as ONE job, shared by the resource, document and character tools (v2 C2b, ADR 0034),
 * on C2a's groundwork (ADR 0032):
 *
 * - the expansion is submitted with the bridge's own steps allowed (`internal`) and the high-level operations, summary
 *   and page-level summary for a proposal; the policy gate and the write guard decide: a job (scope `write`) or ONE
 *   proposal (scope `propose`, or a protected canonical change whatever the scope);
 * - a job is waited for (at most 25 s): `written` with `verified` from the job's verify step, or `queued` /
 *   `waiting_budget` (never resubmitted);
 * - a failed job is NEVER replayed (PLAN-v2 4.13): its result says which writes were made and which were not, with the
 *   journal entries, so a retry is a new, smaller request.
 */
import type { BatchSubmit, JobView, LifecycleMarker, StepSpec } from '../../jobs/index.js';
import type { ProposalExtras } from '../../jobs/policy.js';
import type { McpToolContext, McpToolResult } from '../server.js';
import { finish } from './repo.js';
import { errorFromThrown, errorResult, mcpOrigin, render, type ProjectDeps } from './shape.js';

const WAIT_MS = 25_000;

export interface WriteJobSpec {
  readonly steps: readonly StepSpec[];
  /** A label per step, in order (`create [BSRC] X`, `Status: added`, `check`, `verify`). */
  readonly labels: readonly string[];
  readonly title: string;
  readonly holdLock?: { readonly resourceId: string };
  /** v2 C2c: the second job-level lock (a document of the held page). */
  readonly holdDocument?: { readonly documentId: string };
  readonly holdAlso?: { readonly resourceId: string };
  /** C2d: further job-level locks (a whole set's pages and the notes' documents). */
  readonly holdMore?: { readonly resources?: readonly string[]; readonly documents?: readonly string[] };
  /** C2d (ADR 0036 decision 5): the pages the job touches without naming them (a set), as planned. */
  readonly pageScope?: BatchSubmit['pageScope'];
  /** v2 C2c: the lifecycle change the job makes (the lifecycle guard allows exactly that). */
  readonly lifecycle?: LifecycleMarker | undefined;
  readonly proposal: ProposalExtras;
  /** The plan, as every answer shows it. */
  readonly head: Record<string, unknown>;
  readonly preview: () => unknown;
}

export interface WriteJobOutcome {
  readonly result: McpToolResult;
  /** The answer's body (stored for an `operation_id` repeat). */
  readonly body: Record<string, unknown>;
  readonly jobId?: string;
  readonly proposalId?: string;
}

const CANON_HINT =
  'This touches protected canon, so it was NOT done: it waits for the owner, who alone can accept it as canon. This happens ' +
  'whatever your scope. Never retry it or work around it; tell the user, and follow it with bridge_proposal_status.';
const PROPOSAL_HINT =
  'This needs the owner’s approval and was NOT done. The owner sees the plan; ids of new pages are fixed now and kept at ' +
  'approval. Never retry it; follow it with bridge_proposal_status.';

/** Submits the expansion and answers (see the module comment). */
export async function runWriteJob(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  spec: WriteJobSpec,
): Promise<WriteJobOutcome> {
  let r;
  try {
    r = await pd.engine.submit({
      kind: 'batch_ops',
      project: pd.project.id,
      steps: spec.steps,
      onError: 'stop',
      priority: 'P1',
      origin: mcpOrigin(mctx, tool),
      title: spec.title.slice(0, 300),
      ...(spec.holdLock ? { holdLock: spec.holdLock } : {}),
      ...(spec.holdDocument ? { holdDocument: spec.holdDocument } : {}),
      ...(spec.holdAlso ? { holdAlso: spec.holdAlso } : {}),
      ...(spec.holdMore ? { holdMore: spec.holdMore } : {}),
      ...(spec.pageScope ? { pageScope: spec.pageScope } : {}),
      ...(spec.lifecycle ? { lifecycle: spec.lifecycle } : {}),
      internal: true,
      proposal: spec.proposal,
    });
  } catch (e) {
    const result = errorFromThrown(e, pd);
    return { result, body: { error: parseError(result) } };
  }
  if ('proposalId' in r) {
    const body = {
      ...spec.head,
      status: 'proposal_captured',
      proposalId: r.proposalId,
      ...(r.summary !== undefined ? { summary: r.summary } : {}),
      ...(r.canonical
        ? { requiresCanonicalApproval: true, reason: r.canonical.reason, hint: CANON_HINT }
        : { hint: PROPOSAL_HINT }),
    };
    return { result: finish(pd, mctx, tool, body, spec.preview), body, proposalId: r.proposalId };
  }
  // Held (writes paused, read-only): it runs when they resume; say so at once rather than wait.
  const view =
    r.eta === null
      ? (pd.engine.queries.getJob(pd.project.id, r.jobId) ??
        (await pd.engine.wait(pd.project.id, r.jobId, 0)))
      : await pd.engine.wait(pd.project.id, r.jobId, WAIT_MS);
  const out = describeJob(pd, view, spec.labels, spec.head);
  return {
    result: out.error ? out.result : finish(pd, mctx, tool, out.body, spec.preview),
    body: out.body,
    jobId: view.id,
  };
}

/** The answer for a job as it stands now (also used to answer an `operation_id` repeat). */
export function describeJob(
  pd: ProjectDeps,
  view: JobView,
  labels: readonly string[],
  head: Record<string, unknown>,
): { readonly body: Record<string, unknown>; readonly result: McpToolResult; readonly error: boolean } {
  if (view.status === 'succeeded') {
    const res = (view.result ?? {}) as { verified?: unknown; verification?: Record<string, unknown> };
    const verified = typeof res.verified === 'boolean' ? res.verified : null;
    const ver = res.verification ?? {};
    const body = {
      ...head,
      status: 'written',
      verified,
      jobId: view.id,
      ...(factsVersions(ver) ?? {}),
      ...(verified === false
        ? {
            warning:
              'written but not as planned: what was read back after the writes differs from the plan; something else ' +
              'probably edited at the same moment. Nothing was retried. The journal holds what each write changed ' +
              `(bridge_journal_lookup with jobId ${view.id}). Read the pages and check them.`,
            verification: ver,
          }
        : verified === null
          ? { verification: { status: ver.status, reason: ver.reason } }
          : {}),
    };
    return { body, result: render(body, pd), error: false };
  }
  if (view.status === 'failed' || view.status === 'cancelled') {
    const body = failedBody(pd, view, labels, head);
    return { body, result: errorResult(body as never, pd), error: true };
  }
  const body = {
    ...head,
    status: view.status === 'waiting_budget' ? 'waiting_budget' : 'queued',
    jobId: view.id,
    hint:
      'Accepted and NOT failed: it runs by itself, with every check made again when it runs. Never submit it again: ' +
      'follow it with bridge_job_status or bridge_job_wait.',
  };
  return { body, result: render(body, pd), error: false };
}

/** The factsVersion of each page the verify step read back, by page name. */
function factsVersions(ver: Record<string, unknown>): Record<string, unknown> | null {
  const targets = Array.isArray(ver.targets) ? (ver.targets as Record<string, unknown>[]) : [];
  const out: Record<string, string> = {};
  for (const t of targets) {
    if (typeof t.factsVersion === 'string' && typeof t.label === 'string') out[t.label] = t.factsVersion;
  }
  return Object.keys(out).length > 0 ? { factsVersions: out } : null;
}

/**
 * A job that stopped: a conflict (nothing written), or what was written before it stopped and what was not, with the
 * journal entries. Never replayed.
 */
function failedBody(
  pd: ProjectDeps,
  view: JobView,
  labels: readonly string[],
  head: Record<string, unknown>,
): Record<string, unknown> {
  const err = (view.lastError ?? {}) as {
    code?: unknown;
    message?: unknown;
    differences?: unknown;
    reason?: unknown;
  };
  const why = typeof err.message === 'string' ? err.message : null;
  const steps = pd.engine.stepResults(pd.project.id, view.id) ?? [];
  const isWrite = (n: number) => {
    const l = labels[n - 1];
    return l !== undefined && l !== 'check' && l !== 'verify';
  };
  const written = steps
    .filter((s) => s.status === 'succeeded' && isWrite(s.stepNo))
    .map((s) => labels[s.stepNo - 1]!);
  // CR-2026-11 (CR-07): a write whose answer was lost, and whose check could not tell, may have been made: never listed
  // as not written.
  const uncertain = steps
    .filter((s) => s.status === 'uncertain' && isWrite(s.stepNo))
    .map((s) => labels[s.stepNo - 1]!);
  const notWritten = steps
    .filter((s) => s.status !== 'succeeded' && s.status !== 'uncertain' && isWrite(s.stepNo))
    .map((s) => labels[s.stepNo - 1]!);
  const journal = pd.engine.queries
    .journalLookup(pd.project.id, { jobId: view.id, includePreImage: false, limit: 200 })
    .map((e) => ({ id: e.id, op: e.opId, target: e.targetId, outcome: e.outcome }));
  const code = typeof err.code === 'string' ? err.code : 'JOB_FAILED';
  if (uncertain.length > 0) {
    return {
      code: 'OUTCOME_UNKNOWN',
      message:
        `Not known whether ${uncertain.join('; ')} ${uncertain.length === 1 ? 'was' : 'were'} written: LegendKeeper's answer ` +
        `was lost and the read that should have told failed too (${why ?? view.status}). ` +
        (written.length > 0 ? `Written: ${written.join('; ')}. ` : '') +
        `Not written: ${notWritten.join('; ') || 'nothing else'}. Nothing was retried, and nothing will be.`,
      jobId: view.id,
      written,
      uncertain,
      notWritten,
      journal,
      hint:
        `Read the pages to see what they hold before doing anything else; do not repeat this request. ` +
        `bridge_journal_lookup with jobId ${view.id} shows each write (an unknown one has the outcome "unknown").`,
      ...head,
    };
  }
  if (written.length === 0) {
    return {
      code,
      message:
        code === 'VERSION_CONFLICT'
          ? `${why ?? 'Something changed since it was planned.'}`
          : `Nothing was written: ${why ?? `the job ended ${view.status}`}`,
      ...(Array.isArray(err.differences) ? { differences: err.differences } : {}),
      jobId: view.id,
      written: [],
      notWritten,
      ...(code === 'VERSION_CONFLICT'
        ? { hint: 'Nothing was written. Read the pages again and make a new request on what they hold now.' }
        : {}),
      ...head,
    };
  }
  return {
    code: 'WRITTEN_IN_PART',
    message:
      `Written in part: ${written.join('; ')}; then the job stopped (${why ?? view.status}). ` +
      `Not written: ${notWritten.join('; ') || 'nothing else'}. Nothing was retried, and nothing will be.`,
    jobId: view.id,
    written,
    notWritten,
    journal,
    hint:
      `Read the pages before doing anything else. Do not repeat this request: make a new, smaller one for what was not ` +
      `written. bridge_journal_lookup with jobId ${view.id} shows each write.`,
    ...head,
  };
}

function parseError(r: McpToolResult): unknown {
  const first = r.content[0];
  if (!first || first.type !== 'text') return null;
  try {
    return (JSON.parse(first.text.split('\n')[0]!) as { error?: unknown }).error ?? null;
  } catch {
    return null;
  }
}
