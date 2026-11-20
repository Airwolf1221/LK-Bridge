/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- JSON replies of the admin API and the MCP tools in tests */
/**
 * v3 F4a (ADR 0063): the governance drift check in the nightly audit, against the REAL stack on the mock LegendKeeper
 * (test/packs/f4a-world.ts: Character Architecture's old `write_lk` call; Repository Automation's Startup naming Fiction
 * Writing, a Design References page that resolves, the Moonlit Ledger, which is nowhere, and LK Bootstrap, a near miss
 * for the root's AI Bootstrap tab; its Diagnostic Workflows naming the old skills). The run after a full snapshot
 * reports the `governance` category; `audit_findings` reads it; "Allow this name" silences an external skill for good;
 * and the categories that existed before are unchanged by it. Nothing reads LegendKeeper.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADMIN_CSRF_PURPOSE } from '../../src/admin/guard.js';
import type { Finding } from '../../src/audits/types.js';
import { PUBLIC_URL } from '../tools/helpers.js';
import { PROJECT, f4aWorld, type F4aWorld } from '../packs/f4a-world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: F4aWorld;
beforeAll(async () => {
  w = await f4aWorld();
  await w.snapshot();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

type Json = Record<string, any>;

function owner() {
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
    return { status: res.status, json: (await res.json()) as Json };
  };
  return {
    get: (path: string) => request('GET', path),
    post: (path: string, body: unknown = {}) => request('POST', path, body),
  };
}

const audits = () => w.stack.runtime.audits;
const governance = (): Finding[] =>
  audits().list(PROJECT, { category: ['governance'], acknowledged: 'include', limit: 500 }).findings;
const byName = (name: string) => governance().filter((f) => f.evidence.name === name);

describe('the governance category in the nightly audit (v3 F4a)', () => {
  it('the run after the full snapshot reports the old call, the missing page and the old skill names', () => {
    const run = audits().store.latestRun(PROJECT)!;
    expect(run).toMatchObject({ state: 'succeeded', trigger: 'snapshot' });
    expect(run.counts!.byCategory.governance).toBeDefined();
    const write = byName('write_lk');
    expect(write).toHaveLength(1);
    expect(write[0]).toMatchObject({
      code: 'governance_unknown_tool',
      category: 'governance',
      severity: 'warning',
      documentId: w.governanceDocs.architecture,
      fix: null,
      evidence: { suggestedReplacement: 'get_bridge_guide', arguments: { job_action: 'guide' } },
    });
    // The bridge's own tool on the same page is known: not reported.
    expect(byName('arkona_create_character')).toHaveLength(0);
    // The owner's review: Fiction Writing is the Design References page "Arkona – Fiction Writing Reference" (and its
    // tag), so nothing is reported; a name that is nowhere is.
    expect(byName('Fiction Writing')).toHaveLength(0);
    const moonlit = byName('Moonlit Ledger');
    expect(moonlit).toHaveLength(1);
    expect(moonlit[0]).toMatchObject({
      code: 'governance_missing_reference',
      severity: 'info',
      documentId: w.tabs.automation,
      evidence: { section: 'Repository Automation › Startup and Current Evidence' },
    });
    expect(moonlit[0]!.evidence.nearMiss).toBeUndefined();
    // A near miss for the root's tab, with the closest match suggested.
    expect(byName('LK Bootstrap')[0]).toMatchObject({
      code: 'governance_missing_reference',
      severity: 'info',
      documentId: w.tabs.automation,
      evidence: {
        nearMiss: { closest: 'AI Bootstrap', kind: 'tab', page: { name: 'AI REPOSITORY' } },
        suggestedReplacement: 'AI Bootstrap',
      },
    });
    expect(byName('LK Bootstrap')[0]!.message).toContain('Suggested replacement: “AI Bootstrap”');
    expect(byName('format-baisheng-owners')[0]).toMatchObject({
      code: 'governance_external_name',
      severity: 'info',
      evidence: {
        equivalent: { use: 'arkona_appraise_owner' },
        suggestedReplacement: 'arkona_appraise_owner',
      },
    });
    expect(byName('plan-baisheng-stories')[0]!.evidence.equivalent).toBeUndefined();
    // Project Navigation names only what exists: nothing from it.
    expect(governance().filter((f) => f.documentId === w.tabs.navigation)).toEqual([]);
  });

  it('agents read them with audit_findings (category governance); no fix is ever offered', async () => {
    const r = await w.callRead('audit_findings', { category: 'governance', detail: 'full', project: 'test' });
    expect(r.isError, r.text).toBe(false);
    const codes = new Set((r.body.findings as any[]).map((f) => f.code));
    expect([...codes].sort()).toEqual([
      'governance_external_name',
      'governance_missing_reference',
      'governance_unknown_tool',
    ]);
    expect((r.body.findings as any[]).every((f) => f.fixAvailable === undefined)).toBe(true);
    // "Re-check now" explains that a governance finding is checked by the next run.
    const o = owner();
    const id = byName('write_lk')[0]!.id;
    const re = await o.post(`/audits/findings/${id}/recheck?project=test`, { confirm: true });
    expect(re.status).toBe(409);
    expect(re.json.error.code).toBe('RECHECK_UNSUPPORTED');
    expect(re.json.error.message).toMatch(/Governance findings/);
  });

  it('“Allow this name” silences an external skill for good (audited); other findings cannot be allowed', async () => {
    const o = owner();
    const f = byName('plan-baisheng-stories')[0]!;
    const notSkill = byName('Moonlit Ledger')[0]!;
    const refused = await o.post(`/audits/findings/${notSkill.id}/allow-name?project=test`, {
      confirm: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('NOT_ALLOWABLE');
    const before = w.reads();
    const ok = await o.post(`/audits/findings/${f.id}/allow-name?project=test`, { confirm: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ name: 'plan-baisheng-stories', allowed: ['plan-baisheng-stories'] });
    expect(ok.json.finding.state).toBe('gone');
    expect(audits().config(PROJECT).settings.governanceAllowedNames).toEqual(['plan-baisheng-stories']);
    const row = w.stack.db
      .prepare(`SELECT after FROM audit_log WHERE action = 'audits.allow_name' ORDER BY id DESC LIMIT 1`)
      .get() as { after: string } | undefined;
    expect(row?.after).toMatch(/plan-baisheng-stories/);
    // The next run does not report it again; the other skills are still reported.
    await audits().run(PROJECT, 'manual');
    expect(byName('plan-baisheng-stories').every((x) => x.state === 'gone')).toBe(true);
    expect(byName('format-baisheng-owners')[0]!.state).toBe('open');
    expect(w.reads()).toBe(before);
  });

  it('the categories that existed before are unchanged by it', async () => {
    const others = () =>
      audits()
        .list(PROJECT, { state: 'open', acknowledged: 'include', limit: 500 })
        .findings.filter((f) => f.category !== 'governance')
        .map((f) => `${f.fingerprint} ${f.code} ${f.evidenceHash}`)
        .sort();
    await audits().run(PROJECT, 'manual');
    const withGovernance = others();
    expect(withGovernance.length).toBeGreaterThan(5);
    expect(governance().some((f) => f.state === 'open')).toBe(true);
    // A pack version without the drift rules, approved: the governance category reports nothing; the others as before.
    const packs = w.stack.runtime.packs;
    const pack = packs.get('arkona')!;
    const { governanceAudit: _g, ...rest } = pack.rules;
    const v = packs.store.newVersion('arkona', rest, 'test: no governance drift rules');
    packs.store.approve('arkona', {
      version: v.version,
      at: Date.now(),
      by: 'owner',
      sources: pack.approved!.sources,
    });
    await audits().run(PROJECT, 'manual');
    expect(governance().filter((f) => f.state === 'open')).toEqual([]);
    expect(others()).toEqual(withGovernance);
  });
});
