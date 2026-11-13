/**
 * The opt-in maps sandbox script (test/sandbox/maps.ts) run against the mock map world: no real LegendKeeper involved
 * (the real run is the owner's: `deploy/sandbox-test.sh --project test -- maps`). It checks that every check runs to an
 * answer, that the script cleans up everything it made, and that the generated PNG is a valid PNG of the size asked.
 * The mock cannot take a signed storage PUT, so the upload step is stood in for: the same bytes are decoded here and
 * put in the asset library at the size their header says.
 */
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatMapsReport, generatePng, runMapsSandbox } from '../sandbox/maps.js';
import { API_KEY, PROJECT } from '../tools/helpers.js';
import { mapsWorld, type MapsWorld } from './world.js';

let w: MapsWorld;
beforeAll(async () => {
  w = await mapsWorld();
});
afterAll(async () => w.close());

/** The PNG's header size and pixel data, with every chunk's CRC checked (a decoder, to prove the generator's output valid). */
function decodePng(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let at = 8;
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  for (;;) {
    const len = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('latin1');
    const data = png.subarray(at + 8, at + 8 + len);
    expect(png.readUInt32BE(at + 8 + len), `${type} crc`).toBe(crc(png.subarray(at + 4, at + 8 + len)));
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9]]).toEqual([8, 2]);
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
    if (type === 'IEND') break;
  }
  return { width, height, raw: inflateSync(Buffer.concat(idat)) };
}

describe('the generated PNG', () => {
  it('is a valid 8-bit RGB PNG of exactly the size asked, and small', () => {
    for (const [wd, ht] of [
      [1500, 700],
      [1024, 1024],
      [1, 1],
      [257, 3],
    ] as const) {
      const png = generatePng(wd, ht);
      const d = decodePng(png);
      expect([d.width, d.height]).toEqual([wd, ht]);
      expect(d.raw.length).toBe(ht * (1 + wd * 3));
    }
    expect(generatePng(1500, 700).length).toBeLessThan(50_000);
  });
});

/**
 * Runs the script against the mock map world. With `hold`, three writes are throttled for 31 s (longer than the
 * governor waits inline), so each is PARKED (`waiting_budget`): a map job's createFeature, a plain updateDocument and the
 * clean-up's first page delete. The script must wait for them (test/sandbox/wait.ts), never send them again, and still
 * leave nothing behind (the owner's sandbox run of 12 November 2026).
 */
