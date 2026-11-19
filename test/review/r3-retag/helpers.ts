/**
 * CR-2026-11 round 3 (retagging, ADR 0060): shared helpers for the adversarial review of `arkona_retag_audit`
 * and `arkona_retag_apply`. Every attack runs against the mock LegendKeeper of the appraisal world (the REAL
 * server, runtime, MCP transport, policy and engine; test/appraisal/world.ts), with this review's own fixture
 * pages seeded beside the world's; nothing here touches a live system.
 *
 * - `CTX` / `page`: the pure engine's context and a page input, as test/packs/retag-engine.test.ts builds them
 *   (copied, so importing them does not import that file's tests).
 * - `r3World`: the appraisal world with the retag rules approved (lifecycle tag leads), plus `seed` pages of our own,
 *   `approveRetag` (a new approved version with changed rules: routine tags, token maps, batch size, tool switches) and
 *   `failNext` (one injected 400, as the retag world's).
 */
import { ROOT } from '../../discover/world.js';
import { appraisalWorld, type AppraisalWorld } from '../../appraisal/world.js';
import { approve } from '../../packs/world.js';
import { PROJECT } from '../../tools/helpers.js';
import { ARKONA_PACK } from '../../../src/packs/arkona.js';
import type { RetagContext, RetagPageInput } from '../../../src/packs/retag/engine.js';
import type { PackRules } from '../../../src/packs/types.js';
import type { MockRequest, MockResponse } from '../../contract/mock-lk.js';

export { PROJECT, ROOT, approve };

// ============================================================================================ the pure engine

export const RULES: PackRules = ARKONA_PACK.rules;

export const CTX: RetagContext = {
  rules: RULES,
  lifecycle: {
    status: { authoritative: 'Authoritative', working: 'Working', archived: 'Archived' },
    tags: { canon: 'CANON', working: 'Working', archived: 'Archived' },
    fields: { status: 'Status', continuityType: 'Continuity Type' },
  },
  tagRules: { position: 'lead', au: { continuityType: 'AU', tag: 'AU' }, source: null },
  referenceTypeRow: 'Reference Type',
  governanceIds: new Set(['govpage1']),
};

/** The same lifecycle settings, as the guard reads them (`statusTagChanges` takes a LifecycleConfig). */
export const LC = {
  tags: { canon: 'CANON', working: 'Working', archived: 'Archived' },
} as const;

const facts = (f: Record<string, string | string[]>) =>
  new Map(
    Object.entries(f).map(([k, v]) => [
      k.toLowerCase(),
      { text: Array.isArray(v) ? v[0]! : v, count: Array.isArray(v) ? v.length : 1 },
    ]),
  );

export const CANON_FACTS = {
  Status: 'Authoritative',
  'Continuity Type': 'CANON',
  Continuity: 'Main',
  Inheritance: 'None',
};

export type PageSpec = Partial<Omit<RetagPageInput, 'facts'>> & {
  facts?: Record<string, string | string[]>;
};

export function page(o: PageSpec): RetagPageInput {
  return {
    id: o.id ?? 'page0001',
    rawName: o.rawName ?? '[BSRC] Test - Polity Reference',
    kind: o.kind ?? 'bsrc',
    tags: o.tags ?? [],
    facts: facts({ ...CANON_FACTS, ...(o.facts ?? {}) }),
    lifecycle: o.lifecycle ?? null,
    ancestors: o.ancestors ?? ['AI REPOSITORY'],
    area: o.area ?? null,
    templateId: o.templateId ?? null,
    packRecord: o.packRecord ?? null,
    owner: o.owner ?? null,
  };
}

export const polity = (tags: string[], more: PageSpec = {}) =>
  page({ ...more, tags, facts: { 'Reference Type': 'Polity Reference', ...(more.facts ?? {}) } });

export const core = (
  tags: string[],
  race: string | string[],
  culture: string | string[],
  more: PageSpec = {},
) =>
  page({
    rawName: '[BSRC] Otheiralth - Character Core',
    ...more,
    tags,
    facts: {
      'Reference Type': 'Character Core',
      'Race / Species': race,
      'Naming Culture': culture,
      ...(more.facts ?? {}),
    },
  });

/** Rules with the retag section and the token maps changed (as an owner-approved version would carry them). */
export function rulesWith(o: {
  readonly routine?: readonly string[];
  readonly race?: Readonly<Record<string, string>>;
  readonly culture?: Readonly<Record<string, string>>;
}): PackRules {
  return {
    ...RULES,
    tags: {
      ...RULES.tags,
      ...(o.race ? { race: { ...RULES.tags.race, ...o.race } } : {}),
      ...(o.culture ? { culture: { ...RULES.tags.culture, ...o.culture } } : {}),
    },
    retag: { ...RULES.retag!, ...(o.routine ? { excludedRoutineTags: [...o.routine] } : {}) },
  };
}

// ============================================================================================ the world

export const CANON_ROWS: [string, string][] = [
  ['Status', 'Authoritative'],
  ['Continuity Type', 'CANON'],
  ['Continuity', 'Main'],
  ['Inheritance', 'None'],
];

/** The appraisal world's Legacy Canon Archive index (an excluded area of the retag). */
export const LEGACY_INDEX = 'legacyix';

export interface SeedPage {
  readonly id: string;
  readonly name: string;
  readonly tags: string[];
  readonly referenceType?: string;
  readonly rows?: [string, string][];
  readonly parentId?: string;
}

