/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- parsed JSON replies */
/**
 * v3 F5b follow-up (ADR 0068 amendment): a dashboard action acts only on the project in view. The dashboard sends the
 * selected project in the address (`?project=`, `useProjectApi`); the Tagging page's POST routes read it from the body
 * only, so on a bridge serving several projects they acted on the DEFAULT project. Now every mutating route that names
 * a project takes it from the address, and a body naming another project is refused (`400 PROJECT_MISMATCH`) before
 * anything is done.
 *
 * A two-project bridge (`arkona`, the default, and `test`), each project its own mock LegendKeeper and key:
 *
 * - each Tagging POST route, called with `?project=test` alone, reaches the retag service with `test`'s id (never
 *   Arkona's), and with `?project=arkona` with Arkona's;
 * - a body naming the other project is refused before the service is reached;
 * - "Allow this tag everywhere" end to end: from `test`'s page it is refused (the Tagging Standard is Arkona's page)
 *   and Arkona's Tagging Standard is untouched; from Arkona's page it edits Arkona's Tagging Standard, and nothing
 *   reaches `test`'s LegendKeeper;
 * - the other dashboard routes that name a project in the body (audits, appraisal, chronology, maintenance, automation)
 *   follow the same rule.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock } from '../../src/lk/index.js';
import { RetagError } from '../../src/packs/retag/service.js';
import { MockLk } from '../contract/mock-lk.js';
import { MultiMockLk } from '../contract/multi-mock.js';
import { LkModel } from '../jobs/lk-model.js';
import { SUPPLEMENTARY_SENTENCE } from '../sandbox/tagging-f5a.js';
import { startAdminStack, type AdminStack } from './helpers.js';

const KEYS = { arkona: 'mock-key-arkona-not-real', test: 'mock-key-test-not-real' } as const;
const IDS = { arkona: 'lkp_arkona', test: 'lkp_test' } as const;
type Name = keyof typeof KEYS;
const GOV = { resourceId: 'govroot1', documentId: 'd_govroot1' } as const;

let s: AdminStack;
let front: MultiMockLk;
const mocks = {} as Record<Name, MockLk>;
const models = {} as Record<Name, LkModel>;

beforeAll(async () => {
  for (const name of ['arkona', 'test'] as const) {
    const model = new LkModel(() => systemClock.now());
    model.seedResource(`${name}_root`, { name: `${name} root` });
    models[name] = model;
    mocks[name] = new MockLk({
      clock: systemClock,
      apiKey: KEYS[name],
      projectId: IDS[name],
      projectName: `Project ${name}`,
      respond: model.respond,
    });
    await mocks[name].start();
  }
  // Arkona's governance page: every pinned heading, the Approved Supplementary Tags sentence as the Standard has it.
  const { ARKONA_PACK } = await import('../../src/packs/arkona.js');
  // "Approved Narrow Automations" last: this mock appends an inserted block at the end of the page.
  // v3 F6a (ADR 0076): the Reference Type Vocabulary is not there until the owner publishes it (it reads "unpublished").
  // v3 F6b (ADR 0079): likewise the Navigation and Subject Index Tags (unpublished while the index tag rule is a draft).
  const all = [...new Set(ARKONA_PACK.governance.flatMap((g) => g.sections ?? []))].filter(
    (h) => h !== ARKONA_PACK.rules.referenceTypes?.section && h !== ARKONA_PACK.rules.indexTaxonomy?.section,
  );
  const headings = [...all.filter((h) => h !== 'Approved Narrow Automations'), 'Approved Narrow Automations'];
  models.arkona.seedResource(GOV.resourceId, {
    name: 'Governance',
    blocks: [
      { id: 'gh0', kind: 'heading', level: 1, content: [{ text: 'Governance' }] },
      ...headings.flatMap((h, i) => [
        { id: `gh${i + 1}`, kind: 'heading', level: 2, content: [{ text: h }] },
        {
          id: `gp${i + 1}`,
          kind: 'paragraph',
          content: [
            {
              text:
                h === 'Approved Supplementary Tags'
                  ? SUPPLEMENTARY_SENTENCE
                  : h === 'Approved Narrow Automations'
                    ? 'Assign Block IDs Sweep (owner approval, 17 November 2026): enabling it is the activation, and this approval establishes no wider repair whitelist.'
                    : `The rules of ${h}.`,
            },
          ],
        },
      ]),
    ],
  });
  front = new MultiMockLk(new Map((['arkona', 'test'] as const).map((n) => [KEYS[n], mocks[n]])));
  const url = await front.start();
  s = await startAdminStack({
    lkBaseUrl: url,
    env: {
      LK_API_KEY: '',
      LK_PROJECT_ID: '',
      LK_PROJECTS: 'arkona,test',
      LK_PROJECT_ARKONA_API_KEY: KEYS.arkona,
      LK_PROJECT_TEST_API_KEY: KEYS.test,
      LK_DEFAULT_PROJECT: 'arkona',
    },
  });
  await s.runtime.ready;
  const packs = s.runtime.packs;
  packs.ensureSeeded();
  // Every governance source on Arkona's page (as the sandbox checks do), the pack approved as the owner would.
  packs.store.setGovernance(
    'arkona',
    packs.get('arkona')!.governance.map((g) => ({ ...g, project: 'arkona', ...GOV })),
  );
  await packs.commands.approve('owner', 'arkona');
}, 120_000);
afterAll(async () => {
  await s?.close();
  await front?.stop();
  for (const m of Object.values(mocks)) await m.stop();
});

const stepUp = () =>
  s.db
    .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
    .run(Math.floor(Date.now() / 1000), s.services.sessionHash(s.sessionToken));
const post = (path: string, project: Name | null, body: Record<string, unknown>) =>
  s.post(`/api/admin${path}${project ? `?project=${project}` : ''}`, body);
const writesAt = (name: Name) => mocks[name].calls.filter((c) => c.method !== 'GET').length;

const RUN = 'rtg_0123456789abcdef';
const REC = 'rtr_0123456789abcdef';
/** Each Tagging POST route, a valid body, and the retag service method it acts through. */
const TAGGING: readonly { path: string; body: Record<string, unknown>; method: string }[] = [
  { path: '/tagging/audit', body: { all: true }, method: 'audit' },
  {
    path: '/tagging/classify',
    body: { pageId: 'pg1', primary: 'Law', specialist: null, reason: 'r', confirm: true },
    method: 'classify',
  },
  { path: '/tagging/unclassify', body: { pageId: 'pg1', confirm: true }, method: 'unclassify' },
  {
    path: '/tagging/keep-here',
    body: { pageId: 'pg1', tag: 'Lore', reason: 'r', confirm: true },
    method: 'keepHere',
  },
  { path: '/tagging/unkeep', body: { pageId: 'pg1', tag: 'Lore', confirm: true }, method: 'unkeep' },
  {
    path: '/tagging/allow-everywhere',
    body: { tag: 'Lore', confirm: true },
    method: 'allowEverywhere',
  },
  { path: '/tagging/batches', body: { runId: RUN, pageIds: ['pg1'], confirm: true }, method: 'planApply' },
  { path: '/tagging/apply-all', body: { runId: RUN, confirm: true }, method: 'correctionBatches' },
  {
    path: '/tagging/approve-batches',
    body: { proposalIds: ['prop_x'], confirm: true },
    method: 'isBatchProposal',
  },
  { path: '/tagging/reconciliations', body: { name: 'r', all: true, confirm: true }, method: 'reconcile' },
  { path: `/tagging/reconciliations/${REC}/resume`, body: { confirm: true }, method: 'resume' },
];

