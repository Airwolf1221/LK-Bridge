/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- JSON replies of the admin API and the MCP tools in tests */
/**
 * v2 E2 (ADR 0044): the Audits page's API (src/admin/routes/audits.ts), the `audit_findings` tool
 * (src/mcp/tools/audits.ts) and the maintenance job, against the REAL stack on the mock world.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_CSRF_PURPOSE } from '../../src/admin/guard.js';
import { PROJECT, PUBLIC_URL } from '../tools/helpers.js';
import { A, auditsWorld, type AuditsWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: AuditsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- JSON replies

function owner(world: AuditsWorld) {
  const s = world.stack.services;
  const session = s.owner.createSession('127.0.0.1', 'vitest');
  const cookie = `${s.owner.sessionCookie}=${session}`;
  const csrf = s.owner.csrfToken(session, ADMIN_CSRF_PURPOSE);
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${world.stack.base}/api/admin${path}`, {
      method,
      headers: {
        cookie,
        origin: PUBLIC_URL,
        ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Json };
  };
  return {
    get: (path: string) => request('GET', path),
    post: (path: string, body: unknown = {}) => request('POST', path, body),
    put: (path: string, body: unknown = {}) => request('PUT', path, body),
    /** The owner steps up (ADR 0081: only credential changes ask, within 12 hours). */
    reauth: () =>
      world.stack.db
        .prepare('UPDATE auth_owner_sessions SET reauth_at = ? WHERE session_hash = ?')
        .run(Math.floor(Date.now() / 1000), s.sessionHash(session)),
  };
}

const q = '?project=test';

