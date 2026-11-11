/**
 * What the ETag saves the page lifecycle tools (v2 D1.1, ADR 0039; sandbox B12). The same calls as costs.test.ts, against
 * a LegendKeeper that tells a property row write's new version (1) in the body, as the spec says; (2) only in an `ETag`
 * header, as the test world's does (B12, B13); (3) nowhere, so the bridge must re-read. The owner's sandbox run showed
 * (2): before this change the bridge treated it as (3).
 */
import { afterAll, expect, it } from 'vitest';
import { accept, lifecycleWorld, type LifecycleWorld } from './world.js';

const worlds: LifecycleWorld[] = [];
afterAll(async () => {
  for (const w of worlds) await w.close();
}, 60_000);

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 20));
};

type Mode = 'body' | 'etag' | 'none';

async function measureAll(mode: Mode) {
  const w = await lifecycleWorld();
  worlds.push(w);
  w.sidebars.rowVersions = mode;
  const c = await w.stack.connect();
  const got: Record<string, [number, number]> = {};
  const split = (lines: string[]): [number, number] => [
    lines.filter((l) => l.startsWith('GET')).length,
    lines.filter((l) => !l.startsWith('GET')).length,
  ];
  const measure = async (label: string, tool: string, args: Record<string, unknown>) => {
    const r = await w.stack.call(c, tool, { project: 'test', ...args });
    expect(r.body.status, `${mode} ${label}: ${r.text}`).toBe('proposal_captured');
    const b = w.seen.length;
    const done = await accept(w, r);
    expect(done.body, `${mode} ${label}: ${done.text}`).toMatchObject({ status: 'written', verified: true });
    await settle();
    got[label] = split(w.seen.slice(b));
  };
  await measure('archive_page, Authoritative', 'archive_page', { page: 'Old Harbour' });
  await measure('unarchive_page, to Authoritative', 'unarchive_page', { page: 'Old Harbour' });
  await measure('move_to_working', 'move_to_working', { page: 'Harbour Guild' });
  await measure('promote_page', 'promote_page', { page: 'Harbour Guild', destination: 'locs0001' });
  await measure('archive_page, Working', 'archive_page', { page: 'Sky Ferry' });
  await measure('unarchive_page, to Working', 'unarchive_page', { page: 'Sky Ferry' });
  return got;
}

it('the ETag gives the lifecycle jobs the reads the spec’s version in the body gives them; with neither they re-read', async () => {
  const body = await measureAll('body');
  const etag = await measureAll('etag');
  const none = await measureAll('none');
  const rows = Object.keys(body).map((k) => ({
    call: k,
    body: `${body[k]![0]} reads, ${body[k]![1]} writes`,
    etag: `${etag[k]![0]} reads, ${etag[k]![1]} writes`,
    none: `${none[k]![0]} reads, ${none[k]![1]} writes`,
    saved: none[k]![0] - etag[k]![0],
  }));
  process.stdout.write(`LIFECYCLE ETAG COSTS ${JSON.stringify(rows)}\n`);
  // The ETag does exactly what a version in the body does, and the writes are the same in every mode.
  expect(etag).toEqual(body);
  for (const k of Object.keys(body)) {
    expect(none[k]![1]).toBe(etag[k]![1]);
    expect(none[k]![0]).toBeGreaterThanOrEqual(etag[k]![0]);
  }
}, 60_000);
