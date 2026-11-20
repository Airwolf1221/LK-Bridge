/**
 * v3 F4b (ADR 0064; the owner-approved design docs/design/F4b-consistency-and-as-of.md): the consistency check and "as
 * of a date".
 *
 * Both read the snapshots (the appraisal's overlay and full-text units), the chronology's tables and the calendar engine,
 * through the facts index (./facts-index.ts): **free**. `live: true` re-reads the identity pages' sidebars a result rests
 * on (one read each). Neither ever writes, repairs or picks a winner (Repository Automation's Default Boundary: report,
 * never repair); the only write is the owner's own pick (design D6, ./fix.ts), made into one ordinary proposal.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Appraisal } from '../appraisal/service.js';
import type { PageReader } from '../appraisal/reader.js';
import { extractPage } from '../appraisal/extract.js';
import type { AppraisalFinding, AppraisalReport, Group } from '../appraisal/types.js';
import { AppraisalError, TOOL_GROUPS } from '../appraisal/types.js';
import { newRunId } from '../appraisal/store.js';
import type { Calendar, DateTextStyle } from '../calendar/index.js';
import { DEFAULT_DATE_STYLE } from '../calendar/index.js';
import type { Chronology } from '../chronology/index.js';
import { findTable } from '../chronology/table.js';
import type { Db } from '../db/open.js';
import { lifecycleFrom, type LifecycleConfig } from '../lifecycle/settings.js';
import type { RepoCtx } from '../mcp/tools/repo.js';
import { textKey } from '../packs/engine/text.js';
import {
  currentCharacters,
  nameKeyOf,
  splitAliases,
  subjectPart,
  usableName,
  type CharacterRecord,
} from '../packs/naming/namesakes.js';
import type { ConsistencyRules, PackRules } from '../packs/types.js';
import type { ProjectTypes } from '../registry/index.js';
import { sidebarPiece } from '../snapshots/canonical.js';
import { treeSettingsFrom } from '../tree/classify.js';
import type { TreeMeta, TreeNode, TreeQueries } from '../tree/index.js';
import {
  compareCharacter,
  FINDING_CODE,
  LABEL_SEVERITY,
  LABEL_TEXT,
  type Disagreement,
  type Label,
  type PageInfo,
  type ValueView,
  identityKey,
} from './compare.js';
import type { Edit, Picker } from './fix.js';
import type { ConsistencyAuditItem } from '../audits/context.js';
import {
  describe as describeDate,
  elapsedYears,
  overlaps,
  readCell,
  readLeading,
  spanOf,
  type DateReading,
  type Span,
} from './dates.js';
import {
  compilePatterns,
  extractPageFacts,
  type ChronologyRowInput,
  type Compiled,
  type MatchedAs,
} from './extract.js';
import { FactIndex, type StoredFact } from './facts-index.js';

type Obj = Record<string, unknown>;

export const CONSISTENCY_TOOL = 'arkona_consistency';
/** The pack whose tools these are. */
export const PACK_ID = 'arkona';
/** The most characters one `arkona_as_of` answers (design: `characters[] (≤ 25)`). */
export const MAX_AS_OF = 25;
/** The most identity pages `live: true` re-reads in one call. */
export const MAX_LIVE = 25;
/** Main CANON's continuity (design D9). */
export const MAIN = 'Main CANON';

export class ConsistencyError extends Error {
  override readonly name = 'ConsistencyError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export interface ConsistencyDeps {
  readonly db: Db;
  readonly appraisal: Pick<Appraisal, 'rules' | 'reader' | 'index' | 'store' | 'freshness'>;
  readonly tree: { readonly queries: TreeQueries };
  readonly registry: { forProject(projectId: string): ProjectTypes };
  readonly chronology: Pick<Chronology, 'config' | 'calendar'>;
  /** A snapshot piece by its hash (the snapshot store). */
  readonly piece: (sha256: string) => Promise<unknown>;
  readonly projectSettings: (projectId: string) => Readonly<Record<string, unknown>>;
  readonly now: () => number;
  readonly audit?: (
    actor: string,
    action: string,
    target: string | null,
    before?: unknown,
    after?: unknown,
  ) => void;
}

/** A live read (`live: true`): the tool's own governed read. */
export type LiveRead = (op: string, params: Obj) => Promise<unknown>;

/** Everything one request works from (made per request: nothing is kept between them). */
export interface World {
  readonly projectId: string;
  readonly rules: ConsistencyRules;
  readonly pack: PackRules;
  readonly compiled: Compiled;
  readonly ctx: RepoCtx;
  readonly lifecycle: LifecycleConfig;
  readonly reader: PageReader;
  readonly cal: Calendar | null;
  readonly style: DateTextStyle;
  readonly characters: readonly CharacterRecord[];
  readonly byIdentity: ReadonlyMap<string, CharacterRecord>;
  /** A name's key → the identity pages it names (as a full name or alias). */
  readonly names: ReadonlyMap<string, ReadonlySet<string>>;
  /** A given name's key → the identity pages whose given name it is. */
  readonly given: ReadonlyMap<string, ReadonlySet<string>>;
  readonly chronologyPageId: string | null;
  readonly problems: readonly string[];
  /** A page's lifecycle, area, name and path (labels from the overlay; never guessed). */
  page(id: string): PageInfo;
  /** A page's continuity: `Main CANON`, or the AU's name (its Continuity fact). */
  continuityOf(id: string): string;
  /** The character (by identity page) whose set holds a page, or null. */
  ownerOf(id: string): string | null;
  /** `live: true`: an identity page's sidebar facts read now, standing in for the snapshot's in this request only. */
  readonly live: Map<string, StoredFact[]>;
}

/** A character's facts in one continuity, its reference and how it was reached. */
export interface CharacterFacts {
  readonly character: CharacterRecord;
  readonly continuity: string;
  readonly identityPageId: string;
  readonly facts: readonly StoredFact[];
  /** Main CANON's identity facts shown for an AU that has none of its own (D9). */
  readonly inherited: ReadonlyMap<string, StoredFact>;
  /** Facts naming a name two characters share, outside either's own pages: never attributed (D2). */
  readonly ambiguous: number;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const iso = (t: number) => new Date(t).toISOString();

/** The fingerprint a consistency finding is known by in every run (and the audits' and the dashboard's). */
export function consistencyId(
  projectId: string,
  d: Disagreement,
  identityPageId: string,
  continuity: string,
): string {
  return `cf_${sha1([projectId, identityPageId, continuity, d.kind, d.field ?? '', d.row ?? '', d.label].join('\u0001')).slice(0, 20)}`;
}

const GROUP_OF: Readonly<Record<Label, Group>> = {
  contradictory: 'contradictory',
  differs: 'differs',
  gap: 'gaps',
  historical: 'historical',
  unreadable: 'unreadable',
};

export class Consistency {
  readonly facts: FactIndex;
  private readonly calendarKeys = new WeakMap<object, string>();
  /** D6: makes the owner's pick into one proposal (set by the runtime: it needs the tool layer's deps). */
  private picker: Picker | null = null;

  setPicker(p: Picker): void {
    this.picker = p;
  }

  constructor(readonly d: ConsistencyDeps) {
    this.facts = new FactIndex(d.db, d.now);
  }

  // ============================================================================================ the world

