/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * CR-2026-11 round 4 (sessions): every mutating admin route, checked against ADR 0062 decisions 5 and 6.
 *
 * - SE-13: every mutating route the admin plugin registers is classified below (so a route added later without a
 *   decision fails this test): `asks` (the step-up, always), `conditional` (a loosening asks, a tightening is one
 *   click: tested in SE-14), `one-click` (ADR 0062 decision 6: tightenings, brakes, reads, dry runs, "Run now",
 *   rejections, Sign out everywhere) or `outside` (not on ADR 0062's list: proposals the owner approves later, the
 *   owner's bookkeeping, and the routes this review reports as candidates; see the report).
 * - SE-13 also sends each `asks` route, on a session that has NOT stepped up, a body that passes the route's own input
 *   checks where they come before the step-up: each must answer 403 REAUTH_REQUIRED.
 * - SE-14: the conditional ones, both directions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAdminStack, type AdminStack } from '../../admin/helpers.js';
import { notSteppedUp, type Owner } from './helpers.js';

type Kind = 'asks' | 'conditional' | 'one-click' | 'outside';
interface Route {
  readonly kind: Kind;
  /** Values for the route's parameters (default: `r4x`). */
  readonly params?: Record<string, string>;
  readonly body?: unknown;
}

const ROUTES: Record<string, Route> = {
  // ---- jobs and errors
  // ADR 0066 part B, questions 3 and 4 (the owner, 21 November 2026): releasing a stopped or paused job asks.
  'POST /api/admin/jobs/:id/resume-stopped': {
    kind: 'asks',
    params: { id: 'job_r4x' },
    body: { confirm: true },
  },
  'POST /api/admin/jobs/:id/cancel': { kind: 'one-click' },
  'POST /api/admin/jobs/:id/pause': { kind: 'one-click' },
  'POST /api/admin/jobs/:id/resume': { kind: 'asks', params: { id: 'job_r4x' } }, // a paused job's brake released
  'POST /api/admin/jobs/:id/steps/:stepNo/retry': { kind: 'conditional' }, // a forced retry asks: SE-14
  'POST /api/admin/errors/resolve': { kind: 'outside' },
  'POST /api/admin/jobs/:id/revert': { kind: 'asks', params: { id: 'job_r4x' }, body: { confirm: true } },
  // ---- budgets and writers
  'PUT /api/admin/budgets/reserve-floors': { kind: 'asks', body: { reset: true, confirm: true } },
  'PUT /api/admin/writers/max': { kind: 'asks', body: { value: 2, confirm: true } },
  'POST /api/admin/writes/pause': { kind: 'one-click' },
  'POST /api/admin/writes/resume': { kind: 'asks' },
  'POST /api/admin/writes/drain': { kind: 'one-click' },
  'POST /api/admin/writes/undrain': { kind: 'asks' },
  // ---- proposals (approvals: test/review/r4-sessions/approvals-*.test.ts)
  'POST /api/admin/proposals/:id/approve': { kind: 'conditional' },
  'POST /api/admin/proposals/:id/approve-as-canon': { kind: 'conditional' },
  'POST /api/admin/proposals/:id/repropose': { kind: 'outside' }, // makes a proposal
  'POST /api/admin/proposals/:id/reject': { kind: 'one-click' },
  'POST /api/admin/proposals/bulk': { kind: 'conditional' },
  // v3 F5a (ADR 0067, H4): a decision over a filter: rejecting is a brake (one click), approving asks when guarded.
  'POST /api/admin/proposals/bulk-matching': { kind: 'conditional' },
  // ---- clients and access
  'POST /api/admin/clients/profiles': { kind: 'conditional' },
  'PUT /api/admin/clients/profiles/:id/scope': { kind: 'conditional' },
  'PUT /api/admin/clients/profiles/:id/low-level-tools': { kind: 'asks', body: { show: true } },
  'PUT /api/admin/clients/profiles/:id/rails': {
    kind: 'asks',
    body: { rails: { deletes: false }, confirm: true },
  },
  'PUT /api/admin/clients/default-scope': { kind: 'conditional' },
  'PUT /api/admin/clients/connections/:id/profile': { kind: 'conditional' },
  'POST /api/admin/clients/connections/:id/revoke': { kind: 'one-click' },
  'POST /api/admin/clients/connections/remove-inactive': { kind: 'one-click' },
  'POST /api/admin/clients/connections/:id/remove': { kind: 'one-click' },
  'POST /api/admin/clients/connections/revoke-stale': { kind: 'one-click' },
  'PUT /api/admin/clients/settings/auto-remove-days': { kind: 'asks', body: { days: 0 } },
  'PUT /api/admin/clients/settings/stale-after-days': { kind: 'asks', body: { days: 0 } },
  'POST /api/admin/clients/pats': { kind: 'asks', body: { name: 'r4 key', profileId: 'prof_r4x' } },
  // ---- the bridge's settings
  'PUT /api/admin/settings/read-only': { kind: 'conditional' },
  'PUT /api/admin/settings/expose-per-op-tools': { kind: 'asks', body: { value: true, confirm: true } },
  'PUT /api/admin/settings/member-admin': { kind: 'asks', body: { value: true, confirm: true } },
  'PUT /api/admin/settings/contact-email': { kind: 'asks', body: { value: null, confirm: true } },
  'PUT /api/admin/settings/journal-retention': { kind: 'asks', body: { value: null, confirm: true } },
  'PUT /api/admin/settings/tier-limits': { kind: 'asks', body: { value: null, confirm: true } },
  // ---- maintenance
  'POST /api/admin/maintenance/assign-block-ids-sweep/dry-run': { kind: 'one-click' },
  'PUT /api/admin/maintenance/assign-block-ids-sweep/override': { kind: 'conditional' },
  'PUT /api/admin/maintenance/assign-block-ids-sweep/limit': { kind: 'asks', body: { maxPerRun: 500 } },
  'POST /api/admin/maintenance/:id/enable': { kind: 'asks', params: { id: 'journal-prune' } },
  'POST /api/admin/maintenance/:id/disable': { kind: 'conditional' },
  'PUT /api/admin/maintenance/:id/schedule': {
    kind: 'asks',
    params: { id: 'journal-prune' },
    body: { schedule: null },
  },
  'POST /api/admin/maintenance/:id/run': { kind: 'one-click' },
  // ---- mappings (chunk 6 scaffold: the owner's own records)
  'POST /api/admin/mappings/sets': { kind: 'outside' },
  'PUT /api/admin/mappings/sets/:id': { kind: 'outside' },
  'POST /api/admin/mappings/sets/:id/delete': { kind: 'outside' },
  'POST /api/admin/mappings/sets/:id/activate': { kind: 'outside' },
  'POST /api/admin/mappings/sets/:id/deactivate': { kind: 'outside' },
  'POST /api/admin/mappings/sets/:id/rules': { kind: 'outside' },
  'PUT /api/admin/mappings/rules/:id': { kind: 'outside' },
  'POST /api/admin/mappings/rules/:id/delete': { kind: 'outside' },
  'POST /api/admin/mappings/sets/:id/fields': { kind: 'outside' },
  'PUT /api/admin/mappings/fields/:id': { kind: 'outside' },
  'POST /api/admin/mappings/fields/:id/delete': { kind: 'outside' },
  'POST /api/admin/mappings/import': { kind: 'outside' },
  // ---- projects and keys
  'POST /api/admin/projects/check': { kind: 'asks', body: { name: 'r4x', apiKey: 'not-a-key' } },
  'POST /api/admin/projects/:name/key/check': { kind: 'asks', body: { apiKey: 'not-a-key' } },
  'POST /api/admin/projects/confirm': { kind: 'asks', body: { checkId: 'r4x', confirm: true } },
  'PUT /api/admin/projects/:name/draining': { kind: 'conditional' },
  'POST /api/admin/projects/:name/remove': { kind: 'asks', body: { confirm: true } },
  'POST /api/admin/projects/:name/default': { kind: 'asks', body: { confirm: true } },
  'PUT /api/admin/projects/:name/read-only': { kind: 'conditional' },
  'PUT /api/admin/projects/:name/settings': { kind: 'conditional' },
  'PUT /api/admin/projects/:name/canon': { kind: 'asks', body: { rules: null, confirm: true } },
  'POST /api/admin/projects/:name/verify': { kind: 'one-click' }, // a read
  'PUT /api/admin/projects/:name/lifecycle': { kind: 'asks', body: { confirm: true, reset: true } },
  // the project's chronology settings: stored as the project setting `chronology` (SE-15)
  'PUT /api/admin/projects/:name/chronology': { kind: 'outside' },
  'POST /api/admin/projects/:name/chronology/lookup': { kind: 'one-click' }, // a read
  // ---- the repository tree and the asset tree (reads, and the owner's confirmation of a read's cost)
  'POST /api/admin/tree/build': { kind: 'one-click' },
  'POST /api/admin/tree/build/confirm': { kind: 'one-click' },
  'POST /api/admin/tree/build/cancel': { kind: 'one-click' },
  'POST /api/admin/tree/suggest-root': { kind: 'one-click' },
  'POST /api/admin/asset-tree/build': { kind: 'one-click' },
  'POST /api/admin/asset-tree/build/confirm': { kind: 'one-click' },
  'POST /api/admin/asset-tree/build/cancel': { kind: 'one-click' },
  'POST /api/admin/asset-tree/refresh': { kind: 'one-click' },
  'POST /api/admin/asset-tree/plan': { kind: 'one-click' },
  // ---- the owner's account
  'POST /api/admin/security/reauth': { kind: 'one-click' },
  'POST /api/admin/security/sessions/revoke-all': { kind: 'one-click' },
  'POST /api/admin/security/password': {
    kind: 'asks',
    body: { currentPassword: 'not-it', newPassword: 'not-it-either-x' },
  },
  'POST /api/admin/security/totp/enrol': { kind: 'asks' },
  'POST /api/admin/security/totp/confirm': { kind: 'asks', body: { code: '123456' } },
  'POST /api/admin/security/totp/remove': { kind: 'asks', body: { confirm: true } },
  'POST /api/admin/security/recovery-codes': { kind: 'asks', body: { confirm: true } },
  // ---- the type registry (not on ADR 0062's list)
  'POST /api/admin/registry/types': { kind: 'outside' },
  'PUT /api/admin/registry/types/:id': { kind: 'outside' },
  'POST /api/admin/registry/types/:id/delete': { kind: 'outside' },
  'POST /api/admin/registry/seed-character': { kind: 'outside' },
  'POST /api/admin/registry/templates/refresh': { kind: 'one-click' }, // a read
  'POST /api/admin/registry/types/:id/taxonomy/seed': { kind: 'outside' },
  'POST /api/admin/registry/types/:id/taxonomy/add-missing': { kind: 'outside' },
  'PUT /api/admin/registry/taxonomy/:id': { kind: 'outside' },
  'POST /api/admin/registry/taxonomy/:id/delete': { kind: 'outside' },
  'POST /api/admin/registry/drift/run': { kind: 'one-click' }, // a read
  // ---- chronology
  'POST /api/admin/chronology/records/:id/resolve': { kind: 'outside' },
  'POST /api/admin/chronology/check': { kind: 'one-click' },
  'POST /api/admin/chronology/propose-fix': { kind: 'outside' }, // makes a proposal
  'POST /api/admin/chronology/table-only': { kind: 'outside' },
  // ---- staging
  'POST /api/admin/staging/upload': { kind: 'outside' },
  'POST /api/admin/staging/preview': { kind: 'one-click' },
  'POST /api/admin/staging/:id/place': { kind: 'outside' },
  'POST /api/admin/staging/:id/discard': { kind: 'one-click' }, // a staged image never placed
  'POST /api/admin/staging/allow-delete': { kind: 'asks', body: { assetId: 'r4x', confirm: true } },
  // ---- snapshots
  'POST /api/admin/snapshots/full': { kind: 'one-click' },
  'POST /api/admin/snapshots/runs/:id/abandon': { kind: 'outside' },
  'POST /api/admin/snapshots/restores/:id/finish': { kind: 'outside' }, // makes a proposal
  'POST /api/admin/snapshots/restore': { kind: 'outside' }, // makes a proposal
  'POST /api/admin/snapshots/restore-image': { kind: 'outside' }, // makes a proposal
  'POST /api/admin/snapshots/rehearsals/plan': { kind: 'one-click' },
  // A rehearsal writes into a sandbox project (ADR 0066 part B, question 4): its start asks.
  'POST /api/admin/snapshots/rehearsals': {
    kind: 'asks',
    body: { target: 'r4x', snapshot: '20261121T000000Z-full-0a1b2c', mode: 'sampled', confirm: true },
  },
  'POST /api/admin/snapshots/rehearsals/:id/delete-root': {
    kind: 'asks',
    params: { id: 'rh_0123456789abcdef' },
    body: { confirm: true },
  },
  // ---- the off-site copy (every change asks, ADR 0062)
  'PUT /api/admin/offsite/client': { kind: 'asks', body: { clientId: 'x', clientSecret: 'y' } },
  'POST /api/admin/offsite/connect': { kind: 'asks' },
  'POST /api/admin/offsite/disconnect': { kind: 'asks', body: { confirm: true } },
  'POST /api/admin/offsite/check': { kind: 'one-click' },
  'POST /api/admin/offsite/keys/generate': { kind: 'asks' },
  'POST /api/admin/offsite/keys/confirm': { kind: 'asks' },
  'PUT /api/admin/offsite/keys': { kind: 'asks' },
  'PUT /api/admin/offsite/settings': { kind: 'asks' },
  'POST /api/admin/offsite/copy': { kind: 'one-click' },
  'POST /api/admin/offsite/verify': { kind: 'one-click' },
  'POST /api/admin/offsite/folders/:generation/delete': {
    kind: 'asks',
    params: { generation: '1' },
    body: { confirm: true },
  },
  'POST /api/admin/offsite/adopt': { kind: 'asks', body: { confirm: true } },
  // ---- audits
  'POST /api/admin/audits/run': { kind: 'one-click' },
  'POST /api/admin/audits/findings/:id/acknowledge': { kind: 'outside' },
  'POST /api/admin/audits/findings/:id/unacknowledge': { kind: 'outside' },
  'POST /api/admin/audits/findings/:id/allow-name': { kind: 'outside' }, // ADR 0063 A7: none
  'POST /api/admin/audits/findings/:id/propose-fix': { kind: 'outside' }, // makes a proposal
  'POST /api/admin/audits/findings/:id/recheck': { kind: 'one-click' },
  'PUT /api/admin/audits/config': { kind: 'asks', body: { confirm: true } },
  'POST /api/admin/audits/findings/:id/consistency-pick': {
    kind: 'asks',
    params: { id: '1' },
    body: { confirm: true, side: 'r4x' },
  },
  'PUT /api/admin/tool-calls/retention': { kind: 'asks', body: { days: 30, confirm: true } },
  // ---- evaluation (the owner's notes)
  'POST /api/admin/evaluation/runs': { kind: 'outside' },
  'POST /api/admin/evaluation/runs/:id/finish': { kind: 'outside' },
  'POST /api/admin/evaluation/runs/:id/delete': { kind: 'outside' },
  'POST /api/admin/evaluation/runs/:id/scenarios/:scenario/start': { kind: 'outside' },
  'POST /api/admin/evaluation/runs/:id/scenarios/:scenario/done': { kind: 'outside' },
  'POST /api/admin/evaluation/runs/:id/scenarios/:scenario/reset': { kind: 'outside' },
  'PUT /api/admin/evaluation/runs/:id/scenarios/:scenario/grade': { kind: 'outside' },
  // ---- packs (every change asks)
  'POST /api/admin/packs/:id/approve': { kind: 'asks', body: { confirm: true } },
  'POST /api/admin/packs/:id/sections': { kind: 'asks' },
  'PUT /api/admin/packs/:id/tools': { kind: 'asks' },
  'PUT /api/admin/packs/:id/tokens': { kind: 'asks' },
  // ---- appraisal (reports and proposals)
  'POST /api/admin/appraisal/run': { kind: 'one-click' },
  'POST /api/admin/appraisal/findings/:id/propose-fix': { kind: 'outside' },
  'POST /api/admin/appraisal/index/rebuild': { kind: 'one-click' },
  // ---- tagging
  'POST /api/admin/tagging/audit': { kind: 'one-click' },
  'POST /api/admin/tagging/classify': { kind: 'asks' },
  'POST /api/admin/tagging/unclassify': { kind: 'asks' },
  'POST /api/admin/tagging/batches': { kind: 'conditional' },
  // v3 F5a (ADR 0067, H2 and H4): the owner's rulings on exceptions, and the bulk apply.
  'POST /api/admin/tagging/keep-here': { kind: 'asks' },
  'POST /api/admin/tagging/unkeep': { kind: 'one-click' }, // a tightening: the ruling withdrawn
  'POST /api/admin/tagging/allow-everywhere': { kind: 'conditional' }, // a dry run is one click; the edit asks
  'POST /api/admin/tagging/apply-all': { kind: 'conditional' }, // more than 10 pages in all asks
  'POST /api/admin/tagging/approve-batches': {
    kind: 'asks',
    body: { proposalIds: ['prop_r4x'], confirm: true },
  },
  'POST /api/admin/tagging/reconciliations': { kind: 'outside' }, // an audit (free) only
  'POST /api/admin/tagging/reconciliations/:id/resume': {
    kind: 'asks',
    params: { id: 'rtr_0123456789abcdef' },
    body: { confirm: true },
  },
  // ---- review
  'POST /api/admin/review/mark': { kind: 'outside' },
  'POST /api/admin/review/mark-all': { kind: 'outside' },
};

