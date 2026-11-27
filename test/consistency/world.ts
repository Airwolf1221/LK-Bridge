/**
 * The test world of v3 F4b (ADR 0064): F4a's world (the REAL server, runtime, MCP transport, policy and engine against
 * the mock LegendKeeper; the Arkona pack attached and approved; the Fourth Age chronology table) with fixtures modelled
 * on the real phrasings the owner-approved design quotes (docs/design/F4b-consistency-and-as-of.md), never fetched:
 *
 * - **Temporal Scopes**: Rashad al-Khalid ("Born Camue 44th, 4A 360; alive and immortal in Fifth-Age present 5A 931"),
 *   Soraya bint al-Noor ("Born 2A 73,511; attested through 5A 931"), Titania ("Born Sarias 28th, 1A 51,743; succession
 *   Redfall 1st, 1A 62,313; active at…"), Kamigawa Haru ("Attested 5A 411–5A 931; birth date unestablished"), Leila
 *   Darvish ("Born c. 4A 640"), and Harun al-Saffar ("Born 4A 300", Life State "Deceased Camue 3rd, 4A 400");
 * - **restatements**: Yasmin al-Naim's Biography ("Yasmin was born on Camue 1st, 4A 103", a given name on her own page;
 *   "She was born in 4A 90", a pronoun, never read; her Race / Species as "Elf" against her Core's "Human"; Rashad's
 *   birth with a day Camue does not have); a nation page's dated line ("Azah 19th, 4A 51 (1,250,358 KCY) - Cornelia von
 *   Katzen is born in the palace") and a birth name used as an alias ("Rita von Katzen was born in 4A 305", for Katsuragi
 *   Yamato); a Working draft, an Archived page and an AU page restating Yasmin's birth; a shrine register giving Haru a
 *   birth his identity page leaves unestablished;
 * - **chronology rows**: "Yasmin al-Naim is born" (mentioning her Biography, dated Camue 1st, 4A 100) and "Harun
 *   al-Saffar dies in the siege" (mentioning his Core, Camue 3rd, 4A 400);
 * - **the calendar**: the oracle's (Arkona's own Kumikan Epochal), cached as the chronology keeps it.
 */
import { readFileSync } from 'node:fs';
import { ADMIN_CSRF_PURPOSE } from '../../src/admin/guard.js';
import { PUBLIC_URL } from '../tools/helpers.js';
import { buildModels, ROOT } from '../discover/world.js';
import { SidebarModel } from '../resources/world.js';
import { ProjectStore } from '../../src/projects/store.js';
import { LIFECYCLE, IDENTITY_KEYS } from '../packs/world.js';
import { C, F, O, P, PROJECT, f4aWorld, type F4aWorld } from '../packs/f4a-world.js';

export { C, F, O, P, PROJECT };

