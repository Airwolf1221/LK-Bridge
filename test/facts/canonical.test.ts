/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * The protected canonical facts (v2 C2a, ADR 0032; PLAN-v2 10.3 as refined): the shared function, then every write path
 * through the REAL server and the official MCP client (set_facts, lk_api_write, lk_api_batch, the per-operation tools)
 * at scope `propose`; the approval (ordinary Approve refused, "Approve and accept as canon"), the re-check at
 * execution that refuses a forged expansion, and the backstop inside the lock. v3 F12 (ADR 0081): at scope `write` a
 * protected change is direct (a job on the Review page), so the canonical proposals here are made at scope `propose`;
 * the last group shows the direct path.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assessFactChange, DEFAULT_CANONICAL_RULES } from '../../src/facts/index.js';
import { ProjectStore } from '../../src/projects/index.js';
import { PROJECT } from '../tools/helpers.js';
import { factsWorld, kvText, P, type FactsWorld } from './world.js';

let w: FactsWorld;
let writer: Client;
let proposer: Client;
let reader: Client;
let mark = 0;
const since = () => w.sidebars.requests.slice(mark);
const writesSince = () => since().filter((x) => x.method !== 'GET');
const rowId = (page: string, key: string) => w.sidebars.rows(page).find((r) => r.key === key)!.id;
const kvOf: Record<string, string> = {
  [P.miyabi]: 'kvmiya01',
  [P.mehrana]: 'kvmehr01',
  [P.inae]: 'kvinae01',
};
const rowPath = (page: string, key: string) => ({
  resourceId: page,
  propertyId: kvOf[page]!,
  rowId: rowId(page, key),
});
const proposals = () => w.stack.runtime.policy.proposals;
const settle = async (id: string, states: string[]) => {
  for (let i = 0; i < 200 && !states.includes(proposals().get(id)!.state); i++)
    await new Promise((r) => setTimeout(r, 20));
  return proposals().get(id)!;
};

beforeAll(async () => {
  w = await factsWorld({ env: { MCP_EXPOSE_PER_OP_TOOLS: 'true' } });
  writer = await w.stack.connect();
  proposer = await w.stack.connect(w.stack.newToken('canon-proposer', 'propose').token);
  reader = await w.stack.connect(w.stack.newToken('canon-reader', 'read').token);
});
afterAll(async () => w.close());
beforeEach(() => {
  mark = w.sidebars.requests.length;
});

const kv = (key: string, text: string) => ({ key, content: text ? [{ text }] : [] });

describe('assessFactChange: the shared function', () => {
  const rules = DEFAULT_CANONICAL_RULES;
  it('Status to Authoritative and from Authoritative are both protected; other statuses are not', () => {
    expect(assessFactChange(rules, [kv('Status', 'Working')], [kv('Status', 'Authoritative')])).toMatchObject(
      [{ ruleId: 'status-authoritative', direction: 'to', value: 'Authoritative' }],
    );
    expect(assessFactChange(rules, [kv('status', 'authoritative')], [kv('Status', 'Working')])).toMatchObject(
      [{ direction: 'from' }],
    );
    expect(assessFactChange(rules, [kv('Status', 'Authoritative')], [])).toMatchObject([
      { direction: 'from' },
    ]);
    expect(assessFactChange(rules, [kv('Status', 'Working')], [kv('Status', 'Archived')])).toEqual([]);
    expect(assessFactChange(rules, [], [kv('Status', 'Working')])).toEqual([]);
    // A new page that is canonical from the start (C2b): protected.
    expect(assessFactChange(rules, [], [kv('Status', 'Authoritative')])).toHaveLength(1);
  });
  it('Continuity Type and Continuity: changing a non-empty value is protected; setting an empty one is not', () => {
    expect(
      assessFactChange(rules, [kv('Continuity Type', 'CANON')], [kv('Continuity Type', 'AU')]),
    ).toMatchObject([{ ruleId: 'continuity-type', direction: 'change', before: ['CANON'], after: ['AU'] }]);
    expect(assessFactChange(rules, [kv('Continuity', 'AU-1')], [kv('Continuity', 'AU-2')])).toHaveLength(1);
    expect(assessFactChange(rules, [kv('Continuity', 'Main')], [])).toHaveLength(1);
    expect(assessFactChange(rules, [], [kv('Continuity', 'AU-2'), kv('Continuity Type', 'AU')])).toEqual([]);
    expect(assessFactChange(rules, [kv('Continuity', '')], [kv('Continuity', 'Main')])).toEqual([]);
    // A second value next to an existing one changes it too.
    expect(
      assessFactChange(
        rules,
        [kv('Continuity', 'Main')],
        [kv('Continuity', 'Main'), kv('Continuity', 'AU-1')],
      ),
    ).toHaveLength(1);
    // Marks are not a change of value.
    expect(
      assessFactChange(
        rules,
        [kv('Continuity', 'Main')],
        [{ key: 'Continuity', content: [{ text: 'Main', bold: true }] }],
      ),
    ).toEqual([]);
  });
});

