/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v2 D2 (ADR 0040), opt-in: the map-feature layer checked on a REAL sandbox project (see test/sandbox/README.md, "The
 * maps (v2 D2)"). PLAN-v2 says D2 makes its own test map; with the hard rule against live systems that is this test, which
 * the owner runs (`deploy/sandbox-test.sh --project test -- maps`). It WRITES, then cleans up.
 *
 * It creates ONE throwaway page, `lk-bridge maps <time>` (a plain name: no `[BSRC]`, `[BWRK]`, `[BARC]` or `[INDEX]`
 * prefix and no Status, so the canon and lifecycle guards never stand in the way), with its first, blank document, a
 * second throwaway page to link to, and two generated PNGs (1500×700, then 1024×1024). The writes are the jobs the tools
 * submit (src/maps/jobs.ts: the check inside the lock, the write with its body bound from the check, the verify), planned
 * by the same functions (src/maps/plan.ts), because the sandbox runtime has no repository tree to call the tools with.
 * Everything is cleaned up at the end, even after a failure; a 404 or "already deleted" counts as cleaned (C2d's rule).
 *
 * Each check prints PASS, FAIL or INCONCLUSIVE with what LegendKeeper answered, as the assumptions test does. A FAIL is a
 * place where LegendKeeper differs from what the bridge relies on (docs/adr/0040-map-feature-tools.md, "To verify").
 */
import { deflateSync } from 'node:zlib';
import { mintClientId } from '../../src/jobs/ids.js';
import {
  appBounds,
  buildCreate,
  buildUpdate,
  createJob,
  deleteJob,
  featureHash,
  frameOfState,
  frameState,
  idOf,
  mapState,
  planDelete,
  posToPixel,
  storedGeometry,
  updateJob,
  zoomOf,
  type CreateRequest,
  type MapFrame,
  type MapJob,
  type MapState,
  type UpdateRequest,
} from '../../src/maps/index.js';
import { BridgeLkError, BudgetWaitError } from '../../src/lk/errors.js';
import { SandboxGuardError, type Finding, type SmokeTarget, type Verdict } from './smoke.js';
import { runSettled, waitForJob, type WaitOptions } from './wait.js';

type Obj = Record<string, any>;

export interface MapsOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long a write parked for budget or queued is waited for (test/sandbox/wait.ts; the defaults are 24 × 25 s). */
  readonly wait?: WaitOptions;
  /** How long a freshly created page may take to become linkable (default 8 tries, 4 s apart). */
  readonly linkTries?: number;
  readonly linkWaitMs?: number;
}

/** Thrown inside a check: the assumption does not hold (a FAIL with this message). */
class Fails extends Error {}
/** Thrown inside a check: it could not tell (INCONCLUSIVE with this message). */
class Unclear extends Error {}
const fail = (m: string): never => {
  throw new Fails(m);
};

// ------------------------------------------------------------------------------------------------ a generated PNG

const CRC_TABLE = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/**
 * A valid 8-bit RGB PNG of exactly `width`×`height` pixels (no image library: a header, one deflated image chunk, an
 * end chunk). Its rows are identical (a colour ramp across, a frame of dark pixels at the left and top edges), so it
 * compresses to a few kilobytes whatever its size.
 */
export function generatePng(width: number, height: number): Buffer {
  const row = Buffer.alloc(1 + width * 3); // filter type 0, then the pixels
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = Math.round((x / Math.max(1, width - 1)) * 255);
    row[2 + x * 3] = 128;
    row[3 + x * 3] = 255 - Math.round((x / Math.max(1, width - 1)) * 255);
  }
  const top = Buffer.alloc(1 + width * 3); // the first row all dark
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => (y === 0 ? top : row)));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------------------------------------ the schema's text

/** The conversion exactly as the schema states it, written out apart from the bridge's. */
const schemaPos = (f: MapFrame, x: number, y: number): [number, number] => {
  const [[south, west], [north, east]] = f.bounds;
  return [north - (y * (north - south)) / f.height, west + (x * (east - west)) / f.width];
};
const near = (a: number, b: number, eps = 1e-6) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const nearPair = (a: readonly number[], b: readonly number[], eps?: number) =>
  a.length === 2 && b.length === 2 && near(a[0]!, b[0]!, eps) && near(a[1]!, b[1]!, eps);

export interface MapsReport {
  readonly findings: Finding[];
  /** Assets this run uploaded (cleaned up before it returns). */
  readonly assets: string[];
}

