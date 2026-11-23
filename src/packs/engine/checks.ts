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
import { PACK_ART_FILLER, PACK_CHECKS, PACK_CORE_FILLER, PACK_FILLER, PACK_RECORD_STORE } from './job.js';
import { applyCoreText, type CoreTextInput } from './core.js';
import { blockText, sectionsOf, textKey } from './text.js';
import { mintClientId } from '../../jobs/ids.js';
import type { OutfitStore } from '../../art/store.js';
import type { JobView } from '../../jobs/index.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export interface PackEngineDeps {
  readonly packs: Packs;
  readonly registry: Pick<Registry, 'forProject'>;
  /** Records the template a page was made from on its tree node (an upgraded Reference). */
  readonly setTemplate: (projectId: string, resourceId: string, templateId: string) => void;
  /**
   * v3 F3b (ADR 0052): a staged image as the image service has it now (settled), for the job's check that every image
   * it places is still staged, still on the bridge's server and placed by nothing else.
   */
  readonly stagedImage?: (
    projectId: string,
    stagedId: string,
  ) =>
    | {
        readonly staged: boolean;
        readonly state: string;
        readonly serverSha256: string | null;
        readonly placementJobId: string | null;
        readonly placementProposalId: string | null;
        readonly discardJobId: string | null;
      }
    | undefined;
  /** v3 F3b: the job a proposal ran as (null while it waits), for the staged images' check. */
  readonly proposalJob?: (proposalId: string) => string | null;
  /** v3 F3b (design 1.1a): records ONE Character taxonomy entry for a navigation index a package made. */
  readonly addTaxonomyEntry?: (
    projectId: string,
    r: { readonly resourceId: string; readonly plural: string; readonly parentNodeId: string },
    actor: string,
  ) => Record<string, unknown>;
  /** v3 F7 (ADR 0070, G3): the outfit record an art job writes after its uploads and moves. */
  readonly outfits?: OutfitStore;
  /** v3 F7: what an earlier step of a job returned (the ids LegendKeeper minted: folders, assets). */
  readonly stepValue?: (jobId: string, stepNo: number) => unknown;
  /** v3 F3d (renames), ADR 0058: renames a race's taxonomy entry with its navigation index (an approved rename). */
  readonly renameTaxonomyEntry?: (
    projectId: string,
    r: { readonly entryId: string; readonly from: string; readonly plural: string },
    actor: string,
  ) => Record<string, unknown>;
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
    engine.registerAsyncChecker(PACK_CHECKS.art, (ctx) => artLayoutCheck(ctx)),
    engine.registerFiller(PACK_FILLER, fillBody),
    engine.registerFiller(PACK_ART_FILLER, appendImages),
    engine.registerFiller(PACK_CORE_FILLER, coreTextFill),
    engine.registerRecordHandler((job, _step, params) => {
      const r = ((params.body ?? {}) as { record?: Obj }).record ?? {};
      if (r.kind === 'set_template' && typeof r.resourceId === 'string' && typeof r.templateId === 'string') {
        d.setTemplate(job.projectId, r.resourceId, r.templateId);
        return { recorded: 'set_template', resourceId: r.resourceId, templateId: r.templateId };
      }
      if (
        r.kind === 'taxonomy_entry' &&
        typeof r.resourceId === 'string' &&
        typeof r.plural === 'string' &&
        typeof r.parentNodeId === 'string' &&
        d.addTaxonomyEntry
      ) {
        return d.addTaxonomyEntry(
          job.projectId,
          { resourceId: r.resourceId, plural: r.plural, parentNodeId: r.parentNodeId },
          job.approvedBy ?? job.principalId,
        );
      }
      if (r.kind === 'art_outfit' && d.outfits) return recordOutfit(d, job, r);
      if (
        r.kind === 'taxonomy_rename' &&
        typeof r.entryId === 'string' &&
        typeof r.from === 'string' &&
        typeof r.plural === 'string' &&
        d.renameTaxonomyEntry
      ) {
        return d.renameTaxonomyEntry(
          job.projectId,
          { entryId: r.entryId, from: r.from, plural: r.plural },
          job.approvedBy ?? job.principalId,
        );
      }
      return { recorded: null };
    }, PACK_RECORD_STORE),
  ];
  return () => {
    for (const f of off) f();
  };
}

