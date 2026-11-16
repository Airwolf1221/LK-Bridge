/**
 * What a setting pack registers with the job engine (v3 F3a, ADR 0050): its checks inside a package's job, its page
 * checks in the verify step, the filler that fits a page's text into its template copy, and the record of an upgraded
 * page's template.
 *
 * - `pack.governance` (expect): the pack is still the approved version and every governance source is still the
 *   approved document version (read again now); else the job stops with PACK_GOVERNANCE_CHANGED before any write.
 * - `pack.absent` (expect): a new subject's name is reserved for this job, atomically (another job that still runs and
 *   holds it: CHARACTER_EXISTS), then each planned parent is listed live and the tree asked by name: if the subject (or a
 *   new page's name under an existing index) appeared since the plan, the job stops (CHARACTER_EXISTS or DOMAIN_EXISTS).
 * - `pack.page` (verify): one check of one page read back (cached per verify step): a field, the template's rows (none
 *   added or dropped, each value, Last Major Revision the day the job ran), the tags in order, the links, its name or
 *   its parent.
 * - `pack.body` (fill): the template copy's blocks that Markdown cannot express (a collection, `unsupported` content)
 *   kept: under the planned section of the same heading, else after the planned text with their heading.
 */
import { factKey } from '../../facts/index.js';
import type { JobEngine } from '../../jobs/index.js';
import type {
  FillContext,
  FillResult,
  RegisteredCheckContext,
  RegisteredCheckResult,
} from '../../jobs/internal-steps.js';
import type { StateDifference } from '../../jobs/sidebar-state.js';
import type { LkBlock } from '../../markdown/index.js';
import { KEEP_KINDS } from '../../markdown/model.js';
import type { Registry } from '../../registry/index.js';
import { cleanPrefixes, key as nameKey } from '../../registry/names.js';
import type { Packs } from '../service.js';
import { PACK_CHECKS, PACK_FILLER, PACK_RECORD_STORE } from './job.js';
import { blockText, sectionsOf, textKey } from './text.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export interface PackEngineDeps {
  readonly packs: Packs;
  readonly registry: Pick<Registry, 'forProject'>;
  /** Records the template a page was made from on its tree node (an upgraded Reference). */
  readonly setTemplate: (projectId: string, resourceId: string, templateId: string) => void;
}

/** Registers the pack's checkers, filler and record handler with the engine. Returns an unregister. */
export function registerPackEngine(
  engine: Pick<JobEngine, 'registerAsyncChecker' | 'registerFiller' | 'registerRecordHandler'>,
  d: PackEngineDeps,
): () => void {
  const off = [
    engine.registerAsyncChecker(PACK_CHECKS.governance, (ctx) => governanceCheck(d, ctx)),
    engine.registerAsyncChecker(PACK_CHECKS.absent, (ctx) => absentCheck(d, ctx)),
    engine.registerAsyncChecker(PACK_CHECKS.page, (ctx) => pageCheck(ctx)),
    engine.registerFiller(PACK_FILLER, fillBody),
    engine.registerRecordHandler((job, _step, params) => {
      const r = ((params.body ?? {}) as { record?: Obj }).record ?? {};
      if (r.kind === 'set_template' && typeof r.resourceId === 'string' && typeof r.templateId === 'string') {
        d.setTemplate(job.projectId, r.resourceId, r.templateId);
        return { recorded: 'set_template', resourceId: r.resourceId, templateId: r.templateId };
      }
      return { recorded: null };
    }, PACK_RECORD_STORE),
  ];
  return () => {
    for (const f of off) f();
  };
}