describe('the dashboard API', () => {
  it('summarises by category and severity, filters, groups by page, and shows each finding’s evidence and source', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const o = owner(w);
    const page = await o.get(`/audits${q}`);
    expect(page.status).toBe(200);
    expect(page.json.latestRun).toMatchObject({ state: 'succeeded', trigger: 'snapshot' });
    expect(page.json.runs).toHaveLength(1);
    expect(page.json.newestFullSnapshot).toMatchObject({ id: page.json.latestRun.snapshotId });
    expect(page.json.summary.byCategory.keep_regions.warning).toBeGreaterThanOrEqual(3);
    expect(page.json.summary.byCategory.ordering).toBeDefined();
    expect(page.json.catalogue.codes.find((c: Json) => c.code === 'line_break_paragraph')).toMatchObject({
      category: 'keep_regions',
      fix: 'split_paragraph',
    });

    const all = await o.get(`/audits/findings${q}&limit=500`);
    expect(all.json.total).toBe(page.json.summary.open);
    const filtered = await o.get(
      `/audits/findings${q}&category=keep_regions&code=line_break_paragraph&severity=warning`,
    );
    expect(filtered.json.findings.length).toBe(3);
    expect(filtered.json.findings.every((f: Json) => f.code === 'line_break_paragraph')).toBe(true);
    const byPath = await o.get(`/audits/findings${q}&page=${encodeURIComponent('Audit Zoo / Many Lines')}`);
    expect(byPath.json.findings.length).toBeGreaterThan(0);
    expect(byPath.json.findings.every((f: Json) => f.pagePath.includes('Audit Zoo / Many Lines'))).toBe(true);
    const fresh = await o.get(`/audits/findings${q}&new=true&limit=500`);
    expect(fresh.json.total).toBe(all.json.total);
    const grouped = await o.get(`/audits/findings${q}&group=page&category=keep_regions`);
    const many = grouped.json.groups.find((g: Json) => g.pageId === A.breaks);
    expect(many.findings).toHaveLength(2);
    expect(many.pageName).toBe('[BSRC] Many Lines');

    const one = await o.get(`/audits/findings/${filtered.json.findings[0].id}${q}`);
    expect(one.json.finding).toMatchObject({ code: 'line_break_paragraph', pageId: expect.any(String) });
    expect(one.json.finding.evidence).toMatchObject({ splittable: true });
    expect(one.json.finding.source).toMatchObject({
      kind: 'snapshot',
      snapshotId: page.json.latestRun.snapshotId,
    });
    expect((await o.get(`/audits/findings/99999${q}`)).status).toBe(404);
  });

  it('runs an audit now (in the background, reading no LegendKeeper), and refuses a second while one runs', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const o = owner(w);
    const before = w.requests();
    const r = await o.post(`/audits/run${q}`, { confirm: true });
    expect(r.json).toEqual({ started: true });
    await w.stack.runtime.audits.settled();
    for (let i = 0; i < 200 && w.stack.runtime.audits.store.runs(PROJECT).length < 2; i++)
      await new Promise((x) => setTimeout(x, 25));
    for (let i = 0; i < 200 && w.stack.runtime.audits.store.runningRun(PROJECT); i++)
      await new Promise((x) => setTimeout(x, 25));
    expect(w.stack.runtime.audits.store.runs(PROJECT).map((x) => x.trigger)).toEqual(['manual', 'snapshot']);
    expect(w.requests()).toBe(before);
    expect((await o.post(`/audits/run${q}`, {})).status).toBe(400); // confirm is required
  });

  it('acknowledges with a reason (required), hides the finding, un-acknowledges; audited', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const o = owner(w);
    const f = (await o.get(`/audits/findings${q}&code=unclassified_page`)).json.findings[0];
    expect((await o.post(`/audits/findings/${f.id}/acknowledge${q}`, { confirm: true })).status).toBe(400);
    expect(
      (await o.post(`/audits/findings/${f.id}/acknowledge${q}`, { confirm: true, reason: '  ' })).status,
    ).toBe(400);
    const ok = await o.post(`/audits/findings/${f.id}/acknowledge${q}`, {
      confirm: true,
      reason: 'Scratch page, on purpose.',
    });
    expect(ok.status).toBe(200);
    expect(ok.json.finding.acknowledgement).toMatchObject({
      reason: 'Scratch page, on purpose.',
      by: 'owner',
    });
    expect((await o.get(`/audits/findings${q}&code=unclassified_page`)).json.total).toBe(0);
    expect((await o.get(`/audits/findings${q}&code=unclassified_page&acknowledged=only`)).json.total).toBe(1);
    expect((await o.get(`/audits${q}`)).json.summary.acknowledged).toBe(1);
    const back = await o.post(`/audits/findings/${f.id}/unacknowledge${q}`, { confirm: true });
    expect(back.json.finding.acknowledgement).toBeNull();
    expect((await o.get(`/audits/findings${q}&code=unclassified_page`)).json.total).toBe(1);
    const log = w.stack.db
      .prepare("SELECT action FROM audit_log WHERE action LIKE 'audits.%' ORDER BY id")
      .all() as { action: string }[];
    expect(log.map((l) => l.action)).toEqual(['audits.acknowledge', 'audits.unacknowledge']);
  });

  it('Apply fix and Re-check now are the owner’s buttons: the fix is one confirmed action (a job at once, no proposal); refusals are typed', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const o = owner(w);
    const split = (
      await o.get(`/audits/findings${q}&code=line_break_paragraph&page=Many`)
    ).json.findings.find((f: Json) => f.blockId === 'bp1');
    const before = structuredClone(w.blocksOf(A.breaks));
    // A re-check of the finding reads the page live.
    const rc = await o.post(`/audits/findings/${split.id}/recheck${q}`, { confirm: true });
    expect(rc.json).toMatchObject({ status: 'still_present' });
    expect(rc.json.finding.source.kind).toBe('live');
    expect((await o.post(`/audits/findings/${split.id}/propose-fix${q}`, {})).status).toBe(400); // confirm is required
    expect(w.blocksOf(A.breaks)).toEqual(before);
    // v3 F12 (ADR 0081): the owner's confirmed "Apply fix…" runs the job at once; nothing waits for an approval.
    const pending = (await o.get('/proposals?state=pending')).json;
    const p = await o.post(`/audits/findings/${split.id}/propose-fix${q}`, { confirm: true });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json).toMatchObject({ status: 'job_submitted', fix: 'split_paragraph' });
    expect(p.json.proposalId).toBeUndefined();
    const job = await w.stack.runtime.engine.wait(PROJECT, String(p.json.jobId), 30_000);
    expect(job.status, JSON.stringify(job.lastError ?? null)).toBe('succeeded');
    // The paragraph is split at its line breaks: three paragraphs in its place.
    expect(w.blocksOf(A.breaks)).toHaveLength(before.length + 2);
    expect((await o.get('/proposals?state=pending')).json).toEqual(pending);
    // Re-checked after the fix: gone.
    expect((await o.post(`/audits/findings/${split.id}/recheck${q}`, { confirm: true })).json).toMatchObject({
      status: 'gone',
    });
    // No fix to offer: a typed refusal.
    const noFix = (await o.get(`/audits/findings${q}&code=unclassified_page`)).json.findings[0];
    const refused = await o.post(`/audits/findings/${noFix.id}/propose-fix${q}`, { confirm: true });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('NO_FIX');
  });

  it('the rules editor: seeded defaults from the registry, saved without a fresh code (ADR 0081), audited, validated', async () => {
    w = await auditsWorld();
    const o = owner(w);
    const cfg = await o.get(`/audits/config${q}`);
    expect(cfg.json.seeded).toBe(true);
    expect(cfg.json.rules).toBeNull();
    expect(cfg.json.effectiveRules.map((r: Json) => r.id)).toEqual([
      'character-core',
      'character-compact',
      'index',
    ]);
    expect(cfg.json.registryTypes[0]).toMatchObject({
      singular: 'Character',
      roles: expect.arrayContaining(['core', 'compact', 'index']),
    });
    const rule = {
      id: 'zoo',
      name: 'Zoo',
      enabled: true,
      selectors: { ancestorName: 'Audit Zoo' },
      template: { templateName: 'AI General Source' },
    };
    const body = {
      confirm: true,
      rules: [rule],
      tagSource: { pageId: A.tagdef, documentId: w.mainOf(A.tagdef) },
      settings: { reportUnmatched: false },
    };
    expect((await o.get(`/audits/config${q}`)).json.seeded).toBe(true);
    const bad = await o.put(`/audits/config${q}`, { confirm: true, rules: [{ ...rule, selectors: {} }] });
    expect(bad.status).toBe(400);
    expect((await o.put(`/audits/config${q}`, { rules: [rule] })).status).toBe(400); // confirm is required
    const saved = await o.put(`/audits/config${q}`, body);
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json).toMatchObject({ seeded: false, rules: [rule], settings: { reportUnmatched: false } });
    expect(saved.json.tagSourcePage).toMatchObject({ id: A.tagdef, name: '[BSRC] Tag definitions' });
    expect(saved.json.tagSourcePage.documents.map((d: Json) => d.name)).toContain('Main');
    const log = w.stack.db
      .prepare("SELECT before, after FROM audit_log WHERE action = 'audits.set_config'")
      .all() as { before: string; after: string }[];
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]!.before).rules).toBe('defaults');
    expect(JSON.parse(log[0]!.after).rules[0].id).toBe('zoo');
    // Back to the seeded defaults.
    const reset = await o.put(`/audits/config${q}`, { confirm: true, rules: null });
    expect(reset.json).toMatchObject({ seeded: true });
    expect(reset.json.tagSource).toMatchObject({ pageId: A.tagdef }); // a field left out is kept
  });

  it('the Audit maintenance job runs an audit and is off by default (the full snapshot starts one itself)', async () => {
    w = await auditsWorld();
    await w.stack.runtime.snapshots.full(PROJECT, 'manual');
    await w.stack.runtime.audits.settled();
    const view = w.stack.runtime.maintenance.scheduler.list().find((j) => j.id === 'audit-run')!;
    expect(view).toMatchObject({ implemented: true, enabled: false, scope: 'project', writes: false });
    expect(view.description).toMatch(/never reads LegendKeeper|LegendKeeper is not read/);
  });
});

