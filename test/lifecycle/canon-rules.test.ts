/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * The two recommended canon rules (v2 C2c, ADR 0035; Part 3, not yet decided by the owner, each a per-project rule that
 * can be switched off on the dashboard): deleting a [BARC] page needs canonical approval (the archive is provenance), and
 * deleting a map, timeline or board of an Authoritative page does too (it removes canonical content). Switched off, each
 * goes through as an ordinary delete.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonConfigFrom, DEFAULT_CANONICAL_RULES } from '../../src/facts/index.js';
import { ProjectStore } from '../../src/projects/index.js';
import { PROJECT } from '../tools/helpers.js';
import { SidebarModel } from '../resources/world.js';
import { accept, LIFECYCLE, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));
let store: ProjectStore;
const setRules = (rules: unknown) => store.setSetting(PROJECT, 'canonicalRules', rules);

beforeAll(async () => {
  w = await lifecycleWorld({
    seed: (world) => {
      world.repo.seed({
        id: 'oldpier1',
        name: '[BARC] Old Pier',
        parentId: LIFECYCLE.archived,
        tags: ['Archived'],
      });
      world.repo.seed({
        id: 'oldpier2',
        name: '[BARC] Older Pier',
        parentId: LIFECYCLE.archived,
        tags: ['Archived'],
      });
      // Old Harbour (Authoritative) gets a map and a timeline beside its page.
      world.repo.outside.addDocument('harbour1', 'Harbour chart', 'map');
      world.repo.outside.addDocument('harbour1', 'Harbour years', 'time');
    },
  });
  for (const id of ['oldpier1', 'oldpier2'])
    w.sidebars.page(id, [SidebarModel.kv(`kv${id}`, 'PROPERTIES', [['Status', 'Archived']])]);
  // The Plot Board page (not Authoritative) has a board beside its page.
  w.sidebars.page('board001', [SidebarModel.kv('kvboard1', 'PROPERTIES', [['Status', 'Draft']])]);
  store = new ProjectStore(w.stack.db, () => Date.now());
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('the defaults', () => {
  it('both are default rules, switched on', () => {
    const c = canonConfigFrom(undefined);
    expect(c.rules.map((r) => r.id)).toEqual(DEFAULT_CANONICAL_RULES.map((r) => r.id));
    expect(c.active.map((r) => r.id)).toEqual(
      expect.arrayContaining(['delete-archived', 'delete-document-authoritative']),
    );
  });
});

describe('deleting a [BARC] page', () => {
  it('needs canonical approval: a canonical proposal at scope write; the dry run says so', async () => {
    const dry = await call('delete_resource', { page: 'Old Pier', confirm: true, dryRun: true });
    expect(dry.body).toMatchObject({ status: 'dry_run', requiresCanonicalApproval: true });
    const before = writes().length;
    const r = await call('delete_resource', { page: 'Old Pier', confirm: true });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(r.body.reason).toMatch(/deleting “Old Pier”, a \[BARC\] page/);
    expect(writes().length).toBe(before);
    const done = await accept(w, r);
    expect(done.body, done.text).toMatchObject({ status: 'written' });
    expect(w.repo.live('oldpier1')).toBeUndefined();
  });
  it('switched off on the dashboard, it is an ordinary delete', async () => {
    setRules(DEFAULT_CANONICAL_RULES.map((r) => (r.id === 'delete-archived' ? { ...r, enabled: false } : r)));
    try {
      const r = await call('delete_resource', { page: 'Older Pier', confirm: true });
      expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    } finally {
      setRules(null);
    }
  });
});

describe('deleting a map, timeline or board of an Authoritative page', () => {
  it('needs canonical approval; of a page that is not Authoritative it does not', async () => {
    const r = await call('delete_document', {
      page: 'Old Harbour',
      document: 'Harbour chart',
      confirm: true,
    });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(r.body.reason).toMatch(
      /deleting the map document “Harbour chart” of “Old Harbour”, whose Status is Authoritative/,
    );
    w.stack.runtime.policy.commands.reject('owner', String(r.body.proposalId), 'kept');
    const board = await call('delete_document', {
      page: 'Plot Board',
      document: 'Plot board',
      confirm: true,
    });
    expect(board.body, board.text).toMatchObject({ status: 'written', verified: true });
  });
  it('switched off, it is an ordinary delete', async () => {
    setRules(
      DEFAULT_CANONICAL_RULES.map((r) =>
        r.id === 'delete-document-authoritative' ? { ...r, enabled: false } : r,
      ),
    );
    try {
      const dry = await call('delete_document', {
        page: 'Old Harbour',
        document: 'Harbour years',
        confirm: true,
        dryRun: true,
      });
      expect(dry.body.requiresCanonicalApproval).toBeUndefined();
      const r = await call('delete_document', {
        page: 'Old Harbour',
        document: 'Harbour years',
        confirm: true,
      });
      expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    } finally {
      setRules(null);
    }
  });
});