async function runScript(hold: boolean) {
  const engine = w.stack.runtime.engine;
  const parked = new Set<string>();
  const off = engine.events.on('job', (e) => {
    if (e.job.status === 'waiting_budget') parked.add(`${e.job.id} ${e.job.title ?? ''}`);
  });
  // D3 keeps an asset's bytes (downloaded from the asset host) before any deleteAsset; the mock has no asset host, so
  // the dry run stands in for that download.
  const offKeeper = engine.setAssetDeleteKeeper(() => Promise.resolve({ keptBytes: 'dry run' }));
  const held = { feature: false, doc: false, cleanup: false };
  const throttle = (match: (c: { method: string; path: string }) => boolean) =>
    w.stack.mock.inject(
      (c) => match({ method: c.method, path: c.path.replace(/\/$/, '') }),
      { kind: 'rate-limit', tier: 'write-min', retryAfterS: 31 },
      1,
    );
  // The upload step stands in for a signed PUT: decode the PNG, put an asset of that size in the library.
  const uploads = new Map<string, { id: string; name: string; width: number; height: number; url: string }>();
  let n = 0;
  const wrapped = new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'submit') {
        return (
          o: { kind: string; dataBase64?: string; name?: string; steps?: { op: string }[] },
          ...rest: unknown[]
        ) => {
          if (hold && !held.feature && o.steps?.some((x) => x.op === 'createFeature')) {
            held.feature = true;
            throttle((c) => c.method === 'POST' && c.path.endsWith('/features'));
          }
          if (o.kind !== 'upload_image') return (target.submit as (...a: unknown[]) => unknown)(o, ...rest);
          const { width, height } = decodePng(Buffer.from(o.dataBase64!, 'base64'));
          const id = w.assets.image(o.name!, null, { width, height });
          const a = w.assets.assets.get(id)!;
          const jobId = `jupload${++n}`;
          uploads.set(jobId, { id, name: o.name!, width, height, url: a.url! });
          return Promise.resolve({ jobId, status: 'queued', eta: 1 });
        };
      }
      if (prop === 'run') {
        return (op: string, ...rest: unknown[]) => {
          if (hold && op === 'updateDocument' && !held.doc) {
            held.doc = true;
            throttle((c) => c.method === 'PATCH' && !c.path.includes('/features'));
          }
          if (hold && op === 'deleteResource' && !held.cleanup) {
            held.cleanup = true;
            throttle((c) => c.method === 'DELETE' && /\/resources\/[^/]+$/.test(c.path));
          }
          return (target.run as (...a: unknown[]) => unknown)(op, ...rest);
        };
      }
      if (prop === 'wait') {
        return (project: string, jobId: string, ms: number) => {
          const u = uploads.get(jobId);
          return u
            ? Promise.resolve({
                id: jobId,
                status: 'succeeded',
                result: { asset: { id: u.id, name: u.name, url: u.url, width: u.width, height: u.height } },
              })
            : (target.wait as (...a: unknown[]) => unknown)(project, jobId, ms);
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const done = w.mark();
  try {
    const { findings, assets } = await runMapsSandbox(
      {
        engine: wrapped,
        lk: w.stack.runtime.projects.client(PROJECT)!,
        projectId: PROJECT,
        baseUrl: w.stack.mock.url,
        apiKey: API_KEY,
      },
      PROJECT,
      { sleep: () => Promise.resolve(), linkWaitMs: 0, wait: hold ? { waitMs: 5_000, maxWaits: 30 } : {} },
    );
    return { findings, assets, parked, cost: done(), held };
  } finally {
    off();
    offKeeper();
  }
}

describe('the maps sandbox script, dry run', () => {
  let scriptRuns = 0;
  const IDS = [
    'M1',
    'M2',
    'M3',
    'M4a',
    'M4b',
    'M4c',
    'M4d',
    'M4e',
    'M4f',
    'M5a',
    'M5b',
    'M5c',
    'M6a',
    'M6b',
    'M6c',
    'M6d',
    'M7a',
    'M7b',
    'M8',
    'cleanup',
  ];
  const expectClean = (r: Awaited<ReturnType<typeof runScript>>) => {
    const report = formatMapsReport(r.findings);
    process.stdout.write(`${report}requests on the mock: ${r.cost.reads} reads, ${r.cost.writes} writes\n`);
    // Every check ran to an answer: none is skipped, none could not complete.
    for (const id of IDS) {
      const f = r.findings.find((x) => x.id === id);
      expect(f, `${id} is reported`).toBeDefined();
      expect(f!.verdict, `${id}: ${f!.detail}`).toBe('pass');
    }
    expect(r.findings.map((f) => f.verdict)).not.toContain('skipped');
    // The null probe of M6c is a noted fact about LegendKeeper (the model refuses it as the real API did), not a failure.
    const nullProbe = r.findings.find((x) => x.id === 'M6c-null');
    expect(nullProbe, 'M6c-null is reported').toBeDefined();
    expect(nullProbe!.verdict, nullProbe!.detail).toBe('noted');
    expect(nullProbe!.detail).toContain('parentId: Expected string, received null');
    expect(r.findings.map((f) => f.verdict)).not.toContain('fail');
    // The bridge's own moves sent "" and never null: the probe is the only null, once per run, and wrote nothing.
    scriptRuns++;
    const nulls = w.sent.filter((c) => c.method === 'PATCH' && c.body.parentId === null);
    expect(nulls).toHaveLength(scriptRuns);
    expect(w.sent.some((c) => c.method === 'PATCH' && c.body.parentId === '')).toBe(true);
    // Cleaned up: the throwaway pages and both uploaded images are gone.
    expect(r.assets).toHaveLength(2);
    for (const a of r.assets) expect(w.assets.assets.has(a), `asset ${a}`).toBe(false);
    expect(
      [...w.repo.res.values()].filter((x) => x.name.startsWith('lk-bridge maps') && x.deletedAt === null),
    ).toEqual([]);
  };

  // A run cut short by Vitest's default 5 s would go on into the next test and park its writes there.
  it('runs every check to an answer, writes through the tools’ own jobs, and cleans up everything it made', async () => {
    expectClean(await runScript(false));
  }, 60_000);

  it('waits for writes parked for budget (a map job, a document write, the clean-up) and sends none twice', async () => {
    const writesBefore = w.sent.length;
    const r = await runScript(true);
    expect(r.held).toEqual({ feature: true, doc: true, cleanup: true });
    expect([...r.parked], 'jobs parked for budget').toHaveLength(3);
    expectClean(r);
    // None of the held writes was sent again once it ran: one createFeature per feature the script made, no duplicates.
    const features = w.sent
      .slice(writesBefore)
      .filter((s) => s.method === 'POST' && s.path.endsWith('/features'));
    const ids = features.map((s) => s.body.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 300_000);
});