async function governanceCheck(
  d: PackEngineDeps,
  ctx: RegisteredCheckContext,
): Promise<RegisteredCheckResult> {
  const input = (ctx.input ?? {}) as {
    packId?: string;
    version?: number;
    sources?: { key: string; version: string }[];
    tool?: string;
  };
  const pack = input.packId ? d.packs.get(input.packId) : null;
  const refusal = (message: string, more: Obj = {}): RegisteredCheckResult => ({
    differences: [],
    refusal: { code: 'PACK_GOVERNANCE_CHANGED', message, details: more },
  });
  if (!pack) return refusal('The pack this package was planned with no longer exists. Nothing was written.');
  // CR-2026-11-R2 (R2-29): a job that runs directly (at the agent's scope, not approved by the owner) stops when the
  // tool's switch now says "always propose", in the approved version or in one waiting for approval (the stricter). The
  // check runs again whenever the job starts again before its first write (a hold, a budget wait, a restart).
  if (input.tool && d.packs.store.jobApproval(ctx.projectId, ctx.jobId) === 'direct') {
    if (d.packs.strictToolMode(pack.id, input.tool) === 'propose')
      return refusal(
        `${input.tool} is now switched to “always propose” on the Packs page (pack version ${pack.version}${pack.approved?.version === pack.version ? '' : ', waiting for approval'}), so this package can no longer run directly. Nothing was written: call the tool again; it will be a proposal for the owner.`,
        { tool: input.tool, switch: 'propose' },
      );
  }
  if (!pack.approved || pack.approved.version !== input.version || pack.version !== input.version) {
    return refusal(
      `The ${pack.name} pack changed since this package was planned (planned on version ${input.version ?? '?'}, now version ${pack.version}${pack.approved ? `, approved version ${pack.approved.version}` : ', not approved'}). Nothing was written: plan the package again once the owner has approved the pack.`,
    );
  }
  const status = await d.packs.governance(pack.id);
  if (status.state !== 'current')
    return refusal(`${status.message} Nothing was written.`, { governance: status.sources });
  const want = new Map((input.sources ?? []).map((s) => [s.key, s.version]));
  const moved = status.sources.filter((s) => want.get(s.key) !== s.current);
  if (moved.length > 0) {
    return refusal(
      `The ${pack.name} pack was approved again since this package was planned (${moved.map((s) => s.name).join(', ')}). Nothing was written: plan the package again.`,
    );
  }
  return {
    differences: [],
    observed: {
      version: pack.version,
      sources: status.sources.map((s) => ({ key: s.key, version: s.current })),
    },
  };
}

