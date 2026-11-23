/**
 * `query_facts` (v3 F5c, ADR 0069, H7): field-selective batch reading. It selects pages of the AI REPOSITORY by
 * Reference Type, tag, branch, kind, lifecycle or name (or, with `characters: true`, every current identity page of a
 * continuity) and returns only the named fields, as a compact table: `columns` once, then `rows` as arrays (never one
 * object per row), paged by row; `format: "csv"` gives the same table as CSV text.
 *
 * Free: from the repository tree and the sidebars it stores (the text of each fact). Every answer says how old that is:
 * the tree's last confirmation, and per row its `coverage` (`ok`; `stale`: the tree could not re-read it, or its read is
 * more than 26 hours old; `missing`: its sidebar was never read) and `readAt`, never silently. `live: true` re-reads the
 * page of rows asked for (one `getResource` each, as ONE job), with the estimate first when that is more than 10 reads
 * (`confirm: true` runs it), and only then is `factsVersion` known.
 */
import { createHash } from 'node:crypto';
import * as z from 'zod';
import { lifecycleFrom } from '../../lifecycle/settings.js';
import { treeLabeller } from '../../packs/naming/namesakes.js';
import { textKey } from '../../packs/engine/text.js';
import type { PackRules } from '../../packs/types.js';
import type { SidebarBlock, TreeNode } from '../../tree/index.js';
import type { McpToolProvider } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { factsVersionOfRead } from './discover.js';
import { ago, finish, repoContext, resolvePage, treeInfo, type RepoCtx } from './repo.js';
import {
  errorFromThrown,
  errorResult,
  mcpOrigin,
  projectArg,
  render,
  withProject,
  type ToolDeps,
} from './shape.js';

/** More rows than this re-read live first answer with an estimate. */
export const LIVE_CONFIRM_ABOVE = 10;
/** A stored sidebar read longer ago than this is `stale` (the tree's own "confirmed within 26 hours"). */
export const STALE_AFTER_MS = 26 * 3_600_000;
export const MAX_ROWS = 500;
export const DEFAULT_ROWS = 100;

/** The fields every page has besides its sidebar facts. */
export const BUILTIN_FIELDS = [
  'id',
  'name',
  'canonicalDisplayName',
  'referenceType',
  'scope',
  'tags',
  'parent',
  'path',
  'lastMajorRevision',
  'factsVersion',
] as const;
type Builtin = (typeof BUILTIN_FIELDS)[number];
const BUILTIN: ReadonlySet<string> = new Set(BUILTIN_FIELDS);

const KINDS = ['index', 'bsrc', 'bwrk', 'barc'] as const;
const LIFECYCLES = ['Authoritative', 'Working', 'Archived'] as const;
const MAIN = 'Main CANON';

type Cell = string | readonly string[] | null;
const txt = (v: unknown): string => (typeof v === 'string' ? v : '');

