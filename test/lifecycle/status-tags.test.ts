/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * C2d, Part 3 (ADR 0036 decision 7, accepted by the owner on 11 November 2026): the status tags `CANON`, `Working` and
 * `Archived` (compared without case, with look-alikes caught as CR-12 and CR-14 catch them) are added or removed only by
 * the lifecycle tools and by creates according to their `status`. `update_resource`, `updateResource` on every route
 * (`lk_api_write`, `lk_api_batch`, `lk_op_*`) and create bodies that add one are refused, naming the right tool. Every
 * other tag stays free. It is a per-project rule (`status-tags`), on by default.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CANONICAL_RULES } from '../../src/facts/rules.js';
import { PROJECT } from '../tools/helpers.js';
import { L, lifecycleWorld, LIFECYCLE, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let writer: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(writer, tool, { project: 'test', ...args });
const tags = (id: string) => [...w.repo.res.get(id)!.tags];
const refusedNaming = (r: { isError: boolean; text: string }, tool: RegExp) => {
  expect(r.isError, r.text).toBe(true);
  expect(r.text).toMatch(/status tag/);
  expect(r.text).toMatch(tool);
};

beforeAll(async () => {
  w = await lifecycleWorld({ env: { MCP_EXPOSE_PER_OP_TOOLS: 'true' } });
  writer = await w.stack.connect();
});
afterAll(async () => w.close());

describe('status tags are the lifecycle tools’ (decision 7)', () => {
  it('update_resource: removing CANON from an Authoritative page is refused, naming move_to_working or archive_page', async () => {
    const before = tags(L.harbour);
    expect(before).toContain('CANON');
    const r = await call('update_resource', { page: L.harbour, tags: { remove: ['CANON'] } });
    refusedNaming(r, /move_to_working or archive_page/);
    expect(tags(L.harbour)).toEqual(before);
  });

  it('update_resource: adding Archived or Working is refused, naming archive_page or move_to_working', async () => {
    refusedNaming(
      await call('update_resource', { page: L.harbour, tags: { add: ['Archived'] } }),
      /archive_page/,
    );
    refusedNaming(
      await call('update_resource', { page: L.harbour, tags: { add: ['Working'] } }),
      /move_to_working/,
    );
    expect(tags(L.harbour)).toEqual(['CANON', 'port']);
  });

  it('case and look-alike variants are caught: canon, ＣＡＮＯＮ, a Cyrillic С, a zero-width space', async () => {
    for (const t of ['canon', 'ＣＡＮＯＮ', 'СANON', 'CANON​', 'archived']) {
      const r = await call('update_resource', { page: L.ferry, tags: { add: [t] } });
      refusedNaming(r, /promote_page|archive_page/);
    }
    expect(tags(L.ferry)).toEqual(['Working']);
  });

  it('every raw route: lk_api_write, lk_api_batch and lk_op_updateResource', async () => {
    const before = tags(L.harbour);
    refusedNaming(
      await call('lk_api_write', {
        operationId: 'updateResource',
        params: { path: { resourceId: L.harbour }, body: { tags: ['port'] } },
      }),
      /move_to_working or archive_page/,
    );
    const batch = await call('lk_api_batch', {
      calls: [
        {
          operationId: 'updateResource',
          params: { path: { resourceId: L.guild }, body: { tags: ['note'] } },
        },
        {
          operationId: 'updateResource',
          params: { path: { resourceId: L.harbour }, body: { tags: ['port', 'working'] } },
        },
      ],
    });
    refusedNaming(batch, /status tag/);
    refusedNaming(
      await call('lk_op_updateResource', { path: { resourceId: L.harbour }, body: { tags: [] } }),
      /status tag/,
    );
    expect(tags(L.harbour)).toEqual(before);
    expect(tags(L.guild)).toEqual(['CANON']);
  });

  it('a create body that adds a status tag is refused (raw create, and an index item of create_many_resources)', async () => {
    refusedNaming(
      await call('lk_api_write', {
        operationId: 'createResource',
        params: { body: { name: 'Tagged Note', parentId: 'locs0001', tags: ['Canon'] } },
      }),
      /promote_page|create_resource with status/,
    );
    const many = await call('create_many_resources', {
      items: [{ key: 'i', name: '[INDEX] Tagged Index', parent: 'Locations', tags: ['CANON'] }],
    });
    expect(many.isError, many.text).toBe(true);
    expect(many.text).toMatch(/status tag/);
  });

  it('every other tag stays free; the status tag already there is kept', async () => {
    const r = await call('update_resource', {
      page: L.harbour,
      tags: { add: ['harbour-towns'], remove: ['port'] },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written' });
    expect(tags(L.harbour)).toEqual(['CANON', 'harbour-towns']);
  });

  it('creates according to their status still tag their pages', async () => {
    const r = await call('create_bare_resource', { name: '[BWRK] Tag Draft', parent: LIFECYCLE.working });
    expect(r.body, r.text).toMatchObject({ status: 'written' });
    expect(tags(r.body.pages[0].id)).toEqual(['Working']);
  });

  it('the rule is per project: switched off, the status tags are free again', async () => {
    const settings = w.stack.runtime.projects;
    const rules = DEFAULT_CANONICAL_RULES.map((x) => (x.id === 'status-tags' ? { ...x, enabled: false } : x));
    settings.setSetting(PROJECT, 'canonicalRules', rules);
    try {
      const r = await call('update_resource', { page: L.guild, tags: { remove: ['CANON'] } });
      expect(r.body, r.text).toMatchObject({ status: 'written' });
      expect(tags(L.guild)).toEqual([]);
    } finally {
      settings.setSetting(PROJECT, 'canonicalRules', null);
    }
    refusedNaming(await call('update_resource', { page: L.guild, tags: { add: ['CANON'] } }), /promote_page/);
  });
});
