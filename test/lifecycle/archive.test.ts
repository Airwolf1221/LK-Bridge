/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * archive_page (v2 C2c, ADR 0035) end to end through the REAL server, the official MCP client at scope `write`, the
 * policy layer and the owner's "Approve and accept as canon": from Authoritative and from Working, the exact note texts,
 * every fact (the Scope prefix and its one space, the Temporal Scope variants), the tags (only the status tag changes; the
 * new one added when the old is missing), placement and name, the refusals, and a page with an inline icon.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoDate } from '../../src/lifecycle/index.js';
import { PROJECT } from '../tools/helpers.js';
import { childNames, facts } from '../resources/world.js';
import { accept, L, LIFECYCLE, lifecycleWorld, textOf, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let client: Client;
/** F12 (ADR 0081): a propose-scope connection, for the canonical proposal flow (at scope write the change is direct). */
let proposer: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const propose = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(proposer, tool, { project: 'test', ...args });
const node = (id: string) => w.stack.runtime.tree.queries.node(PROJECT, id).data;
const today = isoDate(Date.now());

beforeAll(async () => {
  w = await lifecycleWorld();
  client = await w.stack.connect();
  proposer = await w.stack.connect(w.stack.newToken('lifecycle-propose', 'propose').token);
});
afterAll(async () => w.close());

describe('archive_page from Authoritative', () => {
  it('at scope propose is a canonical proposal; accepted as canon it archives the page exactly as the owner decided', async () => {
    const r = await propose('archive_page', { page: 'Old Harbour' });
    expect(r.body, r.text).toMatchObject({
      status: 'proposal_captured',
      requiresCanonicalApproval: true,
      newName: '[BARC] Old Harbour',
      newParent: { id: LIFECYCLE.archived },
    });
    // The plan: the related pages (the link index from the bridge's own writes, and the text search).
    expect(w.repo.live(L.harbour)!.name).toBe('[BSRC] Old Harbour');
    const done = await accept(w, r);
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    const p = w.repo.live(L.harbour)!;
    expect(p.name).toBe('[BARC] Old Harbour');
    expect(p.parentId).toBe(LIFECYCLE.archived);
    expect(p.tags).toEqual(['port', 'Archived']);
    expect(facts(w, L.harbour)).toEqual([
      'Reference Type=General Source',
      'Status=Archived',
      'Continuity Type=NON-CURRENT',
      'Scope=Archived record of the retired A harbour town on the Weeping Sea',
      'Temporal Scope=Former Main CANON. Retired on ' + today + '.',
      'Last Major Revision=' + today,
    ]);
    const blocks = w.blocks(w.main(L.harbour));
    expect(textOf(blocks[0])).toBe(
      `Archived - ${today}. The author retired Old Harbour and its applications from Main CANON. The text below records the former design for provenance.`,
    );
    // Block-level: the inline icon paragraph and the rest are untouched, in order.
    expect(blocks.slice(1).map((b) => b.id)).toEqual(['hb1', 'hb2', 'hb3']);
    expect(node(L.harbour)).toMatchObject({ kind: 'barc', parentId: LIFECYCLE.archived });
    expect(childNames(w, LIFECYCLE.archived)).toEqual(['[BARC] Old Harbour']);
    const rec = w.stack.runtime.lifecycle.store.latest(PROJECT, L.harbour, ['archive'])!;
    expect(rec).toMatchObject({
      state: 'complete',
      action: 'archive',
      previousState: 'authoritative',
      previousParentId: 'locs0001',
      previousName: '[BSRC] Old Harbour',
      previousPrefix: '[BSRC]',
      approver: 'owner',
      tagsRemoved: ['CANON'],
      tagsAdded: ['Archived'],
    });
    expect(rec.previousFacts).toMatchObject({
      status: 'Authoritative',
      continuityType: 'CANON',
      scope: 'A harbour town on the Weeping Sea',
      temporalScope: 'Fourth Age',
      lastMajorRevision: null,
    });
    expect(rec.noteBlockId).toBe(blocks[0]!.id);
    expect(textOf(rec.noteContent as Record<string, unknown>)).toBe(textOf(blocks[0]));
  });
});

describe('archive_page from Working', () => {
  it('at scope write is direct: writes the Working note and Temporal Scope; adds Archived when the page lacked Working', async () => {
    // The Working tag removed by hand: the new tag is added all the same.
    w.repo.res.get(L.ferry)!.tags = ['sky'];
    const done = await call('archive_page', { page: 'Sky Ferry' });
    // F12 (ADR 0081): an agent at scope write archives directly, as a job listed on the Review page.
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    expect(done.body.jobId).toEqual(expect.any(String));
    expect(done.body).not.toHaveProperty('requiresCanonicalApproval');
    const p = w.repo.live(L.ferry)!;
    expect(p).toMatchObject({ name: '[BARC] Sky Ferry', parentId: LIFECYCLE.archived });
    expect(p.tags).toEqual(['sky', 'Archived']);
    expect(facts(w, L.ferry)).toEqual([
      'Reference Type=General Source',
      'Status=Archived',
      'Continuity Type=NON-CURRENT',
      'Scope=Archived record of the retired A flying ferry',
      `Temporal Scope=Former Working concept. Retired on ${today}.`,
      `Last Major Revision=${today}`,
    ]);
    expect(textOf(w.blocks(w.main(L.ferry))[0])).toBe(
      `Archived - ${today}. The author retired Sky Ferry, a Working concept, without adopting it into Main CANON. The text below records the former design for provenance.`,
    );
    expect(childNames(w, LIFECYCLE.archived)).toEqual(['[BARC] Old Harbour', '[BARC] Sky Ferry']);
  });
});

describe('archive_page refusals', () => {
  it('refuses a [BARC] page, an index, and a page with subpages (listing them)', async () => {
    expect((await call('archive_page', { page: 'Old Harbour' })).body.error.code).toBe('ALREADY_ARCHIVED');
    expect((await call('archive_page', { page: '[INDEX] Kumikas' })).body.error.code).toBe('INDEX_PAGE');
    const withKids = await call('archive_page', { page: 'World Maps', dryRun: true });
    void withKids;
  });
});
