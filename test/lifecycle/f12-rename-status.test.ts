/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * v3 F12 follow-up (the owner, 27 November 2026; ADR 0081 amendment 1, decision 1): a rename that puts the [BSRC]
 * prefix on, or takes it off, so that the prefix disagrees with the page's Status is refused at every scope: never
 * direct, never a proposal. The refusal names the tool that keeps prefix, Status and tags in step (archive_page,
 * move_to_working or promote_page). A rename that keeps the prefix, or brings it back into step with Status, is not.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SidebarModel } from '../resources/world.js';
import { PROJECT } from '../tools/helpers.js';
import { L, lifecycleWorld, type LifecycleWorld } from './world.js';

const P = { notes: 'fnotes01', charter: 'charter1' } as const;

let w: LifecycleWorld;
let writer: Client;
let proposer: Client;
const call = (c: Client, tool: string, args: Record<string, unknown>) =>
  w.stack.call(c, tool, { project: 'test', ...args });
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));
const proposals = () => w.stack.runtime.policy.commands.listProposals('owner', { project: PROJECT }).length;

beforeAll(async () => {
  w = await lifecycleWorld({
    env: { MCP_EXPOSE_PER_OP_TOOLS: 'true' },
    seed: (world) => {
      // No prefix, Status Working: a [BSRC] rename would disagree with it.
      world.repo.seed({ id: P.notes, name: 'Ferry Notes', parentId: 'locs0001', tags: ['Working'] });
      // No prefix, Status Authoritative: a [BSRC] rename brings the prefix back into step.
      world.repo.seed({ id: P.charter, name: 'Lost Charter', parentId: 'locs0001', tags: ['CANON'] });
    },
  });
  w.sidebars.page(P.notes, [SidebarModel.kv('kvnote01', 'PROPERTIES', [['Status', 'Working']])]);
  w.sidebars.page(P.charter, [SidebarModel.kv('kvchar01', 'PROPERTIES', [['Status', 'Authoritative']])]);
  writer = await w.stack.connect(w.stack.newToken('f12-rename-writer', 'write').token);
  proposer = await w.stack.connect(w.stack.newToken('f12-rename-proposer', 'propose').token);
});
afterAll(async () => w.close());

/** A refusal: nothing written, nothing proposed, the reason naming the tool. */
async function refused(c: Client, tool: string, args: Record<string, unknown>, names: RegExp) {
  const before = { writes: writes().length, proposals: proposals() };
  const r = await call(c, tool, args);
  expect(r.isError, r.text).toBe(true);
  expect(r.body.status, r.text).not.toBe('proposal_captured');
  expect(r.body.error?.code, r.text).toBe('POLICY_DENIED');
  expect(r.body.error?.message, r.text).toMatch(names);
  expect({ writes: writes().length, proposals: proposals() }).toEqual(before);
}

const rename = (resourceId: string, name: string) => ({
  operationId: 'updateResource',
  params: { path: { resourceId }, body: { name } },
});

describe('a rename whose lifecycle prefix would disagree with Status: refused at every scope', () => {
  for (const [scope, client] of [
    ['write', () => writer],
    ['propose', () => proposer],
  ] as const) {
    it(`at scope ${scope}: taking [BSRC] off an Authoritative page names archive_page or move_to_working`, async () => {
      await refused(
        client(),
        'lk_api_write',
        rename(L.harbour, 'Old Harbour'),
        /takes the \[BSRC\] prefix off while its Status is Authoritative.*archive_page or move_to_working/,
      );
      expect(w.repo.res.get(L.harbour)!.name).toBe('[BSRC] Old Harbour');
    });

    it(`at scope ${scope}: putting [BSRC] on a page whose Status is Working names promote_page`, async () => {
      await refused(
        client(),
        'lk_api_write',
        rename(P.notes, '[BSRC] Ferry Notes'),
        /\[BSRC\] prefix says Authoritative while its Status is Working.*promote_page/,
      );
      expect(w.repo.res.get(P.notes)!.name).toBe('Ferry Notes');
    });
  }

  it('in a batch too (lk_api_batch): the whole batch is refused, nothing sent', async () => {
    const before = writes().length;
    const r = await call(writer, 'lk_api_batch', {
      calls: [
        {
          operationId: 'updateResource',
          params: { path: { resourceId: L.tides }, body: { tags: ['CANON', 'sea'] } },
        },
        rename(L.tides, 'Tide Tables'),
      ],
    });
    expect(r.body.error?.code, r.text).toBe('POLICY_DENIED');
    expect(r.body.error?.message, r.text).toMatch(/archive_page or move_to_working/);
    expect(writes().length).toBe(before);
  });

  it('the high-level update_resource never changes a prefix at all (PREFIX_CHANGE), as before', async () => {
    const r = await call(writer, 'update_resource', { page: P.notes, name: '[BSRC] Ferry Notes' });
    expect(r.body.error?.code, r.text).toBe('PREFIX_CHANGE');
  });
});

describe('a rename that keeps the prefix in step with Status is not refused', () => {
  it('keeping [BSRC] on an Authoritative page: direct at scope write', async () => {
    const r = await call(writer, 'lk_api_write', rename(L.guild, '[BSRC] Harbour Guild Hall'));
    expect(r.isError, r.text).toBe(false);
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    if (typeof r.body.jobId === 'string') await w.stack.runtime.engine.wait(PROJECT, r.body.jobId, 20_000);
    expect(w.repo.res.get(L.guild)!.name).toBe('[BSRC] Harbour Guild Hall');
  });

  it('putting [BSRC] back on a page whose Status is Authoritative: direct at scope write', async () => {
    const r = await call(writer, 'lk_api_write', rename(P.charter, '[BSRC] Lost Charter'));
    expect(r.isError, r.text).toBe(false);
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    if (typeof r.body.jobId === 'string') await w.stack.runtime.engine.wait(PROJECT, r.body.jobId, 20_000);
    expect(w.repo.res.get(P.charter)!.name).toBe('[BSRC] Lost Charter');
  });
});