const many = <T extends z.ZodType>(t: T) => z.union([t, z.array(t).min(1).max(50)]);
const asList = <T>(v: T | readonly T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? [...v] : [v as T];

/** A sidebar's facts by key (`PROPERTIES`), as the tree stores them: key (normalised) → text. */
function factMap(sb: readonly SidebarBlock[] | null, property: string): Map<string, string> | null {
  if (!sb) return null;
  const out = new Map<string, string>();
  const kv = sb.find((p) => p.kind === 'keyValue' && textKey(p.title ?? '') === textKey(property));
  for (const r of kv?.rows ?? []) if (!out.has(textKey(r.key))) out.set(textKey(r.key), r.text);
  return out;
}

/** The same from a live getResource answer. */
function liveFactMap(res: unknown, property: string): Map<string, string> {
  const out = new Map<string, string>();
  const props = (res as { properties?: unknown } | null)?.properties;
  if (!Array.isArray(props)) return out;
  const kv = (props as Record<string, unknown>[]).find(
    (p) => p.kind === 'keyValue' && textKey(typeof p.title === 'string' ? p.title : '') === textKey(property),
  );
  const rows = Array.isArray(kv?.rows) ? (kv.rows as Record<string, unknown>[]) : [];
  const rk = (r: Record<string, unknown>) => (typeof r.rank === 'string' ? r.rank : '');
  const sorted = [...rows].sort((a, b) => (rk(a) < rk(b) ? -1 : rk(a) > rk(b) ? 1 : 0));
  for (const r of sorted) {
    const key = typeof r.key === 'string' ? r.key : '';
    if (key === '' || out.has(textKey(key))) continue;
    const text =
      typeof r.text === 'string'
        ? r.text
        : (Array.isArray(r.content) ? (r.content as Record<string, unknown>[]) : [])
            .map((c) => {
              if (typeof c.text === 'string') return c.text;
              const m = c.mention as Record<string, unknown> | undefined;
              return m ? txt(m.text) || txt(m.name) : '';
            })
            .join('');
    out.set(textKey(key), text.trim());
  }
  return out;
}

/** The pack rules a project's character shortcut uses (its approved version), or null. */
function characterRules(ctx: RepoCtx): PackRules | null {
  const packs = ctx.pd.services?.packs;
  if (!packs) return null;
  for (const p of packs.forProject(ctx.projectId)) {
    const rules = packs.approvedRules(p.id);
    if (rules?.types.some((t) => t.hook === 'character')) return rules;
  }
  return null;
}

/** The Reference Types of the identity pages: the identity roles', and the retag's identity-owning Character References. */
export function identityReferenceTypes(rules: PackRules): string[] {
  const type = rules.types.find((t) => t.hook === 'character');
  const roles = (type?.roles ?? [])
    .filter((r) => r.facts === 'identity' && r.referenceType)
    .map((r) => r.referenceType!);
  return [...new Set([...roles, ...(rules.retag?.identityReferenceTypes ?? [])])];
}

/** CSV (RFC 4180): a list cell joined with "; ". */
export function toCsv(columns: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const q = (v: Cell) => {
    const s = v === null ? '' : Array.isArray(v) ? v.join('; ') : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => q(c)).join(','), ...rows.map((r) => r.map(q).join(','))].join('\r\n');
}

