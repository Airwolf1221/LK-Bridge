/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON tool results */
/**
 * CR-2026-11-R4, pass 3 (the "as of" and consistency pass): helpers for the adversarial attempts on `arkona_as_of`,
 * `arkona_as_of_coverage` and `arkona_consistency`. Every world is F4b.1's live-run world (test/consistency/live-world.ts,
 * built verbatim from the owner's live excerpts) with the approved pack `arkona-2026-11-20-f41`, against the mock
 * LegendKeeper; the pages each attempt adds are variations on those excerpts. Nothing here calls a live system.
 */
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { createCalendar, DEFAULT_DATE_STYLE } from '../../../src/calendar/index.js';
import {
  compilePatterns,
  extractPageFacts,
  type NameIndex,
  type Unit,
} from '../../../src/consistency/extract.js';
import { ARKONA_PACK } from '../../../src/packs/arkona.js';
import { nameKeyOf } from '../../../src/packs/naming/namesakes.js';
import { SidebarModel } from '../../resources/world.js';
import { IDENTITY_KEYS } from '../../packs/world.js';
import { L, liveRunWorld, type LiveWorld } from '../../consistency/live-world.js';
import { C, K, O, P } from '../../consistency/world.js';

export { C, K, L, O, P };
export type { LiveWorld };

export const ORACLE = JSON.parse(
  readFileSync(new URL('../../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as { calendar: Record<string, unknown> };
/** Arkona's own calendar (Kumikan Epochal), as the chronology keeps it. */
export const cal = createCalendar(ORACLE.calendar);
/** The approved pack's consistency data (`arkona-2026-11-20-f41`, the seed). */
export const RULES = ARKONA_PACK.rules.consistency!;

// ============================================================================================ unit level

/** A name index from full names (and aliases) and given names, as the service builds it. */
export function nameIndex(full: readonly string[], given: readonly string[] = []): NameIndex {
  const n = new Set(full.map(nameKeyOf));
  const g = new Set(given.map(nameKeyOf));
  return { lookup: (k) => (n.has(k) ? 'name' : g.has(k) ? 'given' : null) };
}

export const ctxWith = (names: NameIndex) => ({
  compiled: compilePatterns(RULES),
  names,
  cal,
  style: DEFAULT_DATE_STYLE,
});

/** The facts the extractor reads from one sentence of prose on a page. */
export function proseFacts(
  sentence: string,
  names: NameIndex,
  o: { readonly section?: string | null; readonly pageName?: string } = {},
) {
  const units: Unit[] = [
    {
      unit: 'name',
      text: o.pageName ?? 'Some Page',
      documentId: null,
      blockId: null,
      field: null,
      section: null,
    },
    {
      unit: 'text',
      text: sentence,
      documentId: 'doc1',
      blockId: 'blk1',
      field: null,
      section: o.section === undefined ? 'Purpose' : o.section,
    },
  ];
  return extractPageFacts('page1', units, ctxWith(names)).facts;
}

/** The dated facts the extractor reads from a page's sidebar fields (its Subject given). */
export function sidebarFacts(subject: string, fields: Record<string, string>) {
  const units: Unit[] = [
    { unit: 'fact', text: subject, documentId: null, blockId: 'r1', field: 'Subject', section: 'sidebar' },
    ...Object.entries(fields).map(([field, text], i): Unit => ({
      unit: 'fact',
      text,
      documentId: null,
      blockId: `r${i + 2}`,
      field,
      section: 'sidebar',
    })),
  ];
  return extractPageFacts('page2', units, ctxWith(nameIndex([]))).facts.filter((f) => f.kind !== 'identity');
}

// ============================================================================================ the world

export const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });
export const heading = (id: string, text: string, level = 2) => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});

const canon = {
  Status: 'Authoritative',
  'Continuity Type': 'CANON',
  Continuity: 'Main',
  Inheritance: 'None',
};