describe('the audit_findings tool', () => {
  it('reads, filters and pages findings at no LegendKeeper cost; each finding says its snapshot and age and offers no way to apply a fix', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const c = await w.stack.connect();
    const call = (args: Record<string, unknown>) =>
      w!.stack.call(c, 'audit_findings', { project: 'test', ...args });
    const before = w.requests();
    const r = await call({ category: 'keep_regions', limit: 2 });
    expect(r.isError, r.text).toBe(false);
    expect(w.requests()).toBe(before);
    expect(r.body.run).toMatchObject({
      snapshot: expect.any(String),
      stale: false,
      snapshotAgeMinutes: expect.any(Number),
    });
    expect(r.body.count).toBe(2);
    expect(r.body.total).toBeGreaterThanOrEqual(5);
    expect(r.body.nextOffset).toBe(2);
    expect(r.body.findings[0]).toMatchObject({
      category: 'keep_regions',
      source: { kind: 'snapshot', snapshot: expect.any(String), ageMinutes: expect.any(Number) },
      status: 'new',
    });
    expect(r.body.findings[0].evidence).toBeUndefined(); // summary by default
    expect(r.body.hint).toMatch(/ordinary tools/);
    const next = await call({ category: 'keep_regions', limit: 2, offset: 2 });
    expect(next.body.findings.map((f: Json) => f.id)).not.toEqual(
      expect.arrayContaining(r.body.findings.map((f: Json) => f.id)),
    );
    const full = await call({ code: 'line_break_paragraph', detail: 'full', page: A.breaks });
    expect(full.body.findings).toHaveLength(2);
    expect(full.body.findings[0].evidence).toMatchObject({ splittable: true });
    expect(full.body.findings[0].fixAvailable).toMatch(/Split the paragraph/);
    expect(
      (await call({ page: 'zoo / many', severity: 'warning' })).body.findings.every((f: Json) =>
        f.page.path.toLowerCase().includes('zoo / many'),
      ),
    ).toBe(true);
    expect((await call({ category: 'nonsense' })).isError).toBe(true);
    expect((await call({ code: 'nonsense' })).isError).toBe(true);
    // Acknowledged findings are hidden by default and listed on request.
    const f = (await call({ code: 'unclassified_page' })).body.findings[0];
    w.stack.runtime.audits.acknowledge('owner', PROJECT, f.id, 'on purpose');
    expect((await call({ code: 'unclassified_page' })).body.findings).toEqual([]);
    expect(
      (await call({ code: 'unclassified_page', acknowledged: 'only' })).body.findings[0].acknowledged,
    ).toEqual({ reason: 'on purpose' });
  });

  it('is the only audit tool: agents cannot run, edit or acknowledge an audit; a read-scope caller may read', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const reader = w.stack.newToken('reader', 'read');
    const c = await w.stack.connect(reader.token);
    const tools = (await c.listTools()).tools.map((t) => t.name);
    // v3 F3f (ADR 0060): the Arkona pack's retag audit is its own read-only tool, not the audits'.
    expect(tools.filter((n) => /audit/i.test(n) && !n.startsWith('arkona_'))).toEqual(['audit_findings']);
    const r = await w.stack.call(c, 'audit_findings', { project: 'test', limit: 1 });
    expect(r.isError).toBe(false);
    const all = (await (await w.stack.connect()).listTools()).tools.map((t) => t.name);
    expect(all.filter((n) => /audit/i.test(n) && !n.startsWith('arkona_'))).toEqual(['audit_findings']);
    expect(all).not.toContain('run_audit');
  });
});