export function queryFactsTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'query_facts',
    title: 'Query facts across pages',
    access: 'read',
    description:
      'Reads the SAME few fields from many pages at once, as a compact table: `columns` once, then `rows` as arrays (or `format: "csv"`). Select pages by `type` (Reference Type, one or several), `tag` (any of them; `tagMode: "all"` for all), `under` (a branch), `kind` (index, bsrc, bwrk, barc), `lifecycle` (Authoritative, Working, Archived) or `name` (a substring); together they narrow. `characters: true` selects every current identity page (Character Core, Compact Character Reference, or identity-owning Character Reference) of Main CANON, or of an AU with `continuity`. `fields`: any sidebar fact key (for example "Race / Species", "Naming Culture") and id, name, canonicalDisplayName, referenceType, scope, tags, parent, path, lastMajorRevision, factsVersion. Free: from the bridge’s repository tree and the sidebars it stores, whose age the answer gives; each row’s `coverage` says `ok`, `stale` (the stored read is old or could not be refreshed) or `missing` (never read): never silently. `live: true` re-reads the rows of this page (1 read each; more than 10 first returns an estimate: repeat with confirm: true), and only then is factsVersion filled. Paged by row: `limit` up to 500, then `offset` or the `nextCursor`. Example: { "characters": true, "type": "Character Core", "fields": ["canonicalDisplayName", "Race / Species", "Naming Culture", "Life State", "Temporal Scope", "tags", "parent"] }. Cost: none (live: 1 read per row).',
    inputSchema: z.object({
      fields: z.array(z.string().min(1).max(256)).min(1).max(40).describe('The columns, in order.'),
      type: many(z.string().min(1).max(200)).optional().describe('Reference Type(s).'),
      tag: many(z.string().min(1).max(100)).optional(),
      tagMode: z.enum(['any', 'all']).optional().describe('With several tags: any (default) or all.'),
      under: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('A branch: the page (name or id) whose subtree is read.'),
      kind: many(z.enum(KINDS)).optional(),
      lifecycle: many(z.enum(LIFECYCLES)).optional(),
      name: z.string().min(1).max(200).optional().describe('A substring of the page’s name (without case).'),
      characters: z
        .boolean()
        .optional()
        .describe('Every current identity page (needs a setting pack with characters).'),
      continuity: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('With characters: "Main CANON" (default) or an AU’s Continuity.'),
      format: z.enum(['table', 'csv']).optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_ROWS)
        .optional()
        .describe(`Rows per page (default ${DEFAULT_ROWS}).`),
      offset: z.number().int().min(0).max(100_000).optional(),
      cursor: z.string().min(1).max(500).optional().describe('nextCursor of the previous page.'),
      live: z.boolean().optional().describe('Re-read this page of rows (1 read each).'),
      confirm: z.boolean().optional().describe('Run a live read of more than 10 rows after its estimate.'),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'read', async (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        const settings = pd.services?.projectSettings?.(ctx.projectId) ?? {};
        const lifecycle = lifecycleFrom(settings);
        const property =
          typeof settings.factsPropertyName === 'string' ? settings.factsPropertyName : 'PROPERTIES';
        const labels = treeLabeller(ctx, lifecycle);

        // 1. The selection.
        let nodes: TreeNode[] = [];
        for (const k of ['index', 'bsrc', 'bwrk', 'barc', 'unclassified'] as const)
          nodes.push(...ctx.tree.byKind(ctx.projectId, k).data);
        const kinds = asList(args.kind);
        if (kinds.length > 0) nodes = nodes.filter((n) => (kinds as string[]).includes(n.kind));
        else nodes = nodes.filter((n) => n.kind !== 'unclassified');
        if (args.under !== undefined) {
          const r = resolvePage(ctx, args.under, { what: 'the branch' });
          if (!r.ok) return r.result;
          const top = r.node.id;
          nodes = nodes.filter((n) => n.id === top || n.path.ids.includes(top));
        }
        const types = asList(args.type).map(textKey);
        let charNote: string | null = null;
        let auType = lifecycle.continuityTypes.au;
        if (args.characters === true) {
          const rules = characterRules(ctx);
          if (!rules)
            return errorResult(
              {
                code: 'NO_CHARACTER_TYPE',
                message:
                  'characters: true needs an approved setting pack with a character type on this project; select by type instead.',
              },
              pd,
            );
          auType = rules.tags.au?.continuityType ?? auType;
          const idTypes = new Set(identityReferenceTypes(rules).map(textKey));
          nodes = nodes.filter((n) => {
            if (!n.referenceType || !idTypes.has(textKey(n.referenceType))) return false;
            if (n.kind === 'barc' || n.kind === 'index') return false;
            const l = labels(n);
            return l.area === null && l.lifecycle !== 'Archived';
          });
          charNote = `current identity pages (${identityReferenceTypes(rules).join(', ')}), Archived pages and the non-current areas left out`;
        } else if (args.continuity !== undefined)
          return errorResult(
            { code: 'INVALID_PARAMS', message: 'continuity goes with characters: true.' },
            pd,
          );
        if (types.length > 0)
          nodes = nodes.filter((n) => n.referenceType !== null && types.includes(textKey(n.referenceType)));
        const tags = asList(args.tag).map(textKey);
        if (tags.length > 0)
          nodes = nodes.filter((n) => {
            const have = new Set(n.tags.map(textKey));
            return args.tagMode === 'all' ? tags.every((t) => have.has(t)) : tags.some((t) => have.has(t));
          });
        const lcs = asList(args.lifecycle);
        if (lcs.length > 0)
          nodes = nodes.filter((n) => {
            const l =
              labels(n).lifecycle ??
              (n.kind === 'bsrc'
                ? 'Authoritative'
                : n.kind === 'bwrk'
                  ? 'Working'
                  : n.kind === 'barc'
                    ? 'Archived'
                    : null);
            return l !== null && (lcs as string[]).includes(l);
          });
        if (args.name !== undefined) {
          const part = args.name.normalize('NFC').toLocaleLowerCase('en-GB');
          nodes = nodes.filter((n) =>
            n.displayName.normalize('NFC').toLocaleLowerCase('en-GB').includes(part),
          );
        }
        // The stored sidebars of the selection (one query), for the continuity and the cells.
        const stored = ctx.tree.sidebars(
          ctx.projectId,
          nodes.map((n) => n.id),
        ).data;
        const continuityLabel = args.characters === true ? (args.continuity?.trim() ?? MAIN) : null;
        if (continuityLabel !== null) {
          const ctKey = textKey(lifecycle.fields.continuityType);
          const main =
            textKey(continuityLabel) === textKey(MAIN) || textKey(continuityLabel) === textKey('Main');
          nodes = nodes.filter((n) => {
            const f = factMap(stored.get(n.id) ?? null, property);
            const ct = f?.get(ctKey) ?? null;
            const isAu = ct !== null && textKey(ct) === textKey(auType);
            if (main) return !isAu;
            return isAu && textKey(f?.get(textKey('Continuity')) ?? '') === textKey(continuityLabel);
          });
        }
        const total = nodes.length;

        // 2. The page of rows.
        const selectionHash = createHash('sha1')
          .update(
            JSON.stringify([
              args.fields,
              args.type,
              args.tag,
              args.tagMode,
              args.under,
              args.kind,
              args.lifecycle,
              args.name,
              args.characters,
              continuityLabel,
            ]),
          )
          .digest('hex')
          .slice(0, 12);
        let offset = args.offset ?? 0;
        if (args.cursor !== undefined) {
          try {
            const c = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')) as {
              o?: unknown;
              h?: unknown;
            };
            if (typeof c.o !== 'number' || c.h !== selectionHash) throw new Error('mismatch');
            offset = c.o;
          } catch {
            return errorResult(
              {
                code: 'CURSOR_INVALID',
                message:
                  'The cursor is not one this selection gave (the fields or filters changed). Start again without it.',
              },
              pd,
            );
          }
        }
        const limit = args.limit ?? DEFAULT_ROWS;
        const page = nodes.slice(offset, offset + limit);
        const next = offset + page.length < total ? offset + page.length : null;

        // 3. live: one getResource per row of this page, as one job (the estimate first above 10).
        const live = new Map<string, unknown>();
        const liveFailed = new Map<string, string>();
        let jobId: string | null = null;
        if (args.live === true && page.length > 0) {
          if (page.length > LIVE_CONFIRM_ABOVE && args.confirm !== true) {
            const e = pd.projects
              .anyClient(pd.project.id)
              ?.governor.estimate({ reads: page.length, writes: 0, createManyItems: 0, priority: 'P1' });
            return render(
              {
                status: 'estimate',
                tree: treeInfo(ctx.meta, ctx.now),
                rows: page.length,
                totalRows: total,
                reads: page.length,
                ...(e
                  ? {
                      wallClockSeconds: Math.round(e.wallClockMs / 1000),
                      tightestTier: e.tightestTier,
                      fitsToday: e.fitsToday,
                    }
                  : {}),
                hint: `Nothing was read. live: true re-reads these ${page.length} rows (1 read each). Repeat the call with confirm: true, or leave live out (free, from the stored sidebars), or lower limit.`,
              },
              pd,
            );
          }
          try {
            const sub = await pd.engine.submit({
              kind: 'batch_ops',
              project: pd.project.id,
              steps: page.map((n) => ({ op: 'getResource', params: { path: { resourceId: n.id } } })),
              onError: 'continue',
              origin: mcpOrigin(mctx, 'query_facts'),
              priority: 'P1',
              title: `query_facts live (${page.length} pages)`,
            });
            if (!('jobId' in sub))
              return errorResult({ code: 'BRIDGE_ERROR', message: 'The read was not accepted.' }, pd);
            jobId = sub.jobId;
            const job = await pd.engine.wait(pd.project.id, sub.jobId, 25_000);
            const results =
              job.status === 'succeeded' || job.status === 'failed'
                ? pd.engine.stepResults(pd.project.id, sub.jobId)
                : undefined;
            if (!results)
              return render(
                {
                  status: 'running',
                  jobId: sub.jobId,
                  hint: 'The reads are waiting for LegendKeeper’s rate budget and have NOT failed. Follow the job with bridge_job_status; do not start another query.',
                },
                pd,
              );
            results.forEach((st, i) => {
              const n = page[i]!;
              if (st.status === 'succeeded') live.set(n.id, st.value);
              else {
                const e = st.error as { message?: unknown } | null;
                liveFailed.set(n.id, typeof e?.message === 'string' ? e.message : st.status);
              }
            });
          } catch (e) {
            return errorFromThrown(e, pd);
          }
        }

        // 4. The cells.
        const lmrKey = textKey(lifecycle.fields.lastMajorRevision);
        const columns = [...args.fields, 'coverage', 'readAt'];
        const unseen = new Set(args.fields.filter((f) => !BUILTIN.has(f)).map(textKey));
        let oldest: number | null = null;
        const rows: Cell[][] = page.map((n) => {
          const res = live.get(n.id);
          const facts =
            res !== undefined ? liveFactMap(res, property) : factMap(stored.get(n.id) ?? null, property);
          const coverage =
            res !== undefined
              ? 'live'
              : liveFailed.has(n.id)
                ? 'stale'
                : facts === null || n.propertiesPending
                  ? 'missing'
                  : n.stale || ctx.now - n.lastReadAt > STALE_AFTER_MS
                    ? 'stale'
                    : 'ok';
          // The tree stamps a read with its own increasing clock (never ahead of now in a real build).
          const readAt = Math.min(n.lastReadAt, ctx.now);
          if (res === undefined && coverage !== 'missing')
            oldest = oldest === null ? readAt : Math.min(oldest, readAt);
          const resObj = (res ?? null) as Record<string, unknown> | null;
          const parent = n.parentId ? ctx.tree.node(ctx.projectId, n.parentId).data : null;
          const cell = (f: string): Cell => {
            if (BUILTIN.has(f)) {
              switch (f as Builtin) {
                case 'id':
                  return n.id;
                case 'name':
                  return typeof resObj?.name === 'string' ? resObj.name : n.displayName;
                case 'canonicalDisplayName':
                  return facts?.get(textKey('Canonical Display Name')) ?? n.canonicalDisplayName;
                case 'referenceType':
                  return facts?.get(textKey('Reference Type')) ?? n.referenceType;
                case 'scope':
                  return facts?.get(textKey(lifecycle.fields.scope)) ?? n.scope;
                case 'tags':
                  return Array.isArray(resObj?.tags) ? (resObj.tags as string[]) : n.tags;
                case 'parent':
                  return parent?.displayName ?? null;
                case 'path':
                  return n.path.names.join(' / ');
                case 'lastMajorRevision':
                  return facts?.get(lmrKey) ?? null;
                case 'factsVersion':
                  return res !== undefined ? factsVersionOfRead(ctx, n.id, res) : null;
              }
            }
            const v = facts?.get(textKey(f));
            if (v !== undefined) unseen.delete(textKey(f));
            return v ?? null;
          };
          return [
            ...args.fields.map(cell),
            coverage,
            res !== undefined
              ? new Date(ctx.now).toISOString()
              : coverage === 'missing'
                ? null
                : new Date(readAt).toISOString(),
          ];
        });
        const counts = { ok: 0, stale: 0, missing: 0, live: 0 } as Record<string, number>;
        for (const r of rows) counts[String(r[r.length - 2])] = (counts[String(r[r.length - 2])] ?? 0) + 1;
        const notes = [
          ...(charNote ? [charNote] : []),
          ...(args.fields.includes('factsVersion') && args.live !== true
            ? [
                'factsVersion is filled only by live: true (the tree keeps each fact’s text, not the sidebar’s version)',
              ]
            : []),
          ...(unseen.size > 0 && rows.length > 0
            ? [
                `no page of this page of rows has: ${args.fields.filter((f) => unseen.has(textKey(f))).join(', ')}`,
              ]
            : []),
          ...(counts.missing! > 0
            ? [`${counts.missing} row(s) missing: their sidebar was never read; their facts are null`]
            : []),
          ...(counts.stale! > 0
            ? [`${counts.stale} row(s) stale: their stored read is old or could not be refreshed`]
            : []),
        ];
        const age = {
          source:
            args.live === true
              ? 'live reads (this page of rows), the tree for the rest'
              : 'the repository tree’s stored sidebars',
          tree: treeInfo(ctx.meta, ctx.now),
          ...(oldest !== null
            ? { oldestRead: new Date(oldest).toISOString(), oldest: ago(ctx.now - oldest) }
            : {}),
        };
        const cursor =
          next !== null
            ? Buffer.from(JSON.stringify({ o: next, h: selectionHash })).toString('base64url')
            : null;
        const body = {
          ...(continuityLabel ? { continuity: continuityLabel } : {}),
          totalRows: total,
          offset,
          returned: rows.length,
          ...(next !== null ? { nextOffset: next, nextCursor: cursor } : {}),
          age,
          coverage: counts,
          ...(jobId ? { jobId } : {}),
          ...(args.format === 'csv' ? { csv: toCsv(columns, rows) } : { columns, rows }),
          ...(notes.length > 0 ? { notes } : {}),
          cost: args.live === true ? `${live.size + liveFailed.size} read(s)` : 'none',
        };
        return finish(pd, mctx, 'query_facts', body, () => ({
          totalRows: total,
          columns,
          rows: rows.slice(0, 5),
        }));
      }),
  });
}