const ORACLE = JSON.parse(
  readFileSync(new URL('../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as { calendar: Record<string, unknown> };

/** The fixture pages' ids. */
export const K = {
  rashadIdx: 'rashidx1',
  rashad: 'rashcor1',
  soraya: 'soraref1',
  titaniaIdx: 'titaidx1',
  titania: 'titacor1',
  haru: 'haruref1',
  yasminIdx: 'yasmidx1',
  yasmin: 'yasmcor1',
  yasminBio: 'yasmbio1',
  katsuIdx: 'katsidx1',
  katsu: 'katscor1',
  corneliaIdx: 'cornidx1',
  cornelia: 'corncor1',
  harunIdx: 'harnidx1',
  harun: 'harncor1',
  leilaIdx: 'leilidx1',
  leila: 'leilcor1',
  nation: 'natnref1',
  register: 'shrnreg1',
  draft: 'yasmdrf1',
  oldNotes: 'yasmold1',
  auPage: 'moonchr1',
} as const;

const para = (id: string, ...runs: Record<string, unknown>[]) => ({ id, kind: 'paragraph', content: runs });
const t = (text: string) => ({ text });
const heading = (id: string, text: string) => ({ id, kind: 'heading', level: 2, content: [{ text }] });

export interface F4bWorld extends F4aWorld {
  /** Sets a page's Main document blocks (the next snapshot takes them). */
  setBody(id: string, blocks: unknown[]): void;
  /** Rebuilds the tree from the mock (after pages were added) and copies the sidebars into it. */
  rebuildTree(): void;
}

const canon = {
  Status: 'Authoritative',
  'Continuity Type': 'CANON',
  Continuity: 'Main',
  Inheritance: 'None',
};

export async function f4bWorld(
  o: {
    readonly seed?: NonNullable<Parameters<typeof f4aWorld>[0]>['seed'];
    /** v3 F12 (ADR 0081): the world's agent scope, as packWorld takes it (`seed`: write; default: propose). */
    readonly toolModes?: 'propose' | 'seed';
  } = {},
): Promise<F4bWorld> {
  const w = await f4aWorld({
    ...(o.toolModes ? { toolModes: o.toolModes } : {}),
    seed: (world) => {
      const r = world.repo;
      const core = (
        idx: string,
        id: string,
        idxParent: string,
        name: string,
        tags: string[],
        aliases: string[] = [],
      ) => {
        r.seed({ id: idx, name: `[INDEX] ${name}`, parentId: idxParent });
        r.seed({
          id,
          name: `[BSRC] ${name} - Character Core`,
          parentId: idx,
          referenceType: 'Character Core',
          canonical: name,
          aliases,
          tags: ['CANON', 'Character', ...tags],
        });
      };
      core(K.rashadIdx, K.rashad, C.humans, 'Rashad al-Khalid', ['Human']);
      core(K.titaniaIdx, K.titania, C.humans, 'Titania', ['Human']);
      core(K.yasminIdx, K.yasmin, C.humans, 'Yasmin al-Naim', ['Human']);
      core(K.katsuIdx, K.katsu, C.humans, 'Katsuragi Yamato', ['Human'], ['Rita von Katzen']);
      core(K.corneliaIdx, K.cornelia, C.humans, 'Cornelia von Katzen', ['Human']);
      core(K.harunIdx, K.harun, C.humans, 'Harun al-Saffar', ['Human']);
      core(K.leilaIdx, K.leila, C.humans, 'Leila Darvish', ['Human']);
      const compact = (id: string, name: string) =>
        r.seed({
          id,
          name: `[BSRC] ${name} - Character Reference`,
          parentId: C.humans,
          referenceType: 'Compact Character Reference',
          canonical: name,
          tags: ['CANON', 'Character', 'Human'],
        });
      compact(K.soraya, 'Soraya bint al-Noor');
      compact(K.haru, 'Kamigawa Haru');
      r.seed({
        id: K.yasminBio,
        name: '[BSRC] Yasmin al-Naim - Biography',
        parentId: K.yasminIdx,
        referenceType: 'General Source',
        tags: ['CANON', 'Character'],
      });
      r.seed({
        id: K.nation,
        name: '[BSRC] Velara - Polity Reference',
        parentId: O.alTibr,
        referenceType: 'Polity Reference',
        tags: ['CANON', 'Polity'],
      });
      r.seed({
        id: K.register,
        name: '[BSRC] Fujimatsu Shrine Register',
        parentId: C.humans,
        referenceType: 'General Source',
        tags: ['CANON'],
      });
      r.seed({
        id: K.draft,
        name: '[BWRK] Yasmin al-Naim - Draft Notes',
        parentId: LIFECYCLE.working,
        tags: ['Working'],
      });
      r.seed({
        id: K.oldNotes,
        name: '[BARC] Yasmin al-Naim - Old Notes',
        parentId: LIFECYCLE.archived,
        tags: ['Archived'],
      });
      r.seed({
        id: K.auPage,
        name: '[BSRC] Moonfall Chronicle',
        parentId: C.humans,
        referenceType: 'General Source',
        tags: ['AU'],
      });
      o.seed?.(world);
    },
  });
  const r = w.repo;
  const sb = w.sidebars;
  const setBody = (id: string, blocks: unknown[]) => r.blocks.set(w.mainOf(id), { version: 1, blocks });
  const identity = (id: string, v: Partial<Record<string, string>>) =>
    sb.page(id, [
      SidebarModel.kv(
        `kv${id}`.slice(0, 8),
        'PROPERTIES',
        IDENTITY_KEYS.map((k) => [k, v[k] ?? ''] as [string, string]),
      ),
      SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
      SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  const person = (
    id: string,
    name: string,
    given: string,
    family: string,
    ref: string,
    v: Partial<Record<string, string>>,
  ) =>
    identity(id, {
      ...canon,
      Subject: name,
      'Canonical Display Name': name,
      'Personal / Given Name': given,
      'Family / Surname': family,
      'Naming Culture': 'Velaran',
      'Reference Type': ref,
      Scope: `${name}, a person of Arkona`,
      'Race / Species': 'Human',
      'Life State': 'Alive',
      'Last Major Revision': '2026-11-01',
      Supersedes: 'None',
      ...v,
    });
  person(K.rashad, 'Rashad al-Khalid', 'Rashad', 'al-Khalid', 'Character Core', {
    'Temporal Scope': 'Born Camue 44th, 4A 360; alive and immortal in Fifth-Age present 5A 931',
  });
  person(K.soraya, 'Soraya bint al-Noor', 'Soraya', 'Unestablished', 'Compact Character Reference', {
    'Temporal Scope': 'Born 2A 73,511; attested through 5A 931',
  });
  person(K.titania, 'Titania', 'Titania', 'Unestablished', 'Character Core', {
    'Temporal Scope': 'Born Sarias 28th, 1A 51,743; succession Redfall 1st, 1A 62,313; active at…',
  });
  person(K.haru, 'Kamigawa Haru', 'Haru', 'Kamigawa', 'Compact Character Reference', {
    'Naming Culture': 'Fujimatsuan',
    'Temporal Scope': 'Attested 5A 411–5A 931; birth date unestablished',
  });
  person(K.yasmin, 'Yasmin al-Naim', 'Yasmin', 'al-Naim', 'Character Core', {
    'Temporal Scope': 'Born Camue 1st, 4A 100',
  });
  person(K.katsu, 'Katsuragi Yamato', 'Yamato', 'Katsuragi', 'Character Core', {
    Aliases: 'Rita von Katzen',
    'Naming Culture': 'Fujimatsuan',
    'Temporal Scope': 'Born Isar 3rd, 4A 300',
  });
  person(K.cornelia, 'Cornelia von Katzen', 'Cornelia', 'von Katzen', 'Character Core', {
    'Temporal Scope': 'Born Azah 19th, 4A 51',
  });
  person(K.harun, 'Harun al-Saffar', 'Harun', 'al-Saffar', 'Character Core', {
    'Temporal Scope': 'Born 4A 300',
    'Life State': 'Deceased Camue 3rd, 4A 400',
  });
  person(K.leila, 'Leila Darvish', 'Leila', 'Darvish', 'Character Core', {
    'Temporal Scope': 'Born c. 4A 640',
  });
  // Yasmin's Biography restates her identity (its Subject is hers), with her Race / Species written differently.
  identity(K.yasminBio, {
    ...canon,
    Subject: 'Yasmin al-Naim',
    'Reference Type': 'General Source',
    'Race / Species': 'Elf',
  });
  identity(K.auPage, {
    ...canon,
    'Continuity Type': 'AU',
    Continuity: 'Moonfall',
    Subject: 'Moonfall Chronicle',
  });

  setBody(K.yasminBio, [
    heading('yb1', 'Purpose'),
    para(
      'yb2',
      t('Yasmin was born on Camue 1st, 4A 103 in the old quarter. She was born in 4A 90 by another count.'),
    ),
    para('yb3', t('Rashad al-Khalid was born on Camue 51st, 4A 360, the tale says.')),
  ]);
  setBody(K.nation, [
    heading('nv1', 'Purpose'),
    para('nv2', t('Azah 19th, 4A 51 (1,250,358 KCY) - Cornelia von Katzen is born in the palace.')),
    para('nv3', t('Rita von Katzen was born in 4A 305, in the river quarter.')),
  ]);
  setBody(K.register, [
    heading('sr1', 'Purpose'),
    para('sr2', t('Kamigawa Haru was born in 5A 400 at the shrine.')),
  ]);
  setBody(K.draft, [
    heading('dn1', 'Purpose'),
    para('dn2', t('Yasmin al-Naim was born in 4A 110, I think.')),
  ]);
  setBody(K.oldNotes, [heading('on1', 'Purpose'), para('on2', t('Yasmin al-Naim was born in 4A 120.'))]);
  setBody(K.auPage, [
    heading('mc1', 'Purpose'),
    para('mc2', t('Yasmin al-Naim was born in 4A 150 in this telling.')),
  ]);

  // Two chronology rows: a birth mentioning her Biography, a death mentioning his Core.
  const fourth = r.blocks.get(w.mainOf(P.fourthAge))!;
  const table = (fourth.blocks as Record<string, unknown>[]).find((b) => b.kind === 'table')!;
  const row = (id: string, event: Record<string, unknown>[], date: string, kcy: string) => ({
    id,
    kind: 'tableRow',
    children: [
      { id: `${id}a`, kind: 'tableCell', children: [para(`${id}ap`, ...event)] },
      { id: `${id}b`, kind: 'tableCell', children: [para(`${id}bp`, t(date))] },
      { id: `${id}c`, kind: 'tableCell', children: [para(`${id}cp`, t(kcy))] },
    ],
  });
  (table.children as unknown[]).push(
    row(
      'farow5',
      [{ mention: { resourceId: K.yasminBio, text: 'Yasmin al-Naim' } }, t(' is born')],
      'Camue 1st, 4A 100',
      '1250407',
    ),
    row(
      'farow6',
      [{ mention: { resourceId: K.harun, text: 'Harun al-Saffar' } }, t(' dies in the siege')],
      'Camue 3rd, 4A 400',
      '1250707',
    ),
  );

  // The calendar, as the chronology keeps it (the appraisal world stores the chronology's table without one).
  const rt = w.stack.runtime;
  rt.chronology.remember(PROJECT, ORACLE.calendar);
  const store = new ProjectStore(w.stack.db);
  const prev = (store.byId(PROJECT)?.settings as Record<string, unknown> | undefined)?.chronology as Record<
    string,
    unknown
  >;
  store.setSetting(PROJECT, 'chronology', { ...prev, calendarId: String(ORACLE.calendar.id) });

  const rebuildTree = () => {
    buildModels(w.stack, r, w.assets);
    const setSidebar = w.stack.db.prepare(
      'UPDATE tree_nodes SET sidebar = ? WHERE project_id = ? AND id = ?',
    );
    for (const [id, sbar] of sb.pages)
      setSidebar.run(
        JSON.stringify(
          sbar.props.map((p) => ({
            id: p.id,
            kind: p.kind,
            title: p.title,
            ...(p.rows
              ? {
                  rows: p.rows.map((x) => ({
                    key: x.key,
                    text: (x.content as { text?: string }[]).map((c) => c.text ?? '').join(''),
                  })),
                }
              : {}),
          })),
        ),
        PROJECT,
        id,
      );
  };
  rebuildTree();
  void ROOT;
  return Object.assign(w, { setBody, rebuildTree });
}

/** The owner on the dashboard's API: a session, its CSRF token, and the step-up (ADR 0062) when asked. */
export function ownerClient(w: { readonly stack: F4aWorld['stack'] }) {
  const s = w.stack.services;
  const session = s.owner.createSession('127.0.0.1', 'vitest');
  const cookie = `${s.owner.sessionCookie}=${session}`;
  const csrf = s.owner.csrfToken(session, ADMIN_CSRF_PURPOSE);
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${w.stack.base}/api/admin${path}`, {
      method,
      headers: {
        cookie,
        origin: PUBLIC_URL,
        ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return {
    get: (path: string) => request('GET', path),
    post: (path: string, body: unknown = {}) => request('POST', path, body),
    /** The step-up, done now (the authenticator code within ten minutes). */
    reauth: () =>
      w.stack.db
        .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
        .run(Math.floor(Date.now() / 1000), s.sessionHash(session)),
  };
}
