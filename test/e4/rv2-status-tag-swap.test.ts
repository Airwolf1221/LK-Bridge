/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * RV2-3: the status tags (ADR 0036 decision 7) are compared folded (case, invisible characters, look-alikes), so that a
 * disguised CANON cannot be ADDED. The same fold lets the genuine tag be REPLACED: a look-alike is added beside it (no
 * change: the page "already has" CANON), then the real CANON is removed (no change: the look-alike still "is" CANON).
 * The Authoritative page ends with no CANON tag at all, only a Cyrillic look-alike, at scope write, with no lifecycle tool.
 *
 * F12 (ADR 0081): a protected fact's change is direct at scope `write` (on the owner's Review page, with Revert) and a
 * canonical proposal at scope `propose`. The point kept: the look-alike Status is still seen as a change of the protected
 * value (never folded into "no change"), so at `propose` it waits for the owner's canonical approval.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { L, lifecycleWorld, type LifecycleWorld } from '../lifecycle/world.js';

let w: LifecycleWorld;
let client: Client;
/** F12 (ADR 0081): a propose-scope connection, where a protected change is still a canonical proposal. */
let proposer: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const propose = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(proposer, tool, { project: 'test', ...args });
const status = (id: string) => w.sidebars.rows(id).find((x) => x.key === 'Status')?.text;

beforeAll(async () => {
  w = await lifecycleWorld();
  client = await w.stack.connect();
  proposer = await w.stack.connect(w.stack.newToken('rv2-swap-propose', 'propose').token);
});
afterAll(async () => w.close());

const LOOKALIKE = 'СANON'; // Cyrillic Es, then ANON: reads as CANON

describe('RV2-3: the genuine status tag swapped for a look-alike', () => {
  it('update_resource cannot take CANON off an Authoritative page by first adding a look-alike', async () => {
    expect(w.repo.live(L.guild)!.tags).toEqual(['CANON']);
    const add = await call('update_resource', { page: L.guild, tags: { add: [LOOKALIKE] } });
    const remove = await call('update_resource', { page: L.guild, tags: { remove: ['CANON'] } });
    const tags = w.repo.live(L.guild)!.tags;
    // SAFE: the page still carries the genuine CANON tag (the removal is refused, naming the lifecycle tools).
    expect(tags, `add: ${add.text}\nremove: ${remove.text}`).toContain('CANON');
  });

  it('the same through lk_api_write updateResource', async () => {
    expect(w.repo.live(L.tides)!.tags).toEqual(['CANON']);
    const a = await call('lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: L.tides }, body: { tags: ['CANON', LOOKALIKE] } },
    });
    const b = await call('lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: L.tides }, body: { tags: [LOOKALIKE] } },
    });
    const tags = w.repo.live(L.tides)!.tags;
    expect(tags, `1: ${a.text}\n2: ${b.text}`).toContain('CANON');
  });

  it('at scope propose, the genuine Status Authoritative replaced by a look-alike is a canonical proposal, not written', async () => {
    const r = await propose('get_resource', { page: L.guild });
    const fv = r.body.factsVersion ?? r.body.page?.factsVersion;
    const set = await propose('set_facts', {
      page: L.guild,
      facts: { Status: 'Authorit\u0430tive' }, // Cyrillic a
      ...(fv ? { baseFactsVersion: fv } : {}),
    });
    // SAFE: Status stays exactly Authoritative until the owner accepts the change as canon.
    expect(set.body, set.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(status(L.guild), set.text).toBe('Authoritative');
  });

  it('at scope write, the same look-alike Status is a direct write of a protected change, on the owner’s Review page', async () => {
    const r = await call('get_resource', { page: L.guild });
    const fv = r.body.factsVersion ?? r.body.page?.factsVersion;
    const set = await call('set_facts', {
      page: L.guild,
      facts: { Status: 'Authorit\u0430tive' }, // Cyrillic a
      ...(fv ? { baseFactsVersion: fv } : {}),
    });
    expect(set.body, set.text).toMatchObject({
      status: 'written',
      facts: { changed: [{ key: 'Status', before: 'Authoritative', after: 'Authorit\u0430tive' }] },
    });
    expect(set.body.requiresCanonicalApproval).toBeUndefined();
    const jobId = String(set.body.jobId);
    expect(
      w.stack.runtime.review.list(PROJECT, { state: 'all', limit: 500 }).some((i) => i.jobId === jobId),
    ).toBe(true);
  });
});