describe('through set_facts', () => {
  it('Status to Authoritative becomes a canonical proposal at scope propose, with the reason; nothing is written', async () => {
    const r = await w.stack.call(proposer, 'set_facts', {
      page: P.miyabi,
      facts: { Status: 'Authoritative' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(r.body.reason).toMatch(/Status would be set to Authoritative/);
    expect(writesSince()).toHaveLength(0);
    const p = proposals().get(String(r.body.proposalId))!;
    expect(p).toMatchObject({ requiresCanonicalApproval: true, state: 'pending' });
    expect(p.pages).toEqual(['Asagiri Miyabi: sidebar, 1 fact changed']);
  });
  it('a read connection is refused as before', async () => {
    const no = await w.stack.call(reader, 'set_facts', {
      page: P.miyabi,
      facts: { Status: 'Authoritative' },
    });
    expect(no.isError).toBe(true);
    expect(no.text).toMatch(/read-only/);
  });
  it('Status from Authoritative, and a Continuity change, are canonical too', async () => {
    const from = await w.stack.call(proposer, 'set_facts', { page: P.inae, facts: { Status: 'Outline' } });
    expect(from.body).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(from.body.reason).toMatch(/Status would change from Authoritative/);
    const cont = await w.stack.call(proposer, 'set_facts', { page: P.miyabi, facts: { Continuity: 'AU-1' } });
    expect(cont.body).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(cont.body.reason).toMatch(/Continuity would change from “Main” to “AU-1”/);
    const gone = await w.stack.call(proposer, 'set_facts', {
      page: P.miyabi,
      facts: { 'Continuity Type': null },
    });
    expect(gone.body).toMatchObject({ requiresCanonicalApproval: true });
    expect(writesSince()).toHaveLength(0);
  });
  it('setting Continuity where it is empty is allowed: written directly at scope write', async () => {
    const r = await w.stack.call(writer, 'set_facts', {
      page: P.mehrana,
      facts: { Continuity: 'AU-2', 'Continuity Type': 'AU' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(kvText(w.sidebars.rows(P.mehrana))).toEqual(
      expect.arrayContaining(['Continuity=AU-2', 'Continuity Type=AU']),
    );
  });
  it('a dry run says the change is protected', async () => {
    const r = await w.stack.call(writer, 'set_facts', {
      page: P.miyabi,
      facts: { Status: 'Authoritative' },
      dryRun: true,
    });
    expect(r.body).toMatchObject({ status: 'dry_run', requiresCanonicalApproval: true });
    expect(r.body.protectedChanges[0]).toMatch(/Status would be set to Authoritative/);
  });
});

describe('through the low-level tools', () => {
  it('lk_api_write: a row write to Authoritative becomes a canonical proposal at scope propose', async () => {
    const r = await w.stack.call(proposer, 'lk_api_write', {
      operationId: 'updatePropertyRow',
      params: { path: rowPath(P.miyabi, 'Status'), body: { content: [{ text: 'Authoritative' }] } },
    });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(r.body.reason).toMatch(/Status would be set to Authoritative/);
    expect(writesSince()).toHaveLength(0);
    expect(kvText(w.sidebars.rows(P.miyabi))).toContain('Status=Outline');
  });
  it('lk_api_batch: a protected change made in two harmless-looking steps is judged as the sequence it is', async () => {
    const r = await w.stack.call(proposer, 'lk_api_batch', {
      calls: [
        {
          operationId: 'updatePropertyRow',
          params: { path: rowPath(P.miyabi, 'Scope'), body: { content: [{ text: 'Authoritative' }] } },
        },
        { operationId: 'deletePropertyRow', params: { path: rowPath(P.miyabi, 'Status') } },
        {
          operationId: 'updatePropertyRow',
          params: { path: rowPath(P.miyabi, 'Scope'), body: { key: 'Status' } },
        },
      ],
    });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(writesSince()).toHaveLength(0);
  });
  it('the per-operation tools: deleting the Authoritative row, and a new property that carries it', async () => {
    const del = await w.stack.call(proposer, 'lk_op_deletePropertyRow', { path: rowPath(P.inae, 'Status') });
    expect(del.body, del.text).toMatchObject({
      status: 'proposal_captured',
      requiresCanonicalApproval: true,
    });
    const create = await w.stack.call(proposer, 'lk_op_createProperty', {
      path: { resourceId: P.mehrana },
      body: { kind: 'keyValue', title: 'EXTRA', rows: [{ key: 'status', text: 'Authoritative' }] },
    });
    expect(create.body, create.text).toMatchObject({
      status: 'proposal_captured',
      requiresCanonicalApproval: true,
    });
    const delProp = await w.stack.call(proposer, 'lk_op_deleteProperty', {
      path: { resourceId: P.inae, propertyId: 'kvinae01' },
    });
    expect(delProp.body, delProp.text).toMatchObject({
      status: 'proposal_captured',
      requiresCanonicalApproval: true,
    });
    const continuity = await w.stack.call(proposer, 'lk_op_updateProperty', {
      path: { resourceId: P.miyabi, propertyId: 'kvmiya01' },
      body: { rows: [{ key: 'Continuity', text: 'AU-9' }] },
    });
    expect(continuity.body).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(writesSince()).toHaveLength(0);
  });
  it('a write to a page that does not exist is not flagged as canon: LegendKeeper refuses it as before', async () => {
    const r = await w.stack.call(writer, 'lk_api_write', {
      operationId: 'createPropertyRow',
      params: {
        path: { resourceId: 'nopage01', propertyId: 'nokv0001' },
        body: { key: 'Status', text: 'Authoritative' },
      },
    });
    expect(r.body.requiresCanonicalApproval).toBeUndefined();
    expect(r.body.error, r.text).toBeDefined();
  });
  it('a row write that touches nothing protected behaves as before (written at scope write)', async () => {
    const r = await w.stack.call(writer, 'lk_api_write', {
      operationId: 'updatePropertyRow',
      params: { path: rowPath(P.miyabi, 'Notes'), body: { content: [{ text: 'Low-level notes' }] } },
    });
    expect(r.body, r.text).toMatchObject({ status: 'succeeded' });
    expect(kvText(w.sidebars.rows(P.miyabi))).toContain('Notes=Low-level notes');
  });
  it('the rules are configuration: with a project’s own rules, only they apply', async () => {
    const store = new ProjectStore(w.stack.db, () => Date.now());
    store.setSetting(PROJECT, 'canonicalRules', [{ id: 'scope', key: 'Scope', kind: 'change' }]);
    try {
      const scope = await w.stack.call(proposer, 'set_facts', {
        page: P.ashgate,
        facts: { Scope: 'A city' },
      });
      expect(scope.body).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
      // Status is no rule here: at scope propose an ordinary proposal.
      const status = await w.stack.call(proposer, 'set_facts', {
        page: P.ashgate,
        facts: { Status: 'Authoritative' },
      });
      expect(status.body, status.text).toMatchObject({ status: 'proposal_captured' });
      expect(status.body.requiresCanonicalApproval).toBeFalsy();
      for (const x of [scope, status])
        w.stack.runtime.policy.commands.reject('owner', String(x.body.proposalId), 'test');
    } finally {
      store.setSetting(PROJECT, 'canonicalRules', null);
    }
  });
});

describe('approval', () => {
  it('ordinary Approve is refused; "Approve and accept as canon" runs it and records canonicalApprovedBy', async () => {
    const r = await w.stack.call(proposer, 'set_facts', {
      page: P.miyabi,
      facts: { Status: 'Authoritative' },
    });
    const id = r.body.proposalId as string;
    await expect(w.stack.runtime.policy.commands.approve('owner', id)).rejects.toMatchObject({
      code: 'CANONICAL_APPROVAL_REQUIRED',
    });
    expect(proposals().get(id)!.state).toBe('pending');
    await w.stack.runtime.policy.commands.approveAsCanon('owner', id);
    const p = await settle(id, ['executed', 'failed', 'conflicted']);
    expect(p, JSON.stringify(p)).toMatchObject({ state: 'executed', canonicalApprovedBy: 'owner' });
    expect(kvText(w.sidebars.rows(P.miyabi))).toContain('Status=Authoritative');
    const audit = w.stack.policy.store
      .listAudit({ limit: 20 })
      .find((a) => a.action === 'proposal.approve_as_canon');
    expect(audit).toMatchObject({ target: id });
    const detail = proposals().detail(id)!;
    expect(detail.execution).toMatchObject({ verified: true });
    // Not a canonical proposal: "accept as canon" is refused, ordinary Approve works.
    const plain = await w.stack.call(proposer, 'set_facts', {
      page: P.miyabi,
      facts: { Notes: 'Proposed notes' },
    });
    await expect(
      w.stack.runtime.policy.commands.approveAsCanon('owner', String(plain.body.proposalId)),
    ).rejects.toMatchObject({
      code: 'NOT_CANONICAL',
    });
    await w.stack.runtime.policy.commands.approve('owner', String(plain.body.proposalId));
    expect((await settle(String(plain.body.proposalId), ['executed', 'failed'])).state).toBe('executed');
  });
  it('bulk approve skips canonical proposals; Reject works as normal', async () => {
    const r = await w.stack.call(proposer, 'set_facts', { page: P.inae, facts: { Status: 'Outline' } });
    const id = r.body.proposalId as string;
    const [res] = await w.stack.runtime.policy.commands.bulkApprove('owner', [id]);
    expect(res).toMatchObject({ ok: false, error: { code: 'CANONICAL_APPROVAL_REQUIRED' } });
    expect(w.stack.runtime.policy.commands.reject('owner', id, 'Inae stays canon').state).toBe('rejected');
  });
  it('at execution the guard checks again: a forged expansion without canonical approval is refused, nothing written', async () => {
    const r = await w.stack.call(proposer, 'lk_api_write', {
      operationId: 'updatePropertyRow',
      params: {
        path: rowPath(P.inae, 'Scope'),
        body: { content: [{ text: 'Moon elf archer of the Vale' }] },
      },
    });
    const id = r.body.proposalId as string;
    expect(proposals().get(id)!.requiresCanonicalApproval).toBe(false);
    // Tampered in the database: the stored expansion now changes the Authoritative Status.
    w.stack.db
      .prepare('UPDATE proposal_ops SET params = ? WHERE proposal_id = ?')
      .run(JSON.stringify({ path: rowPath(P.inae, 'Status'), body: { content: [{ text: 'Outline' }] } }), id);
    mark = w.sidebars.requests.length;
    await w.stack.runtime.policy.commands.approve('owner', id);
    const p = await settle(id, ['failed', 'executed', 'conflicted']);
    expect(p.state).toBe('failed');
    expect(JSON.stringify(p.error)).toMatch(/refused at execution.*not approved as canon/);
    expect(writesSince()).toHaveLength(0);
    expect(kvText(w.sidebars.rows(P.inae))).toContain('Status=Authoritative');
  });
  it('at execution the guard checks again on what is there now (the page changed after the proposal)', async () => {
    // v3 F12 (ADR 0081): at scope write a protected change is direct, so the backstop matters for approved work: an
    // ordinary proposal (deleting the Scope row), approved, whose page changes after the approval's re-read.
    const r = await w.stack.call(proposer, 'lk_api_batch', {
      calls: [{ operationId: 'deletePropertyRow', params: { path: rowPath(P.inae, 'Scope') } }],
    });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured' });
    expect(r.body.requiresCanonicalApproval).toBeFalsy();
    const id = String(r.body.proposalId);
    // Meanwhile, in the app: the Scope row becomes the Status row, Authoritative.
    w.sidebars.after(new RegExp(`^GET /resources/${P.inae}/properties`), 0, () =>
      w.sidebars.outside(P.inae, (s) => {
        const rows = s.props[0]!.rows!;
        const status = rows.findIndex((x) => x.key === 'Status');
        const scope = rows.find((x) => x.key === 'Scope')!;
        rows.splice(status, 1);
        scope.key = 'Status';
        scope.content = [{ text: 'Authoritative' }];
      }),
    );
    await w.stack.runtime.policy.commands.approve('owner', id);
    const p = await settle(id, ['executed', 'failed', 'conflicted']);
    // The guard judged the page as it is now: the row deleted would be the Authoritative Status. Refused, no job.
    expect(p.state, JSON.stringify(p)).toBe('failed');
    expect(p.jobId).toBeNull();
    expect(p.error).toMatchObject({ code: 'POLICY_DENIED' });
    expect(JSON.stringify(p.error)).toMatch(/Status would change from Authoritative.*not approved as canon/);
    expect(writesSince().filter((x) => x.method === 'DELETE')).toHaveLength(0);
  });
});

describe('at scope write (v3 F12, ADR 0081)', () => {
  it('a protected change is direct: written as a job on the Review page, no proposal', async () => {
    const r = await w.stack.call(writer, 'set_facts', { page: P.inae, facts: { Status: 'Outline' } });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(r.body.jobId).toEqual(expect.any(String));
    expect(r.body).not.toHaveProperty('requiresCanonicalApproval');
    expect(r.body).not.toHaveProperty('proposalId');
    expect(kvText(w.sidebars.rows(P.inae))).toContain('Status=Outline');
  });
});
