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
  characterTypeOf,
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
import type { TreeNode, TreeQueries } from '../tree/index.js';
import {
  compareCharacter,
  FINDING_CODE,
  LABEL_SEVERITY,
  LABEL_TEXT,
  type Disagreement,
  type Label,
  type PageInfo,
  type ValueView,
  principalKey,
  valueKey,
} from './compare.js';
import type { Edit, Picker } from './fix.js';
import type { ConsistencyAuditItem } from '../audits/context.js';
import {
  describe as describeDate,
  elapsedYears,
  overlaps,
  readCell,
  readLeading,
  readScan,
  spanOf,
  type DateReading,
  type Span,
} from './dates.js';
import {
  compilePatterns,
  extractPageFacts,
  principalValue,
  type ChronologyRowInput,
  type Compiled,
  type FactPlace,
  type MatchedAs,
} from './extract.js';
import { FactIndex, type StoredFact } from './facts-index.js';
import {
  agreesWithLives,
  buildLives,
  lifeName,
  lifeStart,
  stateAt,
  type Life,
  type LifeMark,
  type LivesInput,
} from './lives.js';

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
  readonly chronology: Pick<Chronology, 'config' | 'calendar'> & Partial<Pick<Chronology, 'loadCalendar'>>;
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
  /** Whether the audits hold a consistency finding with this id (a suggestion may name one the tool never stored). */
  readonly auditKnows?: (projectId: string, consistencyId: string) => boolean;
  /** The job an approved proposal ran as (Revert recognises a pick's job by its proposal). */
  readonly jobOfProposal?: (proposalId: string) => string | null;
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
  /** CR-2026-11-R4 (RC-19): a name's key is a title ("the Kaiser", "Kaiser"): it counts only on its own pages. */
  titleLike(key: string): boolean;
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
  /** ADR 0064 amendment 1 (F): facts left out because their section or row is marked non-current. */
  readonly nonCurrentLeftOut?: number;
  /**
   * CR-2026-11-R4 (RC-8): in an AU, the character's Main CANON facts (D9: inherited where the AU states nothing of its
   * own: its resolved birth and death, its deaths and returns, its prose and chronology rows too).
   */
  readonly main?: CharacterFacts;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const iso = (t: number) => new Date(t).toISOString();
const tidyText = (s: string) => s.replace(/\s+/g, ' ').trim();

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
  spelling: 'spelling',
};

export class Consistency {
  readonly facts: FactIndex;
  private readonly calendarKeys = new WeakMap<object, string>();
  /** D6: makes the owner's pick into one proposal (set by the runtime: it needs the tool layer's deps). */
  private picker: Picker | null = null;

  setPicker(p: Picker): void {
    this.picker = p;
  }

  /** The edits of a pick made into ONE proposal (what `pick` calls; also the tests' way to the chronology rows). */
  propose(o: Parameters<Picker>[0]): ReturnType<Picker> {
    if (!this.picker)
      throw new ConsistencyError('PICK_UNAVAILABLE', 'The pick is not available in this bridge build.');
    return this.picker(o);
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
      meta: this.d.tree.queries.status(projectId),
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

  /**
   * The chronology's calendar, loaded when it is not kept yet (ADR 0064 amendment 2): null when it is there now, else why
   * not (never throws: without a calendar every date stays unread, as before).
   */
  async ensureCalendar(projectId: string, read: LiveRead): Promise<string | null> {
    try {
      if (this.d.chronology.calendar(projectId)) return null;
      if (!this.d.chronology.loadCalendar) return 'the calendar loader is not available here';
      if (!this.d.chronology.config(projectId).calendarId)
        return 'the chronology’s calendar is not confirmed';
      const r = await this.d.chronology.loadCalendar(projectId, { read });
      return r.ok ? null : r.message;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
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
        // The event cell's mentions with their text (rule A: a mention counts only as the name governing the verb).
        const subjects = (event?.runs ?? []).flatMap((r) => {
          const m = r.mention as Obj | undefined;
          if (!m || typeof m !== 'object' || typeof m.resourceId !== 'string') return [];
          const text = typeof m.text === 'string' ? m.text : typeof m.name === 'string' ? m.name : '';
          return text.trim() ? [{ resourceId: m.resourceId, text }] : [];
        });
        out.push({
          pageId: page.id,
          documentId: doc.id,
          rowId: row.id,
          event: event?.text ?? '',
          date: row.cells[found.columns.date]?.text ?? '',
          mentions: [...new Set(row.cells.flatMap((c) => c.mentions.map((m) => m.resourceId)))],
          ...(subjects.length ? { subjects } : {}),
        });
      }
    }
    return out;
  }

