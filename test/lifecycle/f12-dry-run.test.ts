/**
 * v3 F12 follow-up (the owner, 27 November 2026; ADR 0081 amendment 1, decision 4): a dry run of a protected (canon or
 * lifecycle) change says what it will do at the caller's scope. At scope write: it runs directly and appears on the
 * owner's Review page, with no `requiresCanonicalApproval` and no approval wording; at scope propose: a proposal only the
 * owner can accept as canon.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { L, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let writer: Client;
let proposer: Client;
const call = (c: Client, tool: string, args: Record<string, unknown>) =>
  w.stack.call(c, tool, { project: 'test', ...args });
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));

beforeAll(async () => {
  w = await lifecycleWorld();
  writer = await w.stack.connect(w.stack.newToken('f12-dry-writer', 'write').token);
  proposer = await w.stack.connect(w.stack.newToken('f12-dry-proposer', 'propose').token);
});
afterAll(async () => w.close());

/** Each protected change, as a dry run. */
const CASES: [string, string, Record<string, unknown>][] = [
  [
    'set_facts (Continuity Type off CANON)',
    'set_facts',
    { page: L.harbour, facts: { 'Continuity Type': 'AU' } },
  ],
  // delete_resource's dry run: test/resources/resources.test.ts (its world's tree holds the pages' facts).
  ['archive_page (an Authoritative page)', 'archive_page', { page: L.guild }],
  ['move_to_working (an Authoritative page)', 'move_to_working', { page: L.harbour }],
  [
    'create_resource (status authoritative)',
    'create_resource',
    {
      name: 'Salt Roads',
      parent: 'locs0001',
      template: '[BSRC] AI General Source Template',
      status: 'authoritative',
    },
  ],
];

describe('a dry run of a protected change says what it will do at the caller’s scope', () => {
  for (const [label, tool, args] of CASES) {
    it(`${label}: at scope write, it runs directly and appears on the Review page (no approval)`, async () => {
      const before = writes().length;
      const r = await call(writer, tool, { ...args, dryRun: true });
      expect(r.body.status, r.text).toBe('dry_run');
      expect(r.body.requiresCanonicalApproval, r.text).toBeUndefined();
      expect(String(r.body.message), r.text).toMatch(/runs directly and appears on the owner’s Review page/);
      expect(String(r.body.message), r.text).not.toMatch(/approv/i);
      expect(writes().length).toBe(before);
    });

    it(`${label}: at scope propose, it will be a proposal only the owner can accept as canon`, async () => {
      const r = await call(proposer, tool, { ...args, dryRun: true });
      expect(r.body.status, r.text).toBe('dry_run');
      expect(r.body.requiresCanonicalApproval, r.text).toBe(true);
      expect(String(r.body.message), r.text).toMatch(/becomes a proposal only the owner can accept as canon/);
    });
  }
});
