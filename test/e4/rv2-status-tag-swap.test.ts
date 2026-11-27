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

  // v3 F12 follow-up (the owner, 27 November 2026; ADR 0081 amendment 1, decision 2): a look-alike of an allowed Status
  // is an invalid value, refused at every scope (Unicode's confusables, UTS #39), the allowed values listed.
  for (const [scope, run] of [
    ['propose', () => propose],
    ['write', () => call],
  ] as const) {
    it(`at scope ${scope}, the genuine Status Authoritative replaced by a look-alike is refused as an invalid value, not written`, async () => {
      const ask = run();
      const r = await ask('get_resource', { page: L.guild });
      const fv = r.body.factsVersion ?? r.body.page?.factsVersion;
      const set = await ask('set_facts', {
        page: L.guild,
        facts: { Status: 'Authorit\u0430tive' }, // Cyrillic a
        ...(fv ? { baseFactsVersion: fv } : {}),
      });
      expect(set.body.status, set.text).not.toBe('proposal_captured');
      expect(set.body.error?.code, set.text).toBe('POLICY_DENIED');
      expect(set.body.error?.message, set.text).toMatch(
        /only looks like “Authoritative”.*not an allowed value/,
      );
      expect(set.body.error?.message, set.text).toMatch(/“Authoritative”, “Working”, “Archived”/);
      // SAFE: Status stays exactly Authoritative.
      expect(status(L.guild), set.text).toBe('Authoritative');
    });
  }
});