  /** The rules: the approved pack version's consistency data (refused when the approved version has none). */
  rules(projectId: string): { pack: PackRules; rules: ConsistencyRules } {
    let pack: PackRules;
    try {
      pack = this.d.appraisal.rules(projectId);
    } catch (e) {
      if (e instanceof AppraisalError) throw new ConsistencyError(e.code, e.message);
      throw e;
    }
    if (!pack.consistency)
      throw new ConsistencyError(
        'CONSISTENCY_NOT_CONFIGURED',
        'The approved Arkona pack version has no consistency rules yet: the owner approves the version arkona-2026-11-20-f4b (or later) on the Packs page.',
      );
    return { pack, rules: pack.consistency };
  }

  private repo(projectId: string): RepoCtx {
    // The tree's answers only: `pd` is never read by the helpers this module calls (the namesakes' scan and labels).
    return {
      pd: undefined as never,
      projectId,
      tree: this.d.tree.queries,
      types: this.d.registry.forProject(projectId),
      meta: this.d.tree.queries.status(projectId) as TreeMeta,
      now: this.d.now(),
    };
  }

  private calendarKey(cal: Calendar | null): string {
    if (!cal) return 'none';
    const def = cal.engine.definition as unknown as object;
    let k = this.calendarKeys.get(def);
    if (!k) {
      k = sha1(JSON.stringify(cal.engine.definition));
      this.calendarKeys.set(def, k);
    }
    return k;
  }

  /** The chronology's rows, read from the snapshots (one table piece at a time). */
  private async rows(projectId: string, reader: PageReader): Promise<ChronologyRowInput[]> {
    let cfg;
    try {
      cfg = this.d.chronology.config(projectId);
    } catch {
      return [];
    }
    if (!cfg.resourceId) return [];
    const page = reader.page(cfg.resourceId);
    if (!page) return [];
    const out: ChronologyRowInput[] = [];
    for (const age of cfg.ages) {
      const doc = page.documents.find((x) => x.id === age.tableDocumentId);
      if (!doc) continue;
      const piece = (await this.d.piece(doc.sha256)) as { blocks?: unknown[] } | null;
      const found = piece?.blocks
        ? findTable(piece.blocks, { event: cfg.columns.event, date: cfg.columns.date, kcy: cfg.columns.kcy })
        : null;
      if (!found) continue;
      for (const row of found.table.rows) {
        if (!row.id) continue;
        const event = row.cells[found.columns.event];
        out.push({
          pageId: page.id,
          documentId: doc.id,
          rowId: row.id,
          event: event?.text ?? '',
          date: row.cells[found.columns.date]?.text ?? '',
          mentions: [...new Set(row.cells.flatMap((c) => c.mentions.map((m) => m.resourceId)))],
        });
      }
    }
    return out;
  }

  /**
   * Everything a request works from: the rules, the overlay (caught up), the current characters and their names, the
   * calendar, and the facts index brought up to date. Free: the bridge's database and the snapshot store only.
   */
  async world(projectId: string): Promise<World> {
    const { pack, rules } = this.rules(projectId);
    const compiled = compilePatterns(rules);
    let opened: Awaited<ReturnType<ConsistencyDeps['appraisal']['reader']>>;
    try {
      opened = await this.d.appraisal.reader(projectId);
    } catch (e) {
      if (e instanceof AppraisalError) throw new ConsistencyError(e.code, e.message);
      throw e;
    }
    const { reader, state } = opened;
    const ctx = this.repo(projectId);
    const lifecycle = lifecycleFrom(this.d.projectSettings(projectId));
    const scan = currentCharacters({ ctx, rules: pack, lifecycle, include: new Set(['legacy', 'design']) });
    const usable = usableName(pack);
    const names = new Map<string, Set<string>>();
    const given = new Map<string, Set<string>>();
    const add = (m: Map<string, Set<string>>, text: string | null | undefined, id: string) => {
      if (!text || !usable(text)) return;
      const k = nameKeyOf(text);
      if (k === '') return;
      m.set(k, (m.get(k) ?? new Set<string>()).add(id));
    };
    for (const c of scan.characters) {
      const id = c.identity.id;
      for (const n of [...c.names.full, ...c.names.aliases]) add(names, n, id);
      if (c.names.given && c.names.surname && usable(c.names.given) && usable(c.names.surname)) {
        add(names, `${c.names.given} ${c.names.surname}`, id);
        add(names, `${c.names.surname} ${c.names.given}`, id);
      }
      add(given, c.names.given, id);
    }
    let cal: Calendar | null = null;
    let style: DateTextStyle = DEFAULT_DATE_STYLE;
    let chron: Obj = {};
    let chronologyPageId: string | null = null;
    try {
      const cfg = this.d.chronology.config(projectId);
      cal = this.d.chronology.calendar(projectId);
      style = cfg.style.date;
      chronologyPageId = cfg.resourceId && reader.page(cfg.resourceId) ? cfg.resourceId : null;
      chron = { r: cfg.resourceId, a: cfg.ages.map((a) => a.tableDocumentId), c: cfg.columns, s: cfg.style };
    } catch {
      // No chronology settings: no rows, no calendar.
    }
    const entries = [
      ...[...names].map(([k, v]) => `n:${k}:${[...v].sort().join(',')}`),
      ...[...given].map(([k, v]) => `g:${k}:${[...v].sort().join(',')}`),
    ].sort();
    const key = sha1(JSON.stringify({ rules, entries, cal: this.calendarKey(cal), chron, v: 1 }));
    const nameIndex = {
      lookup: (k: string): MatchedAs | null => (names.has(k) ? 'name' : given.has(k) ? 'given' : null),
    };
    await this.facts.ensure(
      projectId,
      { pages: this.d.appraisal.index.pages(projectId), baseSnapshotId: state.baseSnapshotId },
      {
        key,
        ctx: { compiled, names: nameIndex, cal, style },
        rows: () => this.rows(projectId, reader),
        chronologyPageId,
      },
    );
    const byIdentity = new Map(scan.characters.map((c) => [c.identity.id, c]));
    const auType = pack.tags.au?.continuityType ?? 'AU';
    const continuity = new Map<string, string>();
    const continuityOf = (id: string): string => {
      let c = continuity.get(id);
      if (c === undefined) {
        const m = this.facts.pageMeta(projectId, id);
        c =
          m && m.continuityType && textKey(m.continuityType) === textKey(auType)
            ? (m.continuity ?? '').trim() || 'AU'
            : MAIN;
        continuity.set(id, c);
      }
      return c;
    };
    const owners = new Map<string, string | null>();
    const coreOf = (id: string): string | null => {
      const r = ctx.types.characterOfPage(id);
      return r.ok ? r.value.core.id : null;
    };
    const identityOfCore = new Map<string, string>();
    for (const c of scan.characters) {
      const core = coreOf(c.identity.id);
      if (core) identityOfCore.set(core, c.identity.id);
    }
    const ownerOf = (id: string): string | null => {
      if (byIdentity.has(id)) return id;
      if (!owners.has(id)) {
        const core = coreOf(id);
        owners.set(id, core ? (identityOfCore.get(core) ?? null) : null);
      }
      return owners.get(id) ?? null;
    };
    const infos = new Map<string, PageInfo>();
    const page = (id: string): PageInfo => {
      let p = infos.get(id);
      if (!p) {
        const o = reader.page(id);
        const t = ctx.tree.node(projectId, id).data;
        const l = o ? reader.labels(id) : null;
        p = {
          id,
          name: o?.rawName ?? t?.rawName ?? id,
          path: o ? reader.pathText(id) : (t?.path.names.join(' / ') ?? ''),
          lifecycle: l?.lifecycle ?? null,
          area: l?.area ?? null,
        };
        infos.set(id, p);
      }
      return p;
    };
    return {
      projectId,
      rules,
      pack,
      compiled,
      ctx,
      lifecycle,
      reader,
      cal,
      style,
      characters: scan.characters,
      byIdentity,
      names,
      given,
      chronologyPageId,
      problems: [
        ...compiled.problems,
        ...(cal
          ? []
          : [
              'The chronology’s calendar is not available to the bridge yet, so no date can be read (the chronology tools read and keep it).',
            ]),
      ],
      page,
      continuityOf,
      ownerOf,
      live: new Map(),
    };
  }

