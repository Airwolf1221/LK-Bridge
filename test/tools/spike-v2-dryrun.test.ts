/**
 * The v2 phase 0 spike's own logic (docs/PLAN-v2.md, session 0), run against the mock LegendKeeper with a small stateful
 * test world: the guard, all ten checks, the report, the write rules, and check 1's clean-up after a forced failure.
 * Nothing here touches a real project.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseOutboundPortAllowlist } from '../../src/auth/ports.js';
import { systemClock } from '../../src/lk/index.js';
import type { GuardOptions } from '../../src/mcp/tools/upload-http.js';
import { MockLk } from '../contract/mock-lk.js';
import { SandboxGuardError } from '../sandbox/smoke.js';
import { createSoakRuntime, type SoakRuntime } from '../sandbox/soak.js';
import { Evidence, formatReport, runLength, type CheckReport } from '../sandbox/spike-report.js';
import {
  dateForm,
  eventShape,
  kindOf,
  newSpikeContext,
  runSpike,
  siblingOrderOk,
  type SpikeOptions,
  type SpikeOutcome,
} from '../sandbox/spike-v2.js';
import { API_KEY, PROJECT } from './helpers.js';
import { IDS, World, type WorldOptions } from './spike-world.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// ---------------------------------------------------------------------------------------------- the asset host
let dir: string;
let cert: string;
let storage: Server;
let port: number;
const seen: { url: string; headers: Record<string, string | string[] | undefined> }[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lkb-spike-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=assets.test',
      '-addext',
      'subjectAltName=DNS:assets.test',
    ],
    { stdio: 'ignore' },
  );
  cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
  storage = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
    res.end(PNG);
  });
  await new Promise<void>((r) => storage.listen(0, '127.0.0.1', r));
  port = (storage.address() as AddressInfo).port;
});
afterAll(async () => {
  storage.closeAllConnections();
  await new Promise((r) => storage.close(r));
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  seen.length = 0;
});

const guard = (): GuardOptions => ({
  resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]),
  ca: cert,
  allowAddress: (a) => a === '127.0.0.1',
  allowedPorts: parseOutboundPortAllowlist(`assets.test:${port}`),
});

// ---------------------------------------------------------------------------------------------- the stack
let mock: MockLk | undefined;
let soak: SoakRuntime | undefined;
afterEach(async () => {
  await soak?.close();
  await mock?.stop();
  soak = undefined;
  mock = undefined;
});

async function start(world: Partial<WorldOptions> = {}, projectSeen = PROJECT) {
  const w = new World({ projectId: projectSeen, assetBase: `https://assets.test:${port}`, ...world });
  mock = new MockLk({ clock: systemClock, apiKey: API_KEY, respond: w.respond });
  const url = await mock.start();
  soak = createSoakRuntime({
    apiKey: API_KEY,
    projectId: PROJECT,
    baseUrl: url,
    writersMax: 1,
    env: { WRITE_SPACING_MS: '0', WRITE_SPACING_STRETCHED_MS: '0' },
  });
  const target = {
    engine: soak.runtime.engine,
    lk: soak.runtime.lk,
    projectId: PROJECT,
    counters: soak.counters,
  };
  return { world: w, mock, soak, target };
}

const nonGets = () => mock!.calls.filter((c) => c.method !== 'GET');
function report(outcome: SpikeOutcome, s: SoakRuntime): string {
  const c = s.counters;
  return formatReport(
    {
      generatedAt: '2026-11-09T00:00:00.000Z',
      projectId: PROJECT,
      durationMs: outcome.durationMs,
      ids: outcome.ids as unknown as Record<string, string>,
      stats: {
        requests: c.requests,
        reads: c.reads,
        writes: c.writes,
        byStatus: Object.fromEntries([...c.byStatus].map(([k, v]) => [String(k), v])),
        networkErrors: c.networkErrors,
        status429: c.byStatus.get(429) ?? 0,
        downloads: outcome.downloads,
      },
      cleanup: outcome.cleanup,
      budgetFooter: s.runtime.lk.budgetFooter(),
    },
    outcome.checks,
  );
}
const check = (o: SpikeOutcome, id: number): CheckReport => o.checks.find((c) => c.id === id)!;
const run = (t: Awaited<ReturnType<typeof start>>, o: SpikeOptions = {}) =>
  runSpike(t.target, PROJECT, { guard: guard(), ...o });

// ---------------------------------------------------------------------------------------------- tests
describe('spike v2 (dry run)', () => {
  it('refuses, writing nothing, when the key belongs to another project', async () => {
    const t = await start({}, 'proj_somebody_else');
    await expect(run(t)).rejects.toBeInstanceOf(SandboxGuardError);
    expect(nonGets()).toHaveLength(0);
    expect(mock!.calls.filter((c) => c.method === 'GET')).toHaveLength(1); // listProjects, nothing else
  });

  it('runs all ten checks, writes only under the throwaway root, deletes it, and reports', async () => {
    const t = await start();
    const outcome = await run(t);
    const text = report(outcome, t.soak);
    expect(outcome.checks.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const verdicts = Object.fromEntries(outcome.checks.map((c) => [c.id, c.verdict]));
    expect(verdicts, text).toEqual({
      1: 'PASS',
      2: 'PASS',
      3: 'PASS',
      4: 'PASS',
      5: 'PASS',
      6: 'INFO',
      7: 'INFO',
      8: 'INFO',
      9: 'PASS',
      10: 'INFO',
    });

    // Check 1: the batch was nested, and everything it created is gone.
    const batch = t.world.writes.find((w) => w.op === 'createManyResources')!;
    const items = (batch.body as { resources: { id: string; parentId: string }[] }).resources;
    expect(items.map((r) => r.parentId)).toEqual([expect.any(String), items[0]!.id, items[1]!.id]);
    expect(t.world.writes.map((w) => w.op)).toEqual([
      'createResource',
      'createManyResources',
      'deleteResource',
    ]);
    expect(nonGets()).toHaveLength(3);
    expect(t.world.deleted).toHaveLength(4); // the root and A, B, C
    expect(
      [...t.world.resources.values()].filter(
        (r) => r.name.startsWith('spike') || r.name.startsWith('lk-bridge spike'),
      ),
    ).toEqual([]);
    expect(outcome.cleanup).toMatchObject({ attempted: true, ok: true });
    // The three writes went through the engine, so they are in the write journal.
    const journal = t.soak.runtime.engine.queries.journalLookup({ limit: 50 });
    expect(journal.map((j) => j.opId).sort()).toEqual([
      'createManyResources',
      'createResource',
      'deleteResource',
    ]);

    // Check 2: both limits, per query, and the cross-check against the listing.
    expect(check(outcome, 2).evidence.join('\n')).toMatch(/limit 100 → 100 results/);
    expect(check(outcome, 2).evidence.join('\n')).toMatch(/limit 50 +→ 50 results/);
    // Check 3: three images, SHA-256 of the real bytes, no credential sent, and the guard's verdict.
    const c3 = check(outcome, 3).evidence.join('\n');
    expect(c3).toContain(createHash('sha256').update(PNG).digest('hex'));
    expect(c3).toMatch(/guard: allowed/);
    expect(c3).toMatch(/authentication needed: no/);
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s.headers.authorization === undefined)).toBe(true);
    expect(outcome.downloads).toBe(3);
    // Checks 4 and 5: shapes found (month-range only on a later page), five raw samples, the oracle.
    const c4 = check(outcome, 4).evidence.join('\n');
    expect(c4).toMatch(/year-only +→ detail=1/);
    expect(c4).toMatch(/month-range +→ detail=2/);
    expect(c4).toMatch(/date-range +→ detail=3|date-range +→ detail=\(absent\)/);
    expect(c4).toContain('formattedStart:');
    expect(c4).toContain('EventDate (startDate and endDate)');
    expect(c4).toMatch(/1 more page\(s\) were read/);
    expect((outcome.oracle as { events: unknown[] }).events).toHaveLength(45);
    expect(check(outcome, 5).evidence.join('\n')).toContain('Kumikan Epochal');
    expect(check(outcome, 5).evidence.join('\n')).toMatch(/negative: aa/);
    // Check 6: the age table and the Main page.
    const c6 = check(outcome, 6).evidence.join('\n');
    expect(c6).toContain('Top-level blocks (3), in order: heading, paragraph, table');
    expect(c6).toContain('"Historical Event" [header flag] | "Date" [header flag] | "KCY" [header flag]');
    expect(c6).toMatch(/Rows \(excluding the header row\): 10/);
    expect(c6).toContain('year-only×3');
    expect(c6).toContain('Five rows around the year-only row 5 ("4A 139")');
    expect(c6).toContain('digits with thousands commas×1');
    expect(c6).toContain('mention(res h0gczxh7, doc bt0bm3pc');
    // Check 7: the pixel formula reproduces the bounds, features are summarised.
    expect(check(outcome, 7).evidence.join('\n')).toMatch(/reported bounds follow that formula: true/);
    expect(check(outcome, 7).summary).toMatch(/1 map\(s\) read/);
    // Checks 8 to 10.
    const c8 = check(outcome, 8).evidence.join('\n');
    expect(c8).toContain('By kind: [INDEX] 11, [BSRC] 8, unclassified 1.');
    expect(c8).toContain(
      'Resources per depth below the root: depth 1: 4, depth 2: 12, depth 3: 3, depth 4: 1.',
    );
    expect(c8).toContain('Resources OUTSIDE the root: 2');
    expect(c8).toMatch(/Unclassified names \(up to 20 of 1\): "Arkona working notes"/);
    expect(c8).toContain('keyValue "PROPERTIES" rows: 3 keys: "Race / Species", "Scope", "Reference Type"');
    expect(c8).toMatch(
      /follows "\[INDEX\] first, then \[BSRC\], alphabetical": NO, first break at position 2/,
    );
    const c9 = check(outcome, 9).evidence.join('\n');
    expect(c9).toContain('`[INDEX] Characters` under the root: 1 found');
    expect(c9).toContain('directly under Characters: 1');
    expect(c9).toContain('"Character Core"  tpl00002  parent templates');
    const c10 = check(outcome, 10).evidence.join('\n');
    expect(c10).toContain('Total: 6 folder(s) and 5 other asset(s)');
    expect(c10).toContain('returns only the root level');
    expect(c10).toMatch(/Characters\/ +\(1 subfolder\(s\), 1 file\(s\)\)/);

    // The report: summary table, every check, run statistics; no secret, no signed url; samples within the cap.
    for (let i = 1; i <= 10; i++) expect(text).toContain(`## ${i}. `);
    expect(text).toContain('| 1 | createManyResources nesting');
    expect(text).toContain('## Run statistics');
    expect(text).toContain('**429 responses: 0**');
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain('SECRET-SIGNATURE');
    for (const block of text.split('```text\n').slice(1))
      expect(block.split('```')[0]!.split('\n').length - 1).toBeLessThanOrEqual(40);
    expect(text.split('\n').filter((l) => l.length > 400)).toEqual([]);
    // No 429, and every request counted was LegendKeeper's.
    expect(mock!.stats.genuine429).toBe(0);
  }, 60_000);

  it('check 1 when nesting is refused: reports the error, tries three ordered calls, still deletes the root', async () => {
    const t = await start({ nesting: 'refuse' });
    const outcome = await run(t, { skip: new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]) });
    const c1 = check(outcome, 1);
    expect(c1.verdict).toBe('FAIL');
    const text = c1.evidence.join('\n');
    expect(text).toMatch(/\*\*refused\*\* the batch: HTTP 404 NOT_FOUND/);
    expect(text).toContain('resources[1].parentId');
    expect(text).toContain('Fallback result: **PASS**');
    expect(c1.summary).toMatch(/Three ordered calls: PASS/);
    expect(t.world.writes.filter((w) => w.op === 'createResource')).toHaveLength(4); // root + D, E, F
    expect(t.world.deleted).toHaveLength(4);
    expect(outcome.cleanup.ok).toBe(true);
  }, 30_000);

  it('clean-up after a forced failure: the throwaway root is deleted when check 1 stops with an error', async () => {
    const t = await start({ failChildListing: true });
    const outcome = await run(t); // the other checks still run
    const c1 = check(outcome, 1);
    expect(c1.verdict).toBe('FAIL');
    expect(c1.summary).toMatch(/could not complete/);
    expect(c1.evidence.join('\n')).toContain('Clean-up: deleted (cascade)');
    expect(t.world.deleted.length).toBeGreaterThanOrEqual(4);
    expect([...t.world.resources.values()].some((r) => r.name.startsWith('lk-bridge spike'))).toBe(false);
    expect(outcome.cleanup).toMatchObject({ attempted: true, ok: true });
    expect(outcome.checks).toHaveLength(10);
    expect(check(outcome, 4).verdict).toBe('PASS');
  }, 60_000);

  it('clean-up after a forced failure: a failing fallback create is reported and the root is still deleted', async () => {
    const t = await start({ nesting: 'refuse', failCreateNamed: 'spike E' });
    const outcome = await run(t, { skip: new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]) });
    expect(check(outcome, 1).verdict).toBe('FAIL');
    expect(check(outcome, 1).evidence.join('\n')).toMatch(/Fallback result: \*\*FAIL \(HTTP 500/);
    expect(t.world.resources.has(IDS.root)).toBe(true); // nothing outside the throwaway tree was touched
    expect([...t.world.resources.values()].some((r) => /spike/.test(r.name))).toBe(false);
    expect(outcome.cleanup.ok).toBe(true);
  }, 30_000);

  it('with check 1 skipped the whole run is read-only', async () => {
    const t = await start();
    const outcome = await run(t, { skip: new Set([1]) });
    expect(nonGets()).toHaveLength(0);
    expect(check(outcome, 1)).toMatchObject({ verdict: 'INFO', summary: 'Skipped (--skip).' });
    expect(outcome.cleanup).toMatchObject({ attempted: false });
  }, 60_000);

  it('enforces the write rules in code: nothing outside check 1, nothing outside the throwaway tree', async () => {
    const t = await start();
    const ctx = newSpikeContext(t.target, { guard: guard() });
    await expect(ctx.call('createResource', { body: { name: 'x' } })).rejects.toThrow(/outside check 1/);
    await ctx.openWrites(async () => {
      await expect(
        ctx.call('updateResource', { path: { resourceId: IDS.root }, body: { name: 'x' } }),
      ).rejects.toThrow(/not an allowed operation/);
      await expect(ctx.call('createResource', { body: { name: 'x', parentId: IDS.root } })).rejects.toThrow(
        /not in the throwaway tree/,
      );
      await expect(
        ctx.call('createManyResources', { body: { resources: [{ name: 'x', parentId: IDS.root }] } }),
      ).rejects.toThrow(/not in the throwaway tree/);
      await expect(
        ctx.call(
          'deleteResource',
          { path: { resourceId: IDS.root }, query: { cascade: true } },
          { confirm: 'cascade' },
        ),
      ).rejects.toThrow(/not the throwaway root/);
    });
    expect(nonGets()).toHaveLength(0);
  });

  it('flags a hidden search cap', async () => {
    const t = await start({ searchCap: 30 });
    const outcome = await run(t, { skip: new Set([1, 3, 4, 5, 6, 7, 8, 9, 10]) });
    expect(check(outcome, 2).verdict).toBe('FAIL');
    expect(check(outcome, 2).evidence.join('\n')).toMatch(
      /Possible hidden cap: .*hasMore=true below the limit/,
    );
  }, 30_000);

  it("reports the guard's refusal when the asset host is not allowed (port 443 only, public addresses only)", async () => {
    const t = await start();
    // The bridge's production guard: no extra ports. The test host listens on a random port.
    const byPort = await run(t, { guard: {}, skip: new Set([1, 2, 4, 5, 6, 7, 8, 9, 10]) });
    expect(check(byPort, 3).verdict).toBe('FAIL');
    expect(check(byPort, 3).evidence.join('\n')).toMatch(/guard: REFUSED; result: blocked_port/);
    // The port is allowed but the address is loopback: refused by the address rules.
    const byAddress = await run(t, {
      guard: { allowedPorts: parseOutboundPortAllowlist(`assets.test:${port}`), resolve: guard().resolve! },
      skip: new Set([1, 2, 4, 5, 6, 7, 8, 9, 10]),
    });
    expect(check(byAddress, 3).evidence.join('\n')).toMatch(/guard: REFUSED; result: blocked_address/);
    expect(seen).toHaveLength(0); // nothing was ever connected to
  }, 30_000);

  it('says so when there are no maps and no year-only events', async () => {
    const t = await start({ noYearOnly: true });
    const outcome = await run(t, { skip: new Set([1, 2, 3, 5, 6, 8, 9, 10]) });
    expect(check(outcome, 4).evidence.join('\n')).toMatch(/year-only +→ none found in 45 event\(s\)/);
    expect(check(outcome, 4).evidence.join('\n')).toMatch(/8 more page\(s\)|1 more page\(s\)/);
  }, 30_000);
});

describe('spike v2 helpers', () => {
  it('classifies event precision from detail and end', () => {
    expect(eventShape({ start: 1, detail: 1 })).toBe('year-only');
    expect(eventShape({ start: 1, end: 1, detail: 1 })).toBe('year-only');
    expect(eventShape({ start: 1, end: 9, detail: 1 })).toBe('year-range');
    expect(eventShape({ start: 1, end: 9, detail: 2 })).toBe('month-range');
    expect(eventShape({ start: 1, end: 9 })).toBe('date-range'); // detail absent means day
    expect(eventShape({ start: 1 })).toBe('day');
    expect(eventShape({ start: 1, detail: 4 })).toBe('time');
  });
  it('recognises the date forms of the plan', () => {
    expect(dateForm('Kumikas 1st, 1A 159')).toBe('dated');
    expect(dateForm('4A 881')).toBe('year-only');
    expect(dateForm('Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102')).toBe('date-range');
    expect(dateForm('Kumikas - Azaakh, 4A 180')).toBe('month-range');
    expect(dateForm('Unknown, 4A 101')).toBe('unknown-year');
    expect(dateForm('4A 100 - 4A 102')).toBe('year-range');
  });
  it('knows the sibling order rule and the page kinds', () => {
    const n = (name: string) => ({ name });
    expect(kindOf('[INDEX] Foxians')).toBe('index');
    expect(kindOf('[BSRC] Miyabi')).toBe('bsrc');
    expect(kindOf('Notes')).toBe('unclassified');
    expect(siblingOrderOk([n('[INDEX] B'), n('[INDEX] c'), n('[BSRC] a'), n('Z notes')]).ok).toBe(true);
    expect(siblingOrderOk([n('[BSRC] a'), n('[INDEX] b')]).ok).toBe(false);
    expect(siblingOrderOk([n('[INDEX] b'), n('[INDEX] a')]).firstBreak).toMatch(/position 2/);
  });
  it('caps every fenced sample and says how much was left out', () => {
    const ev = new Evidence(40);
    ev.sample(Array.from({ length: 100 }, (_, i) => `line ${i}`));
    const body = ev.lines.slice(1, -2);
    expect(body).toHaveLength(40);
    expect(body[39]).toBe('… (61 more lines)');
    expect(runLength(['a', 'a', 'b'])).toBe('a×2, b');
  });
});
