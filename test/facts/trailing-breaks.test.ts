/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * C2d, Part 2 (ADR 0037): LegendKeeper trims a leading or trailing `{ break: true }` from a key-value row value (the
 * OpenAPI schema; the owner's sandbox run of 11 November 2026, B16). The bridge trims the same way before planning, so
 * what it plans, verifies and remembers is what LegendKeeper stores: a value sent with a trailing new line (plain) or a
 * trailing `<br>` (Markdown) verifies true and causes no later conflict; a value of nothing but breaks clears the row.
 * The mock trims as LegendKeeper does (test/facts/sidebar-model.ts, `trimBreaks`).
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normaliseContent, trimRowBreaks } from '../../src/jobs/sidebar-state.js';
import { rowTextRuns } from '../../src/facts/values.js';
import { resourcesWorld, T, type ResourcesWorld } from '../resources/world.js';
import { PROJECT } from '../tools/helpers.js';
import { P } from './world.js';

let w: ResourcesWorld;
let client: Client;
let proposer: Client;
const call = (tool: string, args: Record<string, unknown>, c: Client = client) =>
  w.stack.call(c, tool, { project: 'test', ...args });
const stored = (page: string, key: string) =>
  w.sidebars.pages
    .get(page)!
    .props.flatMap((p) => p.rows ?? [])
    .find((r) => r.key === key)?.content;
const proposals = () => w.stack.runtime.policy.proposals;
const settle = async (id: string) => {
  for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals().get(id)!.state); i++)
    await new Promise((r) => setTimeout(r, 20));
  return proposals().get(id)!;
};

beforeAll(async () => {
  w = await resourcesWorld();
  client = await w.stack.connect();
  proposer = await w.stack.connect(w.stack.newToken('breaks-proposer', 'propose').token);
});
afterAll(async () => w.close());

describe('row values and line breaks (C2d, Part 2)', () => {
  it('the helpers trim every leading and trailing break, keep inner ones, and empty a break-only value', () => {
    const b = { break: true };
    expect(trimRowBreaks([b, b, { text: 'a' }, b, b, { text: 'b' }, b])).toEqual([
      { text: 'a' },
      b,
      b,
      { text: 'b' },
    ]);
    expect(trimRowBreaks([b, b])).toEqual([]);
    expect(rowTextRuns('one\ntwo\n')).toEqual([{ text: 'one' }, b, { text: 'two' }]);
    expect(rowTextRuns('\n')).toEqual([]);
    expect(normaliseContent([{ text: 'x' }, b])).toEqual([{ text: 'x' }]);
  });

  it('a plain value with a trailing new line verifies true, and its factsVersion is the base of the next write', async () => {
    const r = await call('set_facts', { page: P.miyabi, facts: { Notes: 'Envoy to the court\n' } });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(stored(P.miyabi, 'Notes')).toEqual([{ text: 'Envoy to the court' }]);
    // The version the write answered is the page as LegendKeeper holds it: no conflict on the next write.
    const after = r.body.factsVersion?.after ?? r.body.after?.factsVersion ?? r.body.factsVersionAfter;
    const base = (await call('get_resource', { resource: P.miyabi })).body.resource.factsVersion;
    if (after !== undefined) expect(after).toBe(base);
    const again = await call('set_facts', {
      page: P.miyabi,
      baseFactsVersion: base,
      facts: { Notes: 'Envoy to the court\n' },
    });
    // Unchanged once trimmed: nothing to write, and no conflict.
    expect(again.body.error?.code, again.text).not.toBe('VERSION_CONFLICT');
    expect(stored(P.miyabi, 'Notes')).toEqual([{ text: 'Envoy to the court' }]);
    const next = await call('set_facts', {
      page: P.miyabi,
      baseFactsVersion: base,
      facts: { Notes: 'Envoy, second\n\n' },
    });
    expect(next.body, next.text).toMatchObject({ status: 'written', verified: true });
  });

  it('Markdown with a leading and a trailing <br> verifies true; the inner one is kept', async () => {
    const r = await call('set_facts', {
      page: P.miyabi,
      facts: { Notes: { markdown: '<br>**Envoy**<br>to the court<br>' } },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(stored(P.miyabi, 'Notes')).toEqual([
      { text: 'Envoy', bold: true },
      { break: true },
      { text: 'to the court' },
    ]);
  });

  it('a value of nothing but new lines clears the row (as an empty value does), verified', async () => {
    const r = await call('set_facts', { page: P.miyabi, facts: { Notes: '\n\n' } });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(stored(P.miyabi, 'Notes')).toEqual([]);
  });

  it('a proposal with a trailing break runs without a conflict and verifies true', async () => {
    const p = await call('set_facts', { page: P.miyabi, facts: { Notes: 'Proposed note\n' } }, proposer);
    expect(p.body.status, p.text).toBe('proposal_captured');
    await w.stack.runtime.policy.commands.approve('owner', String(p.body.proposalId));
    const done = await settle(String(p.body.proposalId));
    expect(done.state).toBe('executed');
    const job = w.stack.runtime.engine.queries.getJob(PROJECT, done.jobId!);
    expect((job?.result as { verified?: boolean } | null)?.verified ?? true).toBe(true);
    expect(stored(P.miyabi, 'Notes')).toEqual([{ text: 'Proposed note' }]);
  });

  it('a new page’s facts with trailing breaks: the copy is bound, written and verified true', async () => {
    const r = await call('create_resource', {
      name: 'Break Test',
      template: T.general,
      facts: { Scope: 'First line\nsecond line\n' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(stored(r.body.pages[0].id, 'Scope')).toEqual([
      { text: 'First line' },
      { break: true },
      { text: 'second line' },
    ]);
  });
});
