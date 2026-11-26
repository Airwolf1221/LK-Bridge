/**
 * CR-2026-11 round 2 (packs): shared helpers for the adversarial review of the setting packs and the appraisal tools.
 * Every attack runs against the mock LegendKeeper of the existing test worlds (test/packs/world.ts,
 * test/packs/owners-world.ts, test/appraisal/world.ts); nothing here touches a live system.
 */
import type { ToolCall } from '../../tools/helpers.js';
import type { PackWorld } from '../../packs/world.js';
import { PROJECT } from '../../tools/helpers.js';

export { PROJECT };

/** A page body that satisfies the pack's text rules (Purpose first, the boundary sections last). */
export const body = (md: string, more = ''): string =>
  `## Purpose\n\n${md}\n\n${more}## Source Boundaries\n\nThis page only.\n\n## Unresolved Material\n\nNone.\n`;

/** A full identity for a new character (the six gated fields). */
export const ident = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  givenName: 'Ren',
  surname: 'Asagiri',
  race: 'Foxian',
  namingCulture: 'Fujimatsuan',
  lifeState: 'Alive at 5A 931',
  temporalScope: '5A 900 - 5A 931',
  ...over,
});

/** A developed (index + Core) character package. */
export function developed(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    depth: 'developed',
    identity: ident(),
    pages: [{ role: 'core', scope: 'A shrine guard', markdown: body(`The Core of ${name}.`) }],
    project: 'test',
    ...over,
  };
}

/**
 * An agent connection at scope `write` (as a new profile on the bridge has it), as the
 * brief asks (`stack.newToken(label, 'write')`).
 */
export async function writeAgent(
  w: PackWorld,
  label = 'r2-agent',
): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolCall>> {
  const { token } = w.stack.newToken(label, 'write');
  const client = await w.stack.connect(token);
  return (name, args) => w.stack.call(client, name, args);
}

/** Every live page of the mock with this exact name. */
export const liveNamed = (w: PackWorld, name: string) =>
  [...w.repo.res.values()].filter((r) => r.deletedAt === null && r.name === name);

/** The error object of a refused tool call. */
export const err = (r: ToolCall): Record<string, unknown> =>
  (r.body.error as Record<string, unknown> | undefined) ?? {};

/** Waits for a job to finish (succeeded, failed or cancelled). */
export async function settle(w: PackWorld, jobId: string, ms = 30_000) {
  return w.stack.runtime.engine.wait(PROJECT, jobId, ms);
}

/** Every LegendKeeper write request the mock has seen since `from` (method and path). */
export function writesSince(w: PackWorld, from: number): { method: string; path: string }[] {
  return w.stack.mock.calls
    .slice(from)
    .filter((r) => r.method !== 'GET')
    .map((r) => ({ method: r.method, path: r.path }));
}

/** The mock's request count now (for `writesSince`). */
export const callsNow = (w: PackWorld): number => w.stack.mock.calls.length;
