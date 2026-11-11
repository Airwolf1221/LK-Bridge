/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * C2d, Part 1 (ADR 0037): copies of one template share their property, row and item ids with the template and with
 * each other (LegendKeeper reuses them; the owner's sandbox run of 11 November 2026). The bridge keys everything of a
 * page by the page and the id together. Two copies made in one job, written at once by two jobs, and changed by two
 * proposals: nothing crosses over between them. The copy check's id map is the identity, kept per page.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { facts, resourcesWorld, T, type ResourcesWorld } from './world.js';

let w: ResourcesWorld;
let client: Client;
let proposer: Client;
const call = (tool: string, args: Record<string, unknown>, c: Client = client) =>
  w.stack.call(c, tool, { project: 'test', ...args });
const proposals = () => w.stack.runtime.policy.proposals;
const settle = async (id: string) => {
  for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals().get(id)!.state); i++)
    await new Promise((r) => setTimeout(r, 20));
  return proposals().get(id)!;
};
const rowId = (page: string, key: string) => w.sidebars.rows(page).find((r) => r.key === key)!.id;
const value = (page: string, key: string) => w.sidebars.rows(page).find((r) => r.key === key)?.text;

let alpha = '';
let beta = '';

beforeAll(async () => {
  w = await resourcesWorld();
  client = await w.stack.connect();
  proposer = await w.stack.connect(w.stack.newToken('twin-proposer', 'propose').token);
});
afterAll(async () => w.close());