  /**
   * Everything a request works from: the rules, the overlay (caught up), the current characters and their names, the
   * calendar, and the facts index brought up to date. Free: the bridge's database and the snapshot store only.
   */
  async world(projectId: string, o: { readonly read?: LiveRead } = {}): Promise<World> {
    const { pack, rules } = this.rules(projectId);
    // ADR 0064 amendment 2: a tool (it passes its governed read) loads the chronology's calendar when the bridge has not
    // kept it yet: one read, through the loader calendar_date uses. The nightly audit (no read) never makes a request.
    const loadProblem = o.read ? await this.ensureCalendar(projectId, o.read) : null;
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
    const key = sha1(JSON.stringify({ rules, entries, cal: this.calendarKey(cal), chron, v: 3 }));
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
      titleLike: (k: string) => {
        const t = compiled.words.titles;
        const bare = k.replace(/^(?:the|a|an)\s+/u, '');
        return t.has(k) || t.has(bare);
      },
      chronologyPageId,
      problems: [
        ...compiled.problems,
        ...(cal
          ? []
          : [
              `The chronology’s calendar is not available to the bridge yet, so no date can be read (the chronology tools read and keep it)${loadProblem ? `; reading it now failed: ${loadProblem}` : ''}.`,
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
    let nonCurrentLeftOut = 0;
    /** The characters of this continuity a key names, as a name, an alias or a given name (CR-2026-11-R4, RC-3). */
    const ownersOf = (k: string): string[] =>
      [...new Set([...(w.names.get(k) ?? []), ...(w.given.get(k) ?? [])])].filter(
        (x) => w.continuityOf(x) === continuity || w.continuityOf(x) === own,
      );
    /** The key is this character's given name only (not also one of its names or aliases). */
    const onlyGiven = (k: string): boolean => givenKeys.has(k) && !keys.has(k);
    // ADR 0064 amendment 1 (F): non-current sections and rows inside current pages, left out while the switch is on.
    const leaveOutNonCurrent = w.rules.nonCurrent?.exclude === true && !include.has('pre-rewrite');
    const facts: StoredFact[] = [];
    for (const f of all) {
      const k = `${f.pageId}:${f.seq}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const p = w.page(f.pageId);
      if (p.area && !include.has(p.area)) continue;
      if (p.lifecycle === 'Archived' && !include.has('archived')) continue;
      if (f.nonCurrent && leaveOutNonCurrent) {
        nonCurrentLeftOut++;
        continue;
      }
      if (f.source !== 'chronology' && w.continuityOf(f.pageId) !== continuity) continue;
      if (f.source === 'chronology' && continuity !== MAIN) continue;
      const pageOwner = w.ownerOf(f.pageId);
      const ownPage = pageOwner === id;
      if (f.pageId !== id) {
        if (f.matchedAs === 'mention' && w.ownerOf(f.subjectKey.slice(5)) !== id) continue;
        if (f.matchedAs === 'name' || f.matchedAs === 'given' || f.matchedAs === 'page') {
          // A name several characters of this continuity share counts only on one's own pages. CR-2026-11-R4 (RC-3): the
          // sharing is over names AND given names together, so one character's alias that is another's given name
          // (Katsuragi Yamato's "Yamato", Hoshino Yamato's given name) counts only on the pages of the character who owns
          // the page; on anyone else's it is not attributed.
          const sharing = ownersOf(f.subjectKey);
          if (sharing.length > 1 && !ownPage) {
            if (!(pageOwner !== null && sharing.includes(pageOwner))) ambiguous++;
            continue;
          }
          if (!sharing.includes(id) && !ownPage) continue;
          // A given name alone (D2, chosen) and, CR-2026-11-R4 (RC-19), an alias that is a title ("the Kaiser") count
          // only on the character's own pages.
          if (!ownPage && f.matchedAs !== 'page' && (onlyGiven(f.subjectKey) || w.titleLike(f.subjectKey)))
            continue;
        }
        // A page's own sidebar restates the character only when its subject IS the character (or it is one of its pages).
        if (f.matchedAs === 'page' && !ownPage && !keys.has(f.subjectKey)) continue;
      } else if (f.matchedAs !== 'page' && !keys.has(f.subjectKey) && !givenKeys.has(f.subjectKey)) continue;
      // ADR 0064 amendment 1 (rule A): on the identity page too, a sentence counts only when the name governing its
      // verb is the character's own ("Their son Murad al-Khalid was born…" on Daryavan's page is Murad's birth).
      facts.push(f);
    }
    // D9: an AU without an identity page of its own shows Main CANON's identity facts, labelled.
    const inherited = new Map<string, StoredFact>();
    let identityPageId = id;
    let main: CharacterFacts | undefined;
    if (continuity !== own && own === MAIN) {
      const mainFacts = this.facts.factsOn(w.projectId, [id]).filter((f) => f.matchedAs === 'page');
      for (const f of mainFacts) {
        const k = f.kind === 'identity' ? `identity:${textKey(f.field ?? '')}` : f.kind;
        if (!inherited.has(k) && (f.gap || f.date || f.kind === 'identity')) inherited.set(k, f);
      }
      identityPageId = id;
      // CR-2026-11-R4 (RC-8): Main CANON's own reading of the character (its identity page's prose and the chronology's
      // rows too, not only its sidebar), inherited where the AU states nothing of its own.
      main = this.characterFacts(w, c, { continuity: MAIN, include });
    }
    return {
      character: c,
      continuity,
      identityPageId,
      facts,
      inherited,
      ambiguous,
      ...(nonCurrentLeftOut > 0 ? { nonCurrentLeftOut } : {}),
      ...(main ? { main } : {}),
    };
  }

  /** CR-2026-11-R4 (RC-18): the identity fields that hold a name (the given name and the surname), as the pack keys them. */
  private nameFields(w: World): readonly string[] {
    const type = characterTypeOf(w.pack);
    const keyOf = (field: string, fallback: string) =>
      type?.identity.find((f) => f.field === field)?.key ?? fallback;
    return [keyOf('givenName', 'Personal / Given Name'), keyOf('surname', 'Family / Surname')];
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
    // CR-2026-11-R4 (the owner's request L): a character with several lives agrees with any of its lives' births and
    // deaths, and one life's own value is never compared with another's.
    const lives = this.livesOf(w, cf);
    const lifeOf = new Map<string, number>();
    if (lives.length > 1)
      lives.forEach((l, i) => {
        for (const m of [...l.starts, ...l.deaths])
          if (!m.inherited && !m.restated) lifeOf.set(`${m.fact.pageId}:${m.fact.seq}`, i);
      });
    const list = compareCharacter({
      cal: w.cal,
      margin: w.rules.approxMargin,
      page: (id) => w.page(id),
      identityPageId: cf.identityPageId,
      facts: cf.facts,
      inherited: cf.inherited,
      inheritedLabel: 'inherited from Main CANON',
      rowRelates: this.rowRelates(w),
      nonCurrentHistorical: w.rules.nonCurrent?.exclude === true,
      ...(lives.length > 1
        ? { lives: { lifeOf, agrees: (kind: 'birth' | 'death', s: Span) => agreesWithLives(lives, kind, s) } }
        : {}),
      person: { given: cf.character.names.given, surname: cf.character.names.surname },
      nameFields: this.nameFields(w),
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
          : d.label === 'spelling'
            ? `${cf.character.subject}: ${what} is “${d.reference.value}” on “${d.reference.page.name}”, spelt ${d.restatements.map((r) => `“${r.value}” on “${r.page.name}”`).join('; ')}: the same value but for accents or marks (information, never a conflict).`
            : `${label}: ${cf.character.subject}’s ${what} is ${d.reference.value} on “${d.reference.page.name}”${d.referenceFromRestatement ? ' (the identity page records none)' : ''}, but ${d.restatements.map((r) => `${r.value} on “${r.page.name}”`).join('; ')}.`;
    return {
      id: x.id,
      tool: CONSISTENCY_TOOL,
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
    /** The tool's governed read, for loading the calendar when it is not kept yet (ADR 0064 amendment 2). */
    readonly read?: LiveRead;
  }): Promise<AppraisalReport> {
    const startedAt = this.d.now();
    const w = await this.world(o.projectId, o.read ? { read: o.read } : {});
    const include = new Set(o.include ?? []);
    const characters = this.scopeCharacters(w, o);
    let reads = 0;
    if (o.live) reads = await this.readLive(w, characters, o.live);
    const findings: AppraisalFinding[] = [];
    let ambiguous = 0;
    let nonCurrentLeftOut = 0;
    for (const c of characters) {
      const continuity = o.continuity ?? w.continuityOf(c.identity.id);
      const cf = this.characterFacts(w, c, { continuity, include });
      ambiguous += cf.ambiguous;
      nonCurrentLeftOut += cf.nonCurrentLeftOut ?? 0;
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
      tool: CONSISTENCY_TOOL,
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
          ...(w.rules.nonCurrent?.exclude === true && !include.has('pre-rewrite')
            ? [
                `sections and chronology rows marked ${w.rules.nonCurrent.markers.map((m) => `“${m}”`).join(' or ')}${nonCurrentLeftOut > 0 ? ` (${nonCurrentLeftOut} fact(s))` : ''}: include “pre-rewrite” to bring them in, labelled Historical material differs`,
              ]
            : []),
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
    const propertiesName = treeSettingsFrom(this.d.projectSettings(w.projectId)).propertiesName;
    for (const c of list) {
      const res = (await read('getResource', { path: { resourceId: c.identity.id } })) as Obj | null;
      if (!res) continue;
      const x = extractPage(
        {
          rawName: typeof res.name === 'string' ? res.name : c.identity.name,
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
    /** The tool's governed read, for loading the calendar when it is not kept yet (ADR 0064 amendment 2). */
    readonly read?: LiveRead;
  }): Promise<Obj> {
    if (o.characters.length > MAX_AS_OF)
      throw new ConsistencyError('TOO_MANY', `At most ${MAX_AS_OF} characters in one call.`);
    const w = await this.world(o.projectId, o.read ? { read: o.read } : {});
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
    const where = (f: StoredFact, inherited: boolean) => ({
      value: f.valueText,
      precision: f.date ? describeDate(f.date) : null,
      page: { id: f.pageId, name: w.page(f.pageId).name, lifecycle: w.page(f.pageId).lifecycle },
      source: f.source,
      ...(f.section ? { section: f.section } : {}),
      excerpt: f.excerpt,
      ...(inherited ? { label: 'inherited from Main CANON' } : {}),
    });
    const birth = this.lifeValue(w, cf, 'birth');
    const death = this.lifeValue(w, cf, 'death');
    const born = birth?.fact.date
      ? where(birth.fact, birth.inherited)
      : birth?.fact.gap
        ? {
            ...where(birth.fact, birth.inherited),
            value: 'birth unestablished',
            recorded: birth.fact.valueText,
          }
        : 'birth unestablished';
    const presentSpan = (() => {
      const r = readLeading(cal, w.rules.present, w.style);
      return r.ok ? spanOf(cal, r.reading, 0) : null;
    })();
    // The Life State (the identity page's; in an AU with none of its own, Main CANON's, labelled: D9).
    const lifeState =
      cf.facts.find(
        (f) =>
          f.kind === 'identity' && textKey(f.field ?? '') === textKey(w.rules.lifeState) && f.pageId === id,
      ) ?? cf.inherited.get(`identity:${textKey(w.rules.lifeState)}`);
    const lifeInherited = lifeState
      ? cf.inherited.get(`identity:${textKey(w.rules.lifeState)}`) === lifeState
      : false;
    // v3 F4c (ADR 0065; the owner's ruling from F4b.1's review): "Deceased by <date>" in the Life State is an upper bound
    // on death, read here only (never a fact, never compared): at or after it, "Deceased (recorded by <date>)".
    const deceasedBy = lifeState ? this.deceasedBy(w, lifeState.valueText) : null;
    // ADR 0065 (amending D7): a Life State recording the character alive (its principal part, "Alive") holds at the
    // present. ADR 0064 amendment 2: the principal part STARTS with one of the alive values; a date there ("in / at
    // <date>") is an attestation up to that date, not the present. CR-2026-11-R4 (RC-13): never a value in doubt
    // ("presumed", "unconfirmed", "?"), and the date is read over the whole value ("Alive (last attested 4A 500)").
    const alive = lifeState && !lifeState.gap ? this.aliveOf(w, lifeState.valueText) : null;
    const aliveEnd = alive ? (alive.through ?? presentSpan) : null;
    // CR-2026-11-R4 (the owner's request L; RC-5 to RC-8): the character's lives, from ALL of the identity page's dated
    // births, deaths and starts (returns, restorations) whatever the Life State, the deaths other Authoritative pages
    // restate when the identity page records none, and Main CANON's in an AU that states none of its own.
    const lives = this.livesOf(w, cf);
    const multi = lives.length > 1;
    const st = stateAt({
      lives,
      at: at.span,
      present: presentSpan,
      alive:
        alive && aliveEnd && lifeState
          ? {
              end: aliveEnd,
              endText: alive.throughText
                ? `${alive.throughText} (the date the Life State gives)`
                : `the present (${w.rules.present})`,
              value: lifeState.valueText,
              principal: principalValue(lifeState.valueText),
              inherited: lifeInherited,
            }
          : null,
      deceasedBy:
        deceasedBy && lifeState
          ? {
              span: deceasedBy.span,
              text: deceasedBy.text,
              approximate: deceasedBy.reading.approximate,
              value: lifeState.valueText,
              inherited: lifeInherited,
            }
          : null,
    });
    // Elapsed calendar years (D7): from the birth; for a character with several lives, within the life the date falls
    // in, from that life's start (and said so); none between lives.
    const lifeAt = st.life !== null ? lives[st.life]! : null;
    let elapsed: Obj | string | null = null;
    let elapsedNote: string | null = null;
    const startOfLife =
      multi && lifeAt && lifeAt.n > 1 ? lifeStart(lifeAt) : birth?.fact.date ? { fact: birth.fact } : null;
    if (multi && st.position === 'between')
      elapsedNote = 'no age: between lives, no life is running at this date';
    else if (startOfLife?.fact.date) {
      const s = startOfLife.fact;
      const e = elapsedYears(cal, { reading: s.date!, span: spanOf(cal, s.date!, w.rules.approxMargin) }, at);
      const within =
        multi && lifeAt
          ? {
              counted: `within ${lifeName(lifeAt)}, from ${lifeAt.n > 1 ? (lifeAt.began === 'birth' ? 'its birth' : lifeAt.began === 'restoration' ? 'the restoration' : 'the return') : 'the birth'} (${s.valueText})`,
            }
          : {};
      elapsed =
        e.kind === 'not_yet_born'
          ? 'not yet born'
          : e.kind === 'exact'
            ? { years: e.years, exact: true, ...within }
            : {
                min: e.min,
                max: e.max,
                exact: false,
                why: 'a date is approximate, or not a single day',
                ...(e.maybeUnborn
                  ? { maybeUnborn: true, note: 'the birth may not have happened yet at this date' }
                  : {}),
                ...within,
              };
    } else elapsedNote = 'no age: the birth is not recorded';
    // The death shown: the one recorded for the life the date falls in (several lives), else the resolver's.
    const shownDeath = (() => {
      if (!death?.fact.date) return null;
      if (!multi) return where(death.fact, death.inherited);
      const idx = st.position === 'between' ? st.between![0] : (st.life ?? 0);
      const own = lives[idx]?.deaths[0];
      const before = lives
        .slice(0, idx + 1)
        .flatMap((l) => l.deaths)
        .at(-1);
      const m = own ?? before;
      const lifeOfDeath = m ? lives.find((l) => l.deaths.includes(m)) : undefined;
      return m && lifeOfDeath
        ? { ...where(m.fact, m.inherited), life: lifeName(lifeOfDeath) }
        : where(death.fact, death.inherited);
    })();
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
    // CR-2026-11-R4 (RC-8): in an AU, a row of Main CANON's chronology is Main CANON's, and says so.
    const rowLabel =
      continuity !== MAIN
        ? (r: (typeof rows)[number]) =>
            w.continuityOf(r.row.pageId) === MAIN ? { label: 'inherited from Main CANON' } : {}
        : () => ({});
    const view = (r: (typeof rows)[number]) => ({
      date: r.row.date,
      event: r.row.event,
      row: r.row.rowId,
      table: r.row.documentId,
      ...rowLabel(r),
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
    const lifeView = (l: Life) => {
      const s = l.starts[0];
      return {
        life: lifeName(l),
        began: s ? { how: l.began, ...where(s.fact, s.inherited) } : 'no start is recorded',
        ended:
          l.deaths.length === 0
            ? l.endedUnrecorded
              ? 'ended before the next life began; no death of it is recorded'
              : 'no death is recorded'
            : l.disputed
              ? {
                  how: 'death (its statements disagree)',
                  values: l.deaths.map((d) => where(d.fact, d.inherited)),
                }
              : { how: 'death', ...where(l.deaths[0]!.fact, l.deaths[0]!.inherited) },
        ...(l.attested.length
          ? {
              attested: l.attested.map((a) => ({
                value: a.fact.valueText,
                page: w.page(a.fact.pageId).name,
              })),
            }
          : {}),
      };
    };
    const position = multi
      ? st.position === 'between'
        ? {
            position: 'between lives',
            after: lifeName(lives[st.between![0]]!),
            before: lifeName(lives[st.between![1]]!),
          }
        : st.position === 'before'
          ? { position: 'before the first life' }
          : {
              position:
                st.position === 'in'
                  ? lifeAt?.began === 'restoration'
                    ? 'after the restoration'
                    : 'in a life'
                  : st.position === 'after'
                    ? 'after the death of the life'
                    : 'across a life’s start or end',
              life: lifeAt ? lifeName(lifeAt) : null,
            }
      : null;
    return {
      character: c.subject,
      identityPage: { id, name: c.identity.name, lifecycle: c.lifecycle, continuity: w.continuityOf(id) },
      born,
      elapsedYears: elapsed,
      ...(elapsedNote ? { elapsedNote } : {}),
      ...(shownDeath ? { died: shownDeath } : {}),
      state: {
        value: st.value,
        why: st.why,
        ...(st.inherited ? { label: 'inherited from Main CANON' } : {}),
      },
      ...(position ? { life: position, lives: lives.map(lifeView) } : {}),
      ...(deceasedBy
        ? {
            deceasedBy: {
              value: deceasedBy.text,
              precision: describeDate(deceasedBy.reading),
              recorded: lifeState!.valueText,
              note: 'an upper bound on death (Life State), read by arkona_as_of only; never compared',
              ...(lifeInherited ? { label: 'inherited from Main CANON' } : {}),
            },
          }
        : {}),
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

  /**
   * THE resolver of a character's birth or death (D7), shared by `arkona_as_of` and the coverage report (ADR 0064
   * amendment 2: the coverage report agrees with as-of): the identity page's own value (its Temporal Scope, its Life
   * State, its own prose naming the character), else the Authoritative restatements (prose elsewhere, chronology rows,
   * by name or alias) when they all agree. A date before a gap; null when nothing is recorded. Needs the calendar (a
   * date's span). CR-2026-11-R4: a character with several lives has its FIRST life's birth (request L; the coverage
   * report counts it as the readable birth); in an AU, the AU's own restatements come before Main CANON's resolved value,
   * which is inherited, labelled, only when the AU states none (RC-8, D9).
   */
  lifeValue(
    w: World,
    cf: CharacterFacts,
    kind: 'birth' | 'death',
  ): { fact: StoredFact; inherited: boolean } | null {
    const id = cf.character.identity.id;
    const own = cf.facts.filter((f) => f.kind === kind && f.pageId === id && f.source !== 'chronology');
    const ordered =
      kind === 'birth'
        ? [...own.filter((f) => (f.life ?? 1) === 1), ...own.filter((f) => (f.life ?? 1) !== 1)]
        : own;
    const pick = ordered.find((f) => f.date !== null) ?? ordered.find((f) => f.gap) ?? null;
    if (pick) return { fact: pick, inherited: false };
    const restated = this.restated(w, cf, kind);
    if (restated.length > 0) {
      const first = restated[0]!;
      return restated.every((m) => overlaps(m.span, first.span))
        ? { fact: first.fact, inherited: false }
        : null;
    }
    if (cf.main) {
      const m = this.lifeValue(w, cf.main, kind);
      return m ? { fact: m.fact, inherited: true } : null;
    }
    return null;
  }

  /** The Authoritative restatements of a birth or death (other pages, chronology rows), with their spans. */
  private restated(w: World, cf: CharacterFacts, kind: 'birth' | 'death'): LifeMark[] {
    const cal = w.cal;
    if (!cal) return [];
    const id = cf.character.identity.id;
    return cf.facts
      .filter(
        (f) =>
          f.kind === kind &&
          f.date !== null &&
          !(f.pageId === id && f.source !== 'chronology') &&
          w.page(f.pageId).lifecycle === 'Authoritative',
      )
      .map((f) => ({
        fact: f,
        span: spanOf(cal, f.date!, w.rules.approxMargin),
        inherited: false,
        restated: true,
      }));
  }

  /**
   * CR-2026-11-R4 (the owner's request L; RC-6 to RC-8): a character's lives in one continuity, as `arkona_as_of`, the
   * coverage report and the consistency check read them. From ALL of the identity page's dated births, deaths and starts
   * (returns, restorations), whatever its Life State; when it records no birth, the agreeing Authoritative restatements'
   * (D7); when it records no death, every Authoritative restatement of one (agreeing: the death; disagreeing: a disputed
   * one, RC-7). In an AU, its own pages' birth and deaths first, else Main CANON's, and Main CANON's starts and
   * attestations (inherited, labelled: RC-8).
   */
  livesOf(w: World, cf: CharacterFacts): Life[] {
    return buildLives(this.livesInput(w, cf));
  }

  private livesInput(w: World, cf: CharacterFacts): LivesInput {
    const cal = w.cal;
    if (!cal) return { births: [], deaths: [], starts: [], attested: [] };
    const mark = (f: StoredFact): LifeMark => ({
      fact: f,
      span: spanOf(cal, f.date!, w.rules.approxMargin),
      inherited: false,
    });
    const id = cf.character.identity.id;
    const own = cf.facts.filter((f) => f.pageId === id && f.source !== 'chronology' && f.date !== null);
    let births = own.filter((f) => f.kind === 'birth').map(mark);
    let deaths = own.filter((f) => f.kind === 'death').map(mark);
    let starts = own.filter((f) => f.kind === 'attested' && f.bound === 'from').map(mark);
    let attested = own.filter((f) => f.kind === 'attested' && f.bound !== 'from').map(mark);
    const restatedBirths = births.length === 0 ? this.restated(w, cf, 'birth') : [];
    if (restatedBirths.length > 0 && restatedBirths.every((m) => overlaps(m.span, restatedBirths[0]!.span)))
      births = [mark(restatedBirths[0]!.fact)];
    if (deaths.length === 0) deaths = this.restated(w, cf, 'death');
    if (cf.main) {
      // D9 (RC-8): what the AU states of its own first, else Main CANON's, inherited.
      const m = this.livesInput(w, cf.main);
      const inherit = (x: LifeMark): LifeMark => ({ ...x, inherited: true });
      if (births.length === 0 && restatedBirths.length === 0) births = m.births.map(inherit);
      if (deaths.length === 0) deaths = m.deaths.map(inherit);
      if (starts.length === 0) starts = m.starts.map(inherit);
      if (attested.length === 0) attested = m.attested.map(inherit);
    }
    return { births, deaths, starts, attested };
  }

  /**
   * Whether a Life State records the character alive (ADR 0065, amended by ADR 0064 amendment 2): its principal part
   * (before the first ";", "(" or spaced dash) starts with one of `aliveValues` as a whole word ("Alive", "Living").
   * `through`: the date an `aliveAt` phrasing reads there ("Alive in 5A 931"), the attestation's end; null: the present.
   * CR-2026-11-R4 (RC-13): a word of doubt anywhere in the value (`aliveDoubt`: "presumed", "unconfirmed", "?") makes it
   * no record; only the pack's `aliveFollowers` may follow the alive value ("Living memory" is none); the date is read
   * over the whole value ("Alive (last attested 4A 500)").
   */
  aliveOf(w: World, value: string): { through: Span | null; throughText: string | null } | null {
    const principal = principalValue(value);
    const k = textKey(principal);
    const whole = textKey(value);
    const doubt = (w.rules.aliveDoubt ?? []).some((d) => {
      const dk = textKey(d);
      if (dk === '') return false;
      return /[\p{L}\p{N}]/u.test(dk)
        ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(dk)}(?![\\p{L}\\p{N}])`, 'u').test(whole)
        : whole.includes(dk);
    });
    if (doubt) return null;
    const followers = w.rules.aliveFollowers?.map(textKey).filter((f) => f !== '');
    const starts = (w.rules.aliveValues ?? []).some((v) => {
      const vk = textKey(v);
      if (vk === '') return false;
      if (k === vk) return true;
      if (!k.startsWith(`${vk} `)) return false;
      if (!followers) return true;
      const rest = k.slice(vk.length + 1);
      return followers.some((f) => rest === f || rest.startsWith(`${f} `) || rest.startsWith(`${f},`));
    });
    if (!starts) return null;
    if (w.cal)
      for (const p of w.rules.aliveAt ?? []) {
        let m: RegExpExecArray | null;
        try {
          m = new RegExp(p.regex, 'iu').exec(value);
        } catch {
          continue;
        }
        const date = m?.groups?.date;
        if (!date) continue;
        const r = readScan(w.cal, date, w.style);
        if (r?.ok)
          return {
            through: spanOf(w.cal, r.reading, w.rules.approxMargin),
            throughText: r.reading.text.trim(),
          };
      }
    return { through: null, throughText: null };
  }

  /** A Life State's upper bound on death ("Deceased by 5A 931"), by the pack's `deceasedBy` phrasings; null when none. */
  private deceasedBy(w: World, value: string): { text: string; reading: DateReading; span: Span } | null {
    if (!w.cal) return null;
    for (const clause of value.split(';'))
      for (const p of w.rules.deceasedBy ?? []) {
        let m: RegExpExecArray | null;
        try {
          m = new RegExp(p.regex, 'iu').exec(clause);
        } catch {
          continue;
        }
        const date = m?.groups?.date;
        if (!date) continue;
        const r = readScan(w.cal, date, w.style);
        if (r?.ok)
          return {
            text: r.reading.text.trim(),
            reading: r.reading,
            span: spanOf(w.cal, r.reading, w.rules.approxMargin),
          };
      }
    return null;
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
    // ADR 0064 amendment 2: the value's principal part, through the pack's race token map (F3a: "High Elf" → "High
    // Elf"), matched in the singular or the plural ("High Elves - Core Information", "Humans - Core Information"),
    // first among the Race Core Reference pages under the race roster (Races of Arkona), else as before.
    const principal = principalValue(value);
    const tokens = w.pack.tags.race;
    const token = Object.entries(tokens).find(([k]) => textKey(k) === textKey(principal))?.[1] ?? principal;
    const wanted = new Set([...numberForms(nameKeyOf(principal)), ...numberForms(nameKeyOf(token))]);
    const matches = (n: TreeNode) =>
      [subjectPart(n.displayName), ...n.aliases].some((x) =>
        [...numberForms(nameKeyOf(x))].some((f) => wanted.has(f)),
      );
    const races = w.pack.owners?.races;
    const raceKind = w.pack.owners?.types
      .flatMap((t) => Object.values(t.kinds ?? {}))
      .find((k) => k && k.navigation === 'race');
    const coreType = raceKind?.referenceType ?? 'Race Core Reference';
    const roster = (n: TreeNode) =>
      races !== undefined &&
      (n.path.ids.includes(races.root.id) ||
        n.path.names.some((x) => textKey(x) === textKey(races.root.name)));
    const nodes = (['bsrc', 'bwrk', 'index'] as const).flatMap(
      (kind) => w.ctx.tree.byKind(w.projectId, kind).data,
    );
    let hits: TreeNode[] = nodes.filter(
      (n) =>
        roster(n) &&
        (textKey(n.referenceType ?? '') === textKey(coreType) ||
          / - core information$/iu.test(n.displayName)) &&
        matches(n),
    );
    if (hits.length === 0)
      hits = nodes.filter(
        (n) =>
          matches(n) && (/race|species/i.test(n.referenceType ?? '') || /race|species/i.test(n.displayName)),
      );
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

  /**
   * How many characters have a birth the engine can read, a recorded death, attested bounds, or none (D8). ADR 0064
   * amendment 1 (G): one primary bucket per character, so the buckets add up to the total (a readable birth; a birth
   * deliberately unestablished; attested bounds only; nothing readable); a recorded death and an unreadable birth are
   * flags with their own counts.
   */
  async coverage(o: {
    readonly projectId: string;
    readonly full?: boolean;
    readonly read?: LiveRead;
  }): Promise<Obj> {
    const w = await this.world(o.projectId, o.read ? { read: o.read } : {});
    const counts = {
      characters: 0,
      readableBirth: 0,
      birthUnestablished: 0,
      attestedBoundsOnly: 0,
      nothingReadable: 0,
    };
    const flags = { recordedDeath: 0, unreadableBirth: 0 };
    const nothing: Obj[] = [];
    const unreadable: Obj[] = [];
    const each: Obj[] = [];
    for (const c of w.characters) {
      if (w.continuityOf(c.identity.id) !== MAIN) continue;
      counts.characters++;
      // ADR 0064 amendment 2: the SAME resolver as arkona_as_of (the identity page, its prose, the chronology rows and
      // other Authoritative pages, by name and alias; non-current sections left out as as-of leaves them out), never the
      // identity page's sidebar alone.
      const cf = this.characterFacts(w, c, { continuity: MAIN });
      const id = c.identity.id;
      const birth = this.lifeValue(w, cf, 'birth');
      const readable = birth !== null && birth.fact.date !== null;
      const gap = birth !== null && birth.fact.date === null && birth.fact.gap;
      const death = this.lifeValue(w, cf, 'death')?.fact.date != null;
      const attested = cf.facts.some((f) => f.kind === 'attested' && f.date && f.pageId === id);
      const bad = readable
        ? undefined
        : cf.facts.find((f) => f.kind === 'birth' && f.pageId === id && f.unreadable);
      const bucket = readable
        ? 'readableBirth'
        : gap
          ? 'birthUnestablished'
          : attested
            ? 'attestedBoundsOnly'
            : 'nothingReadable';
      counts[bucket]++;
      if (bucket === 'nothingReadable')
        nothing.push({
          character: c.subject,
          identityPage: { id, name: c.identity.name, lifecycle: c.lifecycle },
          ...(death ? { flags: ['recorded death'] } : {}),
          ...(bad ? { unreadableBirth: bad.valueText } : {}),
        });
      if (death) flags.recordedDeath++;
      if (bad) {
        flags.unreadableBirth++;
        unreadable.push({
          character: c.subject,
          page: c.identity.name,
          text: bad.valueText,
          why: bad.unreadable,
        });
      }
      if (o.full)
        each.push({
          character: c.subject,
          identityPage: id,
          bucket,
          ...(readable
            ? {
                birth: {
                  value: birth.fact.valueText,
                  page: w.page(birth.fact.pageId).name,
                  source: birth.fact.source,
                },
              }
            : {}),
        });
    }
    const cap = o.full ? 1000 : 50;
    return {
      counts,
      flags,
      sums: `Each character is in one bucket: readableBirth + birthUnestablished + attestedBoundsOnly + nothingReadable = characters (${counts.readableBirth} + ${counts.birthUnestablished} + ${counts.attestedBoundsOnly} + ${counts.nothingReadable} = ${counts.characters}). The flags (recordedDeath, unreadableBirth) are counted separately and overlap the buckets.`,
      nothingReadable: nothing.slice(0, cap),
      ...(nothing.length > cap ? { more: nothing.length - cap } : {}),
      ...(unreadable.length ? { unreadableBirths: unreadable.slice(0, cap) } : {}),
      ...(o.full ? { byCharacter: each } : {}),
      note: 'A report for the owner, not a task list: an unrecorded birth is often deliberate (“birth date unestablished”), and nothing here asks for a date to be added. Never invent a date to fill a gap (Character Architecture).',
      scope:
        'Current Main CANON characters (Authoritative and Working), read as arkona_as_of reads them: the identity page (Temporal Scope, Life State, its own prose), then the chronology rows and other Authoritative pages that restate a birth or death by name or alias, as the snapshots hold them.',
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
   * edited (listed). Never runs without the owner: the dashboard's action calls it.
   */
  async pick(o: {
    readonly projectId: string;
    readonly identityPageId: string;
    readonly continuity: string;
    readonly findingId: string;
    readonly side?: string;
    /**
     * CR-2026-11-R4 (PK-51): the side's value as the owner saw it (the dashboard shows the audit's stored value): the pick
     * is refused (`SIDE_CHANGED`) when the side reads otherwise now, so the bridge never proposes a value nobody saw.
     */
    readonly shown?: string;
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
      throw o.shown !== undefined
        ? new ConsistencyError(
            'SIDE_CHANGED',
            `The value you picked (“${o.shown}”) is no longer one of this finding’s: its page changed since it was shown. Nothing was proposed; look at the finding again and pick again.`,
            { shown: o.shown },
          )
        : new ConsistencyError('SIDE_NOT_FOUND', 'That value is not one of this finding’s.');
    // CR-2026-11-R4 (PK-51): the side as the owner saw it, or nothing.
    if (sideView && o.shown !== undefined && tidyText(sideView.value) !== tidyText(o.shown))
      throw new ConsistencyError(
        'SIDE_CHANGED',
        `The value you picked has changed since it was shown: “${o.shown}” then, “${sideView.value}” now (on “${sideView.page.name}”). Nothing was proposed; look at the finding again and pick again.`,
        { shown: o.shown, now: sideView.value, page: sideView.page.name },
      );
    let picked = (sideView?.value ?? o.value ?? '').trim();
    if (picked === '')
      throw new ConsistencyError('INVALID_PARAMS', 'Pick one of the values, or type the right one.');
    // CR-2026-11-R4 (PK-55): a typed value is one line of text (a line break would be written into every page).
    if (o.value !== undefined && /[\p{Cc}\u2028\u2029]/u.test(o.value))
      throw new ConsistencyError(
        'VALUE_UNREADABLE',
        'The value holds a line break or another control character: type it on one line. Nothing was proposed.',
      );
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
      // CR-2026-11-R4 (PK-54): a typed value is ONE date (ADR 0064 D6.2); a range is refused.
      if (o.value !== undefined && r.reading.shape === 'range')
        throw new ConsistencyError(
          'VALUE_UNREADABLE',
          `“${picked}” is a range, not one date: type the one date that is right (or pick the side that gives the range). Nothing was proposed.`,
        );
      // The calendar's own reading of a typed value is what is written (its text, spaces tidied).
      if (o.value !== undefined) picked = r.reading.text;
      pickedSpan = spanOf(w.cal, r.reading, w.rules.approxMargin);
    }
    const agrees = (v: ValueView): boolean => {
      if (v === sideView) return true;
      // ADR 0064 amendment 1 (E): identity values agree when their principal parts do (their qualifiers aside).
      if (!isDate) return principalKey(v.value) === principalKey(picked);
      const r =
        v.source === 'chronology'
          ? readCell(w.cal!, v.value, w.style)
          : readLeading(w.cal!, v.value, w.style);
      return r.ok && overlaps(spanOf(w.cal!, r.reading, w.rules.approxMargin), pickedSpan!);
    };
    const edits: Edit[] = [];
    const untouched: Obj[] = [];
    const left: Obj[] = [];
    // CR-2026-11-R4: each value's place as the check read it (its sentence or clause, the date's offset there), so the
    // pick edits it there and nowhere else.
    const placeOf = new Map<string, FactPlace>();
    for (const f of cf.facts) if (f.place) placeOf.set(valueKey(f), f.place);
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
      const place = placeOf.get(v.key);
      const at = place && place.at !== null ? { sha: place.sha, at: place.at } : null;
      if (v.source === 'chronology' && v.documentId && v.blockId)
        edits.push({
          ...base,
          kind: 'row',
          documentId: v.documentId,
          rowId: v.blockId,
          ...(place ? { event: place.sha } : {}),
        });
      else if (v.source === 'prose' && v.documentId && v.blockId)
        edits.push({
          ...base,
          kind: 'prose',
          documentId: v.documentId,
          blockId: v.blockId,
          context: v.excerpt,
          ...(at ? { sentence: at } : {}),
        });
      else if (v.field && v.source === 'sidebar')
        // An identity value: its principal part becomes the picked one's; its own qualifier is kept (amendment 1 E).
        edits.push({ ...base, kind: 'fact', field: v.field, whole: true, to: principalValue(picked) });
      else if (v.field)
        edits.push({ ...base, kind: 'fact', field: v.field, whole: false, ...(at ? { clause: at } : {}) });
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
    if (r.items.length === 0 || (r.proposalId === '' && !r.jobId))
      throw new ConsistencyError(
        'NOTHING_TO_PROPOSE',
        'No page could be planned: every value that disagrees has changed since the check, is history now, or cannot be written this way (each is listed with why). Nothing was proposed.',
        { notPlanned: r.notPlanned, untouched, ...(left.length ? { leftAsTheyAre: left } : {}) },
      );
    const id = newPickId();
    this.d.db
      .prepare(
        `INSERT INTO consistency_picks (id, project_id, finding_id, audit_finding_id, value, side, picked_by, picked_at,
           proposal_id, job_id, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        r.proposalId === '' ? null : r.proposalId,
        r.jobId ?? null,
        JSON.stringify(r.items.map((i) => i.id)),
      );
    this.d.audit?.(o.actor, 'consistency.pick', o.projectId, null, {
      pick: id,
      finding: o.findingId,
      value: picked,
      side: sideView?.page.name ?? null,
      ...(r.proposalId ? { proposal: r.proposalId } : {}),
      ...(r.jobId ? { jobId: r.jobId } : {}),
      pages,
    });
    return {
      pick: id,
      value: picked,
      ...(r.proposalId ? { proposalId: r.proposalId } : {}),
      ...(r.jobId ? { jobId: r.jobId } : {}),
      summary: r.summary,
      items: r.items,
      untouched,
      ...(left.length ? { leftAsTheyAre: left } : {}),
      ...(r.notPlanned.length ? { notPlanned: r.notPlanned } : {}),
      reads: r.reads,
    };
  }

  /** Whether a job ran an owner's pick (approved, or v3 F12 run at once): Revert applies to it, as to a retag batch. */
  isPickJob(projectId: string, jobId: string): boolean {
    const direct = this.d.db
      .prepare('SELECT 1 FROM consistency_picks WHERE project_id = ? AND job_id = ? LIMIT 1')
      .get(projectId, jobId);
    if (direct) return true;
    if (!this.d.jobOfProposal) return false;
    const rows = this.d.db
      .prepare('SELECT proposal_id FROM consistency_picks WHERE project_id = ? AND proposal_id IS NOT NULL')
      .all(projectId) as { proposal_id: string }[];
    return rows.some((r) => this.d.jobOfProposal!(r.proposal_id) === jobId);
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
      jobId: r.job_id ?? null,
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
    const known =
      (f !== null && f.finding.tool === (CONSISTENCY_TOOL as AppraisalFinding['tool'])) ||
      this.d.auditKnows?.(o.projectId, o.findingId) === true;
    if (!known)
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

/**
 * A name's key in the singular and the plural of its last word (ADR 0064 amendment 2): "high elves" → "high elf",
 * "humans" → "human", "faeries" → "faerie", "foxians" → "foxian"; and the reverse. Only for matching a race value to its
 * reference page; never shown.
 */
export function numberForms(key: string): Set<string> {
  const out = new Set<string>([key]);
  const m = /^(.*?)(\S+)$/u.exec(key);
  if (!m) return out;
  const [, head, last] = m as unknown as [string, string, string];
  const add = (x: string) => {
    if (x.length >= 2) out.add(`${head}${x}`);
  };
  if (last.endsWith('ves')) {
    add(`${last.slice(0, -3)}f`);
    add(`${last.slice(0, -3)}fe`);
  }
  if (last.endsWith('ies')) {
    add(`${last.slice(0, -3)}y`);
    add(last.slice(0, -1));
  }
  if (last.endsWith('es')) add(last.slice(0, -2));
  if (last.endsWith('s') && !last.endsWith('ss')) add(last.slice(0, -1));
  if (last.endsWith('f')) add(`${last.slice(0, -1)}ves`);
  if (last.endsWith('fe')) add(`${last.slice(0, -2)}ves`);
  if (last.endsWith('y')) add(`${last.slice(0, -1)}ies`);
  add(`${last}s`);
  add(`${last}es`);
  return out;
}

export const newPickId = (): string => `cpk_${randomBytes(8).toString('hex')}`;
export { splitAliases };
