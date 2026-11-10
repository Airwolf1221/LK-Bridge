/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * Related pages (v2 C2c, ADR 0035; Part 4): the link index kept up to date from the bridge's own writes as they happen,
 * refreshed by the paced, resumable `link-sweep`; archive_page and move_to_working list the pages that link to or mention
 * a page (never edited), say how fresh the index is, and add one content search's hits marked "found by text search
 * (may be incomplete)".
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLifecycle } from '../../src/lifecycle/index.js';
import { ProjectStore } from '../../src/projects/index.js';
import { PROJECT } from '../tools/helpers.js';
import { SidebarModel } from '../resources/world.js';
import { L, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const lc = () => w.stack.runtime.lifecycle;
const sweep = async () => w.stack.runtime.maintenance.scheduler.runNow('link-sweep').done;
const linksTo = (id: string) =>
  lc()
    .store.linksTo(PROJECT, id)
    .map((l) => `${l.fromId} ${l.kind} ${l.via} (${l.source})`)
    .sort();

const LIMITS = {
  'key-min': 5000,
  'write-min': 2000,
  'key-hour': 60000,
  'write-hour': 30000,
  'project-hour': 60000,
};

beforeAll(async () => {
  w = await lifecycleWorld({ env: { LK_TIER_LIMITS: JSON.stringify(LIMITS) }, limits: LIMITS as never });
  w.sidebars.page(L.ferry, [
    ...w.sidebars.pages.get(L.ferry)!.props,
    SidebarModel.links('depferr1', 'Dependencies', []),
  ] as never);
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('before any sweep', () => {
  it('the report says the index is from the bridge’s own writes only; the content search still finds text mentions', async () => {
    const r = await call('archive_page', { page: 'Old Harbour', dryRun: true });
    expect(r.body, r.text).toMatchObject({ status: 'dry_run' });
    const rel = r.body.relatedPages;
    expect(rel.freshness).toMatch(/no link sweep has completed yet/);
    expect(rel.pages).toEqual([]);
    expect(rel.textSearch.map((p: { name: string }) => p.name).sort()).toEqual([
      '[BSRC] Harbour Guild',
      '[BSRC] Tide Tables',
    ]);
    expect(rel.textSearch[0].found).toBe('found by text search (may be incomplete)');
  });
});

describe('the link sweep', () => {
  it('reads every page’s sidebar and page documents at the lowest priority, and fills the index', async () => {
    const run = await sweep();
    expect(run).toMatchObject({ outcome: 'succeeded' });
    expect(linksTo(L.harbour)).toEqual([
      `${L.guild} collection Dependencies (sweep)`,
      `${L.guild} mention ${w.main(L.guild)} (sweep)`,
    ]);
    const s = lc().store.lastSweep(PROJECT)!;
    const pages = w.stack.runtime.tree.queries.counts(PROJECT).data.total - 1;
    expect(s).toMatchObject({ status: 'succeeded', pagesDone: pages });
    // About two requests per page: its getResource, and one per page document.
    expect(s.requests).toBe(pages + s.documentsRead);
  });

  it('the related pages: the index’s, with how they link, its freshness, and the text search for the rest', async () => {
    const r = await call('archive_page', { page: 'Old Harbour', dryRun: true });
    const rel = r.body.relatedPages;
    expect(rel.freshness).toMatch(/^link index as of .* \(the last complete sweep\)/);
    expect(rel.pages).toEqual([
      expect.objectContaining({
        id: L.guild,
        name: '[BSRC] Harbour Guild',
        links: ['link collection “Dependencies”', 'mentions it in “Main”'],
      }),
    ]);
    expect(rel.textSearch.map((p: { name: string }) => p.name)).toEqual(['[BSRC] Tide Tables']);
    expect(rel.note).toMatch(/never edited/);
    // move_to_working reports them too.
    const m = await call('move_to_working', { page: 'Old Harbour', dryRun: true });
    expect(m.body.relatedPages.pages.map((p: { id: string }) => p.id)).toEqual([L.guild]);
  });

  it('is resumable: a run that stops part-way is continued by the next, never restarted', async () => {
    // A fault on one page's read, part-way through the pass.
    const ids = w.stack.runtime.tree.queries
      .subtree(PROJECT, 'airepo01', { limit: 10_000 })
      .data.entries.map((e) => e.node.id)
      .filter((id) => id !== 'airepo01')
      .sort();
    const victim = ids[Math.floor(ids.length / 2)]!;
    let failed = false;
    const before = [...w.overrides];
    w.overrides.clear();
    w.overrides.set(new RegExp(`/resources/${victim}$`), (req) => {
      if (failed || req.method !== 'GET') return undefined;
      failed = true;
      return { status: 500, body: { code: 'INTERNAL', message: 'injected', requestId: 'x' } };
    });
    for (const [k, v] of before) w.overrides.set(k, v);
    const first = await sweep();
    expect(first?.outcome).toBe('failed');
    const running = lc().store.runningSweep(PROJECT)!;
    expect(running.cursor! < victim).toBe(true);
    const doneBefore = running.pagesDone;
    expect(doneBefore).toBeGreaterThan(0);
    const second = await sweep();
    expect(second?.outcome).toBe('succeeded');
    const s = lc().store.sweep(running.id)!;
    expect(s.status).toBe('succeeded');
    expect(s.pagesDone).toBe(ids.length);
  });

  it('gives way to agents’ work: it waits while P1 or P2 work is queued for the project', async () => {
    let busyCalls = 0;
    let slept = 0;
    const store = new ProjectStore(w.stack.db, () => Date.now());
    const paced = createLifecycle({
      db: w.stack.db,
      engine: w.stack.runtime.engine,
      tree: w.stack.runtime.tree,
      settings: (p) => store.byId(p)?.settings,
      setSetting: () => undefined,
      projectName: () => 'test',
      audit: () => undefined,
      now: () => Date.now(),
      busy: () => busyCalls++ < 3,
      sleep: async () => {
        slept++;
      },
    });
    const r = await paced.sweep(PROJECT);
    expect(r.changed).toBe(true);
    expect(slept).toBe(3);
  });
});

describe('kept up to date from the bridge’s own writes', () => {
  it('a link added or removed with set_facts, and a mention written with write_page, show at once', async () => {
    const add = await call('set_facts', {
      page: 'Sky Ferry',
      links: { Dependencies: { add: ['Old Harbour'] } },
    });
    expect(add.body, add.text).toMatchObject({ status: 'written', verified: true });
    expect(linksTo(L.harbour)).toContain(`${L.ferry} collection Dependencies (write)`);
    const wp = await call('write_page', {
      page: 'Tide Tables',
      mode: 'append',
      markdown: 'See also [[Old Harbour]].',
    });
    expect(wp.body, wp.text).toMatchObject({ status: 'written' });
    expect(linksTo(L.harbour)).toContain(`${L.tides} mention ${w.main(L.tides)} (write)`);
    const r = await call('archive_page', { page: 'Old Harbour', dryRun: true });
    expect(r.body.relatedPages.pages.map((p: { id: string }) => p.id).sort()).toEqual(
      [L.guild, L.tides, L.ferry].sort(),
    );
    const rm = await call('set_facts', {
      page: 'Sky Ferry',
      links: { Dependencies: { remove: ['Old Harbour'] } },
    });
    expect(rm.body, rm.text).toMatchObject({ status: 'written' });
    expect(linksTo(L.harbour).join(' ')).not.toContain(L.ferry);
  });
});