describe('two copies of one template, with the template’s ids (C2d, Part 1)', () => {
  it('one job makes both, binding each copy’s facts to its own page: the id map is the identity, kept per page', async () => {
    const r = await call('create_many_resources', {
      items: [
        { key: 'a', name: 'Twin Alpha', template: T.general, facts: { Scope: 'Alpha scope' } },
        { key: 'b', name: 'Twin Beta', template: T.general, facts: { Scope: 'Beta scope' } },
      ],
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    alpha = r.body.pages.find((p: { name: string }) => p.name === '[BWRK] Twin Alpha').id;
    beta = r.body.pages.find((p: { name: string }) => p.name === '[BWRK] Twin Beta').id;
    // LegendKeeper's behaviour, as the mock now models it: the same property and row ids on both and the template.
    const tplRows = w.sidebars.rows(T.general).map((x) => x.id);
    expect(w.sidebars.rows(alpha).map((x) => x.id)).toEqual(tplRows);
    expect(w.sidebars.rows(beta).map((x) => x.id)).toEqual(tplRows);
    // Each page has its own facts, nothing of the other's.
    expect(value(alpha, 'Scope')).toBe('Alpha scope');
    expect(value(beta, 'Scope')).toBe('Beta scope');
    // The copy checks mapped each page's ids to themselves, per page.
    const results = w.stack.runtime.engine.stepResults(PROJECT, r.body.jobId) ?? [];
    const maps = results
      .map((x) => (x.value as { idsByPage?: Record<string, Record<string, string>> } | null)?.idsByPage)
      .filter((m): m is Record<string, Record<string, string>> => m !== undefined);
    const pages = Object.assign({}, ...maps) as Record<string, Record<string, string>>;
    expect(Object.keys(pages).sort()).toEqual([alpha, beta].sort());
    for (const m of Object.values(pages)) {
      expect(Object.keys(m).length).toBeGreaterThan(0);
      for (const [from, to] of Object.entries(m)) expect(to).toBe(from);
    }
  });

  it('two jobs at once, one per copy, each write only their own page', async () => {
    const [a, b] = await Promise.all([
      call('set_facts', { page: alpha, facts: { Scope: 'Alpha, second', 'Continuity Type': 'AU' } }),
      call('set_facts', { page: beta, facts: { Scope: 'Beta, second' } }),
    ]);
    expect(a.body, a.text).toMatchObject({ status: 'written', verified: true });
    expect(b.body, b.text).toMatchObject({ status: 'written', verified: true });
    expect(value(alpha, 'Scope')).toBe('Alpha, second');
    expect(value(alpha, 'Continuity Type')).toBe('AU');
    expect(value(beta, 'Scope')).toBe('Beta, second');
    expect(value(beta, 'Continuity Type')).toBe('');
    // The journal: the Scope row's id is the same on both pages, so it is looked up with its page.
    const scope = rowId(alpha, 'Scope');
    expect(rowId(beta, 'Scope')).toBe(scope);
    const q = w.stack.runtime.engine.queries;
    const onAlpha = q.journalLookup(PROJECT, { targetId: scope, resourceId: alpha, limit: 50 });
    const onBeta = q.journalLookup(PROJECT, { targetId: scope, resourceId: beta, limit: 50 });
    expect(onAlpha.length).toBeGreaterThan(0);
    expect(onBeta.length).toBeGreaterThan(0);
    expect(onAlpha.every((e) => e.resourceId === alpha)).toBe(true);
    expect(onBeta.every((e) => e.resourceId === beta)).toBe(true);
    // Without its page, a row id matches nothing (it would match both copies and the template).
    expect(q.journalLookup(PROJECT, { targetId: scope, limit: 50 })).toEqual([]);
  });

  it('proposals on both copies: each runs on its own page only', async () => {
    const [a, b] = await Promise.all([
      call('set_facts', { page: alpha, facts: { Scope: 'Alpha, proposed' } }, proposer),
      call('set_facts', { page: beta, facts: { Scope: 'Beta, proposed' } }, proposer),
    ]);
    expect(a.body.status, a.text).toBe('proposal_captured');
    expect(b.body.status, b.text).toBe('proposal_captured');
    const owner = w.stack.runtime.policy.commands;
    // Approved in the opposite order.
    await owner.approve('owner', String(b.body.proposalId));
    await owner.approve('owner', String(a.body.proposalId));
    expect((await settle(String(a.body.proposalId))).state).toBe('executed');
    expect((await settle(String(b.body.proposalId))).state).toBe('executed');
    expect(value(alpha, 'Scope')).toBe('Alpha, proposed');
    expect(value(beta, 'Scope')).toBe('Beta, proposed');
    expect(value(alpha, 'Continuity Type')).toBe('AU');
    expect(value(beta, 'Continuity Type')).toBe('');
  });

  it('a factsVersion belongs to one page: the twin’s version is a conflict, nothing written', async () => {
    // Make the two sidebars equal in content, so only the page tells their versions apart.
    // (Changing Alpha's Continuity Type from AU would be protected canon; setting Beta's where empty is not.)
    const sa = await call('set_facts', { page: alpha, facts: { Scope: 'Same' } });
    expect(sa.body, sa.text).toMatchObject({ status: 'written', verified: true });
    const sb = await call('set_facts', { page: beta, facts: { Scope: 'Same', 'Continuity Type': 'AU' } });
    expect(sb.body, sb.text).toMatchObject({ status: 'written', verified: true });
    const ra = await call('get_resource', { resource: alpha });
    const rb = await call('get_resource', { resource: beta });
    const va = ra.body.resource.factsVersion as string;
    const vb = rb.body.resource.factsVersion as string;
    expect(va).toMatch(/^fv2_/);
    expect(vb).toMatch(/^fv2_/);
    expect(va).not.toBe(vb);
    const before = w.sidebars.rows(beta);
    const r = await call('set_facts', { page: beta, baseFactsVersion: va, facts: { Scope: 'Wrong page' } });
    expect(r.body.error?.code, r.text).toBe('VERSION_CONFLICT');
    expect(w.sidebars.rows(beta)).toEqual(before);
    const ok = await call('set_facts', { page: beta, baseFactsVersion: vb, facts: { Scope: 'Right page' } });
    expect(ok.body, ok.text).toMatchObject({ status: 'written', verified: true });
    expect(facts(w, alpha)).toContain('Scope=Same');
  });
});