async function governanceCheck(d: PackEngineDeps, ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = (ctx.input ?? {}) as { packId?: string; version?: number; sources?: { key: string; version: string }[] };
  const pack = input.packId ? d.packs.get(input.packId) : null;
  const refusal = (message: string, more: Obj = {}): RegisteredCheckResult => ({
    differences: [],
    refusal: { code: 'PACK_GOVERNANCE_CHANGED', message, details: more },
  });
  if (!pack) return refusal('The pack this package was planned with no longer exists. Nothing was written.');
  if (!pack.approved || pack.approved.version !== input.version || pack.version !== input.version) {
    return refusal(
      `The ${pack.name} pack changed since this package was planned (planned on version ${input.version ?? '?'}, now version ${pack.version}${pack.approved ? `, approved version ${pack.approved.version}` : ', not approved'}). Nothing was written: plan the package again once the owner has approved the pack.`,
    );
  }
  const status = await d.packs.governance(pack.id);
  if (status.state !== 'current') return refusal(`${status.message} Nothing was written.`, { governance: status.sources });
  const want = new Map((input.sources ?? []).map((s) => [s.key, s.version]));
  const moved = status.sources.filter((s) => want.get(s.key) !== s.current);
  if (moved.length > 0) {
    return refusal(
      `The ${pack.name} pack was approved again since this package was planned (${moved.map((s) => s.name).join(', ')}). Nothing was written: plan the package again.`,
    );
  }
  return { differences: [], observed: { version: pack.version, sources: status.sources.map((s) => ({ key: s.key, version: s.current })) } };
}

async function absentCheck(d: PackEngineDeps, ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = (ctx.input ?? {}) as {
    reservation?: string | null;
    subject?: string;
    mode?: 'new' | 'extend';
    type?: string;
    under?: { parentId: string; names: string[] }[];
  };
  const subject = input.subject ?? '?';
  const what = (input.type ?? 'character').toLowerCase();
  if (input.reservation) {
    const r = d.packs.store.reserve(ctx.projectId, input.reservation, ctx.jobId);
    if (!r.ok) {
      return {
        differences: [],
        refusal: {
          code: 'CHARACTER_EXISTS',
          message: `Another approved package is creating “${subject}” now (job ${r.holder}). Nothing was written. Once it has finished, re-run this package with target set to “${subject}” to add its pages.`,
          details: { job: r.holder, hint: `Re-run with target: "${subject}".` },
        },
      };
    }
  }
  for (const u of input.under ?? []) {
    const names = new Set(u.names.map((n) => nameKey(n)));
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await ctx.read('listResources', {
        query: { parentId: u.parentId, limit: 100, ...(cursor ? { cursor } : {}) },
      });
      const body = (r.body ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
      for (const x of Array.isArray(body.data) ? (body.data as Obj[]) : []) {
        const raw = str(x.name) ?? '';
        if (typeof x.deletedAt === 'string') continue;
        const display = cleanPrefixes(raw).name;
        if (names.has(nameKey(display))) {
          const extend = input.mode === 'extend';
          return {
            differences: [],
            refusal: {
              code: extend ? 'DOMAIN_EXISTS' : 'CHARACTER_EXISTS',
              message: extend
                ? `${raw} appeared since this package was planned, so its page would be a duplicate. Nothing was written. Read the character again and plan a new package.`
                : `“${subject}” appeared since this package was planned (${raw}). Nothing was written. Re-run the package with target set to “${subject}” to add its pages to the existing ${what}.`,
              details: { existing: { id: str(x.id), name: raw }, hint: extend ? undefined : `Re-run with target: "${subject}".` },
            },
          };
        }
      }
      if (body.hasMore !== true || typeof body.nextCursor !== 'string') break;
      cursor = body.nextCursor;
    }
  }
  if (input.mode === 'new' && input.subject) {
    // The tree, after the earlier job's re-read: a character of this name anywhere (an alias, a Canonical Display Name).
    const types = d.registry.forProject(ctx.projectId);
    let r;
    try {
      r = types.resolve(input.subject, {});
    } catch {
      r = null;
    }
    const ids = r?.status === 'resolved' ? [r.node.id] : r?.status === 'ambiguous' ? r.candidates.map((c) => c.id) : [];
    for (const id of ids) {
      const c = types.characterOfPage(id);
      if (c.ok) {
        return {
          differences: [],
          refusal: {
            code: 'CHARACTER_EXISTS',
            message: `“${subject}” exists now (${c.value.core.rawName}), since this package was planned. Nothing was written. Re-run it with target set to “${subject}” to add its pages.`,
            details: { existing: { id: c.value.core.id, name: c.value.core.rawName }, hint: `Re-run with target: "${subject}".` },
          },
        };
      }
    }
  }
  return { differences: [] };
}