/** The project id each retag service method was asked to act on (each stubbed to stop there). */
function spyRetag(): { calls: { method: string; projectId: string }[]; restore: () => void } {
  const calls: { method: string; projectId: string }[] = [];
  const r = s.runtime.retag as any;
  const spies = TAGGING.map(({ method }) =>
    vi.spyOn(r, method).mockImplementation((...args: any[]) => {
      const projectId =
        typeof args[0] === 'string' && args[0] !== 'owner'
          ? args[0]
          : typeof args[1] === 'string'
            ? args[1]
            : String(args[0]?.projectId);
      calls.push({ method, projectId });
      if (method === 'isBatchProposal') return false;
      throw new RetagError('STUBBED', 'stopped by the test after recording the project');
    }),
  );
  return { calls, restore: () => spies.forEach((x) => x.mockRestore()) };
}

describe('every Tagging POST route acts only on the project in view', () => {
  it('?project=test reaches the service with test’s id; ?project=arkona with Arkona’s', async () => {
    stepUp();
    const spy = spyRetag();
    try {
      for (const name of ['test', 'arkona'] as const)
        for (const r of TAGGING) {
          spy.calls.length = 0;
          const res = await post(r.path, name, r.body);
          expect(res.status, `${r.path} ${name}: ${JSON.stringify(res.json)}`).not.toBe(403);
          expect(spy.calls, `${r.path} on ${name}`).toEqual([{ method: r.method, projectId: IDS[name] }]);
        }
    } finally {
      spy.restore();
    }
  });

  it('a body naming another project than the address is refused before anything is done', async () => {
    stepUp();
    const spy = spyRetag();
    try {
      for (const r of TAGGING) {
        const res = await post(r.path, 'test', { ...r.body, project: 'arkona' });
        expect(res.status, r.path).toBe(400);
        expect(res.json.error.code, r.path).toBe('PROJECT_MISMATCH');
      }
      expect(spy.calls).toEqual([]);
      // The same project named in both places is fine.
      const same = await post('/tagging/audit', 'test', { all: true, project: 'test' });
      expect(same.json.error?.code).toBe('STUBBED');
      expect(spy.calls).toEqual([{ method: 'audit', projectId: IDS.test }]);
    } finally {
      spy.restore();
    }
  });
});

