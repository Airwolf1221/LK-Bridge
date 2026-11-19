/**
 * CR-2026-11 round 3 (approval): shared helpers for the adversarial review of selective approval, "Propose these again"
 * and Resume (ADR 0058 decisions 2 and 3, and the Amendment; ADR 0049 decision 6; ADR 0055). Every attack runs against
 * the mock LegendKeeper of the existing test worlds (test/packs/rename-world.ts, test/packs/world.ts, ...); nothing
 * here touches a live system.
 */
import { expect } from 'vitest';
import type { MockRequest, MockResponse } from '../../contract/mock-lk.js';
import type { RenameWorld } from '../../packs/rename-world.js';
import type { PackWorld } from '../../packs/world.js';
import type { JobOrigin } from '../../../src/jobs/types.js';
import { C, PROJECT } from '../../packs/rename-world.js';

export { PROJECT };

type Obj = Record<string, unknown>;
type AnyWorld = RenameWorld | PackWorld;

export const OLD = 'Nadira al-Khalid';
export const NEW = 'Laila al-Khalid';

/** The dashboard's origin for the owner's Resume (as test/packs/resume.test.ts gives it). */
export const OWNER_ORIGIN = {
  kind: 'ui',
  client: 'owner',
  tool: 'job.resume',
  principal: { principalId: 'system', profile: 'owner', label: 'owner' },
} as unknown as JobOrigin;

/** The dashboard's origin for "Propose these again" (as the admin action gives it). */
export const reproposeOrigin = (id: string) =>
  ({
    kind: 'ui',
    client: 'owner',
    tool: 'proposal.repropose',
    detail: `repropose:${id}`,
  }) as unknown as JobOrigin;

/** Runs `fn` on each request matching `method` and `path`, before the mock answers it (first in line). */
export function intercept(
  w: AnyWorld,
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
  const ws = w as unknown as { overrides: Map<RegExp, (req: MockRequest) => MockResponse | undefined> };
  const rest = [...ws.overrides.entries()];
  ws.overrides.clear();
  ws.overrides.set(new RegExp('.'), hook);
  for (const [re, f] of rest) ws.overrides.set(re, f);
  return { count: () => n, off: () => (on = false) };
}

/** An edit in the app: a block's text replaced, the document's version moved on. */
export function outsideEdit(w: RenameWorld, pageId: string, blockId: string, text: string): void {
  const doc = w.repo.blocks.get(w.mainOf(pageId))!;
  const b = (doc.blocks as Obj[]).find((x) => x.id === blockId)!;
  b.content = [{ text }];
  doc.version += 1;
}

/** A block's plain text (a mention by its label). */
export const textOf = (w: RenameWorld, pageId: string, blockId: string): string => {
  const block = (w.repo.blocks.get(w.mainOf(pageId))!.blocks as Obj[]).find((x) => x.id === blockId)!;
  return ((block.content as Obj[] | undefined) ?? [])
    .map((r) => {
      if (typeof r.text === 'string') return r.text;
      const label = (r.mention as Obj | undefined)?.text;
      return typeof label === 'string' ? label : '';
    })
    .join('');
};

/** Proposes Nadira al-Khalid's rename to Laila al-Khalid (a canonical proposal made of items). */
export async function proposeRename(w: RenameWorld, more: Obj = {}): Promise<string> {
  const r = await w.call('arkona_rename', { subject: C.nadira, newName: NEW, given: 'Laila', ...more });
  expect(r.body.status, r.text).toBe('proposal_captured');
  return String(r.body.proposalId);
}

/** Waits until a job has stopped (succeeded, failed or cancelled). */
export async function settle(w: AnyWorld, jobId: string) {
  for (let i = 0; i < 1500; i++) {
    const j = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
    if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the job did not settle');
}

/** Waits until an approved proposal's job has stopped. */
export async function finished(w: AnyWorld, proposalId: string) {
  const policy = w.stack.runtime.policy;
  for (let i = 0; i < 1500; i++) {
    const p = policy.proposals.get(proposalId)!;
    if (p.state === 'conflicted') return { proposal: p, job: undefined };
    const job = p.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : undefined;
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return { proposal: p, job };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the proposal did not finish');
}

/** The ids of a proposal's items, with their ticks. */
export function itemsOf(w: AnyWorld, proposalId: string) {
  return w.stack.runtime.policy.proposals.itemsOf(proposalId)!;
}

/** Approves a proposal (as canon when it needs it) with an explicit selection. */
export async function approveItems(w: AnyWorld, proposalId: string, items: readonly string[]) {
  const policy = w.stack.runtime.policy;
  const p = policy.proposals.get(proposalId)!;
  if (p.requiresCanonicalApproval) await policy.commands.approveAsCanon('owner', proposalId, { items });
  else await policy.commands.approve('owner', proposalId, { items });
  return finished(w, proposalId);
}

/** The error a call throws or rejects with (or `undefined` when it resolves). */
export async function rejection(
  f: (() => unknown) | Promise<unknown>,
): Promise<(Error & { code?: string; details?: Obj }) | undefined> {
  try {
    await (typeof f === 'function' ? f() : f);
    return undefined;
  } catch (e) {
    return e as Error & { code?: string; details?: Obj };
  }
}

/** The writes (non-GET requests) the mock received to a path matching `re`. */
export const writesTo = (w: AnyWorld, re: RegExp) =>
  w.stack.mock.calls.filter((c) => c.method !== 'GET' && re.test(c.path.replace(/\/$/, ''))).length;