/** The plain text of a row's runs. */
const runsText = (content: unknown): string =>
  Array.isArray(content)
    ? (content as Obj[])
        .map((r) => (typeof r.text === 'string' ? r.text : isObj(r.mention) && typeof r.mention.text === 'string' ? r.mention.text : ''))
        .join('')
        .trim()
    : '';

async function pageCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = (ctx.input ?? {}) as Obj;
  const id = str(input.resourceId);
  if (!id) return { differences: [{ path: ctx.label, expected: 'a page', actual: '(none named)' }] };
  const r = await ctx.read('getResource', { path: { resourceId: id } });
  if (!r.exists) return { differences: [{ path: ctx.label, expected: 'present', actual: '(gone)' }] };
  const res = (r.body ?? {}) as Obj;
  const diffs: StateDifference[] = [];
  const props = Array.isArray(res.properties) ? (res.properties as Obj[]) : [];
  const kv = (title: string) => props.filter((p) => p.kind === 'keyValue' && factKey(str(p.title) ?? '') === factKey(title));
  const rowsOf = (p: Obj) =>
    (Array.isArray(p.rows) ? (p.rows as Obj[]) : [])
      .slice()
      .sort((a, b) => {
        const ra = str(a.rank) ?? '';
        const rb = str(b.rank) ?? '';
        return ra < rb ? -1 : ra > rb ? 1 : (str(a.id) ?? '') < (str(b.id) ?? '') ? -1 : 1;
      })
      .map((row) => ({ key: str(row.key) ?? '', value: runsText(row.content ?? (row.text ? [{ text: row.text }] : [])) }));
  switch (input.check) {
    case 'field': {
      const p = kv(str(input.property) ?? 'PROPERTIES');
      const row = p.length === 1 ? rowsOf(p[0]!).find((x) => factKey(x.key) === factKey(str(input.key) ?? '')) : undefined;
      const want = str(input.value);
      if (!row) diffs.push({ path: ctx.label, expected: `the row “${String(input.key)}”`, actual: '(no row)' });
      else if (want !== null && row.value !== want.trim()) diffs.push({ path: ctx.label, expected: want, actual: row.value });
      else if (want === null && row.value === '') diffs.push({ path: ctx.label, expected: 'a value', actual: '(blank)' });
      break;
    }
    case 'rows': {
      const p = kv(str(input.property) ?? 'PROPERTIES');
      if (p.length !== 1) {
        diffs.push({ path: ctx.label, expected: 'one key-value property', actual: `${p.length}` });
        break;
      }
      const got = rowsOf(p[0]!);
      const keys = Array.isArray(input.keys) ? (input.keys as string[]) : [];
      if (got.map((x) => factKey(x.key)).join('|') !== keys.map(factKey).join('|')) {
        diffs.push({
          path: `${ctx.label} (the template's rows)`,
          expected: keys,
          actual: got.map((x) => x.key),
        });
      }
      const values = isObj(input.values) ? (input.values as Record<string, string>) : {};
      for (const [k, v] of Object.entries(values)) {
        const row = got.find((x) => factKey(x.key) === factKey(k));
        if (row && row.value !== v.trim()) diffs.push({ path: `${ctx.label} “${k}”`, expected: v, actual: row.value });
      }
      const lmrKey = str(input.lmrKey);
      const lmr = ctx.from.lmr as { date?: unknown } | null | undefined;
      if (lmrKey && lmr && typeof lmr.date === 'string') {
        const row = got.find((x) => factKey(x.key) === factKey(lmrKey));
        if (row && row.value !== lmr.date)
          diffs.push({ path: `${ctx.label} “${lmrKey}”`, expected: lmr.date, actual: row.value });
      }
      break;
    }
    case 'tags': {
      const want = Array.isArray(input.tags) ? (input.tags as string[]) : [];
      const got = Array.isArray(res.tags) ? (res.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [];
      if (want.join('\u0000') !== got.join('\u0000'))
        diffs.push({ path: `${ctx.label} (in order)`, expected: want, actual: got });
      break;
    }
    case 'links': {
      const cols = Array.isArray(input.collections) ? (input.collections as { title: string; ids: string[] }[]) : [];
      for (const c of cols) {
        const hits = props.filter(
          (p) =>
            (p.kind === 'resourceCollection' || p.kind === 'resourceLink') &&
            factKey(str(p.title) ?? '') === factKey(c.title),
        );
        if (hits.length !== 1) {
          diffs.push({ path: `${ctx.label} ${c.title}`, expected: 'one collection', actual: `${hits.length}` });
          continue;
        }
        const items = (Array.isArray(hits[0]!.items) ? (hits[0]!.items as Obj[]) : []).map((i) => str(i.resourceId));
        const missing = c.ids.filter((x) => !items.includes(x));
        if (missing.length > 0) diffs.push({ path: `${ctx.label} ${c.title}`, expected: c.ids, actual: items });
      }
      break;
    }
    case 'name':
      if (str(res.name) !== str(input.name)) diffs.push({ path: ctx.label, expected: input.name, actual: res.name ?? null });
      break;
    case 'parent':
      if (str(res.parentId) !== str(input.parentId))
        diffs.push({ path: ctx.label, expected: input.parentId, actual: res.parentId ?? null });
      break;
    default:
      diffs.push({ path: ctx.label, expected: 'a known check', actual: String(input.check) });
  }
  return { differences: diffs };
}