describe('"Allow this tag everywhere" end to end on the two projects', () => {
  it('from test’s page: refused (the Tagging Standard is Arkona’s page), Arkona’s page untouched', async () => {
    stepUp();
    const version = models.arkona.docs.get(GOV.documentId)!.version;
    const before = { arkona: writesAt('arkona'), test: writesAt('test') };
    for (const body of [
      { tag: 'Lore', dryRun: true },
      { tag: 'Lore', confirm: true },
    ]) {
      const res = await post('/tagging/allow-everywhere', 'test', body);
      expect(res.status, JSON.stringify(res.json)).toBe(409);
      expect(res.json.error.code).toBe('SOURCE_ELSEWHERE');
    }
    expect(models.arkona.docs.get(GOV.documentId)!.version).toBe(version);
    expect({ arkona: writesAt('arkona'), test: writesAt('test') }).toEqual(before);
  });

  it('from Arkona’s page: the dry run reads Arkona’s Tagging Standard; the edit changes it, and nothing reaches test', async () => {
    stepUp();
    const dry = await post('/tagging/allow-everywhere', 'arkona', { tag: 'Lore', dryRun: true });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    expect(dry.json.after).toMatch(/Cosmology, Chronology, Setting Framework and Lore/);
    const testWrites = writesAt('test');
    const edit = await post('/tagging/allow-everywhere', 'arkona', { tag: 'Lore', confirm: true });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    await s.runtime.engine.wait(IDS.arkona, edit.json.jobId, 20_000);
    const text = JSON.stringify(models.arkona.docs.get(GOV.documentId)!.blocks);
    expect(text).toMatch(/Cosmology, Chronology, Setting Framework and Lore/);
    expect(writesAt('test')).toBe(testWrites);
  });
});

describe('the other dashboard routes that name a project in the body follow the same rule', () => {
  const ROUTES: readonly { path: string; body: Record<string, unknown> }[] = [
    { path: '/audits/run', body: { confirm: true } },
    { path: '/appraisal/index/rebuild', body: { confirm: true } },
    { path: '/chronology/check', body: { confirm: true } },
    { path: '/maintenance/audit-run/run', body: {} },
    { path: '/maintenance/assign-block-ids-sweep/dry-run', body: {} },
    { path: '/automation/codes/blank_paragraphs', body: { mode: 'apply', confirm: true } },
    { path: '/automation/run', body: { confirm: true } },
  ];

  it('a body naming another project than the address is refused (400 PROJECT_MISMATCH)', async () => {
    stepUp();
    for (const r of ROUTES) {
      const res = await post(r.path, 'test', { ...r.body, project: 'arkona' });
      expect(res.status, `${r.path}: ${JSON.stringify(res.json)}`).toBe(400);
      expect(res.json.error.code, r.path).toBe('PROJECT_MISMATCH');
    }
  });

  it('the project in the address is the one acted on: refused for test, written on Arkona’s page for Arkona', async () => {
    stepUp();
    // Repository Automation is a page of Arkona, not of test: from test's page the setting is refused.
    const refused = await post('/automation/codes/blank_paragraphs', 'test', {
      mode: 'propose',
      confirm: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('SOURCE_ELSEWHERE');
    expect(s.runtime.automation.store.mode(IDS.test, 'blank_paragraphs')).toBe('off');
    expect(s.runtime.automation.store.mode(IDS.arkona, 'blank_paragraphs')).toBe('off');
    // From Arkona's page: written into Arkona's Repository Automation; nothing reaches test. (The owner first approves
    // the version "Allow this tag everywhere" offered above.)
    await s.runtime.packs.governance('arkona'); // the new version is offered
    await s.runtime.packs.commands.approve('owner', 'arkona');
    const testWrites = writesAt('test');
    const ok = await post('/automation/codes/blank_paragraphs', 'arkona', { mode: 'propose', confirm: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ governance: 'written', approvalCarried: true });
    expect(s.runtime.automation.store.mode(IDS.arkona, 'blank_paragraphs')).toBe('propose');
    expect(s.runtime.automation.store.mode(IDS.test, 'blank_paragraphs')).toBe('off');
    expect(JSON.stringify(models.arkona.docs.get(GOV.documentId)!.blocks)).toMatch(
      /Bridge automation blank_paragraphs:/,
    );
    expect(writesAt('test')).toBe(testWrites);
  });
});