  // ============================================================================================ a character's facts

  /**
   * The facts about one character in one continuity (D2, D9): by its names and aliases (a name two characters share only
   * on one's own pages), by its given name only on its own pages, its own pages' sidebars, and the chronology rows
   * naming it; only pages of that continuity; the Archived pages and the non-current areas only when `include` asks.
   */
  characterFacts(
    w: World,
    c: CharacterRecord,
    o: { readonly continuity?: string; readonly include?: ReadonlySet<string> } = {},
  ): CharacterFacts {
    const id = c.identity.id;
    const own = w.continuityOf(id);
    const continuity = o.continuity ?? own;
    const include = o.include ?? new Set<string>();
    const keys = new Set<string>();
    for (const [k, ids] of w.names) if (ids.has(id)) keys.add(k);
    const givenKeys = new Set<string>();
    for (const [k, ids] of w.given) if (ids.has(id)) givenKeys.add(k);
    const candidates = this.facts.factsAbout(w.projectId, [...keys, ...givenKeys]);
    // Rows naming it by a mention of one of its pages (`page:<id>`).
    const mentioned = this.d.db
      .prepare(
        `SELECT DISTINCT subject_key FROM consistency_facts WHERE project_id = ? AND matched_as = 'mention'`,
      )
      .all(w.projectId) as { subject_key: string }[];
    const pageKeys = mentioned.map((r) => r.subject_key).filter((k) => w.ownerOf(k.slice(5)) === id);
    const all = [
      ...candidates,
      ...this.facts.factsAbout(w.projectId, pageKeys),
      ...this.facts.factsOn(w.projectId, [id]),
    ].filter((f) => !(f.matchedAs === 'page' && w.live.has(f.pageId)));
    for (const [pageId, list] of w.live)
      if (pageId === id || keys.has(list[0]?.subjectKey ?? '')) all.push(...list);
    const seen = new Set<string>();
    let ambiguous = 0;
    const facts: StoredFact[] = [];
    for (const f of all) {
      const k = `${f.pageId}:${f.seq}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const p = w.page(f.pageId);
      if (p.area && !include.has(p.area)) continue;
      if (p.lifecycle === 'Archived' && !include.has('archived')) continue;
      if (f.source !== 'chronology' && w.continuityOf(f.pageId) !== continuity) continue;
      if (f.source === 'chronology' && continuity !== MAIN) continue;
      const ownPage = w.ownerOf(f.pageId) === id;
      if (f.pageId !== id) {
        if (f.matchedAs === 'given' && !ownPage) continue;
        if (f.matchedAs === 'mention' && w.ownerOf(f.subjectKey.slice(5)) !== id) continue;
        if (f.matchedAs === 'name' || f.matchedAs === 'page') {
          // A name several characters of this continuity share counts only on one's own pages.
          const sharing = [...(w.names.get(f.subjectKey) ?? [])].filter(
            (x) => w.continuityOf(x) === continuity || w.continuityOf(x) === own,
          );
          if (sharing.length > 1 && !ownPage) {
            ambiguous++;
            continue;
          }
          if (!sharing.includes(id) && !ownPage) continue;
        }
        // A page's own sidebar restates the character only when its subject IS the character (or it is one of its pages).
        if (f.matchedAs === 'page' && !ownPage && !keys.has(f.subjectKey)) continue;
      } else if (f.matchedAs !== 'page' && f.source !== 'prose') continue;
      facts.push(f);
    }
    // D9: an AU without an identity page of its own shows Main CANON's identity facts, labelled.
    const inherited = new Map<string, StoredFact>();
    let identityPageId = id;
    if (continuity !== own && own === MAIN) {
      const main = this.facts.factsOn(w.projectId, [id]).filter((f) => f.matchedAs === 'page');
      for (const f of main) {
        const k = f.kind === 'identity' ? `identity:${textKey(f.field ?? '')}` : f.kind;
        if (!inherited.has(k) && (f.gap || f.date || f.kind === 'identity')) inherited.set(k, f);
      }
      identityPageId = id;
    }
    return { character: c, continuity, identityPageId, facts, inherited, ambiguous };
  }

  /** Whether a chronology row relates to a page: the row mentions it, or the page links to the row's table (D1). */
  private rowRelates(w: World): (row: StoredFact, pageId: string) => boolean {
    const links = new Set(
      w.chronologyPageId
        ? (
            this.d.db
              .prepare(
                `SELECT DISTINCT from_page, to_document FROM appraisal_refs WHERE project_id = ? AND to_page = ?`,
              )
              .all(w.projectId, w.chronologyPageId) as { from_page: string; to_document: string | null }[]
          ).map((r) => `${r.from_page}:${r.to_document ?? ''}`)
        : [],
    );
    return (row, pageId) =>
      row.mentions.includes(pageId) ||
      links.has(`${pageId}:${row.documentId ?? ''}`) ||
      links.has(`${pageId}:`);
  }

  /** Every disagreement of one character (D3, D4), with its stable id. */
  disagreements(w: World, cf: CharacterFacts): { id: string; d: Disagreement }[] {
    const list = compareCharacter({
      cal: w.cal,
      margin: w.rules.approxMargin,
      page: (id) => w.page(id),
      identityPageId: cf.identityPageId,
      facts: cf.facts,
      inherited: cf.inherited,
      inheritedLabel: 'inherited from Main CANON',
      rowRelates: this.rowRelates(w),
    });
    return list.map((d) => ({ id: consistencyId(w.projectId, d, cf.identityPageId, cf.continuity), d }));
  }

  // ============================================================================================ arkona_consistency

  /** The characters a scope covers (D5): one subject, a branch, or everything; each in its own continuity. */
  scopeCharacters(
    w: World,
    s: {
      readonly subject?: string;
      readonly underId?: string;
      readonly all?: boolean;
      readonly continuity?: string;
    },
  ): CharacterRecord[] {
    // No continuity: every character in its own. Main CANON: its characters. An AU: its own characters, and Main CANON's
    // (their values inherited where the AU states none; one with no fact on the AU's pages is not reported).
    const inContinuity = (c: CharacterRecord) =>
      s.continuity === undefined ||
      w.continuityOf(c.identity.id) === s.continuity ||
      (s.continuity !== MAIN && w.continuityOf(c.identity.id) === MAIN);
    if (s.subject !== undefined) return this.resolveCharacters(w, s.subject, s.continuity);
    if (s.underId !== undefined)
      return w.characters.filter((c) => this.underOf(w, c, s.underId!)).filter(inContinuity);
    return w.characters.filter(inContinuity);
  }

  private underOf(w: World, c: CharacterRecord, under: string): boolean {
    const n = w.ctx.tree.node(w.projectId, c.identity.id).data;
    return n !== null && n.path.ids.includes(under);
  }

  /** One character by a name, alias, page or id (refused when it names several: pass the identity page's id). */
  resolveCharacters(w: World, q: string, continuity?: string): CharacterRecord[] {
    const byId = w.byIdentity.get(q) ?? (w.ownerOf(q) ? w.byIdentity.get(w.ownerOf(q)!) : undefined);
    if (byId) return [byId];
    const k = nameKeyOf(q);
    let ids = [...(w.names.get(k) ?? [])];
    if (ids.length === 0) {
      // A page's name or path: the registry's resolution, then its character.
      try {
        const r = w.ctx.types.resolve(q, {});
        if (r.status === 'resolved') {
          const owner = w.ownerOf(r.node.id);
          if (owner) ids = [owner];
        }
      } catch {
        // Not a page.
      }
    }
    if (continuity !== undefined && ids.length > 1) {
      const narrowed = ids.filter((id) => w.continuityOf(id) === continuity);
      if (narrowed.length > 0) ids = narrowed;
    } else if (ids.length > 1) {
      const main = ids.filter((id) => w.continuityOf(id) === MAIN);
      if (main.length === 1) ids = main;
    }
    if (ids.length === 0)
      throw new ConsistencyError(
        'NOT_FOUND',
        `“${q}” is not a current character the bridge knows (a name, alias, page or id).`,
      );
    if (ids.length > 1)
      throw new ConsistencyError(
        'AMBIGUOUS',
        `“${q}” names ${ids.length} characters: pass the identity page's id.`,
        {
          candidates: ids.map((id) => ({
            id,
            name: w.byIdentity.get(id)?.identity.name ?? id,
            continuity: w.continuityOf(id),
            lifecycle: w.byIdentity.get(id)?.lifecycle ?? null,
          })),
        },
      );
    return [w.byIdentity.get(ids[0]!)!];
  }

