/**
 * The test world for the Resources, Documents and character tools (v2 C2b): C2a's facts world (the REAL server, runtime,
 * MCP transport, policy and engine; chunk 1's mock LegendKeeper with A2's resource model and C2a's faithful sidebar
 * model, with LegendKeeper's different row orders), plus:
 *
 * - the templates the tools copy, each with a sidebar in the model: `[INDEX] AI Index`, `[BSRC] AI Character Core`,
 *   `[BSRC] AI Compact Character Reference`, `[BSRC] AI General Source` (PROPERTIES with a Status row, and two link
 *   collections) and `[BSRC] AI Note` (PROPERTIES without a Status row); listed by `listTemplates`;
 * - a template copy as LegendKeeper makes it: the resource (A2's model) and its sidebar copied with NEW property, row
 *   and item ids and the same ranks, answered by `createResourceFromTemplate` and every later read;
 * - the Character type with its Index, Core and Compact templates, and its taxonomy seeded from the tree and reviewed
 *   (Beastkin, Foxians, Qishen, Elves, Moon Elves, Humans; Undetermined / Unknown reserved).
 */
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { factsWorld, CORE_TEMPLATE, SidebarModel, type FactsWorld, type MSidebar } from '../facts/world.js';
import { ROOT } from '../discover/world.js';
import { PROJECT, type ToolCall } from '../tools/helpers.js';

export { CORE_KEYS, CORE_TEMPLATE, P, kvText, SidebarModel } from '../facts/world.js';

export const T = {
  index: 'tplindex',
  core: CORE_TEMPLATE,
  compact: 'tplcomp1',
  general: 'tplgen01',
  note: 'tplnote1',
} as const;

export const INDEX_KEYS = ['Reference Type', 'Index Scope', 'Status'];
export const COMPACT_KEYS = [
  'Reference Type',
  'Subject',
  'Race / Species',
  'Status',
  'Canonical Display Name',
  'Scope',
];
export const GENERAL_KEYS = ['Reference Type', 'Scope', 'Status', 'Continuity Type'];

export interface ResourcesWorld extends FactsWorld {
  readonly characterTypeId: string;
}

/**
 * v2 C2c (ADR 0035): the lifecycle indexes of the C2b test world, as the owner added them to the test world to match
 * Arkona: `[INDEX] Working` and `[INDEX] Archived` directly under the AI REPOSITORY (found by name, never by id or
 * position: the tests confirm them through the dashboard's lookup, as the owner does).
 */
export const LIFECYCLE = { working: 'working1', archived: 'archive1' } as const;

let copies = 0;
const fresh = (p: string) => `${p}${(++copies).toString(36).padStart(7 - p.length + 1, '0')}`.slice(0, 8);

/** Copies a template's modelled sidebar onto a new page: new ids, the same ranks, keys, values and items. */
function copySidebar(sb: SidebarModel, templateId: string, pageId: string): void {
  const t = sb.pages.get(templateId);
  if (!t) return;
  const copy: MSidebar = {
    version: 1,
    props: t.props.map((p) => ({
      ...structuredClone(p),
      id: fresh('q'),
      ...(p.rows ? { rows: p.rows.map((r) => ({ ...structuredClone(r), id: fresh('w') })) } : {}),
      ...(p.items ? { items: p.items.map((i) => ({ ...structuredClone(i), id: fresh('j') })) } : {}),
    })),
  };
  sb.pages.set(pageId, copy);
}