/** The identity sidebar of a page (IDENTITY_KEYS, as the fixtures write it). */
export function identitySidebar(w: LiveWorld, id: string, v: Record<string, string>): void {
  w.sidebars.page(id, [
    SidebarModel.kv(
      `kv${id}`.slice(0, 8),
      'PROPERTIES',
      IDENTITY_KEYS.map((k) => [k, v[k] ?? ''] as [string, string]),
    ),
    SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
    SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
    { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
  ]);
}

/** Sets sidebar rows of a page already in the world (an empty text clears a row). */
export function setRows(w: LiveWorld, id: string, rows: Record<string, string>): void {
  w.sidebars.outside(id, (sb) => {
    const props = sb.props.find((p) => p.title === 'PROPERTIES')!;
    for (const [key, text] of Object.entries(rows)) {
      const at = props.rows!.find((r) => r.key === key);
      if (at) at.content = [{ text }];
      else props.rows!.push({ id: `${id.slice(0, 4)}${key.length}x`, rank: 'zz', key, content: [{ text }] });
    }
  });
}

/**
 * A character: a Compact Character Reference under the live-run fixtures' index, or (with `core`) a Character Core
 * under an index of its own (so a page under that index is one of its own pages). Main CANON and Authoritative unless
 * `v` says otherwise.
 */
export function person(
  w: LiveWorld,
  o: {
    readonly id: string;
    readonly name: string;
    readonly given: string;
    readonly family: string;
    readonly v?: Record<string, string>;
    /** A Character Core under its own index (this id). */
    readonly core?: string;
    readonly aliases?: readonly string[];
  },
): void {
  const ref = o.core ? 'Character Core' : 'Compact Character Reference';
  if (o.core) w.repo.seed({ id: o.core, name: `[INDEX] ${o.name}`, parentId: L.idx });
  w.repo.seed({
    id: o.id,
    name: `[BSRC] ${o.name} - ${o.core ? 'Character Core' : 'Character Reference'}`,
    parentId: o.core ?? L.idx,
    referenceType: ref,
    canonical: o.name,
    aliases: [...(o.aliases ?? [])],
    tags: ['CANON', 'Character', 'Human'],
  });
  identitySidebar(w, o.id, {
    ...canon,
    Subject: o.name,
    'Canonical Display Name': o.name,
    'Personal / Given Name': o.given,
    'Family / Surname': o.family,
    'Naming Culture': 'Velaran',
    'Reference Type': ref,
    Scope: `${o.name}, a person of Arkona`,
    'Race / Species': 'Human',
    'Last Major Revision': '2026-11-01',
    Supersedes: 'None',
    ...(o.v ?? {}),
  });
}

/** An Authoritative General Source (or another Reference Type) with an optional sidebar and body. */
export function page(
  w: LiveWorld,
  o: {
    readonly id: string;
    readonly name: string;
    readonly parentId: string;
    readonly referenceType?: string;
    readonly tags?: readonly string[];
    readonly sidebar?: Record<string, string>;
    readonly body?: readonly unknown[];
  },
): void {
  w.repo.seed({
    id: o.id,
    name: o.name,
    parentId: o.parentId,
    referenceType: o.referenceType ?? 'General Source',
    tags: [...(o.tags ?? ['CANON'])],
  });
  if (o.sidebar)
    identitySidebar(w, o.id, {
      ...canon,
      'Reference Type': o.referenceType ?? 'General Source',
      ...o.sidebar,
    });
  if (o.body) w.setBody(o.id, [...o.body]);
}

/** Appends rows to the Universal Chronology's fixture table (Event | Date | KCY), by their columns. */
export function chronologyRows(
  w: LiveWorld,
  rows: readonly {
    readonly id: string;
    readonly event: readonly Record<string, unknown>[];
    readonly date: string;
  }[],
): void {
  const fourth = w.repo.blocks.get(w.mainOf(P.fourthAge))!;
  const table = (fourth.blocks as Record<string, unknown>[]).find((b) => b.kind === 'table')!;
  for (const r of rows)
    (table.children as unknown[]).push({
      id: r.id,
      kind: 'tableRow',
      children: [
        {
          id: `${r.id}a`,
          kind: 'tableCell',
          children: [{ id: `${r.id}ap`, kind: 'paragraph', content: r.event }],
        },
        {
          id: `${r.id}b`,
          kind: 'tableCell',
          children: [{ id: `${r.id}bp`, kind: 'paragraph', content: [{ text: r.date }] }],
        },
        {
          id: `${r.id}c`,
          kind: 'tableCell',
          children: [{ id: `${r.id}cp`, kind: 'paragraph', content: [{ text: '' }] }],
        },
      ],
    });
}

export async function refresh(w: LiveWorld): Promise<void> {
  w.rebuildTree();
  await w.snapshot();
}

/** The tool calls every attempt uses. */
export function tools(w: LiveWorld) {
  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = await w.call(tool, { project: 'test', ...args });
    expect(r.isError, r.text).toBe(false);
    return r.body as any;
  };
  return {
    call,
    asOf: async (character: string, date: string, more: Record<string, unknown> = {}) =>
      (await call('arkona_as_of', { characters: [character], date, ...more })).characters[0],
    consistency: (args: Record<string, unknown>) =>
      call('arkona_consistency', { detail: 'full', limit: 200, ...args }),
  };
}

/** An `arkona_as_of` answer in one line, for an assertion's message (what was answered, and why). */
export function brief(a: any): string {
  const v = (x: any) =>
    x && typeof x === 'object'
      ? `${x.value}${x.label ? ` [${x.label}]` : ''} (${x.page?.id ?? ''} ${x.source ?? ''})`
      : x;
  return JSON.stringify({
    born: v(a?.born),
    died: a?.died ? v(a.died) : undefined,
    elapsed: a?.elapsedYears,
    state: a?.state,
    deceasedBy: a?.deceasedBy?.value,
    contradictions: a?.contradictions?.map(
      (c: any) => `${c.what}: ${c.values.map((x: any) => x.value).join(' / ')}`,
    ),
    warning: a?.warning,
  });
}

/** Every value (reference and restatements) of a run's findings, flattened, with the finding's label and kind. */
export function valuesOf(
  run: any,
): { label: string; what: string; value: string; excerpt: string; page: string }[] {
  return (run.findings as any[]).flatMap((f) =>
    [f.details.reference, ...(f.details.restatements as any[])].map((v: any) => ({
      label: f.details.label as string,
      what: f.details.what as string,
      value: v.value as string,
      excerpt: v.excerpt as string,
      page: v.page.id as string,
    })),
  );
}

export { liveRunWorld };
