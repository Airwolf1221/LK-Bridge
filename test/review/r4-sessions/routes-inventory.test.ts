/**
 * CR-2026-11 round 4 (sessions): every mutating admin route, checked against ADR 0081 (the owner, 26 November 2026: "A
 * code at sign-in is enough"), which narrowed ADR 0062 decisions 5 and 6.
 *
 * - SE-13: every mutating route the admin plugin registers is classified below (so a route added later without a
 *   decision fails this test): `asks` (a credential change: the fresh code, always; exactly the routes of
 *   test/auth/stepup-routes.ts), `was-asked` (asked, always or for a loosening, under ADR 0062; now it does not) or `no`
 *   (never asked).
 * - SE-13 also sends each `asks` route, on a session that has NOT stepped up, a body that would pass its input checks:
 *   each must answer 403 REAUTH_REQUIRED; and each `was-asked` route, with the body the review gave it, must not.
 * - SE-14: the routes that asked only for a loosening under ADR 0062, both directions: a connection's scope asks both
 *   ways now; the others ask neither way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAdminStack, type AdminStack } from '../../admin/helpers.js';
import { STEP_UP_ROUTES } from '../../auth/stepup-routes.js';
import { notSteppedUp, type Owner } from './helpers.js';

type Kind = 'asks' | 'was-asked' | 'no';
interface Route {
  readonly kind: Kind;
  /** Values for the route's parameters (default: `r4x`). */
  readonly params?: Record<string, string>;
  readonly body?: unknown;
}