  /** A disagreement as a stored finding (the appraisal's shape, so a run is kept and paged like the appraisal's). */
  toFinding(w: World, cf: CharacterFacts, x: { id: string; d: Disagreement }): AppraisalFinding {
    const { d } = x;
    const p = w.page(cf.identityPageId);
    const label = LABEL_TEXT[d.label];
    const values = [d.reference, ...d.restatements];
    const pages = [...new Set(values.map((v) => v.page.id))];
    const what =
      d.kind === 'identity'
        ? `${d.field}`
        : d.kind === 'chronology'
          ? `${d.what} (a chronology row)`
          : d.what;
    const message =
      d.label === 'gap'
        ? `${cf.character.subject}: ${what}: ${d.reference.gap ? 'the identity page leaves it unestablished' : `the identity page records ${d.reference.value}`}, while ${d.restatements.length} other place(s) ${d.reference.gap ? 'give a value' : 'leave it unestablished'} (a gap, never a conflict).`
        : d.label === 'unreadable'
          ? `${cf.character.subject}: ${what}: ${d.restatements.length} date(s) the calendar cannot read (each reported with its text; never guessed).`
          : `${label}: ${cf.character.subject}’s ${what} is ${d.reference.value} on “${d.reference.page.name}”${d.referenceFromRestatement ? ' (the identity page records none)' : ''}, but ${d.restatements.map((r) => `${r.value} on “${r.page.name}”`).join('; ')}.`;
    return {
      id: x.id,
      tool: CONSISTENCY_TOOL as AppraisalFinding['tool'],
      check: FINDING_CODE[d.kind],
      group: GROUP_OF[d.label],
      evidence:
        d.label === 'contradictory'
          ? 'Contradictory'
          : d.label === 'differs'
            ? 'Proposal differs from canon'
            : d.label === 'gap'
              ? 'Gap'
              : d.label === 'unreadable'
                ? 'Incomplete'
                : 'Review signal',
      rule: { page: 'Repository Automation', section: 'Default Boundary', rule: 'report, never repair' },
      page: { id: p.id, name: p.name, path: p.path },
      message,
      details: {
        subject: cf.character.subject,
        identityPage: { id: cf.identityPageId, name: p.name },
        continuity: cf.continuity,
        kind: d.kind,
        what: d.what,
        ...(d.field ? { field: d.field } : {}),
        label,
        severity: LABEL_SEVERITY[d.label],
        reference: d.reference,
        ...(d.referenceFromRestatement
          ? {
              referenceNote:
                'the identity page records none: the first Authoritative restatement is shown first',
            }
          : {}),
        restatements: d.restatements,
        ...(d.row ? { row: d.row } : {}),
        pages,
      },
      followUp: {
        kind: 'judgement',
        tool: 'the dashboard’s “Pick the right value” (the owner only); an agent may suggest one with arkona_consistency_suggest',
        decide: 'which value is right: the check never decides',
      },
      source: { kind: 'snapshot', takenAt: this.d.now(), ageMs: 0 },
      labels: { lifecycle: p.lifecycle, branch: null },
    };
  }

