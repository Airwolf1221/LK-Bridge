/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * `factsVersion` and `baseFactsVersion` (v2 C2b): stable across reads and across endpoints that give the rows in
 * different orders; changed by any row or link edit; a stale base is a VERSION_CONFLICT with what changed and nothing
 * written, caught at planning and again inside the lock; no base behaves as before.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RHEASHIRA } from '../facts/world.js';
import { P, resourcesWorld, type ResourcesWorld } from './world.js';

let w: ResourcesWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const version = async (page: string) =>
  (await call('get_resource', { resource: page })).body.resource.factsVersion as string;
const writes = () => w.sidebars.requests.filter((r) => r.method !== 'GET');

beforeAll(async () => {
  w = await resourcesWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('factsVersion', () => {
  it('is stable across reads, and the same from getResource (stored order) and listProperties (set_facts)', async () => {
    const a = await version(RHEASHIRA.page);
    const b = await version(RHEASHIRA.page);
    expect(a).toMatch(/^fv2_[0-9a-f]{24}$/);
    expect(b).toBe(a);
    // set_facts plans on listProperties; Rheashira's rows are stored out of rank order.
    const dry = await call('set_facts', { page: RHEASHIRA.page, facts: { Mood: 'Calm' }, dryRun: true });
    expect(dry.body.factsVersion).toBe(a);
    const many = await call('get_resources', { resources: [RHEASHIRA.page, P.miyabi] });
    expect(many.body.resources[0].factsVersion).toBe(a);
  });

  it('changes on any row or link edit; set_facts gives the version before and after', async () => {
    const v0 = await version(P.mehrana);
    const r = await call('set_facts', { page: P.mehrana, facts: { Notes: 'Tidy' }, baseFactsVersion: v0 });
    expect(r.body, r.text).toMatchObject({ status: 'written', factsVersion: { before: v0 } });
    const v1 = await version(P.mehrana);
    expect(v1).not.toBe(v0);
    expect(r.body.factsVersion.after).toBe(v1);
    // A link edit made in the app changes it too.
    w.sidebars.outside(P.mehrana, (sb) => {
      sb.props
        .find((p) => p.title === 'Dependencies')!
        .items!.push({ id: 'appitem1', rank: 'z', resourceId: 'kaede001' });
    });
    expect(await version(P.mehrana)).not.toBe(v1);
  });

  it('a stale baseFactsVersion is a VERSION_CONFLICT at planning, with what changed; nothing is written', async () => {
    const v = await version(P.miyabi);
    w.sidebars.outside(P.miyabi, (sb) => {
      const row = sb.props.find((p) => p.title === 'PROPERTIES')!.rows!.find((x) => x.key === 'Scope')!;
      row.content = [{ text: 'Edited in the app' }];
    });
    const before = writes().length;
    const r = await call('set_facts', { page: P.miyabi, facts: { Notes: 'Mine' }, baseFactsVersion: v });
    expect(r.body.error, r.text).toMatchObject({
      code: 'VERSION_CONFLICT',
      reason: 'changed_since_base',
      baseFactsVersion: v,
    });
    expect(JSON.stringify(r.body.error.differences)).toContain('Scope');
    expect(writes().length).toBe(before);
    // A version the bridge never handed out: still a conflict, without the list.
    const u = await call('set_facts', {
      page: P.miyabi,
      facts: { Notes: 'Mine' },
      baseFactsVersion: 'fv2_000000000000000000000000',
    });
    expect(u.body.error).toMatchObject({ code: 'VERSION_CONFLICT', reason: 'base_unknown' });
  });

  it('a change between planning and the lock is caught inside the lock (any part of the sidebar); nothing written', async () => {
    const v = await version(P.miyabi);
    // Right after set_facts' planning read, someone adds a link in the app (a collection the call does not touch).
    w.sidebars.after(/^GET \/resources\/miyabi01\/properties\/?$/, 0, () =>
      w.sidebars.outside(P.miyabi, (sb) => {
        sb.props
          .find((p) => p.title === 'Related Sources')!
          .items!.push({ id: 'appitem2', rank: 'z', resourceId: 'kumi0001' });
      }),
    );
    const before = writes().length;
    const r = await call('set_facts', { page: P.miyabi, facts: { Notes: 'Locked' }, baseFactsVersion: v });
    expect(r.body.error, r.text).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(JSON.stringify(r.body.error.differences)).toContain('Related Sources');
    expect(writes().length).toBe(before);
  });

  it('without baseFactsVersion it behaves as before: a change elsewhere in the sidebar does not stop it', async () => {
    w.sidebars.outside(P.miyabi, (sb) => {
      sb.props.find((p) => p.title === 'Related Sources')!.items!.pop();
    });
    const r = await call('set_facts', { page: P.miyabi, facts: { Notes: 'No base' } });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
  });

  it('create_resource returns the new page’s factsVersion, usable as a base at once', async () => {
    const r = await call('create_resource', {
      name: 'Version Hall',
      template: 'tplgen01',
    });
    expect(r.body, r.text).toMatchObject({ status: 'written' });
    const fv = r.body.factsVersions['[BWRK] Version Hall'];
    expect(fv).toBe(await version(r.body.pages[0].id));
    const s = await call('set_facts', {
      page: r.body.pages[0].id,
      facts: { Scope: 'Based' },
      baseFactsVersion: fv,
    });
    expect(s.body, s.text).toMatchObject({ status: 'written' });
  });
});