const ROUTES: Record<string, Route> = {
  // ---- jobs and errors
  // ADR 0066 part B, questions 3 and 4 had releasing a stopped or paused job ask; ADR 0081: it does not.
  'POST /api/admin/jobs/:id/resume-stopped': {
    kind: 'was-asked',
    params: { id: 'job_r4x' },
    body: { confirm: true },
  },
  'POST /api/admin/jobs/:id/cancel': { kind: 'no' },
  'POST /api/admin/jobs/:id/pause': { kind: 'no' },
  'POST /api/admin/jobs/:id/resume': { kind: 'was-asked', params: { id: 'job_r4x' } }, // a paused job's brake released (asked before ADR 0081)
  'POST /api/admin/jobs/:id/steps/:stepNo/retry': { kind: 'was-asked' }, // a forced retry asked: SE-14
  'POST /api/admin/errors/resolve': { kind: 'no' },
  'POST /api/admin/jobs/:id/revert': {
    kind: 'was-asked',
    params: { id: 'job_r4x' },
    body: { confirm: true },
  },
  // ---- budgets and writers
  'PUT /api/admin/budgets/reserve-floors': { kind: 'was-asked', body: { reset: true, confirm: true } },
  // v3 F9 amendment 1 (ADR 0074): the daily tier's floors, a setting.
  'PUT /api/admin/budgets/reserve-day-floors': { kind: 'was-asked', body: { reset: true, confirm: true } },
  'PUT /api/admin/writers/max': { kind: 'was-asked', body: { value: 2, confirm: true } },
  'POST /api/admin/writes/pause': { kind: 'no' },
  'POST /api/admin/writes/resume': { kind: 'was-asked' },
  'POST /api/admin/writes/drain': { kind: 'no' },
  'POST /api/admin/writes/undrain': { kind: 'was-asked' },
  // ---- proposals (approvals: test/review/r4-sessions/approvals-*.test.ts)
  'POST /api/admin/proposals/:id/approve': { kind: 'was-asked' },
  'POST /api/admin/proposals/:id/approve-as-canon': { kind: 'was-asked' },
  'POST /api/admin/proposals/:id/repropose': { kind: 'no' }, // makes a proposal
  'POST /api/admin/proposals/:id/reject': { kind: 'no' },
  'POST /api/admin/proposals/bulk': { kind: 'was-asked' },
  // v3 F5a (ADR 0067, H4): a decision over a filter (approving asked when guarded, before ADR 0081).
  'POST /api/admin/proposals/bulk-matching': { kind: 'was-asked' },
  // ---- clients and access
  'POST /api/admin/clients/profiles': { kind: 'asks' },
  'PUT /api/admin/clients/profiles/:id/scope': { kind: 'asks' },
  'PUT /api/admin/clients/profiles/:id/low-level-tools': { kind: 'was-asked', body: { show: true } },
  'PUT /api/admin/clients/default-scope': { kind: 'asks' },
  'PUT /api/admin/clients/connections/:id/profile': { kind: 'asks' },
  'POST /api/admin/clients/connections/:id/revoke': { kind: 'asks' },
  'POST /api/admin/clients/connections/remove-inactive': { kind: 'asks' },
  'POST /api/admin/clients/connections/:id/remove': { kind: 'asks' },
  'POST /api/admin/clients/connections/revoke-stale': { kind: 'asks' },
  'PUT /api/admin/clients/settings/auto-remove-days': { kind: 'was-asked', body: { days: 0 } },
  'PUT /api/admin/clients/settings/stale-after-days': { kind: 'was-asked', body: { days: 0 } },
  'POST /api/admin/clients/pats': { kind: 'asks', body: { name: 'r4 key', profileId: 'prof_r4x' } },
  // ---- the bridge's settings
  'PUT /api/admin/settings/read-only': { kind: 'was-asked' },
  'PUT /api/admin/settings/expose-per-op-tools': { kind: 'was-asked', body: { value: true, confirm: true } },
  'PUT /api/admin/settings/member-admin': { kind: 'was-asked', body: { value: true, confirm: true } },
  'PUT /api/admin/settings/contact-email': { kind: 'was-asked', body: { value: null, confirm: true } },
  'PUT /api/admin/settings/journal-retention': { kind: 'was-asked', body: { value: null, confirm: true } },
  'PUT /api/admin/settings/tier-limits': { kind: 'was-asked', body: { value: null, confirm: true } },
  // v3 F8 (ADR 0073): every registry setting's edit and reset, and "Restart the bridge" (asked before ADR 0081).
  'PUT /api/admin/settings/config/:key': {
    kind: 'was-asked',
    params: { key: 'IMAGE_MAX_PIXELS' },
    body: { value: 2000, confirm: true },
  },
  'POST /api/admin/settings/config/:key/reset': {
    kind: 'was-asked',
    params: { key: 'IMAGE_MAX_PIXELS' },
    body: { confirm: true },
  },
  'POST /api/admin/bridge/restart': { kind: 'was-asked', body: { confirm: true } },
  // ---- maintenance
  'POST /api/admin/maintenance/assign-block-ids-sweep/dry-run': { kind: 'no' },
  'PUT /api/admin/maintenance/assign-block-ids-sweep/override': { kind: 'was-asked' },
  'PUT /api/admin/maintenance/assign-block-ids-sweep/limit': { kind: 'was-asked', body: { maxPerRun: 500 } },
  'POST /api/admin/maintenance/:id/enable': { kind: 'was-asked', params: { id: 'journal-prune' } },
  'POST /api/admin/maintenance/:id/disable': { kind: 'was-asked' },
  'PUT /api/admin/maintenance/:id/schedule': {
    kind: 'was-asked',
    params: { id: 'journal-prune' },
    body: { schedule: null },
  },
  'POST /api/admin/maintenance/:id/run': { kind: 'no' },
  // ---- mappings (chunk 6 scaffold: the owner's own records)
  'POST /api/admin/mappings/sets': { kind: 'no' },
  'PUT /api/admin/mappings/sets/:id': { kind: 'no' },
  'POST /api/admin/mappings/sets/:id/delete': { kind: 'no' },
  'POST /api/admin/mappings/sets/:id/activate': { kind: 'no' },
  'POST /api/admin/mappings/sets/:id/deactivate': { kind: 'no' },
  'POST /api/admin/mappings/sets/:id/rules': { kind: 'no' },
  'PUT /api/admin/mappings/rules/:id': { kind: 'no' },
  'POST /api/admin/mappings/rules/:id/delete': { kind: 'no' },
  'POST /api/admin/mappings/sets/:id/fields': { kind: 'no' },
  'PUT /api/admin/mappings/fields/:id': { kind: 'no' },
  'POST /api/admin/mappings/fields/:id/delete': { kind: 'no' },
  'POST /api/admin/mappings/import': { kind: 'no' },
  // ---- projects and keys
  'POST /api/admin/projects/check': { kind: 'asks', body: { name: 'r4x', apiKey: 'not-a-key' } },
  'POST /api/admin/projects/:name/key/check': { kind: 'asks', body: { apiKey: 'not-a-key' } },
  'POST /api/admin/projects/confirm': { kind: 'asks', body: { checkId: 'r4x', confirm: true } },
  'PUT /api/admin/projects/:name/draining': { kind: 'was-asked' },
  'POST /api/admin/projects/:name/remove': { kind: 'asks', body: { confirm: true } },
  'POST /api/admin/projects/:name/default': { kind: 'was-asked', body: { confirm: true } },
  'PUT /api/admin/projects/:name/read-only': { kind: 'was-asked' },
  'PUT /api/admin/projects/:name/settings': { kind: 'was-asked' },
  'PUT /api/admin/projects/:name/canon': { kind: 'was-asked', body: { rules: null, confirm: true } },
  'POST /api/admin/projects/:name/verify': { kind: 'no' }, // a read
  'PUT /api/admin/projects/:name/lifecycle': { kind: 'was-asked', body: { confirm: true, reset: true } },
  // the project's chronology settings: stored as the project setting `chronology` (SE-15)
  'PUT /api/admin/projects/:name/chronology': { kind: 'no' },
  'POST /api/admin/projects/:name/chronology/lookup': { kind: 'no' }, // a read
  // ---- the repository tree and the asset tree (reads, and the owner's confirmation of a read's cost)
  'POST /api/admin/tree/build': { kind: 'no' },
  'POST /api/admin/tree/build/confirm': { kind: 'no' },
  'POST /api/admin/tree/build/cancel': { kind: 'no' },
  'POST /api/admin/tree/suggest-root': { kind: 'no' },
  'POST /api/admin/asset-tree/build': { kind: 'no' },
  'POST /api/admin/asset-tree/build/confirm': { kind: 'no' },
  'POST /api/admin/asset-tree/build/cancel': { kind: 'no' },
  'POST /api/admin/asset-tree/refresh': { kind: 'no' },
  'POST /api/admin/asset-tree/plan': { kind: 'no' },
  // ---- the owner's account
  'POST /api/admin/security/reauth': { kind: 'no' },
  'POST /api/admin/security/sessions/revoke-all': { kind: 'no' },
  'POST /api/admin/security/password': {
    kind: 'asks',
    body: { currentPassword: 'not-it', newPassword: 'not-it-either-x' },
  },
  'POST /api/admin/security/totp/enrol': { kind: 'asks' },
  'POST /api/admin/security/totp/confirm': { kind: 'asks', body: { code: '123456' } },
  'POST /api/admin/security/totp/remove': { kind: 'asks', body: { confirm: true } },
  'POST /api/admin/security/recovery-codes': { kind: 'asks', body: { confirm: true } },
  // ---- the type registry
  'POST /api/admin/registry/types': { kind: 'no' },
  'PUT /api/admin/registry/types/:id': { kind: 'no' },
  'POST /api/admin/registry/types/:id/delete': { kind: 'no' },
  'POST /api/admin/registry/seed-character': { kind: 'no' },
  'POST /api/admin/registry/templates/refresh': { kind: 'no' }, // a read
  'POST /api/admin/registry/types/:id/taxonomy/seed': { kind: 'no' },
  'POST /api/admin/registry/types/:id/taxonomy/add-missing': { kind: 'no' },
  'PUT /api/admin/registry/taxonomy/:id': { kind: 'no' },
  'POST /api/admin/registry/taxonomy/:id/delete': { kind: 'no' },
  'POST /api/admin/registry/drift/run': { kind: 'no' }, // a read
  // ---- chronology
  'POST /api/admin/chronology/records/:id/resolve': { kind: 'no' },
  'POST /api/admin/chronology/check': { kind: 'no' },
  'POST /api/admin/chronology/propose-fix': { kind: 'no' }, // makes a proposal
  'POST /api/admin/chronology/table-only': { kind: 'no' },
  // ---- staging
  'POST /api/admin/staging/upload': { kind: 'no' },
  'POST /api/admin/staging/preview': { kind: 'no' },
  'POST /api/admin/staging/:id/place': { kind: 'no' },
  'POST /api/admin/staging/:id/discard': { kind: 'no' }, // a staged image never placed
  'POST /api/admin/staging/allow-delete': { kind: 'was-asked', body: { assetId: 'r4x', confirm: true } },
  // ---- v3 F7c (ADR 0075): image archives
  'POST /api/admin/archives/:id/discard': { kind: 'was-asked' },
  // ---- snapshots
  'POST /api/admin/snapshots/full': { kind: 'no' },
  'POST /api/admin/snapshots/runs/:id/abandon': { kind: 'no' },
  'POST /api/admin/snapshots/restores/:id/finish': { kind: 'no' }, // makes a proposal
  'POST /api/admin/snapshots/restore': { kind: 'no' }, // makes a proposal
  'POST /api/admin/snapshots/restore-image': { kind: 'no' }, // makes a proposal
  'POST /api/admin/snapshots/rehearsals/plan': { kind: 'no' },
  // A rehearsal writes into a sandbox project (ADR 0066 part B, question 4: its start asked, before ADR 0081).
  'POST /api/admin/snapshots/rehearsals': {
    kind: 'was-asked',
    body: { target: 'r4x', snapshot: '20261121T000000Z-full-0a1b2c', mode: 'sampled', confirm: true },
  },
  'POST /api/admin/snapshots/rehearsals/:id/delete-root': {
    kind: 'was-asked',
    params: { id: 'rh_0123456789abcdef' },
    body: { confirm: true },
  },
  // ---- the off-site copy (ADR 0081: its credentials ask; its settings and folders do not)
  'PUT /api/admin/offsite/client': { kind: 'asks', body: { clientId: 'x', clientSecret: 'y' } },
  'POST /api/admin/offsite/connect': { kind: 'asks' },
  'POST /api/admin/offsite/disconnect': { kind: 'asks', body: { confirm: true } },
  'POST /api/admin/offsite/check': { kind: 'no' },
  'POST /api/admin/offsite/keys/generate': { kind: 'asks' },
  'POST /api/admin/offsite/keys/confirm': { kind: 'asks' },
  'PUT /api/admin/offsite/keys': { kind: 'asks' },
  'PUT /api/admin/offsite/settings': { kind: 'was-asked' },
  'POST /api/admin/offsite/copy': { kind: 'no' },
  'POST /api/admin/offsite/verify': { kind: 'no' },
  'POST /api/admin/offsite/folders/:generation/delete': {
    kind: 'was-asked',
    params: { generation: '1' },
    body: { confirm: true },
  },
  'POST /api/admin/offsite/adopt': { kind: 'was-asked', body: { confirm: true } },
  // ---- audits
  'POST /api/admin/audits/run': { kind: 'no' },
  'POST /api/admin/audits/findings/:id/acknowledge': { kind: 'no' },
  'POST /api/admin/audits/findings/:id/unacknowledge': { kind: 'no' },
  'POST /api/admin/audits/findings/:id/allow-name': { kind: 'no' }, // ADR 0063 A7: none
  'POST /api/admin/audits/findings/:id/propose-fix': { kind: 'no' }, // makes a proposal
  'POST /api/admin/audits/findings/:id/recheck': { kind: 'no' },
  'PUT /api/admin/audits/config': { kind: 'was-asked', body: { confirm: true } },
  'POST /api/admin/audits/findings/:id/consistency-pick': {
    kind: 'was-asked',
    params: { id: '1' },
    body: { confirm: true, side: 'r4x' },
  },
  // ---- v3 F7 (ADR 0070, G3): the outfit record. A seeding only reads and lists; saving records it.
  'POST /api/admin/art/outfits/seed': { kind: 'no' },
  'POST /api/admin/art/outfits/seed/:id/save': { kind: 'was-asked', params: { id: 'seed_r4x' } },
  'POST /api/admin/art/outfits/seed/:id/discard': { kind: 'no' },
  'POST /api/admin/art/outfits/:id/aliases': { kind: 'no' },
  'POST /api/admin/art/outfits/:id/aliases/remove': { kind: 'no' },
  'PUT /api/admin/tool-calls/retention': { kind: 'was-asked', body: { days: 30, confirm: true } },
  // ---- evaluation (the owner's notes)
  'POST /api/admin/evaluation/runs': { kind: 'no' },
  'POST /api/admin/evaluation/runs/:id/finish': { kind: 'no' },
  'POST /api/admin/evaluation/runs/:id/delete': { kind: 'no' },
  'POST /api/admin/evaluation/runs/:id/scenarios/:scenario/start': { kind: 'no' },
  'POST /api/admin/evaluation/runs/:id/scenarios/:scenario/done': { kind: 'no' },
  'POST /api/admin/evaluation/runs/:id/scenarios/:scenario/reset': { kind: 'no' },
  'PUT /api/admin/evaluation/runs/:id/scenarios/:scenario/grade': { kind: 'no' },
  // ---- packs (every change asked before ADR 0081)
  'POST /api/admin/packs/:id/approve': { kind: 'was-asked', body: { confirm: true } },
  'POST /api/admin/packs/:id/sections': { kind: 'was-asked' },
  'PUT /api/admin/packs/:id/tokens': { kind: 'was-asked' },
  // ---- appraisal (reports and proposals)
  'POST /api/admin/appraisal/run': { kind: 'no' },
  'POST /api/admin/appraisal/findings/:id/propose-fix': { kind: 'no' },
  'POST /api/admin/appraisal/index/rebuild': { kind: 'no' },
  // ---- tagging
  'POST /api/admin/tagging/audit': { kind: 'no' },
  'POST /api/admin/tagging/classify': { kind: 'was-asked' },
  'POST /api/admin/tagging/unclassify': { kind: 'was-asked' },
  'POST /api/admin/tagging/batches': { kind: 'was-asked' },
  // v3 F5a (ADR 0067, H2 and H4): the owner's rulings on exceptions, and the bulk apply.
  'POST /api/admin/tagging/keep-here': { kind: 'was-asked' },
  'POST /api/admin/tagging/unkeep': { kind: 'no' }, // a tightening: the ruling withdrawn
  'POST /api/admin/tagging/allow-everywhere': { kind: 'was-asked' }, // the edit asked before ADR 0081
  'POST /api/admin/tagging/apply-all': { kind: 'was-asked' }, // more than 10 pages in all asked before ADR 0081
  // v3 F5b (ADR 0068, H5): the automation settings and the brake's release asked before ADR 0081.
  'POST /api/admin/automation/codes/:code': {
    kind: 'was-asked',
    params: { code: 'blank_paragraphs' },
    body: { mode: 'apply', confirm: true },
  },
  'POST /api/admin/automation/codes/:code/resume': {
    kind: 'was-asked',
    params: { code: 'blank_paragraphs' },
    body: { confirm: true },
  },
  'POST /api/admin/automation/pause': { kind: 'no' }, // a brake
  'POST /api/admin/automation/resume': { kind: 'was-asked', body: { confirm: true } },
  'POST /api/admin/automation/run': { kind: 'was-asked', body: { confirm: true } },
  'POST /api/admin/tagging/approve-batches': {
    kind: 'was-asked',
    body: { proposalIds: ['prop_r4x'], confirm: true },
  },
  'POST /api/admin/tagging/reconciliations': { kind: 'no' }, // an audit (free) only
  'POST /api/admin/tagging/reconciliations/:id/resume': {
    kind: 'was-asked',
    params: { id: 'rtr_0123456789abcdef' },
    body: { confirm: true },
  },
  // v3 F6a (ADR 0076): the Reference Type decisions and publishing (asked before ADR 0081).
  'POST /api/admin/reference-types/decide': {
    kind: 'was-asked',
    body: { value: 'Cultural Reference', category: 'Culture', action: 'accept', confirm: true },
  },
  'POST /api/admin/reference-types/bulk-accept': { kind: 'was-asked', body: { confirm: true } },
  'POST /api/admin/reference-types/undo': {
    kind: 'was-asked',
    body: { id: 'rtd_0123456789abcdef', confirm: true },
  },
  'POST /api/admin/reference-types/publish': { kind: 'was-asked' }, // the write asked before ADR 0081
  // v3 F6b (ADR 0079): the index classification decisions, the bulk approve and the structural lists (asked before).
  'POST /api/admin/index-classification/decide': {
    kind: 'was-asked',
    body: { pageId: 'idx00001', action: 'approve', confirm: true },
  },
  'POST /api/admin/index-classification/bulk-approve': { kind: 'was-asked', body: { confirm: true } },
  'PUT /api/admin/index-classification/structural': { kind: 'was-asked', body: { confirm: true } },
  // v3 F6c (ADR 0080): the Nation Subindexes decisions, the mapping for every page of a name, an undo, the seed of a
  // structural type and "Keep it here" (asked before ADR 0081).
  'POST /api/admin/nation-subindexes/decide': {
    kind: 'was-asked',
    body: { pageId: 'idx00001', action: 'accept', confirm: true },
  },
  'POST /api/admin/nation-subindexes/map-all': {
    kind: 'was-asked',
    body: { pageId: 'idx00001', role: 'Institutions', confirm: true },
  },
  'POST /api/admin/nation-subindexes/undo': {
    kind: 'was-asked',
    body: { pageId: 'idx00001', confirm: true },
  },
  'POST /api/admin/nation-subindexes/accept-all': { kind: 'was-asked', body: { confirm: true } },
  'POST /api/admin/registry/structural/:kind/seed': { kind: 'was-asked', body: { confirm: true } },
  'POST /api/admin/registry/structural/:kind/add-missing': { kind: 'was-asked', body: { confirm: true } },
  'POST /api/admin/audits/findings/:id/keep-home': {
    kind: 'was-asked',
    body: { reason: 'here', confirm: true },
  },
  // ---- review
  'POST /api/admin/review/mark': { kind: 'no' },
  'POST /api/admin/review/mark-all': { kind: 'no' },
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

const asked = (r: { status: number; json?: { error?: { code?: string } } }) =>
  r.status === 403 && r.json?.error?.code === 'REAUTH_REQUIRED';

describe('every mutating admin route, against ADR 0081', () => {
  it('SE-13: every mutating route is classified; those that ask are the list, and nothing else asks', async () => {
    const registered = s.routes.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url}`);
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered.filter((r) => !(r in ROUTES))).toEqual([]);
    expect(Object.keys(ROUTES).filter((r) => !registered.includes(r))).toEqual([]);
    const asks = Object.entries(ROUTES)
      .filter(([, r]) => r.kind === 'asks')
      .map(([k]) => k);
    expect([...asks].sort()).toEqual([...STEP_UP_ROUTES].sort());
    const wrong: string[] = [];
    for (const [key, r] of Object.entries(ROUTES)) {
      if (r.kind === 'no' || !registered.includes(key)) continue;
      const [method, url] = key.split(' ') as [string, string];
      const res = await owner.call(method, fill(url, r.params), r.body ?? {});
      if (asked(res) !== (r.kind === 'asks'))
        wrong.push(`${key} (${r.kind}) → ${res.status} ${res.text.slice(0, 160)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('SE-14: what asked only for a loosening: a connection’s scope now asks both ways, the rest neither way', async () => {
    const out: Record<string, number | string> = {};
    const code = async (method: string, path: string, body: unknown) => {
      const r = await owner.call(method, `/api/admin${path}`, body);
      return asked(r) ? 'asks' : r.status;
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
    // A connection's scope, either way (ADR 0081: it is a credential change).
    out.defaultScopeRaise = await code('PUT', '/clients/default-scope', {
      scope: 'write',
      confirmRaise: true,
    });
    out.defaultScopeLower = await code('PUT', '/clients/default-scope', { scope: 'read' });
    out.connectionToWrite = await code('PUT', `/clients/connections/${pat.pat.id}/profile`, {
      profileId: write.id,
    });
    out.connectionDown = await code('PUT', `/clients/connections/${pat.pat.id}/profile`, {
      profileId: read.id,
    });
    out.newProfileWithScope = await code('POST', '/clients/profiles', {
      label: 'r4 se14 new',
      kind: 'other',
      scope: 'propose',
    });
    out.newProfileAtDefault = await code('POST', '/clients/profiles', {
      label: 'r4 se14 new 2',
      kind: 'other',
    });
    // The rest: neither way.
    out.sweepOverrideOn = await code('PUT', '/maintenance/assign-block-ids-sweep/override', { on: true });
    out.sweepOverrideOff = await code('PUT', '/maintenance/assign-block-ids-sweep/override', { on: false });
    out.backupJobOff = await code('POST', '/maintenance/snapshot-full/disable', {});
    out.ordinaryJobOff = await code('POST', '/maintenance/journal-prune/disable', {});
    out.projectSetting = await code('PUT', `/projects/${project}/settings`, {
      key: 'charactersRootId',
      value: 'r4root001',
    });
    out.fileSourceBackToDefault = await code('PUT', `/projects/${project}/settings`, {
      key: 'fileSourceEnabled',
      value: null,
    });
    out.fileSourceOff = await code('PUT', `/projects/${project}/settings`, {
      key: 'fileSourceEnabled',
      value: false,
    });
    out.forcedRetry = await code('POST', `/jobs/job_r4x/steps/0/retry?project=${project}`, { force: true });
    out.normalRetry = await code('POST', `/jobs/job_r4x/steps/0/retry?project=${project}`, { force: false });
    out.retagBatchOf11 = await code('POST', '/tagging/batches', {
      runId: 'rtg_0123456789abcdef',
      pageIds: Array.from({ length: 11 }, (_, i) => `r4page${i}`),
      confirm: true,
    });
    const credential = [
      'defaultScopeRaise',
      'defaultScopeLower',
      'connectionToWrite',
      'connectionDown',
      'newProfileWithScope',
      'newProfileAtDefault',
    ];
    for (const k of credential) expect(out[k], k).toBe('asks');
    for (const k of Object.keys(out).filter((k) => !credential.includes(k)))
      expect(out[k], k).not.toBe('asks');
  });
});