  /** One run (D5): every finding of the scope, stored as a run (read a page at a time with its `runId`). */
  async run(o: {
    readonly projectId: string;
    readonly subject?: string;
    readonly underId?: string;
    readonly all?: boolean;
    readonly include?: readonly string[];
    readonly continuity?: string;
    readonly actor: string;
    readonly live?: LiveRead;
  }): Promise<AppraisalReport> {
    const startedAt = this.d.now();
    const w = await this.world(o.projectId);
    const include = new Set(o.include ?? []);
    const characters = this.scopeCharacters(w, o);
    let reads = 0;
    if (o.live) reads = await this.readLive(w, characters, o.live);
    const findings: AppraisalFinding[] = [];
    let ambiguous = 0;
    for (const c of characters) {
      const continuity = o.continuity ?? w.continuityOf(c.identity.id);
      const cf = this.characterFacts(w, c, { continuity, include });
      ambiguous += cf.ambiguous;
      if (continuity !== w.continuityOf(c.identity.id) && cf.facts.length === 0) continue;
      for (const x of this.disagreements(w, cf)) findings.push(this.toFinding(w, cf, x));
    }
    const order = TOOL_GROUPS.arkona_consistency;
    findings.sort(
      (a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.message.localeCompare(b.message),
    );
    const counts: Record<string, number> = { total: findings.length };
    for (const g of order) counts[g] = findings.filter((f) => f.group === g).length;
    const st = this.facts.state(o.projectId);
    const scope: Obj = {
      ...(o.subject !== undefined ? { subject: o.subject } : {}),
      ...(o.underId !== undefined ? { under: o.underId } : {}),
      ...(o.all ? { all: true } : {}),
      ...(o.include?.length ? { include: [...o.include] } : {}),
      continuity: o.continuity ?? 'each character’s own',
    };
    const report: AppraisalReport = {
      tool: CONSISTENCY_TOOL as AppraisalReport['tool'],
      runId: newRunId(),
      scope,
      createdAt: iso(this.d.now()),
      source: {
        index: this.d.appraisal.freshness(o.projectId),
        ...(reads > 0 ? { live: { reads, at: iso(this.d.now()) } } : {}),
      },
      inspected: {
        characters: characters.length,
        facts: st?.facts ?? 0,
        pages: st?.pages ?? 0,
        ...(ambiguous > 0 ? { ambiguousNames: ambiguous } : {}),
        leftOut: [
          ...(include.has('archived') ? [] : ['Archived pages']),
          ...(include.has('legacy') ? [] : ['the Legacy Canon Archive']),
          ...(include.has('design') ? [] : ['the Design References']),
        ],
      },
      couldNotCheck: [
        ...w.problems,
        ...(ambiguous > 0
          ? [
              `${ambiguous} sentence(s) name a name several characters share, outside either’s own pages: never attributed (D2).`,
            ]
          : []),
        'Only the pack’s phrasings are read (D2: precision over recall): a restatement written only with a pronoun, or in another phrasing, is not seen.',
      ],
      counts,
      findings,
    };
    return this.d.appraisal.store.save(o.projectId, {
      report,
      scopeKey: JSON.stringify(Object.entries(scope).sort()),
      actor: o.actor,
      startedAt,
    });
  }

  /**
   * `live: true`: each identity page's sidebar re-read now (one read each, at most 25) and its sidebar facts read again
   * from it in place of the snapshot's (prose and rows stay the snapshots'). Returns the reads made.
   */
  private async readLive(w: World, characters: readonly CharacterRecord[], read: LiveRead): Promise<number> {
    const list = characters.slice(0, MAX_LIVE);
    const propertiesName = treeSettingsFrom(this.d.projectSettings(w.projectId) as never).propertiesName;
    for (const c of list) {
      const res = (await read('getResource', { path: { resourceId: c.identity.id } })) as Obj | null;
      if (!res) continue;
      const x = extractPage(
        {
          rawName: String(res.name ?? c.identity.name),
          displayName: c.identity.name,
          resource: res,
          sidebar: sidebarPiece(res.properties ?? []),
          documents: [],
        },
        propertiesName,
      );
      const units = x.units.filter((u) => u.unit === 'name' || u.unit === 'fact');
      const facts = extractPageFacts(c.identity.id, units, {
        compiled: w.compiled,
        names: { lookup: (k) => (w.names.has(k) ? 'name' : w.given.has(k) ? 'given' : null) },
        cal: w.cal,
        style: w.style,
      });
      w.live.set(
        c.identity.id,
        facts.facts.filter((f) => f.matchedAs === 'page').map((f, i) => ({ ...f, seq: 10_000 + i })),
      );
    }
    return list.length;
  }

  // ============================================================================================ the audits, the brief

  /** The Contradictory findings of every current character (D5: the nightly audit's `consistency` category). */
  async contradictions(projectId: string): Promise<AppraisalFinding[]> {
    const w = await this.world(projectId);
    const out: AppraisalFinding[] = [];
    for (const c of w.characters) {
      const cf = this.characterFacts(w, c);
      for (const x of this.disagreements(w, cf))
        if (x.d.label === 'contradictory') out.push(this.toFinding(w, cf, x));
    }
    return out;
  }

  /**
   * The audits' hook (D5): the Contradictory findings as audit items, or null where the consistency rules do not apply
   * (no pack, no consistency rules in the approved version, no snapshot yet).
   */
  async auditItems(projectId: string): Promise<ConsistencyAuditItem[] | null> {
    let list: AppraisalFinding[];
    try {
      list = await this.contradictions(projectId);
    } catch (e) {
      if (e instanceof ConsistencyError) return null;
      throw e;
    }
    return list.map((f) => {
      const d = f.details as Obj;
      const slim = (v: ValueView) => ({
        key: v.key,
        page: { id: v.page.id, name: v.page.name },
        lifecycle: v.lifecycle,
        value: v.value,
        ...(v.precision ? { precision: v.precision } : {}),
        source: v.source,
        ...(v.section ? { section: v.section } : {}),
        excerpt: v.excerpt,
        ...(v.documentId ? { documentId: v.documentId } : {}),
        ...(v.blockId ? { blockId: v.blockId } : {}),
        ...(v.field ? { field: v.field } : {}),
      });
      return {
        id: f.id,
        code: f.check as ConsistencyAuditItem['code'],
        pageId: f.page!.id,
        message: f.message,
        evidence: {
          subject: d.subject,
          continuity: d.continuity,
          what: d.what,
          ...(d.field ? { field: d.field } : {}),
          label: d.label,
          reference: slim(d.reference as ValueView),
          restatements: (d.restatements as ValueView[]).map(slim),
          pages: d.pages,
          ...(d.row ? { row: d.row } : {}),
        },
      };
    });
  }

  // ============================================================================================ arkona_as_of

  /** A date the caller gave (`now` and an empty date mean the pack's present, D10). */
  readDate(w: World, date: string): { reading: DateReading; span: Span; text: string; isPresent: boolean } {
    const isPresent = date.trim() === '' || textKey(date) === 'now' || textKey(date) === 'present';
    const text = isPresent ? w.rules.present : date.trim();
    if (!w.cal)
      throw new ConsistencyError(
        'NO_CALENDAR',
        'The chronology’s calendar is not available to the bridge yet, so no date can be read.',
      );
    const r = readLeading(w.cal, text, w.style);
    if (!r.ok) {
      const c = readCell(w.cal, text, w.style);
      if (!c.ok)
        throw new ConsistencyError(
          'DATE_UNREADABLE',
          `“${text}” is not a date the calendar can read: ${r.reason}.`,
        );
      return { reading: c.reading, span: spanOf(w.cal, c.reading, w.rules.approxMargin), text, isPresent };
    }
    return { reading: r.reading, span: spanOf(w.cal, r.reading, w.rules.approxMargin), text, isPresent };
  }

  /**
   * One character at a date (D7): born (and where), elapsed calendar years, the state recorded, the chronology rows
   * around the date, and any open Contradictory finding on its birth or death. Never apparent or biological age.
   */
  async asOf(o: {
    readonly projectId: string;
    readonly characters: readonly string[];
    readonly date: string;
    readonly continuity?: string;
    readonly window?: number;
    readonly live?: LiveRead;
  }): Promise<Obj> {
    if (o.characters.length > MAX_AS_OF)
      throw new ConsistencyError('TOO_MANY', `At most ${MAX_AS_OF} characters in one call.`);
    const w = await this.world(o.projectId);
    const at = this.readDate(w, o.date);
    const continuity = o.continuity ?? MAIN;
    const resolved: { asked: string; c?: CharacterRecord; error?: Obj }[] = o.characters.map((q) => {
      try {
        return { asked: q, c: this.resolveCharacters(w, q, continuity)[0]! };
      } catch (e) {
        if (e instanceof ConsistencyError)
          return { asked: q, error: { code: e.code, message: e.message, ...e.details } };
        throw e;
      }
    });
    let reads = 0;
    if (o.live)
      reads = await this.readLive(
        w,
        resolved.flatMap((r) => (r.c ? [r.c] : [])),
        o.live,
      );
    const rows = await this.timeline(w);
    const window = o.window ?? 3;
    const answers = resolved.map((r) =>
      r.c ? this.oneAsOf(w, r.c, at, continuity, rows, window) : { asked: r.asked, refused: r.error },
    );
    return {
      date: {
        asked: o.date,
        read: at.text,
        ...(at.isPresent ? { present: `the pack’s present, ${w.rules.present} (D10)` } : {}),
        precision: describeDate(at.reading),
      },
      continuity,
      characters: answers,
      ...(w.problems.length ? { couldNotCheck: w.problems } : {}),
      rule: 'Elapsed calendar years only, never apparent or biological age: Arkona’s races mature and age differently; read the race reference linked for its maturation rules. An attested life never proves survival past it (Character Architecture).',
      freshness: {
        snapshots: this.d.appraisal.freshness(o.projectId),
        ...(reads ? { live: `${reads} identity page(s) re-read now` } : {}),
      },
      cost: reads
        ? `${reads} read(s) (live); the rest free`
        : 'free: the bridge’s snapshots, full-text index, chronology tables and calendar engine',
    };
  }

  /** The chronology's rows with their dates read, once per request (for "around the date"). */
  private async timeline(
    w: World,
  ): Promise<{ row: ChronologyRowInput; span: Span | null; reading: DateReading | null }[]> {
    if (!w.chronologyPageId) return [];
    return (await this.rows(w.projectId, w.reader)).map((row) => {
      const r = w.cal ? readCell(w.cal, row.date, w.style) : null;
      return r && r.ok
        ? { row, reading: r.reading, span: spanOf(w.cal!, r.reading, w.rules.approxMargin) }
        : { row, reading: null, span: null };
    });
  }

  private oneAsOf(
    w: World,
    c: CharacterRecord,
    at: { reading: DateReading; span: Span },
    continuity: string,
    rows: readonly { row: ChronologyRowInput; span: Span | null; reading: DateReading | null }[],
    window: number,
  ): Obj {
    const cf = this.characterFacts(w, c, { continuity });
    const id = c.identity.id;
    const cal = w.cal!;
    const span = (f: StoredFact) => spanOf(cal, f.date!, w.rules.approxMargin);
    const valueOf = (kind: 'birth' | 'death') => {
      const own = cf.facts.filter((f) => f.kind === kind && f.pageId === id && f.source !== 'chronology');
      const pick = own.find((f) => f.date !== null) ?? own.find((f) => f.gap) ?? null;
      if (pick) return { fact: pick, inherited: false };
      const inh = cf.inherited.get(kind);
      if (inh && (inh.date || inh.gap)) return { fact: inh, inherited: true };
      // No value on the identity page: the Authoritative restatements, when they agree.
      const others = cf.facts.filter(
        (f) => f.kind === kind && f.date !== null && w.page(f.pageId).lifecycle === 'Authoritative',
      );
      const first = others[0];
      if (first && others.every((f) => overlaps(span(f), span(first))))
        return { fact: first, inherited: false };
      return null;
    };
    const where = (f: StoredFact, inherited: boolean) => ({
      value: f.valueText,
      precision: f.date ? describeDate(f.date) : null,
      page: { id: f.pageId, name: w.page(f.pageId).name, lifecycle: w.page(f.pageId).lifecycle },
      source: f.source,
      ...(f.section ? { section: f.section } : {}),
      excerpt: f.excerpt,
      ...(inherited ? { label: 'inherited from Main CANON' } : {}),
    });
    const birth = valueOf('birth');
    const death = valueOf('death');
    const born = birth?.fact.date
      ? where(birth.fact, birth.inherited)
      : birth?.fact.gap
        ? {
            ...where(birth.fact, birth.inherited),
            value: 'birth unestablished',
            recorded: birth.fact.valueText,
          }
        : 'birth unestablished';
    let elapsed: Obj | string | null = null;
    if (birth?.fact.date) {
      const e = elapsedYears(cal, { reading: birth.fact.date, span: span(birth.fact) }, at);
      elapsed =
        e.kind === 'not_yet_born'
          ? 'not yet born'
          : e.kind === 'exact'
            ? { years: e.years, exact: true }
            : { min: e.min, max: e.max, exact: false, why: 'a date is approximate, or not a single day' };
    }
    // The state recorded (D7): Alive between birth and a recorded death, or inside the attested span; Deceased after a
    // recorded death; Unestablished otherwise. An attested life never proves survival past it.
    const deathSpan = death?.fact.date ? span(death.fact) : null;
    const birthSpan = birth?.fact.date ? span(birth.fact) : null;
    const attested = cf.facts.filter((f) => f.kind === 'attested' && f.date && f.pageId === id);
    const presentSpan = (() => {
      const r = readLeading(cal, w.rules.present, w.style);
      return r.ok ? spanOf(cal, r.reading, 0) : null;
    })();
    let window_: Span | null = null;
    for (const f of attested) {
      const s = span(f);
      // The attested span runs from the recorded birth (once born and attested alive later, the life is attested in
      // between) or, with no birth recorded, from the attestation's own start; never past the latest attestation.
      const from = birthSpan ? Math.min(birthSpan.to, s.from) : f.bound === 'to' ? null : s.from;
      // "alive at 5A 931": attested up to the present (D10).
      const to = presentSpan && overlaps(s, presentSpan) ? Math.max(s.to, presentSpan.to) : s.to;
      if (from === null) continue;
      window_ = window_ ? { from: Math.min(window_.from, from), to: Math.max(window_.to, to) } : { from, to };
    }
    let state: string;
    let why: string;
    if (deathSpan && at.span.from > deathSpan.to) {
      state = 'Deceased (recorded)';
      why = `after the recorded death (${death!.fact.valueText})`;
    } else if (birthSpan && deathSpan && at.span.from > birthSpan.to && at.span.to < deathSpan.from) {
      state = 'Alive (recorded)';
      why = 'between the recorded birth and the recorded death';
    } else if (
      window_ &&
      at.span.from >= window_.from &&
      at.span.to <= window_.to &&
      !(deathSpan && at.span.to >= deathSpan.from)
    ) {
      state = 'Alive (recorded)';
      why = 'inside the attested span';
    } else {
      state = 'Unestablished';
      why =
        birthSpan && at.span.to < birthSpan.from
          ? 'before the recorded birth'
          : 'nothing recorded places the character alive or dead at this date (an attested life does not prove survival past it)';
    }
    // Around the date: the chronology rows naming the character, nearest each side.
    const names = new Set(
      [...w.names]
        .filter(([, ids]) => ids.has(id))
        .map(([k]) => k)
        .filter((k) => k.length >= 3),
    );
    const naming = rows.filter(
      (r) =>
        r.span &&
        (r.row.mentions.some((m) => w.ownerOf(m) === id) ||
          [...names].some((k) => ` ${nameKeyOf(r.row.event.replace(/['’]s\b/g, ''))} `.includes(` ${k} `))),
    );
    const view = (r: (typeof rows)[number]) => ({
      date: r.row.date,
      event: r.row.event,
      row: r.row.rowId,
      table: r.row.documentId,
    });
    const before = naming
      .filter((r) => r.span!.to < at.span.from)
      .sort((a, b) => b.span!.from - a.span!.from)
      .slice(0, window);
    const during = naming.filter((r) => overlaps(r.span!, at.span));
    const after = naming
      .filter((r) => r.span!.from > at.span.to)
      .sort((a, b) => a.span!.from - b.span!.from)
      .slice(0, window);
    // Open Contradictory findings on its birth or death (so a chapter is not written on a disputed date).
    const disputes = this.disagreements(w, cf)
      .filter((x) => x.d.label === 'contradictory' && (x.d.what === 'birth' || x.d.what === 'death'))
      .map((x) => ({
        id: x.id,
        what: x.d.what,
        kind: x.d.kind,
        values: [x.d.reference, ...x.d.restatements].map((v) => ({ value: v.value, page: v.page.name })),
      }));
    const race = c.names && this.raceOf(w, cf);
    return {
      character: c.subject,
      identityPage: { id, name: c.identity.name, lifecycle: c.lifecycle, continuity: w.continuityOf(id) },
      born,
      elapsedYears: elapsed,
      ...(elapsed === null ? { elapsedNote: 'no age: the birth is not recorded' } : {}),
      ...(death?.fact.date ? { died: where(death.fact, death.inherited) } : {}),
      state: { value: state, why },
      around: {
        before: before.reverse().map(view),
        ...(during.length ? { during: during.map(view) } : {}),
        after: after.map(view),
        window,
      },
      ...(disputes.length
        ? {
            contradictions: disputes,
            warning:
              'its birth or death is disputed between Authoritative pages: ask the owner before writing at this date',
          }
        : {}),
      ...(race ? { raceReference: race } : {}),
    };
  }

  /** The character's race reference (its Race / Species value's page), for the maturation rules (D7): never guessed. */
  private raceOf(w: World, cf: CharacterFacts): Obj | null {
    const fact =
      cf.facts.find(
        (f) =>
          f.kind === 'identity' &&
          textKey(f.field ?? '') === textKey('Race / Species') &&
          f.pageId === cf.identityPageId,
      ) ?? cf.inherited.get(`identity:${textKey('Race / Species')}`);
    const value = fact?.valueText;
    if (!value || fact.gap) return null;
    const k = nameKeyOf(value);
    const hits: TreeNode[] = [];
    for (const kind of ['bsrc', 'bwrk', 'index'] as const)
      for (const n of w.ctx.tree.byKind(w.projectId, kind).data)
        if (
          (nameKeyOf(subjectPart(n.displayName)) === k || n.aliases.some((a) => nameKeyOf(a) === k)) &&
          (/race|species/i.test(n.referenceType ?? '') || /race|species/i.test(n.displayName))
        )
          hits.push(n);
    return hits.length === 1
      ? {
          value,
          page: { id: hits[0]!.id, name: hits[0]!.rawName },
          read: 'its maturation and ageing rules there',
        }
      : {
          value,
          page: null,
          note:
            hits.length > 1
              ? `${hits.length} race references match: open the one meant`
              : 'no race reference page matches this value',
        };
  }

  // ============================================================================================ coverage (D8)

  /** How many characters have a birth the engine can read, a recorded death, attested bounds, or none (D8). */
  async coverage(o: { readonly projectId: string; readonly full?: boolean }): Promise<Obj> {
    const w = await this.world(o.projectId);
    const counts = {
      characters: 0,
      readableBirth: 0,
      unreadableBirth: 0,
      birthUnestablished: 0,
      recordedDeath: 0,
      attestedBounds: 0,
      nothingReadable: 0,
    };
    const nothing: Obj[] = [];
    const unreadable: Obj[] = [];
    for (const c of w.characters) {
      if (w.continuityOf(c.identity.id) !== MAIN) continue;
      counts.characters++;
      const own = this.facts.factsOn(w.projectId, [c.identity.id]).filter((f) => f.matchedAs === 'page');
      const birth = own.filter((f) => f.kind === 'birth');
      const readable = birth.some((f) => f.date);
      if (readable) counts.readableBirth++;
      else if (birth.some((f) => f.unreadable)) {
        counts.unreadableBirth++;
        unreadable.push({
          character: c.subject,
          page: c.identity.name,
          text: birth.find((f) => f.unreadable)!.valueText,
          why: birth.find((f) => f.unreadable)!.unreadable,
        });
      }
      if (birth.some((f) => f.gap) && !readable) counts.birthUnestablished++;
      const death = own.some((f) => f.kind === 'death' && f.date);
      if (death) counts.recordedDeath++;
      const attested = own.some((f) => f.kind === 'attested' && f.date);
      if (attested) counts.attestedBounds++;
      if (!readable && !death && !attested) {
        counts.nothingReadable++;
        nothing.push({
          character: c.subject,
          identityPage: { id: c.identity.id, name: c.identity.name, lifecycle: c.lifecycle },
          ...(birth.some((f) => f.gap) ? { recorded: 'birth deliberately unestablished' } : {}),
        });
      }
    }
    const cap = o.full ? 1000 : 50;
    return {
      counts,
      nothingReadable: nothing.slice(0, cap),
      ...(nothing.length > cap ? { more: nothing.length - cap } : {}),
      ...(unreadable.length ? { unreadableBirths: unreadable.slice(0, cap) } : {}),
      note: 'A report for the owner, not a task list: an unrecorded birth is often deliberate (“birth date unestablished”), and nothing here asks for a date to be added. Never invent a date to fill a gap (Character Architecture).',
      scope:
        'Current Main CANON characters (Authoritative and Working), from their identity pages’ Temporal Scope and Life State as the snapshots hold them.',
      ...(w.problems.length ? { couldNotCheck: w.problems } : {}),
      freshness: this.d.appraisal.freshness(o.projectId),
      cost: 'free',
    };
  }

  // ============================================================================================ the pick (D6)

  /**
   * "Pick the right value" (D6): the owner picks one side's value (`side`, a value's key) or types one (`value`); every
   * page whose value disagrees with it gets an edit, in ONE proposal of items (one per page). The picked side, and any
   * value that agrees with the pick, is never touched; a deliberate gap and a value inherited from Main CANON are never
   * edited (listed). Never runs without the owner: the dashboard's step-up action calls it.
   */
  async pick(o: {
    readonly projectId: string;
    readonly identityPageId: string;
    readonly continuity: string;
    readonly findingId: string;
    readonly side?: string;
    readonly value?: string;
    readonly actor: string;
    readonly auditFindingId?: number;
  }): Promise<Obj> {
    if (!this.picker)
      throw new ConsistencyError('PICK_UNAVAILABLE', 'The pick is not available in this bridge build.');
    const w = await this.world(o.projectId);
    const c = w.byIdentity.get(o.identityPageId);
    if (!c)
      throw new ConsistencyError(
        'FINDING_GONE',
        'The character of this finding is no longer a current character; nothing was proposed.',
      );
    const cf = this.characterFacts(w, c, { continuity: o.continuity });
    const x = this.disagreements(w, cf).find((y) => y.id === o.findingId);
    if (!x)
      throw new ConsistencyError(
        'FINDING_GONE',
        'This disagreement is no longer there (the pages agree now, or changed since): nothing was proposed. Run the check again.',
      );
    const values = [x.d.reference, ...x.d.restatements];
    const sideView = o.side !== undefined ? values.find((v) => v.key === o.side) : undefined;
    if (o.side !== undefined && !sideView)
      throw new ConsistencyError('SIDE_NOT_FOUND', 'That value is not one of this finding’s.');
    const picked = (sideView?.value ?? o.value ?? '').trim();
    if (picked === '')
      throw new ConsistencyError('INVALID_PARAMS', 'Pick one of the values, or type the right one.');
    const isDate = x.d.kind !== 'identity';
    let pickedSpan: Span | null = null;
    if (isDate) {
      if (!w.cal)
        throw new ConsistencyError(
          'NO_CALENDAR',
          'The chronology’s calendar is not available, so no date can be read.',
        );
      const r = readLeading(w.cal, picked, w.style);
      if (!r.ok || r.reading.text.replace(/\s+/g, ' ') !== picked.replace(/\s+/g, ' '))
        throw new ConsistencyError(
          'VALUE_UNREADABLE',
          `“${picked}” is not a date the calendar can read as a whole${r.ok ? '' : `: ${r.reason}`}. Nothing was proposed.`,
        );
      pickedSpan = spanOf(w.cal, r.reading, w.rules.approxMargin);
    }
    const agrees = (v: ValueView): boolean => {
      if (v === sideView) return true;
      if (!isDate) return identityKey(v.value) === identityKey(picked);
      const r =
        v.source === 'chronology'
          ? readCell(w.cal!, v.value, w.style)
          : readLeading(w.cal!, v.value, w.style);
      return r.ok && overlaps(spanOf(w.cal!, r.reading, w.rules.approxMargin), pickedSpan!);
    };
    const edits: Edit[] = [];
    const untouched: Obj[] = [];
    const left: Obj[] = [];
    for (const v of values) {
      if (agrees(v)) {
        untouched.push({
          page: v.page.name,
          value: v.value,
          why: v === sideView ? 'the side picked' : 'agrees with the pick',
        });
        continue;
      }
      if (v.gap || v.unreadable || v.inherited) {
        left.push({
          page: v.page.name,
          value: v.value,
          why: v.gap
            ? 'a deliberate gap: edit it by hand if wanted'
            : v.inherited
              ? 'inherited from Main CANON: not this continuity’s page'
              : 'its date cannot be read',
        });
        continue;
      }
      const base = { pageId: v.page.id, pageName: v.page.name, from: v.value, to: picked };
      if (v.source === 'chronology' && v.documentId && v.blockId)
        edits.push({ ...base, kind: 'row', documentId: v.documentId, rowId: v.blockId });
      else if (v.source === 'prose' && v.documentId && v.blockId)
        edits.push({
          ...base,
          kind: 'prose',
          documentId: v.documentId,
          blockId: v.blockId,
          context: v.excerpt,
        });
      else if (v.field) edits.push({ ...base, kind: 'fact', field: v.field, whole: v.source === 'sidebar' });
      else
        left.push({
          page: v.page.name,
          value: v.value,
          why: 'not a field, sentence or row the bridge can edit',
        });
    }
    if (edits.length === 0)
      throw new ConsistencyError(
        'NOTHING_TO_PROPOSE',
        'Every value already agrees with the pick (or cannot be edited): nothing was proposed.',
        { untouched, left },
      );
    const what =
      x.d.kind === 'identity' ? x.d.what : `${x.d.what}${x.d.kind === 'chronology' ? ' (chronology)' : ''}`;
    const pages = new Set(edits.map((e) => e.pageId)).size;
    const title = `Pick the right value: ${c.subject}’s ${what} → ${picked} (${pages} page${pages === 1 ? '' : 's'})`;
    const r = await this.picker({
      projectId: o.projectId,
      edits,
      title,
      operation: {
        tool: CONSISTENCY_TOOL,
        pick: {
          findingId: o.findingId,
          subject: c.subject,
          what,
          value: picked,
          ...(sideView ? { side: sideView.page.name } : { typed: true }),
        },
        untouched,
        ...(left.length ? { leftAsTheyAre: left } : {}),
      },
    });
    const id = newPickId();
    this.d.db
      .prepare(
        `INSERT INTO consistency_picks (id, project_id, finding_id, audit_finding_id, value, side, picked_by, picked_at,
           proposal_id, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        o.projectId,
        o.findingId,
        o.auditFindingId ?? null,
        picked,
        o.side ?? null,
        o.actor,
        this.d.now(),
        r.proposalId,
        JSON.stringify(r.items.map((i) => i.id)),
      );
    this.d.audit?.(o.actor, 'consistency.pick', o.projectId, null, {
      pick: id,
      finding: o.findingId,
      value: picked,
      side: sideView?.page.name ?? null,
      proposal: r.proposalId,
      pages,
    });
    return {
      pick: id,
      value: picked,
      proposalId: r.proposalId,
      summary: r.summary,
      items: r.items,
      untouched,
      ...(left.length ? { leftAsTheyAre: left } : {}),
      ...(r.notPlanned.length ? { notPlanned: r.notPlanned } : {}),
      reads: r.reads,
    };
  }

  /** The owner's earlier picks of a finding (newest first). */
  picks(projectId: string, findingId: string): Obj[] {
    return (
      this.d.db
        .prepare(
          'SELECT * FROM consistency_picks WHERE project_id = ? AND finding_id = ? ORDER BY picked_at DESC LIMIT 20',
        )
        .all(projectId, findingId) as Obj[]
    ).map((r) => ({
      id: r.id,
      value: r.value,
      pickedAt: iso(Number(r.picked_at)),
      proposalId: r.proposal_id,
    }));
  }

  // ============================================================================================ suggestions (D6)

  /** An agent's suggestion on a finding: recorded and shown to the owner on the dashboard; it never applies anything. */
  suggest(o: {
    readonly projectId: string;
    readonly findingId: string;
    readonly value: string;
    readonly reason: string;
    readonly principalId: string;
  }): Obj {
    const f = this.d.appraisal.store.finding(o.projectId, o.findingId);
    if (!f || f.finding.tool !== (CONSISTENCY_TOOL as AppraisalFinding['tool']))
      throw new ConsistencyError(
        'FINDING_NOT_FOUND',
        `No consistency finding ${o.findingId} in this project (run arkona_consistency first).`,
      );
    const r = this.d.db
      .prepare(
        `INSERT INTO consistency_suggestions (project_id, finding_id, value, reason, principal_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(o.projectId, o.findingId, o.value.trim(), o.reason.trim(), o.principalId, this.d.now());
    return { suggestion: Number(r.lastInsertRowid), findingId: o.findingId, value: o.value.trim() };
  }

  suggestions(
    projectId: string,
    findingId: string,
  ): { id: number; value: string; reason: string; principalId: string; createdAt: string }[] {
    return (
      this.d.db
        .prepare(
          'SELECT * FROM consistency_suggestions WHERE project_id = ? AND finding_id = ? ORDER BY id DESC LIMIT 50',
        )
        .all(projectId, findingId) as Obj[]
    ).map((r) => ({
      id: Number(r.id),
      value: String(r.value),
      reason: String(r.reason),
      principalId: String(r.principal_id),
      createdAt: iso(Number(r.created_at)),
    }));
  }
}

export const newPickId = (): string => `cpk_${randomBytes(8).toString('hex')}`;
export { splitAliases };