export async function resourcesWorld(
  o: Parameters<typeof factsWorld>[0] & {
    /** v2 C2c: confirm the two lifecycle indexes in the project's settings (default true). */
    readonly confirmLifecycle?: boolean;
  } = {},
): Promise<ResourcesWorld> {
  const w = (await factsWorld({
    ...o,
    seed: (world) => {
      world.repo.seed({ id: LIFECYCLE.working, name: '[INDEX] Working', parentId: ROOT });
      world.repo.seed({ id: LIFECYCLE.archived, name: '[INDEX] Archived', parentId: ROOT });
      o.seed?.(world);
    },
  })) as ResourcesWorld & { characterTypeId: string };
  const sb = w.sidebars;
  // The templates (outside the root, as templates are), with their sidebars.
  const tpl = (id: string, name: string) => w.repo.seed({ id, name, parentId: null, props: false });
  tpl(T.index, '[INDEX] AI Index');
  tpl(T.compact, '[BSRC] AI Compact Character Reference');
  tpl(T.general, '[BSRC] AI General Source');
  tpl(T.note, '[BSRC] AI Note');
  const blank = (keys: string[]) => keys.map((k) => [k, ''] as [string, string]);
  sb.page(T.index, [SidebarModel.kv('kvtplidx', 'PROPERTIES', blank(INDEX_KEYS))]);
  sb.page(T.compact, [SidebarModel.kv('kvtplcmp', 'PROPERTIES', blank(COMPACT_KEYS))]);
  sb.page(T.general, [
    SidebarModel.kv('kvtplgen', 'PROPERTIES', blank(GENERAL_KEYS)),
    SidebarModel.links('deptplgn', 'Dependencies', []),
    SidebarModel.links('reltplgn', 'Related Sources', []),
    { id: 'tagstplg', kind: 'unsupported', title: 'TAGS' },
  ]);
  sb.page(T.note, [SidebarModel.kv('kvtplnot', 'PROPERTIES', blank(['Reference Type', 'Scope']))]);
  const templates = [
    { id: T.index, name: '[INDEX] AI Index Template' },
    { id: T.core, name: '[BSRC] AI Character Core Template' },
    { id: T.compact, name: '[BSRC] AI Compact Character Reference Template' },
    { id: T.general, name: '[BSRC] AI General Source Template' },
    { id: T.note, name: '[BSRC] AI Note Template' },
  ];
  w.overrides.set(/\/templates$/, (req) =>
    req.method === 'GET'
      ? {
          status: 200,
          body: {
            data: templates.map((t) => ({ ...t, parentId: 'templates' })),
            hasMore: false,
            nextCursor: null,
          },
        }
      : undefined,
  );
  // A template copy: the resource (A2's model), then its sidebar copied with new ids (as LegendKeeper does).
  w.overrides.set(/\/resources\/from-template$/, (req: MockRequest): MockResponse | undefined => {
    if (req.method !== 'POST') return undefined;
    const r = w.repo.respond(req);
    if (!r || r.status !== 201) return r;
    const body = req.body as { templateId: string; id?: string };
    const id = (r.body as { id: string }).id;
    copySidebar(sb, body.templateId, id);
    const view = w.repo.resourceView(w.repo.live(id)!);
    return {
      status: 201,
      body: {
        ...view,
        properties: sb.pages.get(id)?.props.map((p) => sb.propView(p, sb.pages.get(id)!)) ?? [],
      },
    };
  });

  // The Character type: its Index, Core and Compact templates, and its taxonomy seeded and reviewed.
  const reg = w.stack.runtime.registry.forProject(PROJECT);
  const type = reg.store.listTypes().find((t) => t.singular === 'Character')!;
  reg.commands.updateType('owner', type.id, {
    indexTemplateId: T.index,
    pageTemplates: [
      { role: 'core', templateId: T.core },
      { role: 'compact', templateId: T.compact },
    ],
    reviewed: true,
  });
  await reg.commands.refreshTemplates('owner');
  reg.commands.seedTaxonomy('owner', type.id);
  for (const e of reg.store.entries(type.id)) reg.commands.updateEntry('owner', e.id, { reviewed: true });
  w.characterTypeId = type.id;
  if (o.confirmLifecycle !== false) confirmLifecycle(w);
  return w;
}

/** v2 C2c: as the owner does on the dashboard: find the two lifecycle indexes by name, then confirm what was found. */
export function confirmLifecycle(w: FactsWorld): void {
  const lc = w.stack.runtime.lifecycle;
  const found = lc.find(PROJECT);
  if (found.working.status !== 'found' || found.archived.status !== 'found') {
    throw new Error(`lifecycle indexes not found: ${JSON.stringify(found)}`);
  }
  lc.update('owner', PROJECT, {
    workingIndexId: found.working.node!.id,
    archiveIndexId: found.archived.node!.id,
  });
}

/** The key-value rows of a page in the sidebar model, as LegendKeeper shows them (by rank): `key=value`. */
export function facts(w: FactsWorld, page: string): string[] {
  return w.sidebars.rows(page).map((r) => `${r.key}=${r.text}`);
}

/** The display names of a parent's children in the model, in rank order. */
export function childNames(w: FactsWorld, parentId: string): string[] {
  return [...w.repo.res.values()]
    .filter((r) => r.parentId === parentId && r.deletedAt === null)
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((r) => r.name);
}

/**
 * v2 C2c: an Authoritative create is canon, so it is a canonical proposal at every scope. As the owner does, this
 * accepts it as canon, waits for it to run, and answers as a direct write would (`written`, `verified`, the job).
 */
export async function asCanon(w: FactsWorld, r: ToolCall): Promise<ToolCall> {
  if (r.body.status !== 'proposal_captured') return r;
  const id = String(r.body.proposalId);
  await w.stack.runtime.policy.commands.approveAsCanon('owner', id);
  const proposals = w.stack.runtime.policy.proposals;
  for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals.get(id)!.state); i++)
    await new Promise((res) => setTimeout(res, 20));
  const p = proposals.get(id)!;
  const job = p.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : null;
  const res = (job?.result ?? {}) as {
    verified?: boolean;
    verification?: { targets?: { label?: string; factsVersion?: string }[] };
  };
  const factsVersions = Object.fromEntries(
    (res.verification?.targets ?? [])
      .filter((t) => typeof t.factsVersion === 'string' && typeof t.label === 'string')
      .map((t) => [t.label!, t.factsVersion!]),
  );
  return {
    ...r,
    body: {
      ...r.body,
      status: job?.status === 'succeeded' ? 'written' : (job?.status ?? p.state),
      verified: res.verified ?? null,
      ...(Object.keys(factsVersions).length > 0 ? { factsVersions } : {}),
      jobId: p.jobId,
      proposalId: id,
      ...(job?.lastError ? { error: job.lastError } : {}),
      ...(res.verified === false ? { verification: res.verification } : {}),
    },
  };
}
