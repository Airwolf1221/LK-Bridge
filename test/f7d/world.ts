/**
 * v3 F7d (ADR 0077): the world of the groups tests. The owners' world (the mock LegendKeeper with the Arkona pack), its
 * Character Art template given the sidebar the real one has (the identity copies, Temporal Scope, Visual State /
 * Period), and helpers to stage images, call the tool, approve (whole or item by item) and read the Art page back.
 */
import { expect } from 'vitest';
import { fixture } from '../images/world.js';
import { ownersWorld, PROJECT, TPL, type OwnersWorld } from '../packs/owners-world.js';
import { SidebarModel } from '../resources/world.js';

export { PROJECT };

/** The real Character Art template's rows (the evidence of 24 November 2026: Soraya's and Iuno's Art pages). */
export const ART_KEYS = [
  'Status',
  'Continuity Type',
  'Continuity',
  'Inheritance',
  'Subject',
  'Canonical Display Name',
  'Family / Surname',
  'Personal / Given Name',
  'Naming Culture',
  'Aliases',
  'Reference Type',
  'Scope',
  'Temporal Scope',
  'Visual State / Period',
  'Last Major Revision',
  'Supersedes',
];

export async function f7dWorld(): Promise<OwnersWorld> {
  const w = await ownersWorld();
  w.sidebars.page(TPL.art, [
    SidebarModel.kv(
      'kvtart0',
      'PROPERTIES',
      ART_KEYS.map((k) => [k, ''] as [string, string]),
    ),
    SidebarModel.links('dptart0', 'Dependencies', []),
    SidebarModel.links('rltart0', 'Related Sources', []),
    { id: 'tgtart0', kind: 'unsupported' as const, title: 'TAGS' },
  ]);
  return w;
}

const FILES = ['alpha.png', 'orientation-6.jpg', 'already.webp', 'png-named.jpg', 'animated.gif'];
let nth = 0;

/** A distinct staged image each time. */
export async function stage(w: OwnersWorld): Promise<string> {
  const file = FILES[nth % FILES.length]!;
  const r = await w.call('upload_image', {
    data_base64: fixture(file).toString('base64'),
    name: `f7d stage ${nth}`,
    stage: true,
    deduplicate: false,
    operation_id: `f7d-stage-${nth++}`,
    project: 'test',
  });
  expect(r.isError, r.text).toBe(false);
  return String(r.body.staged_id);
}

export const img = (id: string, label: string) => ({
  staged_id: id,
  label,
  interpretation: `What ${label} establishes.`,
});

/** The approved proposal's outcome (whole, or the items given). */
export async function approveItems(
  w: OwnersWorld,
  proposalId: string,
  items?: string[],
): Promise<{
  state: string;
  job: ReturnType<OwnersWorld['stack']['runtime']['engine']['queries']['getJob']>;
}> {
  const policy = w.stack.runtime.policy;
  const p0 = policy.proposals.get(proposalId)!;
  if (p0.requiresCanonicalApproval)
    await policy.commands.approveAsCanon('owner', proposalId, items ? { items } : {});
  else await policy.commands.approve('owner', proposalId, items ? { items } : {});
  for (let i = 0; i < 1000; i++) {
    const p = policy.proposals.get(proposalId)!;
    if (['executed', 'failed', 'conflicted'].includes(p.state)) {
      const job = p.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : undefined;
      if (job && !['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      return { state: p.state, job };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the proposal did not finish');
}

/** A page's live Main blocks. */
export function blocksOf(
  w: OwnersWorld,
  pageId: string,
): { kind: string; level?: number; content?: { text?: string }[]; url?: string; alt?: string }[] {
  const main = w.repo.liveDocs(w.repo.res.get(pageId)!).find((d) => d.name === 'Main')!;
  return (w.repo.blocks.get(main.id)?.blocks ?? []) as never;
}

export const headingsOf = (w: OwnersWorld, pageId: string) =>
  blocksOf(w, pageId)
    .filter((b) => b.kind === 'heading')
    .map((b) => `${b.level}:${(b.content ?? []).map((r) => r.text ?? '').join('')}`);

/** A live page by its exact name. */
export const pageNamed = (w: OwnersWorld, name: string) =>
  [...w.repo.res.values()].find((r) => r.deletedAt === null && r.name === name);

/** A page's row (by key) as the mock's sidebar holds it: its text, or null when the page has no such row. */
export function rowOf(w: OwnersWorld, pageId: string, key: string): string | null {
  const sb = w.sidebars.pages.get(pageId);
  const kv = sb?.props.find((p) => p.kind === 'keyValue');
  const row = (kv as { rows?: { key: string; content: { text?: string }[] }[] } | undefined)?.rows?.find(
    (r) => r.key === key,
  );
  return row ? row.content.map((c) => c.text ?? '').join('') : null;
}

/** The pages a link collection (by title) of a page names. */
export function linksOf(w: OwnersWorld, pageId: string, title: string): string[] {
  const sb = w.sidebars.pages.get(pageId);
  const p = sb?.props.find((x) => x.title === title) as { items?: { resourceId: string }[] } | undefined;
  return (p?.items ?? []).map((i) => i.resourceId);
}

/** Sets one row of a page's key-value property in the mock, as an edit in the app (the version moves on). */
export function setRowOf(w: OwnersWorld, pageId: string, key: string, text: string): void {
  const sb = w.sidebars.pages.get(pageId)!;
  const kv = sb.props.find((p) => p.kind === 'keyValue') as { rows: { key: string; content: unknown[] }[] };
  const row = kv.rows.find((r) => r.key === key)!;
  row.content = text === '' ? [] : [{ text }];
  sb.version++;
}