export interface R3World extends AppraisalWorld {
  /** The review's desk (an index under the root) every seeded page sits under, unless it names another parent. */
  readonly desk: string;
  /** A new approved pack version with these retag rules (as the owner would approve it). */
  approveRetag(o?: {
    readonly routine?: readonly string[];
    readonly batchSize?: number;
    readonly race?: Readonly<Record<string, string>>;
    readonly culture?: Readonly<Record<string, string>>;
    readonly tools?: Readonly<Record<string, 'propose' | 'scope'>>;
  }): void;
  /** The n-th (0-based) next request matching method and path fails once with a 400. */
  failNext(method: string, path: RegExp, n?: number): void;
}

export const DESK = 'r3desk01';

export async function r3World(pages: readonly SeedPage[]): Promise<R3World> {
  const w = await appraisalWorld({
    retag: true,
    seed: (world) => {
      const r = world.repo;
      r.seed({ id: DESK, name: '[INDEX] R3 Retag Desk', parentId: ROOT });
      for (const p of pages) {
        r.seed({
          id: p.id,
          name: p.name,
          parentId: p.parentId ?? DESK,
          tags: p.tags,
          referenceType: p.referenceType ?? 'Polity Reference',
        });
        for (const [k, v] of p.rows ?? CANON_ROWS) r.outside.setRow(p.id, k, v);
      }
    },
  });
  const approveRetag: R3World['approveRetag'] = (o = {}) => {
    const packs = w.stack.runtime.packs;
    const pack = packs.get('arkona')!;
    const base =
      pack.approved?.version === pack.version
        ? pack.rules
        : packs.store.rulesAt('arkona', pack.approved!.version)!;
    const next = packs.store.newVersion(
      'arkona',
      {
        ...base,
        lifecycleTagPosition: { arkona: 'lead', test: 'lead' },
        tags: {
          ...base.tags,
          ...(o.race ? { race: { ...base.tags.race, ...o.race } } : {}),
          ...(o.culture ? { culture: { ...base.tags.culture, ...o.culture } } : {}),
        },
        settings: {
          ...base.settings,
          ...(o.tools ? { tools: { ...(base.settings.tools ?? {}), ...o.tools } } : {}),
        },
        retag: {
          ...(base.retag ?? ARKONA_PACK.rules.retag!),
          excludedRoutineTags: [...(o.routine ?? ['Imported'])],
          ...(o.batchSize !== undefined ? { batchSize: o.batchSize } : {}),
        },
      },
      'test: r3 retag rules',
    );
    packs.store.approve('arkona', {
      version: next.version,
      at: Date.now(),
      by: 'owner',
      sources: pack.approved?.sources ?? [],
    });
  };
  approveRetag();
  const failNext = (method: string, path: RegExp, n = 0) => {
    let seen = 0;
    let fired = false;
    const fn = (req: MockRequest): MockResponse | undefined => {
      if (fired || req.method !== method || !path.test(req.path.replace(/\/$/, ''))) return undefined;
      if (seen++ !== n) return undefined;
      fired = true;
      return {
        status: 400,
        body: {
          message: 'model VALIDATION_ERROR (injected)',
          code: 'VALIDATION_ERROR',
          requestId: 'r3-injected',
        },
      };
    };
    const rest = [...w.overrides.entries()];
    w.overrides.clear();
    w.overrides.set(/./, fn);
    for (const [re, f] of rest) w.overrides.set(re, f);
  };
  return Object.assign(w, { desk: DESK, approveRetag, failNext });
}

// ============================================================================================ tool calls

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool JSON, as the tools return it
type Obj = Record<string, any>;

export async function audit(w: R3World, args: Record<string, unknown>): Promise<Obj> {
  const r = await w.callRead('arkona_retag_audit', { project: 'test', limit: 200, ...args });
  if (r.isError) throw new Error(`audit refused: ${r.text}`);
  return r.body as Obj;
}

export const byId = (body: Obj): Map<string, Obj> =>
  new Map<string, Obj>((body.pages as Obj[]).map((p) => [p.pageId as string, p]));

/** Proposes a batch of a run; returns the tool's body (throws when refused). */
export async function propose(w: R3World, runId: string, pages: readonly string[]): Promise<Obj> {
  const r = await w.call('arkona_retag_apply', { project: 'test', runId, pages });
  if (r.isError || r.body.status !== 'proposal_captured') throw new Error(`apply refused: ${r.text}`);
  return r.body as Obj;
}

/** The batch a proposal made, with its dispositions. */
export const batchOf = (w: R3World, proposalId: string) =>
  w.stack.runtime.retag.store.batchByProposal(proposalId);

/** The mock's current tags of a page. */
export const tagsOf = (w: R3World, id: string): string[] => [...w.repo.res.get(id)!.tags];

/** Waits until a job has ended. */
export async function settle(w: R3World, jobId: string): Promise<void> {
  for (let i = 0; i < 1500; i++) {
    const j = w.stack.runtime.engine.queries.getJob(PROJECT, jobId);
    if (j && ['succeeded', 'failed', 'cancelled'].includes(j.status)) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`job ${jobId} did not end`);
}

/** Every write the mock answered for one page since a call index (method and path). */
export const writesTo = (w: R3World, id: string, from = 0) =>
  w.stack.mock.calls
    .slice(from)
    .filter((c) => c.method !== 'GET' && c.path.replace(/\/$/, '').endsWith(`/resources/${id}`));
