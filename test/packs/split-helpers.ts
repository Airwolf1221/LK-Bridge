/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3e (ADR 0059): what the split tests share: proposing, approving (whole or by items), following a job to its end,
 * the pages' bodies and sidebars as the mock LegendKeeper holds them, and the split's record.
 */
import { expect } from 'vitest';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { PUBLIC_URL } from '../tools/helpers.js';
import { PROJECT, type SplitWorld } from './split-world.js';
import type { JobOrigin } from '../../src/jobs/types.js';

export type Obj = Record<string, unknown>;

export const OWNER_ORIGIN = {
  kind: 'ui',
  client: 'owner',
  tool: 'job.resume',
  principal: { principalId: 'system', profile: 'owner', label: 'owner' },
} as unknown as JobOrigin;

/** `arkona_split_owner` at the default (write) scope. */
export const split = (w: SplitWorld, args: Obj) => w.call('arkona_split_owner', { project: 'test', ...args });

/** The first refusal with `code` in a refused call (each refusal carries its own lists). */
export function refusal(r: { isError?: boolean; body: any; text: string }, code: string): any {
  expect(r.isError, r.text).toBe(true);
  const all = (r.body.error.refusals ?? [r.body.error]) as any[];
  const hit = all.find((x) => x.code === code);
  expect(hit, `${code} in ${all.map((x) => x.code).join(', ')}`).toBeTruthy();
  return hit;
}

export async function settle(w: SplitWorld, jobId: string) {
  for (let i = 0; i < 1000; i++) {
    const j = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
    if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the job did not settle');
}

/** Approves a proposal (as canon when it asks for it), optionally only `items`, and follows its job to the end. */
export async function approveSplit(w: SplitWorld, proposalId: string, items?: readonly string[]) {
  const policy = w.stack.runtime.policy;
  const p0 = policy.proposals.get(proposalId)!;
  const opts = items ? { items } : undefined;
  if (p0.requiresCanonicalApproval) await policy.commands.approveAsCanon('owner', proposalId, opts);
  else await policy.commands.approve('owner', proposalId, opts);
  for (let i = 0; i < 1000; i++) {
    const p = policy.proposals.get(proposalId)!;
    if (p.jobId) {
      const job = await settle(w, p.jobId);
      return { jobId: p.jobId, job };
    }
    if (['failed', 'conflicted', 'rejected'].includes(p.state))
      throw new Error(`the proposal ended ${p.state}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the proposal did not start');
}

/**
 * `approveSplit`, measuring the job's own requests: counted when its job ends (the bridge's phase 2 proposal starts
 * only after that event, so it is not counted).
 */
export async function approveMeasured(w: SplitWorld, proposalId: string, items?: readonly string[]) {
  const policy = w.stack.runtime.policy;
  const start = w.requests();
  let at: { all: number; writes: number } | null = null;
  const off = w.stack.runtime.engine.events.on('job', (e: { job: { id: string; status: string } }) => {
    if (at) return;
    const jid = policy.proposals.get(proposalId)?.jobId;
    if (jid === e.job.id && ['succeeded', 'failed', 'cancelled'].includes(e.job.status)) at = w.requests();
  });
  try {
    const r = await approveSplit(w, proposalId, items);
    const end = at ?? w.requests();
    return { ...r, cost: { requests: end.all - start.all, writes: end.writes - start.writes } };
  } finally {
    off();
  }
}

/** A split's record, once `until` holds of it (the bridge follows the job's events). */
export async function recordOf(
  w: SplitWorld,
  ref: string,
  until: (r: any) => boolean = () => true,
): Promise<any> {
  const splits = w.stack.runtime.splits;
  for (let i = 0; i < 1000; i++) {
    const r = splits.find(PROJECT, ref);
    if (r && until(r)) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`split ${ref}: not as expected (${JSON.stringify(splits.find(PROJECT, ref))})`);
}

/** A page's main document's top-level blocks, as the mock holds them. */
export const bodyOf = (w: SplitWorld, pageId: string): Obj[] =>
  w.repo.blocks.get(w.mainOf(pageId))!.blocks as Obj[];

export const ids = (blocks: readonly Obj[]) => blocks.map((b) => b.id as string);

/** A block's plain text (a mention as its page id). */
export const textOf = (b: Obj): string =>
  ((b.content as Obj[] | undefined) ?? [])
    .map((r) =>
      typeof r.text === 'string' ? r.text : `@${String((r.mention as Obj | undefined)?.resourceId)}`,
    )
    .join('');

/** The mentions a block holds. */
export const mentionsIn = (b: Obj): string[] =>
  JSON.stringify(b)
    .match(/"resourceId":"([^"]+)"/g)
    ?.map((m) => m.slice('"resourceId":"'.length, -1)) ?? [];

/** A page's link collection (`Dependencies`) as the mock holds it. */
export const linksOf = (w: SplitWorld, pageId: string, title = 'Dependencies'): string[] =>
  (w.sidebars.pages.get(pageId)?.props.find((p) => p.title === title)?.items ?? []).map((i) => i.resourceId);

/** A page's key-value rows (`PROPERTIES`) as the mock holds them. */
export const rowsOf = (w: SplitWorld, pageId: string): Record<string, string> =>
  Object.fromEntries(
    (w.sidebars.pages.get(pageId)?.props.find((p) => p.kind === 'keyValue')?.rows ?? []).map((r) => [
      r.key,
      (r.content as Obj[]).map((c) => (typeof c.text === 'string' ? c.text : '')).join(''),
    ]),
  );

/** A live page by its raw name. */
export const named = (w: SplitWorld, name: string) =>
  [...w.repo.res.values()].find((r) => r.name === name && !r.deletedAt);

/** Runs `fn` on each request matching `method` and `path`, before the mock answers it (first in line). */
export function intercept(
  w: SplitWorld,
  method: string,
  path: RegExp,
  fn: (n: number, req: MockRequest) => MockResponse | undefined,
): { count: () => number; off: () => void } {
  let n = 0;
  let on = true;
  const hook = (req: MockRequest) => {
    if (!on || req.method !== method || !path.test(req.path.replace(/\/$/, ''))) return undefined;
    return fn(n++, req);
  };
  const rest = [...w.overrides.entries()];
  w.overrides.clear();
  w.overrides.set(/./, hook);
  for (const [re, f] of rest) w.overrides.set(re, f);
  return {
    count: () => n,
    off: () => {
      on = false;
    },
  };
}

/** A GET of the dashboard's API as the signed-in owner. */
export async function adminGet(w: SplitWorld, path: string): Promise<{ status: number; json: any }> {
  const s = w.stack.services;
  const session = s.owner.createSession('127.0.0.1', 'vitest');
  const res = await fetch(`${w.stack.base}${path}`, {
    headers: { cookie: `${s.owner.sessionCookie}=${session}`, origin: PUBLIC_URL },
  });
  return { status: res.status, json: await res.json() };
}

/** Today's date as the bridge writes Last Major Revision. */
export const today = () => new Date().toISOString().slice(0, 10);