async function absentCheck(d: PackEngineDeps, ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = (ctx.input ?? {}) as {
    reservation?: string | null;
    subject?: string;
    mode?: 'new' | 'extend';
    type?: string;
    under?: { parentId: string; names: string[]; prefixes?: string[]; code?: string }[];
    reservations?: string[];
    present?: { resourceId: string; parentId: string; name: string; code: string }[];
    kind?: 'character' | 'owner' | 'relationship' | 'art';
    images?: string[];
    takeovers?: { stagedId: string; proposalId: string }[];
    /**
     * v3 F3d (ADR 0058): the pages this package makes (their ids minted when it was planned). A page found with one of
     * these ids is this job's own (a package resumed after it stopped part-way), never a duplicate.
     */
    ownIds?: string[];
  };
  const own = new Set(input.ownIds ?? []);
  const subject = input.subject ?? '?';
  const what = (input.type ?? 'character').toLowerCase();
  const kind = input.kind ?? 'character';
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
  // v3 F3b (ADR 0052): more names reserved (an owner's name in its home, a nation index, a relationship's pair).
  for (const key of input.reservations ?? []) {
    const r = d.packs.store.reserve(ctx.projectId, key, ctx.jobId);
    if (!r.ok) {
      const code = key.startsWith('nation:')
        ? 'NATION_INDEX_EXISTS'
        : key.startsWith('relationship:')
          ? 'RELATIONSHIP_EXISTS'
          : 'OWNER_EXISTS';
      return {
        differences: [],
        refusal: {
          code,
          message: `Another approved package is making “${subject}” (or the index it needs) now (job ${r.holder}). Nothing was written. Once it has finished, look at what it made before planning again.`,
          details: { job: r.holder },
        },
      };
    }
  }
  // v3 F3b: an existing page the job moves or relies on is still where the plan saw it.
  for (const p of input.present ?? []) {
    const r = await ctx.read('getResource', { path: { resourceId: p.resourceId } });
    const body = (r.body ?? {}) as Obj;
    const parent = str(body.parentId);
    if (!r.exists || typeof body.deletedAt === 'string' || parent !== p.parentId) {
      return {
        differences: [],
        refusal: {
          code: p.code,
          message: `${p.name} is no longer where this package was planned (${!r.exists ? 'it is gone' : `it is under ${parent ?? 'no parent'} now`}). Nothing was written: plan the package again.`,
          details: { page: { id: p.resourceId, name: p.name }, expectedParent: p.parentId, parent },
        },
      };
    }
  }
  // v3 F3b (design section 6): every staged image the job places is still staged, on the server, placed by nothing else.
  for (const id of input.images ?? []) {
    const row = d.stagedImage?.(ctx.projectId, id);
    // v3 F3d (ADR 0058): placed already by this very job (a package resumed after it stopped part-way).
    if (row && !row.staged && row.placementJobId === ctx.jobId) continue;
    // CR-2026-11-R2 (R2-34): the image's own placement proposal this package takes over, still waiting (no job), is this
    // job's to supersede: a direct job runs before it is withdrawn (withdrawn once the job has succeeded).
    const takenOver = (pid: string) =>
      (input.takeovers ?? []).some((t) => t.stagedId === id && t.proposalId === pid) &&
      (d.proposalJob?.(pid) ?? null) === null;
    const mine = (pid: string | null) => pid === null || d.proposalJob?.(pid) === ctx.jobId || takenOver(pid);
    const busy =
      !row ||
      !row.staged ||
      row.state !== 'uploaded' ||
      !row.serverSha256 ||
      row.discardJobId !== null ||
      (row.placementJobId !== null && row.placementJobId !== ctx.jobId) ||
      !mine(row.placementProposalId);
    if (busy)
      return {
        differences: [],
        refusal: {
          code: 'STAGED_IMAGE_BUSY',
          message: `The staged image ${id} is no longer this package's to place (${!row ? 'it is gone' : !row.staged ? 'it was placed or discarded' : 'something else is placing or discarding it'}). Nothing was written.`,
          details: { stagedId: id },
        },
      };
  }
  for (const u of input.under ?? []) {
    const names = new Set(u.names.map((n) => nameKey(n)));
    const prefixes = (u.prefixes ?? []).map((p) => nameKey(p));
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await ctx.read('listResources', {
        query: { parentId: u.parentId, limit: 100, ...(cursor ? { cursor } : {}) },
      });
      const body = (r.body ?? {}) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
      for (const x of Array.isArray(body.data) ? (body.data as Obj[]) : []) {
        const raw = str(x.name) ?? '';
        if (typeof x.deletedAt === 'string') continue;
        if (own.has(str(x.id) ?? '')) continue;
        const display = cleanPrefixes(raw).name;
        if (names.has(nameKey(display)) || prefixes.some((p) => nameKey(display).startsWith(p))) {
          if (u.code)
            return {
              differences: [],
              refusal: {
                code: u.code,
                message: `${raw} appeared since this package was planned, so what it makes would be a duplicate. Nothing was written. Look at ${raw} and plan again.`,
                details: { existing: { id: str(x.id), name: raw } },
              },
            };
          const extend = input.mode === 'extend';
          return {
            differences: [],
            refusal: {
              code: extend ? 'DOMAIN_EXISTS' : 'CHARACTER_EXISTS',
              message: extend
                ? `${raw} appeared since this package was planned, so its page would be a duplicate. Nothing was written. Read the character again and plan a new package.`
                : `“${subject}” appeared since this package was planned (${raw}). Nothing was written. Re-run the package with target set to “${subject}” to add its pages to the existing ${what}.`,
              details: {
                existing: { id: str(x.id), name: raw },
                hint: extend ? undefined : `Re-run with target: "${subject}".`,
              },
            },
          };
        }
      }
      if (body.hasMore !== true || typeof body.nextCursor !== 'string') break;
      cursor = body.nextCursor;
    }
  }
  if (input.mode === 'new' && input.subject && kind === 'character') {
    // The tree, after the earlier job's re-read: a character of this name anywhere (an alias, a Canonical Display Name).
    const types = d.registry.forProject(ctx.projectId);
    let r;
    try {
      r = types.resolve(input.subject, {});
    } catch {
      r = null;
    }
    const ids =
      r?.status === 'resolved' ? [r.node.id] : r?.status === 'ambiguous' ? r.candidates.map((c) => c.id) : [];
    for (const id of ids) {
      if (own.has(id)) continue;
      const c = types.characterOfPage(id);
      if (c.ok && !own.has(c.value.core.id)) {
        return {
          differences: [],
          refusal: {
            code: 'CHARACTER_EXISTS',
            message: `“${subject}” exists now (${c.value.core.rawName}), since this package was planned. Nothing was written. Re-run it with target set to “${subject}” to add its pages.`,
            details: {
              existing: { id: c.value.core.id, name: c.value.core.rawName },
              hint: `Re-run with target: "${subject}".`,
            },
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
        .map((r) =>
          typeof r.text === 'string'
            ? r.text
            : isObj(r.mention) && typeof r.mention.text === 'string'
              ? r.mention.text
              : '',
        )
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
  const kv = (title: string) =>
    props.filter((p) => p.kind === 'keyValue' && factKey(str(p.title) ?? '') === factKey(title));
  const rowsOf = (p: Obj) =>
    (Array.isArray(p.rows) ? (p.rows as Obj[]) : [])
      .slice()
      .sort((a, b) => {
        const ra = str(a.rank) ?? '';
        const rb = str(b.rank) ?? '';
        return ra < rb ? -1 : ra > rb ? 1 : (str(a.id) ?? '') < (str(b.id) ?? '') ? -1 : 1;
      })
      .map((row) => ({
        key: str(row.key) ?? '',
        value: runsText(row.content ?? (row.text ? [{ text: row.text }] : [])),
      }));
  switch (input.check) {
    case 'field': {
      const p = kv(str(input.property) ?? 'PROPERTIES');
      const row =
        p.length === 1
          ? rowsOf(p[0]!).find((x) => factKey(x.key) === factKey(str(input.key) ?? ''))
          : undefined;
      const want = str(input.value);
      if (!row)
        diffs.push({ path: ctx.label, expected: `the row “${String(input.key)}”`, actual: '(no row)' });
      else if (want !== null && row.value !== want.trim())
        diffs.push({ path: ctx.label, expected: want, actual: row.value });
      else if (want === null && row.value === '')
        diffs.push({ path: ctx.label, expected: 'a value', actual: '(blank)' });
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
        if (row && row.value !== v.trim())
          diffs.push({ path: `${ctx.label} “${k}”`, expected: v, actual: row.value });
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
      const got = Array.isArray(res.tags)
        ? (res.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      if (want.join('\u0000') !== got.join('\u0000'))
        diffs.push({ path: `${ctx.label} (in order)`, expected: want, actual: got });
      break;
    }
    case 'links': {
      const cols = Array.isArray(input.collections)
        ? (input.collections as { title: string; ids: string[] }[])
        : [];
      for (const c of cols) {
        const hits = props.filter(
          (p) =>
            (p.kind === 'resourceCollection' || p.kind === 'resourceLink') &&
            factKey(str(p.title) ?? '') === factKey(c.title),
        );
        if (hits.length !== 1) {
          diffs.push({
            path: `${ctx.label} ${c.title}`,
            expected: 'one collection',
            actual: `${hits.length}`,
          });
          continue;
        }
        const items = (Array.isArray(hits[0]!.items) ? (hits[0]!.items as Obj[]) : []).map((i) =>
          str(i.resourceId),
        );
        const missing = c.ids.filter((x) => !items.includes(x));
        if (missing.length > 0)
          diffs.push({ path: `${ctx.label} ${c.title}`, expected: c.ids, actual: items });
      }
      break;
    }
    case 'name':
      if (str(res.name) !== str(input.name))
        diffs.push({ path: ctx.label, expected: input.name, actual: res.name ?? null });
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
  // v3 F3b (ADR 0052): the template copy's own headings the plan does not fill are left out (design 1.4: placeholder
  // headings are removed, not left empty); the note names them.
  const plannedTitles = new Set(
    sectionsOf(planned)
      .filter((x) => x.heading)
      .map((x) => textKey(x.title)),
  );
  const dropped = sectionsOf(current)
    .filter((x) => x.heading && !plannedTitles.has(textKey(x.title)) && !x.blocks.some(keepKind))
    .map((x) => x.title);
  const droppedNote = dropped.length ? { droppedHeadings: dropped } : {};
  if (!current.some(keepKind)) return { blocks: planned, note: { kept: 0, ...droppedNote } };
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
    note: {
      kept,
      ...(keptSections.length ? { keptSections } : {}),
      ...droppedNote,
      what: current.filter(keepKind).map((b) => blockText(b) || String((b as Obj).kind)),
    },
  };
}

/**
 * v3 F3b (ADR 0052; design section 3): the Art page filler. The planned blocks are the images section's heading, then
 * per image its label (level 3), the image block (its address bound in the job) and its interpretation. On the page as
 * it is now: appended at the end of its images section (after any image already there), or, when it has none, the
 * section with its heading placed before the first boundary section (Source Boundaries, Unresolved Material), else at
 * the end. Nothing else on the page is touched, so every `unsupported` block stays where it is.
 */
export function appendImages(ctx: FillContext): FillResult {
  const input = (ctx.input ?? {}) as {
    section?: string;
    boundaries?: string[];
    outfit?: { name: string; aliases?: string[] };
  };
  // v3 F7 (ADR 0070, G5): outfit pieces under the outfit's heading.
  if (input.outfit) return placeOutfitImages(ctx, input.outfit, input.boundaries ?? []);
  const section = input.section ?? 'Reference Images';
  const boundaries = (input.boundaries ?? []).map(textKey);
  const current = [...(ctx.current.blocks as LkBlock[])];
  const planned = ctx.planned as LkBlock[];
  const head = planned[0];
  const isHead =
    head !== undefined && (head as Obj).kind === 'heading' && textKey(blockText(head)) === textKey(section);
  const add = isHead ? planned.slice(1) : planned;
  const secs = sectionsOf(current);
  const offset = (upTo: number) => {
    let n = 0;
    for (let i = 0; i < upTo; i++) n += (secs[i]!.heading ? 1 : 0) + secs[i]!.blocks.length;
    return n;
  };
  const at = secs.findIndex((x) => x.heading && textKey(x.title) === textKey(section));
  if (at >= 0) {
    const level = secs[at]!.level;
    let end = at + 1;
    while (end < secs.length && secs[end]!.heading && secs[end]!.level > level) end++;
    current.splice(offset(end), 0, ...add);
    return { blocks: current, note: { appendedTo: secs[at]!.title, blocks: add.length } };
  }
  const withHead = isHead ? planned : planned;
  const b = secs.findIndex((x) => x.heading && boundaries.includes(textKey(x.title)));
  if (b >= 0) current.splice(offset(b), 0, ...withHead);
  else current.push(...withHead);
  return { blocks: current, note: { madeSection: section, blocks: withHead.length } };
}

/**
 * v3 F7.1 (ADR 0072): the Compact → Core upgrade's text change, on the page as it is when the job runs: the wording rules
 * on the blocks the plan named, the image blocks it named removed while each still shows the planned file, then (the Art
 * page) the Core's images it lacked appended under its images section, as the Art filler appends. Nothing else is
 * touched, so every `unsupported` block stays where it is.
 */
export function coreTextFill(ctx: FillContext): FillResult {
  const input = (ctx.input ?? {}) as CoreTextInput;
  const done = applyCoreText(ctx.current.blocks as LkBlock[], input);
  if ((ctx.planned ?? []).length === 0)
    return { blocks: done.blocks, note: { replaced: done.replaced, removed: done.removed } };
  const appended = appendImages({
    ...ctx,
    input: { section: input.section ?? 'Reference Images', boundaries: input.boundaries ?? [] },
    current: { version: ctx.current.version, blocks: done.blocks },
  });
  return {
    blocks: appended.blocks,
    note: { replaced: done.replaced, removed: done.removed, ...(appended.note ?? {}) },
  };
}

// ============================================================================================ v3 F7: outfit art

const isHeading = (b: unknown): boolean => isObj(b) && b.kind === 'heading';
const levelOf = (b: unknown): number => (isObj(b) && typeof b.level === 'number' ? b.level : 1);

/** A heading block of `text` at `level` (1 to 6), with a new id. */
function heading(text: string, level: number): LkBlock {
  return {
    id: mintClientId(),
    kind: 'heading',
    level: Math.min(6, Math.max(1, level)),
    content: [{ text }],
  };
}

/** The pieces' blocks with each label heading set to `level` (capped at 6); every other block as planned. */
function relevel(blocks: readonly LkBlock[], level: number): LkBlock[] {
  return blocks.map((b) =>
    isHeading(b) ? ({ ...(b as Obj), level: Math.min(6, Math.max(1, level)) } as unknown as LkBlock) : b,
  );
}

/** Where a heading's section ends: the next heading of the same or a higher level (or the end). */
function sectionEnd(blocks: readonly LkBlock[], at: number): number {
  const level = levelOf(blocks[at]);
  for (let i = at + 1; i < blocks.length; i++)
    if (isHeading(blocks[i]) && levelOf(blocks[i]) <= level) return i;
  return blocks.length;
}

/**
 * v3 F7 (ADR 0070, G5): outfit pieces on an existing Art page, placed when the job runs, on the page as it is then:
 *
 * 1. under an existing heading anywhere on the page that names the outfit or one of its aliases (Soraya's page nests
 *    them under "Approved Rangawan Wardrobe"): at the end of its section, the labels one level below it;
 * 2. else a new heading naming the outfit at the end of the page's first heading holding "Wardrobe", one level below it;
 * 3. else a new "Wardrobe" section (level 2) before the first boundary section (else at the end), the outfit's heading
 *    at level 3 and the labels at level 4.
 *
 * The planned blocks are the outfit's heading, then per image its label, the image block and its interpretation. Nothing
 * else on the page is touched.
 */
export function placeOutfitImages(
  ctx: FillContext,
  outfit: { name: string; aliases?: string[] },
  boundaries: readonly string[],
): FillResult {
  const current = [...(ctx.current.blocks as LkBlock[])];
  const planned = ctx.planned as LkBlock[];
  const keys = new Set([outfit.name, ...(outfit.aliases ?? [])].map(textKey));
  const head = planned[0];
  const pieces =
    head !== undefined && isHeading(head) && keys.has(textKey(blockText(head))) ? planned.slice(1) : planned;
  const named = current.findIndex((b) => isHeading(b) && keys.has(textKey(blockText(b))));
  if (named >= 0) {
    const end = sectionEnd(current, named);
    current.splice(end, 0, ...relevel(pieces, levelOf(current[named]) + 1));
    return {
      blocks: current,
      note: { outfit: outfit.name, appendedTo: blockText(current[named]!), blocks: pieces.length },
    };
  }
  const wardrobe = current.findIndex((b) => isHeading(b) && /wardrobe/i.test(blockText(b)));
  if (wardrobe >= 0) {
    const level = levelOf(current[wardrobe]) + 1;
    const end = sectionEnd(current, wardrobe);
    current.splice(end, 0, heading(outfit.name, level), ...relevel(pieces, level + 1));
    return {
      blocks: current,
      note: {
        outfit: outfit.name,
        madeHeadingUnder: blockText(current[wardrobe]!),
        blocks: pieces.length + 1,
      },
    };
  }
  const bounds = boundaries.map(textKey);
  const b = current.findIndex((x) => isHeading(x) && bounds.includes(textKey(blockText(x))));
  const add = [heading('Wardrobe', 2), heading(outfit.name, 3), ...relevel(pieces, 4)];
  if (b >= 0) current.splice(b, 0, ...add);
  else current.push(...add);
  return { blocks: current, note: { outfit: outfit.name, madeSection: 'Wardrobe', blocks: add.length } };
}

/**
 * v3 F7 (ADR 0070, G2, G9): before an art job writes, each loose piece it moves is read live: still there, still in
 * the folder the plan read it in. Else the job stops (ART_LAYOUT_CHANGED) before any write: plan it again.
 */
async function artLayoutCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = (ctx.input ?? {}) as { moves?: { assetId: string; name: string; folderId: string | null }[] };
  const changed: string[] = [];
  for (const m of input.moves ?? []) {
    const r = await ctx.read('getAsset', { path: { assetId: m.assetId } });
    const a = (r.body ?? {}) as Obj;
    if (!r.exists) changed.push(`“${m.name}” is gone`);
    else if ((a.folderId ?? null) !== m.folderId) changed.push(`“${m.name}” has been moved`);
  }
  if (changed.length === 0) return { differences: [] };
  return {
    differences: [],
    refusal: {
      code: 'ART_LAYOUT_CHANGED',
      message: `The character’s Wardrobe changed since this was planned (${changed.join('; ')}). Nothing was written; plan it again.`,
      details: { changed },
    },
  };
}

/** v3 F7 (ADR 0070, G3): the outfit record, from the ids the job's own steps returned. */
function recordOutfit(d: PackEngineDeps, job: JobView, r: Obj): Record<string, unknown> {
  const idOf = (n: unknown): string | null => {
    if (typeof n !== 'number' || !d.stepValue) return null;
    const v = d.stepValue(job.id, n) as { id?: unknown } | null | undefined;
    return typeof v?.id === 'string' ? v.id : null;
  };
  const characterFolderId = str(r.characterFolderId) ?? idOf(r.characterFolderStep);
  if (!characterFolderId) return { recorded: null, reason: 'the character’s folder is not known' };
  const pieces = (Array.isArray(r.pieces) ? (r.pieces as Obj[]) : [])
    .map((p) => ({ assetId: idOf(p.assetStep), name: str(p.name) ?? '' }))
    .filter((p): p is { assetId: string; name: string } => p.assetId !== null);
  const moved = (Array.isArray(r.moved) ? (r.moved as Obj[]) : [])
    .map((p) => ({ assetId: str(p.assetId), name: str(p.name) ?? '' }))
    .filter((p): p is { assetId: string; name: string } => p.assetId !== null);
  const rec = d.outfits!.recordPlacement({
    projectId: job.projectId,
    characterFolderId,
    characterName: str(r.characterName) ?? '',
    outfit: str(r.outfit) ?? '',
    folderId: str(r.folderId) ?? idOf(r.folderStep),
    pieces: [...moved, ...pieces],
    by: job.approvedBy ?? job.principalId,
  });
  return {
    recorded: 'art_outfit',
    outfitId: rec.id,
    outfit: rec.name,
    folderId: rec.folderId,
    pieces: rec.pieces.length,
    // G5: lines on the character's pages naming a moved piece: for the owner, never edited.
    ...(Array.isArray(r.linesForOwner) && r.linesForOwner.length ? { linesForOwner: r.linesForOwner } : {}),
  };
}