export async function runMapsSandbox(
  t: SmokeTarget,
  expectedProjectId: string,
  o: MapsOptions = {},
): Promise<MapsReport> {
  const findings: Finding[] = [];
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const origin = { kind: 'test' as const, client: 'sandbox-maps', tool: 'sandbox-maps' };
  const record = (id: string, title: string, verdict: Verdict, detail: string) =>
    findings.push({ id, title, verdict, detail });

  /**
   * One governed call at P1, settled (test/sandbox/wait.ts): a read refused for budget is made again when the budget
   * allows; a write the governor PARKS for budget (`waiting_budget`) or queues behind the pacing has not failed, and is
   * waited for, never sent again. Every write of this script, the clean-up's too, goes through here or `settle`.
   */
  const wait: WaitOptions = { ...(o.sleep ? { sleep: o.sleep } : {}), ...o.wait };
  const run = async (op: string, params: Obj = {}, extra: Obj = {}): Promise<any> =>
    runSettled(t, op, params, { origin, priority: 'P1', project: t.projectId, ...extra }, wait);
  /** A submitted job (a map job or an upload), waited for the same way; the job when it succeeded. */
  const settle = async (jobId: string, what: string) => {
    try {
      return await waitForJob(t.engine, t.projectId, jobId, what, wait);
    } catch (e) {
      const err = (t.engine.queries.getJob(t.projectId, jobId)?.lastError ?? {}) as Obj;
      throw new Error(
        `${(e as Error).message} ${err.differences ? JSON.stringify(err.differences).slice(0, 300) : ''}`.trim(),
        { cause: e },
      );
    }
  };
  /** A call whose refusal is an answer: `{ status, code, message }` from LegendKeeper, or `{ status: 200, body }`. */
  const attempt = async (op: string, params: Obj = {}, extra: Obj = {}) => {
    try {
      return { ok: true as const, body: await run(op, params, extra) };
    } catch (e) {
      return { ok: false as const, error: e as Error };
    }
  };
  const p = (path: Obj, rest: Obj = {}) => ({ path, ...rest });
  /**
   * One RAW `updateFeature` through the governor, with a body the bridge's own validation would refuse before sending
   * (`parentId: null`): the answer LegendKeeper itself gives, `{ status, code, issues }`. A write the governor parks for
   * budget is made again once it allows (nothing was sent when it was parked).
   */
  const rawUpdateFeature = async (
    featureId: string,
    body: Obj,
  ): Promise<{ status: number; code?: string; issues: string[] }> => {
    for (let tries = 0; ; tries++) {
      try {
        const res = await t.lk.call<Response>({
          operationId: 'updateFeature',
          priority: 'P1',
          input: { body },
          run: () =>
            t.lk.fetch(
              `${t.baseUrl}/api/v3/projects/${t.projectId}/resources/${rootId}/docs/${mapDoc}/features/${featureId}`,
              {
                method: 'PATCH',
                headers: { authorization: `Bearer ${t.apiKey}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
              },
            ),
        });
        return { status: res.status, issues: [] };
      } catch (e) {
        if (e instanceof BudgetWaitError && tries < 5) {
          await sleep(Math.max(1000, e.retryAtMs - Date.now()));
          continue;
        }
        if (e instanceof BridgeLkError)
          return {
            status: e.status ?? 0,
            ...(e.code ? { code: e.code } : {}),
            issues: e.errors.map((i) => `${i.path}: ${i.message}`),
          };
        throw e;
      }
    }
  };

  // ---- guard: the key must belong to exactly the sandbox project --------------------------------------------------
  const projects = (await run('listProjects')) as { data?: { id: string }[] };
  const ids = (projects.data ?? []).map((x) => x.id);
  if (ids.length !== 1 || ids[0] !== expectedProjectId || t.projectId !== expectedProjectId) {
    throw new SandboxGuardError(
      `Refusing to run: the key's project is [${ids.join(', ')}], not the sandbox project ${expectedProjectId}.`,
    );
  }

  // ---- what it creates --------------------------------------------------------------------------------------------
  const stamp = new Date().toISOString();
  const root = (await run('createResource', { body: { name: `lk-bridge maps ${stamp}` } })) as Obj;
  const rootId = root.id as string;
  const mapDoc = root.documents[0].id as string; // the page's first document is `blank`
  const target = (await run('createResource', {
    body: { name: `lk-bridge maps link target ${stamp}`, parentId: rootId },
  })) as Obj;
  const assets: string[] = [];
  const path = { resourceId: rootId, documentId: mapDoc };
  const where = {
    tool: 'sandbox-maps',
    resourceId: rootId,
    documentId: mapDoc,
    page: { id: rootId, name: root.name as string },
    document: { id: mapDoc, name: 'Main' },
  };

  const check = async (id: string, title: string, fn: () => Promise<string> | string) => {
    try {
      record(id, title, 'pass', await fn());
    } catch (e) {
      if (e instanceof Fails) record(id, title, 'fail', e.message);
      else if (e instanceof Unclear) record(id, title, 'inconclusive', e.message);
      else record(id, title, 'inconclusive', `the check could not complete: ${(e as Error).message}`);
    }
  };
  /** The map as the tools read it: its settings (image frame) and every feature. */
  const state = async (): Promise<MapState> =>
    mapState(
      await run('getDocument', p({ resourceId: rootId, documentId: mapDoc })),
      (await run('listFeatures', p(path))).data,
    );
  const features = async (): Promise<Obj[]> => (await run('listFeatures', p(path))).data as Obj[];
  const feature = async (id: string): Promise<Obj> =>
    (await run('getFeature', p({ ...path, featureId: id }))) as Obj;

  /** Submits a map job as a tool would, waits for it, and answers the job (it failed: the reason, with the differences). */
  const submit = async (job: MapJob, title: string) => {
    const r = await t.engine.submit({
      kind: 'batch_ops',
      project: t.projectId,
      steps: job.steps,
      onError: 'stop',
      priority: 'P1',
      origin,
      title,
      holdDocuments: job.holdDocuments,
      internal: true,
    });
    if (!('jobId' in r)) throw new Error(`${title}: not queued (${JSON.stringify(r).slice(0, 200)})`);
    const view = await settle(r.jobId, title);
    const res = (view.result ?? {}) as Obj;
    if (res.verified === false)
      throw new Error(
        `${title}: written but not as planned: ${JSON.stringify(res.verification?.differences ?? res.verification).slice(0, 400)}`,
      );
    return view;
  };
  const create = async (req: Partial<CreateRequest> & Pick<CreateRequest, 'type' | 'name'>) => {
    const st = await state();
    const request: CreateRequest = {
      id: mintClientId(24),
      geometry: null,
      allowOutside: false,
      frame: req.geometry?.system === 'pixel' ? frameOfState(st.frame) : null,
      parentId: null,
      placement: { at: 'end' },
      style: {},
      ...req,
    };
    const built = buildCreate(st, request);
    if (!built.ok) throw new Error(`${built.code}: ${built.message}`);
    const view = await submit(createJob(where, request, built), `create ${request.type} ${request.name}`);
    return { id: request.id, view, sent: built.body };
  };
  const update = async (id: string, req: Partial<UpdateRequest>) => {
    const st = await state();
    const cur = st.features.find((f) => idOf(f) === id)!;
    const request: UpdateRequest = {
      featureId: id,
      expectedHash: featureHash(cur),
      allowOutside: false,
      frame: req.geometry?.system === 'pixel' ? frameOfState(st.frame) : null,
      style: {},
      ...req,
    };
    const built = buildUpdate(st, request);
    if (!built.ok) throw new Error(`${built.code}: ${built.message}`);
    if (built.noChange) throw new Error('nothing to change');
    const view = await submit(updateJob(where, cur, request, built), `update ${id}`);
    return { view, sent: built.body };
  };

  // =============================================================================================== the checks
  let png1500 = null as { id: string; url: string } | null;
  let frame = null as MapFrame | null;

  try {
    // ---- M1: a generated PNG of an awkward size uploads through the existing path ---------------------------------
    await check('M1', 'a generated 1500×700 PNG uploads, and LegendKeeper reports its size', async () => {
      const bytes = generatePng(1500, 700);
      const r = await t.engine.submit({
        project: t.projectId,
        kind: 'upload_image',
        contentType: 'image/png',
        contentLength: bytes.length,
        dataBase64: bytes.toString('base64'),
        name: `lk-bridge maps ${stamp} 1500x700`,
        origin,
        priority: 'P1',
      });
      if (!('jobId' in r)) throw new Unclear(`not queued: ${r.status}`);
      const job = await settle(r.jobId, 'the upload').catch((e: Error) => {
        throw new Unclear(e.message);
      });
      const asset = (job.result as Obj).asset as Obj;
      assets.push(asset.id);
      png1500 = { id: asset.id, url: asset.url };
      if (asset.width !== 1500 || asset.height !== 700)
        fail(
          `the asset is ${asset.width}×${asset.height}, not 1500×700 (LegendKeeper may have processed the image)`,
        );
      return `asset ${asset.id}, ${asset.width}×${asset.height}, ${bytes.length} bytes`;
    });
    if (!png1500) {
      for (const [id, title] of [
        ['M2', 'a blank document becomes a map when given the image; MapImage reads back its frame'],
        ['M3', 'the app’s zoom formula gives the bounds LegendKeeper reports'],
        ['M4', 'a feature of every type, by pixel position, is stored where the formula says'],
        ['M5', 'a link, a folder with a nested pin, a move into the folder, a cascade delete'],
      ] as const)
        record(id, title, 'skipped', 'needs the uploaded image (M1)');
    } else {
      const image = png1500;

      // ---- M2: setting the image ----------------------------------------------------------------------------------
      await check(
        'M2',
        'a blank document becomes a map when given the image; MapImage reads back its frame',
        async () => {
          const before = (await run('getDocument', p({ resourceId: rootId, documentId: mapDoc }))) as Obj;
          if (before.type !== 'blank')
            throw new Unclear(`the page's first document is ${before.type}, not blank`);
          await run(
            'updateDocument',
            p({ resourceId: rootId, documentId: mapDoc }, { body: { mapImage: { assetId: image.id } } }),
          );
          const doc = (await run('getDocument', p({ resourceId: rootId, documentId: mapDoc }))) as Obj;
          if (doc.type !== 'map') fail(`the document is ${doc.type} after the image was set, not map`);
          const mi: Obj | null = doc.mapImage;
          if (!mi) fail('getDocument has no mapImage after the image was set');
          const st = frameState(mi);
          if (st.kind !== 'image') fail(`the frame state is ${st.kind}: ${JSON.stringify(mi)}`);
          frame = (st as { frame: MapFrame }).frame;
          if (mi!.width !== 1500 || mi!.height !== 700) fail(`mapImage is ${mi!.width}×${mi!.height}`);
          if (mi!.assetId !== image.id) fail(`mapImage.assetId is ${mi!.assetId}, not ${image.id}`);
          return `blank → map; ${mi!.width}×${mi!.height}, bounds ${JSON.stringify(mi!.bounds)}, assetId ${mi!.assetId}, url ${mi!.url ? 'present' : 'null'}`;
        },
      );

      // ---- M3: the app's own zoom formula -------------------------------------------------------------------------
      await check('M3', 'the app’s zoom formula gives the bounds LegendKeeper reports', () => {
        if (!frame) throw new Unclear('no frame was read (M2)');
        const f = frame;
        const want = appBounds(f.width, f.height);
        const z = zoomOf(f.width, f.height);
        const ok = nearPair(f.bounds[0], want[0]) && nearPair(f.bounds[1], want[1]);
        if (!ok)
          fail(
            `z = ceil(log2(max(${f.width}, ${f.height}) / 256)) = ${z}, so [[-${f.height} / 2^z, 0], [0, ${f.width} / 2^z]] = ${JSON.stringify(want)}; LegendKeeper reports ${JSON.stringify(f.bounds)}`,
          );
        return `z = ${z}: bounds ${JSON.stringify(f.bounds)} equal [[-h / 2^z, 0], [0, w / 2^z]]`;
      });

      // ---- M4: every type, by pixel position ----------------------------------------------------------------------
      const made: Record<string, string> = {};
      const stored = (id: string) => feature(id);
      const needFrame = () => {
        if (!frame) throw new Unclear('no frame was read (M2)');
        return frame;
      };
      await check(
        'M4a',
        'a pin by pixel position is stored at the formula’s lat/lng, and reads back as the same pixel',
        async () => {
          const f = needFrame();
          const c = await create({
            type: 'pin',
            name: 'Pin',
            geometry: { system: 'pixel', shape: 'point', point: { x: 1000, y: 300 } },
          });
          made.pin = c.id;
          const s = await stored(c.id);
          const want = schemaPos(f, 1000, 300);
          if (!s.pos || !nearPair(s.pos, want))
            fail(`stored pos ${JSON.stringify(s.pos)}, the formula says ${JSON.stringify(want)}`);
          const back = posToPixel(f, s.pos);
          if (!near(back.x, 1000) || !near(back.y, 300))
            fail(`the stored pos reads back as pixel (${back.x}, ${back.y}), not (1000, 300)`);
          return `pos ${JSON.stringify(s.pos)} = formula ${JSON.stringify(want)}; back to (${back.x.toFixed(4)}, ${back.y.toFixed(4)}); ${JSON.stringify(c.view.result?.verified)} verified by the job`;
        },
      );
      await check('M4b', 'a label by pixel position', async () => {
        const f = needFrame();
        const c = await create({
          type: 'label',
          name: 'Label',
          geometry: { system: 'pixel', shape: 'point', point: { x: 0, y: 0 } },
        });
        made.label = c.id;
        const s = await stored(c.id);
        if (!s.pos || !nearPair(s.pos, schemaPos(f, 0, 0)))
          fail(
            `stored pos ${JSON.stringify(s.pos)} for the top-left pixel, expected ${JSON.stringify(schemaPos(f, 0, 0))} ([0, 0])`,
          );
        return `top-left pixel stored as ${JSON.stringify(s.pos)}`;
      });
      await check('M4c', 'a region (one polygon) by pixel points', async () => {
        const f = needFrame();
        const pts = [
          { x: 100, y: 100 },
          { x: 700, y: 100 },
          { x: 700, y: 500 },
          { x: 100, y: 500 },
        ];
        const c = await create({
          type: 'region',
          name: 'Region',
          geometry: { system: 'pixel', shape: 'points', points: pts },
          style: { color: '#336699', fillOpacity: 0.4, fillStyle: 'striped' },
        });
        made.region = c.id;
        const g = storedGeometry(await stored(c.id));
        const want = pts.map((q) => schemaPos(f, q.x, q.y));
        if (!g.polygons || g.polygons.length !== 1 || !g.polygons[0]!.every((v, i) => nearPair(v, want[i]!)))
          fail(`stored polygons ${JSON.stringify(g.polygons)}, the formula says ${JSON.stringify([want])}`);
        return `4 points stored at the formula's lat/lng (as ${(await stored(c.id)).polygon ? '`polygon`' : '`polygons`'})`;
      });
      await check('M4d', 'a region of several polygons by pixel points', async () => {
        const f = needFrame();
        const a = [
          { x: 10, y: 10 },
          { x: 90, y: 10 },
          { x: 90, y: 90 },
        ];
        const b = [
          { x: 1000, y: 400 },
          { x: 1100, y: 400 },
          { x: 1100, y: 500 },
          { x: 1000, y: 500 },
        ];
        const c = await create({
          type: 'region',
          name: 'Islands',
          geometry: { system: 'pixel', shape: 'polygons', polygons: [a, b] },
        });
        made.islands = c.id;
        const g = storedGeometry(await stored(c.id));
        const want = [a, b].map((poly) => poly.map((q) => schemaPos(f, q.x, q.y)));
        if (
          !g.polygons ||
          g.polygons.length !== 2 ||
          !g.polygons.every((poly, i) => poly.every((v, j) => nearPair(v, want[i]![j]!)))
        )
          fail(`stored polygons ${JSON.stringify(g.polygons)}, the formula says ${JSON.stringify(want)}`);
        return '2 polygons (3 and 4 points) stored at the formula’s lat/lng';
      });
      await check('M4e', 'a path by pixel points', async () => {
        const f = needFrame();
        const pts = [
          { x: 50, y: 650 },
          { x: 400, y: 400 },
          { x: 900, y: 450 },
          { x: 1450, y: 50 },
        ];
        const c = await create({
          type: 'path',
          name: 'Path',
          geometry: { system: 'pixel', shape: 'points', points: pts },
          style: { strokeWidth: 3, strokeStyle: 'dashed', color: '#aa5500' },
        });
        made.path = c.id;
        const s = await stored(c.id);
        const want = pts.map((q) => schemaPos(f, q.x, q.y));
        if (!s.polyline || !s.polyline.every((v: number[], i: number) => nearPair(v, want[i]!)))
          fail(`stored polyline ${JSON.stringify(s.polyline)}, the formula says ${JSON.stringify(want)}`);
        return '4 points stored at the formula’s lat/lng';
      });
      await check('M4f', 'a folder (no coordinates)', async () => {
        const c = await create({ type: 'folder', name: 'Folder' });
        made.folder = c.id;
        const s = await stored(c.id);
        if (s.type !== 'folder') fail(`stored type ${s.type}`);
        return `folder ${c.id}${s.pos ? ` (LegendKeeper gave it pos ${JSON.stringify(s.pos)})` : ' with no pos'}`;
      });

      // ---- M5: links ----------------------------------------------------------------------------------------------
      /** A create with a link: a page just created in LegendKeeper can take a few seconds to become linkable. */
      const withLink = async (name: string, uri: string) => {
        let last = '';
        for (let i = 0; i < (o.linkTries ?? 8); i++) {
          try {
            return await create({
              type: 'pin',
              name,
              geometry: { system: 'pixel', shape: 'point', point: { x: 750, y: 350 } },
              uri,
            });
          } catch (e) {
            last = (e as Error).message;
            if (!/uri|VALIDATION|linkable|link/i.test(last)) throw e;
            await sleep(o.linkWaitMs ?? 4000);
          }
        }
        throw new Unclear(`LegendKeeper refused the link ${uri} after ${o.linkTries ?? 8} tries: ${last}`);
      };
      await check('M5a', 'a link to the throwaway page is stored as sent', async () => {
        const uri = `lk://resources/${target.id}`;
        const c = await withLink('Linked pin', uri);
        made.linked = c.id;
        const s = await stored(c.id);
        if (s.uri !== uri) fail(`stored uri ${JSON.stringify(s.uri)}, sent ${uri}`);
        return `uri ${s.uri}`;
      });
      await check(
        'M5b',
        'a link to one document of a page (lk://resources/<id>/docs/<documentId>) is stored as sent',
        async () => {
          const doc = target.documents[0].id as string;
          const uri = `lk://resources/${target.id}/docs/${doc}`;
          const c = await withLink('Linked doc pin', uri);
          const s = await stored(c.id);
          if (s.uri !== uri) fail(`stored uri ${JSON.stringify(s.uri)}, sent ${uri}`);
          return `uri ${s.uri}`;
        },
      );
      await check('M5c', 'a link is cleared with an empty uri', async () => {
        if (!made.linked) throw new Unclear('no linked pin (M5a)');
        await update(made.linked, { uri: '' });
        const s = await stored(made.linked);
        if (s.uri !== undefined && s.uri !== null && s.uri !== '')
          fail(`the link is still ${JSON.stringify(s.uri)}`);
        return `uri is now ${JSON.stringify(s.uri ?? null)}`;
      });

      // ---- M6: folders, ranks and moves ---------------------------------------------------------------------------
      await check(
        'M6a',
        'a pin nested in a folder; the stored rank is the one sent, and placement after a sibling sorts between its neighbours',
        async () => {
          if (!made.folder) throw new Unclear('no folder (M4f)');
          const mk = (name: string, x: number) => ({
            type: 'pin' as const,
            name,
            parentId: made.folder!,
            geometry: { system: 'pixel' as const, shape: 'point' as const, point: { x, y: 600 } },
          });
          const a = await create(mk('Nested A', 100));
          const b = await create(mk('Nested B', 200));
          const c = await create({ ...mk('Nested C', 300), placement: { at: 'after', siblingId: a.id } });
          made.nestedA = a.id;
          const [sa, sb, sc] = [await stored(a.id), await stored(b.id), await stored(c.id)];
          if (sa.parentId !== made.folder)
            fail(`the nested pin's parentId is ${JSON.stringify(sa.parentId)}, not the folder`);
          for (const [x, sent, got] of [
            ['A', a.sent.rank, sa.rank],
            ['B', b.sent.rank, sb.rank],
            ['C', c.sent.rank, sc.rank],
          ] as const)
            if (sent !== got)
              fail(
                `LegendKeeper stored rank ${JSON.stringify(got)} for ${x}, the bridge sent ${JSON.stringify(sent)}`,
              );
          if (!(sa.rank < sc.rank && sc.rank < sb.rank))
            fail(`ranks A ${sa.rank}, C ${sc.rank}, B ${sb.rank}: C is not between A and B`);
          // and the order the listing gives is the rank order
          const inFolder = (await features()).filter((f) => f.parentId === made.folder).map((f) => f.name);
          return `ranks kept as sent (A ${sa.rank} < C ${sc.rank} < B ${sb.rank}); listing order ${JSON.stringify(inFolder)}`;
        },
      );
      await check('M6b', 'an update moves a pin into the folder (end of it)', async () => {
        if (!made.folder || !made.pin) throw new Unclear('no folder or pin');
        await update(made.pin, { parentId: made.folder });
        const s = await stored(made.pin);
        if (s.parentId !== made.folder)
          fail(`the pin's parentId is ${JSON.stringify(s.parentId)} after the move`);
        const sibs = (await features()).filter((f) => f.parentId === made.folder);
        const last = sibs.sort((x, y) => (String(x.rank) < String(y.rank) ? -1 : 1)).at(-1)!;
        if (last.id !== made.pin) fail(`the moved pin is not last in the folder (last: ${last.name})`);
        return `pin now in the folder, last by rank (${s.rank})`;
      });
      await check(
        'M6c',
        'a move to the top level: parentId "" works (with a rank between two siblings), and reads back as the top level',
        async () => {
          if (!made.pin) throw new Unclear('no pin');
          // The owner's probe of 12 November 2026: LegendKeeper moves a feature to the top level with `parentId: ""`.
          // The bridge's own move sends exactly that (buildUpdate), so this goes through the tools' job.
          let sent: Obj;
          try {
            ({ sent } = await update(made.pin, { parentId: null }));
          } catch (e) {
            fail(
              `LegendKeeper refused the move to the top level: ${(e as Error).message}. update_map_feature's \`folder: null\` fails (docs/adr/0040-map-feature-tools.md, decision 9).`,
            );
          }
          if (sent!.parentId !== '')
            fail(`the bridge sent parentId ${JSON.stringify(sent!.parentId)}, not ""`);
          const s = await stored(made.pin);
          if (s.parentId !== undefined && s.parentId !== null && s.parentId !== '')
            fail(`the pin's parentId is still ${JSON.stringify(s.parentId)} after parentId: ""`);
          // A midpoint rank between two top-level siblings is accepted on a move (base-62, "a1V" between "a1" and "a2").
          const top = (await features())
            .filter((f) => f.id !== made.pin && !(typeof f.parentId === 'string' && f.parentId !== ''))
            .filter((f) => typeof f.rank === 'string')
            .sort((x, y) => (String(x.rank) < String(y.rank) ? -1 : 1));
          let midpoint = '';
          if (top.length >= 2 && made.folder) {
            await update(made.pin, { parentId: made.folder, placement: { at: 'end' } });
            const a = top[0]!;
            const b = top[1]!;
            await update(made.pin, { parentId: null, placement: { at: 'after', siblingId: a.id as string } });
            const m = await stored(made.pin);
            if (!(String(m.rank) > String(a.rank) && String(m.rank) < String(b.rank)))
              fail(
                `after "${a.name}" the pin's rank is ${m.rank}, which is not between ${a.rank} and ${b.rank}`,
              );
            midpoint = `; a move after “${a.name}” took the midpoint rank ${m.rank} (between ${a.rank} and ${b.rank})`;
          }
          const sibs = (await features()).filter(
            (f) => !(typeof f.parentId === 'string' && f.parentId !== ''),
          );
          if (!sibs.some((f) => f.id === made.pin)) fail('the pin is not among the top-level features');
          return `pin at the top level (parentId ${JSON.stringify(s.parentId ?? null)} on the read; the bridge sent ""), rank ${s.rank}${midpoint}`;
        },
      );
      // The other half of the probe, recorded as a NOTED fact about LegendKeeper (never a failure of the bridge): the
      // schema says "(null = root)" but types parentId as a string, and LegendKeeper enforces the type.
      try {
        if (!made.pin) throw new Unclear('no pin');
        // The governor's own validation (the registry's) refuses null before it is sent, so this is a raw governed call.
        const r = await rawUpdateFeature(made.pin, { parentId: null });
        const title =
          'parentId null on updateFeature is refused by LegendKeeper (the owner’s probe of 12 November 2026)';
        if (r.status >= 200 && r.status < 300) {
          record(
            'M6c-null',
            title,
            'inconclusive',
            'LegendKeeper ACCEPTED parentId null this time; the probe of 12 November 2026 was refused (400, parentId: "Expected string, received null"). The bridge sends "" either way, so nothing needs changing; tell the maintainer.',
          );
        } else {
          const refused = r.status === 400 && r.code === 'VALIDATION_ERROR';
          record(
            'M6c-null',
            title,
            refused ? 'noted' : 'inconclusive',
            refused
              ? `NOTED: LegendKeeper answers 400 VALIDATION_ERROR (${r.issues.join('; ') || 'no issue listed'}); nothing was written. The schema's “(null = root)” is wrong: its type is a string. The bridge sends "" to move to the top level (M6c).`
              : `answered ${r.status} ${r.code ?? ''} ${r.issues.join('; ')}`.trim(),
          );
        }
      } catch (e) {
        record(
          'M6c-null',
          'parentId null on updateFeature is refused by LegendKeeper (the owner’s probe of 12 November 2026)',
          'inconclusive',
          e instanceof Unclear ? e.message : `the check could not complete: ${(e as Error).message}`,
        );
      }
      await check(
        'M6d',
        'a region’s geometry is replaced by several polygons (stored as polygons, with no stale polygon)',
        async () => {
          if (!made.region) throw new Unclear('no region (M4c)');
          const f = needFrame();
          const a = [
            { x: 10, y: 10 },
            { x: 60, y: 10 },
            { x: 60, y: 60 },
          ];
          const b = [
            { x: 200, y: 200 },
            { x: 260, y: 200 },
            { x: 260, y: 260 },
          ];
          await update(made.region, { geometry: { system: 'pixel', shape: 'polygons', polygons: [a, b] } });
          const s = await stored(made.region);
          const g = storedGeometry(s);
          const want = [a, b].map((poly) => poly.map((q) => schemaPos(f, q.x, q.y)));
          if (
            !g.polygons ||
            g.polygons.length !== 2 ||
            !g.polygons.every((poly, i) => poly.every((v, j) => nearPair(v, want[i]![j]!)))
          )
            fail(
              `stored polygon ${JSON.stringify(s.polygon)} / polygons ${JSON.stringify(s.polygons)}, expected two polygons`,
            );
          // v2 E4 (backlog 4): the bridge writes one consistent form: a region that still carries a `polygon` gets it set to
          // the first of its new polygons, so the two never show different shapes. A stale OLD shape is still a finding.
          if (Array.isArray(s.polygon) && s.polygon.length > 0) {
            const first = want[0]!;
            const mirrored =
              s.polygon.length === first.length &&
              (s.polygon as unknown[]).every(
                (v, j) => Array.isArray(v) && nearPair(v as number[], first[j]!),
              );
            if (!mirrored)
              throw new Unclear(
                `two polygons were stored in \`polygons\`, but the old \`polygon\` (${s.polygon.length} points) is still there: LegendKeeper keeps both, and which one the app draws is not known. Look at the region in the app.`,
              );
            return 'two polygons stored in `polygons`; `polygon` holds the first of them (the bridge’s one consistent form), not the old shape';
          }
          return 'two polygons stored in `polygons`; the old `polygon` is gone';
        },
      );

      // ---- M6e (v2 E4, backlog 4): can a region's `polygon` be cleared, and how? Three tries on throwaway regions, each
      // written RAW (bodies the bridge itself does not send): `polygon: null`, `polygon: []`, and `polygons` alone. What
      // LegendKeeper accepts, and what reads back, is recorded (NOTED); it decides which form the bridge writes.
      const m6eTitle =
        'how a region’s single `polygon` can be cleared when it is given `polygons` (null, [], or left out)';
      await (async () => {
        try {
          const f = needFrame();
          const tri = (dx: number) => [
            { x: 10 + dx, y: 10 },
            { x: 60 + dx, y: 10 },
            { x: 60 + dx, y: 60 },
          ];
          const ll = (pts: { x: number; y: number }[]) => pts.map((q) => schemaPos(f, q.x, q.y));
          const results: string[] = [];
          for (const [label, extra] of [
            ['polygon: null', { polygon: null }],
            ['polygon: []', { polygon: [] }],
            ['polygons alone', {}],
          ] as const) {
            const c = await create({
              type: 'region',
              name: `M6e ${label}`,
              geometry: { system: 'pixel', shape: 'points', points: tri(0) },
            });
            const r = await rawUpdateFeature(c.id, { polygons: [ll(tri(100)), ll(tri(200))], ...extra });
            const back = await stored(c.id);
            const poly = Array.isArray(back.polygon)
              ? `${back.polygon.length} points`
              : JSON.stringify(back.polygon ?? null);
            const polys = Array.isArray(back.polygons)
              ? `${back.polygons.length} polygon(s)`
              : JSON.stringify(back.polygons ?? null);
            results.push(
              `${label}: ${r.status}${r.code ? ` ${r.code}` : ''}${r.issues.length ? ` (${r.issues.join('; ')})` : ''}; reads back polygon ${poly}, polygons ${polys}`,
            );
            await run('deleteFeature', p({ ...path, featureId: c.id }));
          }
          record('M6e', m6eTitle, 'noted', `NOTED: ${results.join(' | ')}`);
        } catch (e) {
          record('M6e', m6eTitle, 'inconclusive', `the probe could not complete: ${(e as Error).message}`);
        }
      })();

      // ---- M7: deleting a folder -----------------------------------------------------------------------------------
      await check(
        'M7a',
        'deleting a folder leaves the features in it (their parentId still names it)',
        async () => {
          const f = await create({ type: 'folder', name: 'Doomed folder' });
          const k = await create({
            type: 'pin',
            name: 'Left behind',
            parentId: f.id,
            geometry: { system: 'pixel', shape: 'point', point: { x: 5, y: 5 } },
          });
          await run('deleteFeature', p({ ...path, featureId: f.id }));
          const kid = await attempt('getFeature', p({ ...path, featureId: k.id }));
          if (!kid.ok)
            fail(
              `the nested pin is gone too: ${kid.error.message} (LegendKeeper deleted the folder's features with it)`,
            );
          const sf = kid.body as Obj;
          if (sf.parentId !== f.id)
            fail(
              `the nested pin's parentId is ${JSON.stringify(sf.parentId)}, expected the deleted folder ${f.id}`,
            );
          await run('deleteFeature', p({ ...path, featureId: k.id }));
          return 'the pin stayed, with parentId naming the deleted folder (so the bridge deletes a folder’s features first)';
        },
      );
      await check(
        'M7b',
        'a cascade delete removes a nested tree deepest first and journals every removed feature in full',
        async () => {
          const top = await create({ type: 'folder', name: 'Cascade' });
          const mk = (name: string, parentId: string, x: number) => ({
            type: 'pin' as const,
            name,
            parentId,
            geometry: { system: 'pixel' as const, shape: 'point' as const, point: { x, y: 450 } },
          });
          await create(mk('Cascade pin 1', top.id, 20));
          const inner = await create({ type: 'folder', name: 'Cascade inner', parentId: top.id });
          await create(mk('Cascade pin 2', inner.id, 40));
          const st = await state();
          const plan = planDelete(st, top.id, true);
          if (!plan.ok) throw new Error(`${plan.code}: ${plan.message}`);
          const request = {
            ids: plan.order.map(idOf),
            hashes: Object.fromEntries(plan.order.map((x) => [idOf(x), featureHash(x)])),
            cascade: true,
          };
          const view = await submit(
            deleteJob(
              where,
              st.features.find((x) => idOf(x) === top.id)!,
              plan.order,
              request,
            ),
            'cascade delete',
          );
          const left = (await features()).filter((x) => plan.order.some((g) => idOf(g) === x.id));
          if (left.length > 0) fail(`still there: ${left.map((x) => x.name).join(', ')}`);
          const entries = t.engine.queries
            .journalLookup(t.projectId, { jobId: view.id, includePreImage: true, limit: 50 })
            .filter((e) => e.opId === 'deleteFeature');
          if (entries.length !== plan.order.length)
            fail(`${entries.length} journal entries for ${plan.order.length} deletes`);
          const folderEntry = entries.find((e) => (e.preImage as Obj)?.id === top.id);
          const removed = (folderEntry?.preImage as Obj | undefined)?.with?.removedWithIt as
            Obj[] | undefined;
          if (
            !removed ||
            removed.length !== plan.order.length - 1 ||
            !removed.every((x) => x.id && x.name && x.type)
          )
            fail(
              `the folder's journal entry does not hold the ${plan.order.length - 1} removed features in full: ${JSON.stringify(folderEntry?.preImage).slice(0, 300)}`,
            );
          return `${plan.order.length} features deleted (${plan.order.map((x) => x.name).join(' → ')}); the folder's entry holds ${removed!.length} in full`;
        },
      );
    }

    // ---- M8: replacing the image keeps positions; the frame follows the new size ---------------------------------------
    await check(
      'M8',
      'replacing the image with one of another size keeps every feature’s pos, and the frame follows (the basis of the replacement warning)',
      async () => {
        if (!png1500 || !frame) throw new Unclear('no image or frame (M1, M2)');
        const pins = (await features()).filter((x) => x.pos);
        if (pins.length === 0) throw new Unclear('no feature with a position to compare');
        const before = Object.fromEntries(pins.map((x) => [x.id, x.pos]));
        const bytes = generatePng(1024, 1024);
        const r = await t.engine.submit({
          project: t.projectId,
          kind: 'upload_image',
          contentType: 'image/png',
          contentLength: bytes.length,
          dataBase64: bytes.toString('base64'),
          name: `lk-bridge maps ${stamp} 1024x1024`,
          origin,
          priority: 'P1',
        });
        if (!('jobId' in r)) throw new Unclear(`not queued: ${r.status}`);
        const job = await settle(r.jobId, 'the second upload').catch((e: Error) => {
          throw new Unclear(e.message);
        });
        const asset = (job.result as Obj).asset as Obj;
        assets.push(asset.id);
        await run(
          'updateDocument',
          p({ resourceId: rootId, documentId: mapDoc }, { body: { mapImage: { assetId: asset.id } } }),
        );
        const doc = (await run('getDocument', p({ resourceId: rootId, documentId: mapDoc }))) as Obj;
        const st = frameState(doc.mapImage);
        if (st.kind !== 'image') fail(`the frame state is ${st.kind} after the replacement`);
        const f2 = (st as { frame: MapFrame }).frame;
        if (f2.width !== 1024 || f2.height !== 1024)
          fail(`the frame is ${f2.width}×${f2.height} after the replacement`);
        const want = appBounds(1024, 1024);
        if (!(nearPair(f2.bounds[0], want[0]) && nearPair(f2.bounds[1], want[1])))
          fail(`bounds ${JSON.stringify(f2.bounds)}, the app's formula says ${JSON.stringify(want)}`);
        const moved = (await features()).filter(
          (x) => x.pos && before[x.id] && !nearPair(x.pos, before[x.id]),
        );
        if (moved.length > 0)
          fail(
            `${moved.length} feature(s) changed pos: ${moved.map((x) => x.name).join(', ')} (the spec says they keep it)`,
          );
        return `1500×700 → 1024×1024: bounds ${JSON.stringify(f2.bounds)}; ${pins.length} feature(s) kept their pos (so they sit over different pixels, which update_document warns about)`;
      },
    );
  } finally {
    // Clean up: the throwaway pages (the cascade takes the documents and features with them), then each uploaded asset.
    // C2d's rule: a page or asset that is already gone (404, "already deleted") counts as cleaned; any other failure is
    // confirmed by a read before it is reported.
    const goneAlready = (e: unknown): boolean => {
      const m = (e as Error).message ?? '';
      const lk = (e as { lk?: { status?: number; code?: string } }).lk;
      const codes = [(e as { code?: string }).code, lk?.code];
      return (
        /\b404\b|NOT_FOUND|ALREADY_DELETED|already deleted|is deleted|was deleted|not found/i.test(m) ||
        lk?.status === 404 ||
        codes.includes('NOT_FOUND') ||
        codes.includes('ALREADY_DELETED') ||
        (e instanceof BridgeLkError && e.status === 404)
      );
    };
    const isGone = async (op: string, params: Obj): Promise<boolean> => {
      try {
        const r = (await run(op, params)) as Obj;
        return r?.deletedAt != null;
      } catch (e) {
        return goneAlready(e);
      }
    };
    const remove = async (op: string, params: Obj, extra: Obj, readOp: string): Promise<string | null> => {
      for (let attemptNo = 0; ; attemptNo++) {
        try {
          await run(op, params, extra);
          return null;
        } catch (e) {
          const m = (e as Error).message;
          // "Already gone" is believed only after a read says so (a failure that merely sounds like it, such as the
          // image's bytes not being kept before its delete, must not count as cleaned).
          if (goneAlready(e)) return (await isGone(readOp, { path: params.path })) ? null : m;
          if (attemptNo >= 3 || !/could not (be read|be listed|all be checked)|budget/i.test(m))
            return (await isGone(readOp, { path: params.path })) ? null : m;
          await sleep(65_000);
        }
      }
    };
    const left: string[] = [];
    for (const id of [target.id as string, rootId]) {
      const why = await remove(
        'deleteResource',
        { path: { resourceId: id }, query: { cascade: true } },
        { confirm: 'cascade' },
        'getResource',
      );
      if (why) left.push(`page ${id} (${why})`);
    }
    for (const id of assets) {
      const why = await remove('deleteAsset', { path: { assetId: id } }, {}, 'getAsset');
      if (why) left.push(`asset ${id} (${why})`);
    }
    if (left.length === 0)
      record(
        'cleanup',
        'throwaway pages and images deleted',
        'pass',
        [rootId, target.id, ...assets].join(', '),
      );
    else
      record(
        'cleanup',
        'throwaway pages and images deleted',
        'fail',
        `left: ${left.join('; ')}. Delete them by hand.`,
      );
  }
  return { findings, assets };
}

export function formatMapsReport(findings: readonly Finding[]): string {
  const mark = {
    pass: 'PASS',
    fail: 'FAIL',
    inconclusive: 'INCONCLUSIVE',
    skipped: 'SKIPPED',
    noted: 'NOTED',
  } as const;
  const count = (v: Verdict) => findings.filter((f) => f.verdict === v && f.id !== 'cleanup').length;
  return [
    '',
    'LK-Bridge sandbox: the map-feature layer on LegendKeeper (docs/adr/0040-map-feature-tools.md)',
    '============================================================================================',
    ...findings.map((f) => `[${mark[f.verdict]}] (${f.id}) ${f.title}\n        ${f.detail}`),
    '',
    `${count('pass')} PASS, ${count('fail')} FAIL, ${count('inconclusive')} INCONCLUSIVE, ${count('skipped')} SKIPPED, ${count('noted')} NOTED`,
    '',
  ].join('\n');
}
