/**
 * CR-2026-11 round 2, "break Revert" (ADR 0055 decision B): shared helpers for the adversarial tests in this directory.
 * Every test runs against the mock LegendKeeper in this repository; nothing here reaches a live system.
 */
import type { Client } from '@modelcontextprotocol/client';
import type { Stack } from '../../tools/helpers.js';
import { PROJECT } from '../../tools/helpers.js';

export { PROJECT };

/** The job id a write tool answered with. */
export const jobOf = (r: { body: Record<string, unknown> }): string =>
  typeof r.body.jobId === 'string' ? r.body.jobId : String((r.body.job as { id?: string } | undefined)?.id);

/** An agent at scope `write` (default rails), with the low-level tools shown. */
export async function writeAgent(
  stack: Stack,
  label: string,
): Promise<{ client: Client; profileId: string }> {
  const t = stack.newToken(label, 'write');
  stack.runtime.policy.commands.setShowLowLevelTools('owner', t.profileId, true);
  return { client: await stack.connect(t.token), profileId: t.profileId };
}

/** Reverts a job as the owner (the service the admin route calls after re-authentication) and waits for its job. */
export async function revertAndWait(stack: Stack, jobId: string, confirmPartial = false) {
  const rt = stack.runtime;
  const r = await rt.reverts.revert('owner', PROJECT, jobId, { confirmPartial });
  if (r.status !== 'submitted') return { r, job: null };
  const job = await rt.engine.wait(PROJECT, r.revertJobId, 25_000);
  return { r, job };
}

export const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Waits until `fn` is true (or the time is up). */
export async function until(fn: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  return fn();
}