let s: AdminStack;
let owner: Owner;
let project: string;
beforeAll(async () => {
  s = await startAdminStack();
  await s.runtime.ready;
  owner = notSteppedUp(s);
  project = s.runtime.projects.defaultProject().name;
});
afterAll(async () => {
  await s?.close();
});

const fill = (url: string, params: Record<string, string> = {}) =>
  url.replace(/:([A-Za-z]+)/g, (_, k: string) => params[k] ?? (k === 'name' ? project : 'r4x'));

describe('every mutating admin route, against ADR 0062', () => {
  it('SE-13: every mutating route is classified, and every route that always asks answers REAUTH_REQUIRED unstepped', async () => {
    const registered = s.routes.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url}`);
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered.filter((r) => !(r in ROUTES))).toEqual([]);
    expect(Object.keys(ROUTES).filter((r) => !registered.includes(r))).toEqual([]);
    const notAsking: string[] = [];
    for (const [key, r] of Object.entries(ROUTES)) {
      if (r.kind !== 'asks') continue;
      const [method, url] = key.split(' ') as [string, string];
      const res = await owner.call(method, fill(url, r.params), r.body ?? {});
      if (res.status !== 403 || res.json?.error?.code !== 'REAUTH_REQUIRED')
        notAsking.push(`${key} → ${res.status} ${res.text.slice(0, 160)}`);
    }
    expect(notAsking).toEqual([]);
    const count = (k: Kind) => Object.values(ROUTES).filter((r) => r.kind === k).length;
    expect({
      all: registered.length,
      asks: count('asks'),
      conditional: count('conditional'),
      oneClick: count('one-click'),
      outside: count('outside'),
    }).toMatchObject({ all: Object.keys(ROUTES).length });
  });

  it('SE-14: the conditional routes ask for the loosening and stay one click for the tightening', async () => {
    const out: Record<string, number | string> = {};
    const code = async (method: string, path: string, body: unknown) => {
      const r = await owner.call(method, `/api/admin${path}`, body);
      return r.status === 403 && r.json?.error?.code === 'REAUTH_REQUIRED' ? 'asks' : r.status;
    };
    const read = s.policy.commands.createProfile('owner', {
      label: 'r4 se14 read',
      kind: 'other',
      scope: 'read',
    });
    const write = s.policy.commands.createProfile('owner', {
      label: 'r4 se14 write',
      kind: 'other',
      scope: 'write',
    });
    const pat = s.services.pats.create({ name: 'r4 se14', profileId: read.id });
    out.defaultScopeRaise = await code('PUT', '/clients/default-scope', {
      scope: 'write',
      confirmRaise: true,
    });
    out.connectionToWrite = await code('PUT', `/clients/connections/${pat.pat.id}/profile`, {
      profileId: write.id,
    });
    out.newProfileWithScope = await code('POST', '/clients/profiles', {
      label: 'r4 se14 new',
      kind: 'other',
      scope: 'propose',
    });
    out.sweepOverrideOn = await code('PUT', '/maintenance/assign-block-ids-sweep/override', { on: true });
    out.backupJobOff = await code('POST', '/maintenance/snapshot-full/disable', {});
    out.projectSetting = await code('PUT', `/projects/${project}/settings`, {
      key: 'charactersRootId',
      value: 'r4root001',
    });
    out.fileSourceBackToDefault = await code('PUT', `/projects/${project}/settings`, {
      key: 'fileSourceEnabled',
      value: null,
    });
    // ADR 0066 part B, question 4: a forced step retry (sent again as new work) asks; a normal one checks first.
    out.forcedRetry = await code('POST', `/jobs/job_r4x/steps/0/retry?project=${project}`, { force: true });
    out.retagBatchOf11 = await code('POST', '/tagging/batches', {
      runId: 'rtg_0123456789abcdef',
      pageIds: Array.from({ length: 11 }, (_, i) => `r4page${i}`),
      confirm: true,
    });
    // The tightenings: one click (any answer but REAUTH_REQUIRED).
    out.fileSourceOff = await code('PUT', `/projects/${project}/settings`, {
      key: 'fileSourceEnabled',
      value: false,
    });
    out.connectionDown = await code('PUT', `/clients/connections/${pat.pat.id}/profile`, {
      profileId: read.id,
    });
    out.ordinaryJobOff = await code('POST', '/maintenance/journal-prune/disable', {});
    out.sweepOverrideOff = await code('PUT', '/maintenance/assign-block-ids-sweep/override', { on: false });
    out.normalRetry = await code('POST', `/jobs/job_r4x/steps/0/retry?project=${project}`, { force: false });
    expect(out).toMatchObject({
      defaultScopeRaise: 'asks',
      connectionToWrite: 'asks',
      newProfileWithScope: 'asks',
      sweepOverrideOn: 'asks',
      backupJobOff: 'asks',
      projectSetting: 'asks',
      fileSourceBackToDefault: 'asks',
      retagBatchOf11: 'asks',
      forcedRetry: 'asks',
    });
    for (const k of ['fileSourceOff', 'connectionDown', 'ordinaryJobOff', 'sweepOverrideOff', 'normalRetry'])
      expect(out[k], k).not.toBe('asks');
  });
});
