/**
 * v3 F3.4 (ADR 0055 decision C): the safety rails through the real server, MCP transport, policy gate and engine, at
 * scope `write`. A delete and a bulk change become proposals saying which rail sent them (and nothing is sent); 10
 * pages run directly and 11 are proposed; renames run directly until the owner switches that rail on (applied at the
 * next request); the owner's change of a rail is audited; and switching every rail off never removes a proposal the
 * canon guard asks for.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PROJECTS } from '../../src/projects/index.js';
import { PROJECT } from '../tools/helpers.js';
import { factsWorld, P, type FactsWorld } from '../facts/world.js';

let w: FactsWorld;
let agent: Client;
let profileId: string;
let patId: string;
const bulkPage = (i: number) => `bk${i.toString(36).padStart(6, '0')}`;
const writes = () => w.stack.mock.calls.filter((c) => c.method !== 'GET').length;

beforeAll(async () => {
  w = await factsWorld();
  const t = w.stack.newToken('rails-agent', 'write');
  profileId = t.profileId;
  patId = t.patId;
  agent = await w.stack.connect(t.token);
  w.stack.runtime.policy.commands.setShowLowLevelTools('owner', profileId, true);
});
afterAll(async () => w.close());

const proposal = (id: string) => w.stack.runtime.policy.proposals.get(id)!;

describe('the default rails at scope write', () => {
  it('a delete becomes ONE proposal saying why, and nothing is sent', async () => {
    const before = writes();
    const r = await w.stack.call(agent, 'delete_resource', { page: P.mehrana, confirm: true });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.proposedBecause).toBe('proposed because: delete (1 page “Mehrana al-Khalid”)');
    expect(r.body.hint).toMatch(/safety rail on your profile/);
    expect(writes()).toBe(before);
    const p = proposal(String(r.body.proposalId));
    expect(p.state).toBe('pending');
    expect(p.proposedBecause).toBe('proposed because: delete (1 page “Mehrana al-Khalid”)');
    expect(p.requiresCanonicalApproval).toBe(false);
    // The agent reads the reason back with its own proposals.
    const mine = await w.stack.call(agent, 'bridge_proposal_status', { proposalId: p.id });
    expect(mine.body.proposedBecause ?? mine.body.proposal?.proposedBecause).toBe(p.proposedBecause);
    w.stack.runtime.policy.commands.reject('owner', p.id, 'test');
  });

  it('a bulk change: 10 pages run directly, 11 become a proposal (N = 10)', async () => {
    const batch = (n: number) =>
      w.stack.call(agent, 'lk_api_batch', {
        calls: Array.from({ length: n }, (_, i) => ({
          operationId: 'updateResource',
          params: { path: { resourceId: bulkPage(i) }, body: { aliases: [`Rail test ${n}`] } },
        })),
      });
    const ten = await batch(10);
    expect(ten.body.status, ten.text).not.toBe('proposal_captured');
    expect(typeof ten.body.jobId).toBe('string');
    const done = await w.stack.runtime.engine.wait(PROJECT, String(ten.body.jobId), 20_000);
    expect(done.status).toBe('succeeded');
    const before = writes();
    const eleven = await batch(11);
    expect(eleven.body.status, eleven.text).toBe('proposal_captured');
    expect(eleven.body.proposedBecause).toBe('proposed because: bulk change (11 pages > 10)');
    expect(writes()).toBe(before);
    w.stack.runtime.policy.commands.reject('owner', String(eleven.body.proposalId), 'test');
  });

  it('a rename runs directly by default; once the owner switches the rail on, the next one is proposed', async () => {
    const rename = (name: string) =>
      w.stack.call(agent, 'lk_api_write', {
        operationId: 'updateResource',
        params: { path: { resourceId: 'loose001' }, body: { name } },
      });
    const direct = await rename('Loose notes, renamed');
    expect(direct.body.status, direct.text).toBe('succeeded');
    const cmd = w.stack.runtime.policy.commands;
    cmd.setRails('owner', profileId, { renamesMoves: true });
    // Audited with the rails before and after.
    const audit = w.stack.runtime.policy.store.listAudit({ action: 'profile.set_rails', limit: 1 })[0]!;
    expect(audit.target).toBe(profileId);
    expect(JSON.stringify(audit.before)).toContain('"renamesMoves":false');
    expect(JSON.stringify(audit.after)).toContain('"renamesMoves":true');
    const proposed = await rename('Loose notes, renamed again');
    expect(proposed.body.status, proposed.text).toBe('proposal_captured');
    expect(proposed.body.proposedBecause).toBe(
      'proposed because: rename of a page (“Loose notes, renamed” → “Loose notes, renamed again”)',
    );
    cmd.reject('owner', String(proposed.body.proposalId), 'test');
    cmd.setRails('owner', profileId, { renamesMoves: false });
  });
});

describe('the rails can only add proposals', () => {
  it('every rail off: a protected canon change is still a canonical proposal, with no rail named', async () => {
    const cmd = w.stack.runtime.policy.commands;
    cmd.setRails('owner', profileId, { deletes: false, bulk: false, renamesMoves: false, assets: false });
    const r = await w.stack.call(agent, 'set_facts', {
      page: P.mehrana,
      facts: { Status: 'Authoritative' },
    });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.requiresCanonicalApproval).toBe(true);
    expect(r.body.proposedBecause).toBeUndefined();
    const p = proposal(String(r.body.proposalId));
    expect(p.requiresCanonicalApproval).toBe(true);
    expect(p.proposedBecause).toBeNull();
    cmd.reject('owner', p.id, 'test');
  });

  it('every rail off: a delete runs directly (the owner chose so)', async () => {
    const r = await w.stack.call(agent, 'delete_resource', { page: 'loose001', confirm: true });
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    const pending = w.stack.runtime.policy.commands
      .listProposals('owner', { project: ALL_PROJECTS, principalId: patId, state: 'pending' })
      .filter((x) => x.projectId === PROJECT);
    expect(pending.map((x) => x.summary)).toEqual([]);
    w.stack.runtime.policy.commands.setRails('owner', profileId, {
      deletes: true,
      bulk: true,
      assets: true,
    });
  });

  it('a proposal at scope propose never names a rail (rails are for scope write only)', async () => {
    const t = w.stack.newToken('rails-proposer', 'propose');
    const proposer = await w.stack.connect(t.token);
    const r = await w.stack.call(proposer, 'delete_resource', { page: P.ashgate, confirm: true });
    expect(r.body.status, r.text).toBe('proposal_captured');
    expect(r.body.proposedBecause).toBeUndefined();
    expect(proposal(String(r.body.proposalId)).proposedBecause).toBeNull();
    w.stack.runtime.policy.commands.reject('owner', String(r.body.proposalId), 'test');
  });
});