/** The pack's filler (see the module comment). */
export function fillBody(ctx: FillContext): FillResult {
  const planned = ctx.planned as LkBlock[];
  const current = ctx.current.blocks as LkBlock[];
  const keepKind = (b: unknown) => isObj(b) && typeof b.kind === 'string' && b.kind in KEEP_KINDS;
  if (!current.some(keepKind)) return { blocks: planned, note: { kept: 0 } };
  const input = (ctx.input ?? {}) as { keepSections?: string[] };
  const out = [...planned];
  const plannedSections = () => sectionsOf(out);
  let kept = 0;
  const keptSections: string[] = [];
  const insertAfterSection = (title: string, blocks: LkBlock[]): boolean => {
    const secs = plannedSections();
    const i = secs.findIndex((s) => s.heading && textKey(s.title) === textKey(title));
    if (i < 0) return false;
    let at = 0;
    for (let j = 0; j <= i; j++) at += (secs[j]!.heading ? 1 : 0) + secs[j]!.blocks.length;
    // Sub-sections of the matched one stay after the kept blocks only when the matched section has none.
    out.splice(at, 0, ...blocks);
    return true;
  };
  for (const s of sectionsOf(current)) {
    const keep = s.blocks.filter(keepKind);
    if (keep.length === 0) continue;
    kept += keep.length;
    if (!s.heading) {
      out.unshift(...keep);
      continue;
    }
    keptSections.push(s.title);
    if (insertAfterSection(s.title, keep)) continue;
    out.push(s.heading, ...keep);
  }
  void input;
  return {
    blocks: out,
    note: { kept, ...(keptSections.length ? { keptSections } : {}), what: current.filter(keepKind).map((b) => blockText(b) || String((b as Obj).kind)) },
  };
}
