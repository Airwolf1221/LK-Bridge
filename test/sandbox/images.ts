/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * The image pipeline on a REAL sandbox project (v2 D3, ADR 0041), opt-in: `deploy/sandbox-test.sh --project test --
 * images`. It writes, then cleans up everything it made. Each check prints PASS, FAIL or INCONCLUSIVE with its cost
 * (requests to LegendKeeper, and downloads from its asset host).
 *
 * 1. The fixture images (test/fixtures/images) are uploaded through base64 (the service, as upload_image does), through
 *    the binary endpoint (prepare → POST over real HTTP to the pipeline's own endpoint → upload), and through a URL when
 *    LKB_SANDBOX_IMAGE_URL names a stable public test image.
 *    Caddy: a large POST to `<BRIDGE_PUBLIC_URL>/uploads/<id>` with no valid capability must come back from the live
 *    bridge as its generic refusal (Caddy passes the path and the body; nothing is stored).
 * 2. Each stored asset is downloaded and checked: SHA-256, dimensions, alpha, orientation and frames as LegendKeeper
 *    stored them.
 * 3. One image is staged, then placed (move, unhide, rename, read back); another is staged and discarded (its bytes
 *    kept first).
 * 4. A nested destination is created under a throwaway asset folder.
 * 5. Everything is deleted: the throwaway folder and the run's own staging folder (404 or "already deleted" counts as
 *    cleaned). Writes parked for budget or queued are waited for (test/sandbox/wait.ts), the clean-up's too.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import sharp from 'sharp';
import { uploadsPlugin } from '../../src/images/http.js';
import { downloadAsset } from '../../src/images/download.js';
import type { ImageService } from '../../src/images/service.js';
import type { Runtime } from '../../src/runtime.js';
import type { GuardOptions } from '../../src/mcp/tools/upload-http.js';
import { resolveImage } from '../../src/mcp/tools/upload-source.js';
import type { Finding, Verdict } from './smoke.js';
import type { HttpCounters } from './soak.js';
import { runSettled, waitForJob, type WaitOptions } from './wait.js';

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/images/${name}`, import.meta.url));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export interface ImagesTarget {
  readonly runtime: Runtime;
  readonly projectId: string;
  readonly counters: HttpCounters;
  /** The live bridge's public address (for the Caddy check), or null to skip it. */
  readonly publicUrl: string | null;
  /** A stable public image for the URL source, or null to skip it. */
  readonly imageUrl: string | null;
  /** The URL fetch's address and port policy (tests only; the default is the production policy). */
  readonly guard?: GuardOptions;
}

interface Uploaded {
  readonly label: string;
  readonly fixture: string;
  readonly assetId: string;
  readonly webpSha: string;
  readonly expect: { width: number; height: number; frames: number; alpha: boolean };
}

export async function runImagesSandbox(t: ImagesTarget, wait: WaitOptions = {}): Promise<Finding[]> {
  const findings: Finding[] = [];
  const rt = t.runtime;
  const svc: ImageService = rt.images;
  const pid = t.projectId;
  const origin = { kind: 'test' as const, client: 'sandbox-images', tool: 'sandbox-images' };
  const downloads = { n: 0 };
  const cost = (before: { r: number; w: number; d: number }) =>
    `cost: ${t.counters.reads - before.r} reads, ${t.counters.writes - before.w} writes, ${downloads.n - before.d} downloads`;
  const mark = () => ({ r: t.counters.reads, w: t.counters.writes, d: downloads.n });
  const record = (id: string, title: string, verdict: Verdict, detail: string) =>
    findings.push({ id, title, verdict, detail });
  const check = async (id: string, title: string, fn: () => Promise<string>) => {
    const before = mark();
    try {
      record(id, title, 'pass', `${await fn()}; ${cost(before)}`);
    } catch (e) {
      const inconclusive = e instanceof Unclear;
      record(id, title, inconclusive ? 'inconclusive' : 'fail', `${(e as Error).message}; ${cost(before)}`);
    }
  };
  const run = (op: string, params: Record<string, unknown>) =>
    runSettled(
      { engine: rt.engine, projectId: pid },
      op,
      params,
      { origin, priority: 'P1', project: pid },
      wait,
    );

  // ---- the asset tree (the planner needs it; about one request per folder)
  const build = rt.assets.prepareBuild(pid, { trigger: 'sandbox-images', autoConfirm: true });
  for (let i = 0; i < 600 && rt.assets.store.activePass(pid); i++)
    await new Promise((r) => setTimeout(r, 500));
  void build;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = `lk-bridge images sandbox ${stamp}`;
  const stagingName = `${root} staging`;
  rt.projects.setSetting(pid, 'imageStagingFolder', stagingName);
  const uploaded: Uploaded[] = [];

  const uploadBytes = async (
    label: string,
    bytes: Buffer,
    name: string,
    folder: string[],
    staged = false,
  ) => {
    const img = await svc.convert(bytes);
    const plan = staged ? svc.planStaging(pid) : svc.plan(pid, { folder });
    if (!plan.ok) throw new Error(`${plan.error.code}: ${plan.error.message}`);
    const started = await svc.startUpload({
      projectId: pid,
      image: img,
      name,
      plan: plan.plan,
      staged,
      source: 'data_base64',
      origin,
    });
    if (!started.row) throw new Error('not accepted');
    await waitForJob(rt.engine, pid, started.row.jobId!, `${label} upload`, wait);
    const row = svc.settle(svc.store.upload(pid, started.row.id)!);
    if (row.state !== 'uploaded' || !row.assetId)
      throw new Error(`${label}: ${row.state} ${row.error ?? ''}`);
    return { row, img };
  };

  try {
    // ---- 1. the ways in
    const cases: { file: string; expect: Uploaded['expect'] }[] = [
      { file: 'alpha.png', expect: { width: 40, height: 24, frames: 1, alpha: true } },
      { file: 'orientation-6.jpg', expect: { width: 20, height: 30, frames: 1, alpha: false } },
      { file: 'animated.gif', expect: { width: 16, height: 12, frames: 3, alpha: true } },
      { file: 'already.webp', expect: { width: 10, height: 10, frames: 1, alpha: false } },
    ];
    await check('1.base64', 'upload the fixtures through base64 (converted, verified)', async () => {
      const out: string[] = [];
      for (const c of cases) {
        const { row } = await uploadBytes(c.file, fixture(c.file), `sandbox ${c.file}`, [root, 'uploads']);
        // Transparency kept: the PNG's alpha must survive; the stored file is then checked against what was sent.
        if (c.expect.alpha && c.file.endsWith('.png') && !row.hasAlpha)
          throw new Error(`${c.file}: alpha dropped`);
        uploaded.push({
          label: 'base64',
          fixture: c.file,
          assetId: row.assetId!,
          webpSha: row.webp.sha256,
          expect: { ...c.expect, alpha: row.hasAlpha },
        });
        if (row.storedVerified !== true)
          throw new Error(`${c.file}: stored bytes not verified (${row.verifyReason})`);
        out.push(`${c.file} → ${row.assetId}`);
      }
      return out.join(', ');
    });

    await check(
      '1.binary',
      'upload through the binary endpoint (prepare, POST over HTTP, upload)',
      async () => {
        const app = Fastify({ logger: false });
        await app.register(uploadsPlugin, { images: svc, scopeOf: () => 'write' });
        await app.listen({ host: '127.0.0.1', port: 0 });
        try {
          const file = fixture('orientation-6.jpg');
          const prepared = svc.slots.prepare({
            projectId: pid,
            principalId: 'system',
            sha256: sha(file),
            byteLength: file.length,
            contentType: 'image/jpeg',
            name: 'sandbox binary',
          });
          const port = (app.server.address() as AddressInfo).port;
          const answer = await post(`http://127.0.0.1:${port}/uploads/${prepared.uploadId}`, file, {
            authorization: `Upload ${prepared.token}`,
          });
          if (answer.status !== 201) throw new Error(`the endpoint answered ${answer.status} ${answer.body}`);
          const slot = svc.store.slot(prepared.uploadId)!;
          const bytes = await svc.slots.read(slot);
          if (!bytes) throw new Error('the received file is not readable');
          // The same image as base64 above: a different operation is needed to upload it again, as upload_image would.
          const img = await svc.convert(bytes);
          const plan = svc.plan(pid, { folder: [root, 'binary'] });
          if (!plan.ok) throw new Error(plan.error.message);
          const started = await svc.startUpload({
            projectId: pid,
            image: img,
            name: 'sandbox binary',
            plan: plan.plan,
            staged: false,
            source: 'upload_id',
            origin,
          });
          await svc.slots.consume(slot);
          await waitForJob(rt.engine, pid, started.row!.jobId!, 'binary upload', wait);
          const row = svc.settle(svc.store.upload(pid, started.row!.id)!);
          if (row.storedVerified !== true) throw new Error(`not verified: ${row.verifyReason}`);
          uploaded.push({
            label: 'binary',
            fixture: 'orientation-6.jpg',
            assetId: row.assetId!,
            webpSha: row.webp.sha256,
            expect: cases[1]!.expect,
          });
          return `received ${file.length} bytes, asset ${row.assetId}`;
        } finally {
          await app.close();
        }
      },
    );

    await check('1.caddy', 'Caddy passes POST /uploads/* with a large body to the live bridge', async () => {
      if (!t.publicUrl) throw new Unclear('no BRIDGE_PUBLIC_URL known; skipped');
      const body = Buffer.alloc(8 * 1024 * 1024, 0x41);
      const r = await post(`${t.publicUrl.replace(/\/+$/, '')}/uploads/upl_${'A'.repeat(22)}`, body, {
        authorization: `Upload ${'B'.repeat(43)}`,
      });
      if (r.status === 403 && r.body.includes('upload_refused'))
        return 'the live bridge answered its generic refusal (403)';
      if (r.status === 404) throw new Error('404: the live bridge has no /uploads route (deploy D3 first)');
      if (r.status === 413)
        throw new Error(
          '413: something in front of the bridge limits the body size (see the runbook, Caddy)',
        );
      if (r.status === 502 || r.status === 0) {
        throw new Unclear(
          `${r.status || 'no answer'}: the bridge refuses before reading and closes the connection; the proxy reported ` +
            `that instead of the refusal (${r.body.slice(0, 120)}). Send a real upload through prepare_image_upload to be sure.`,
        );
      }
      throw new Error(`answered ${r.status}: ${r.body.slice(0, 200)}`);
    });

    await check('1.url', 'upload through a URL (LKB_SANDBOX_IMAGE_URL)', async () => {
      if (!t.imageUrl) throw new Unclear('LKB_SANDBOX_IMAGE_URL is not set; skipped');
      const got = await resolveImage({ url: t.imageUrl }, svc.settings.upload, t.guard ?? {});
      const bytes = Buffer.from(got.dataBase64, 'base64');
      const { row } = await uploadBytes('url', bytes, 'sandbox url', [root, 'url']);
      const m = await sharp(bytes, { animated: true }).metadata();
      uploaded.push({
        label: 'url',
        fixture: t.imageUrl,
        assetId: row.assetId!,
        webpSha: row.webp.sha256,
        expect: {
          width: row.width,
          height: row.height,
          frames: Math.max(1, m.pages ?? 1),
          alpha: row.hasAlpha,
        },
      });
      return `asset ${row.assetId}`;
    });

    // ---- 2. what LegendKeeper stored
    await check('2', 'stored assets: SHA-256, dimensions, alpha, orientation and frames', async () => {
      const out: string[] = [];
      for (const u of uploaded) {
        const asset = (await run('getAsset', { path: { assetId: u.assetId } })) as any;
        downloads.n++;
        const got = await downloadAsset(rt.projects.client(pid)!, asset.url, {
          hosts: svc.settings.images.assetHosts,
          priority: 'P1',
          opId: 'sandbox.download',
        });
        if (got.sha256 !== u.webpSha) throw new Error(`${u.fixture} (${u.label}): stored SHA-256 differs`);
        const m = await sharp(got.bytes, { animated: true }).metadata();
        const frames = Math.max(1, m.pages ?? 1);
        const height = m.pageHeight ?? m.height;
        if (m.format !== 'webp') throw new Error(`${u.fixture}: stored as ${m.format}`);
        if (m.width !== u.expect.width || height !== u.expect.height || frames !== u.expect.frames) {
          throw new Error(
            `${u.fixture}: stored ${m.width}×${height}×${frames}, expected ${u.expect.width}×${u.expect.height}×${u.expect.frames}`,
          );
        }
        if (Boolean(m.hasAlpha) !== u.expect.alpha) throw new Error(`${u.fixture}: alpha ${m.hasAlpha}`);
        if (m.orientation !== undefined && m.orientation !== 1)
          throw new Error(`${u.fixture}: orientation ${m.orientation} kept`);
        if (asset.width !== u.expect.width || asset.height !== u.expect.height) {
          throw new Error(`${u.fixture}: LegendKeeper records ${asset.width}×${asset.height}`);
        }
        out.push(`${u.fixture} (${u.label}) ok`);
      }
      return out.join(', ');
    });

    // ---- 3. staging (v3 F2, ADR 0049 decision 10: on the bridge's server; nothing goes to LegendKeeper until placed)
    await check(
      '3',
      'stage on the server (nothing sent) → place (uploaded into its final folder, named, verified); stage → discard (server copy removed)',
      async () => {
        const stageOnServer = async (bytes: Buffer, name: string) =>
          svc.stageOnServer({
            projectId: pid,
            image: await svc.convert(bytes),
            name,
            source: 'data_base64',
            origin,
          });
        const a = await stageOnServer(fixture('png-named.jpg'), 'sandbox staged');
        if (a.assetId !== null || !a.serverSha256) throw new Error('the staged image reached LegendKeeper');
        const plan = svc.plan(pid, { folder: [root, 'placed'] });
        if (!plan.ok) throw new Error(plan.error.message);
        const placed = await svc.place({
          projectId: pid,
          row: a,
          plan: plan.plan,
          rename: 'sandbox placed',
          origin,
          tool: 'sandbox',
        });
        if (!('jobId' in placed.submitted)) throw new Error('placing became a proposal');
        const job = await waitForJob(rt.engine, pid, placed.submitted.jobId, 'placing', wait);
        if ((job.result as any)?.verified !== true)
          throw new Error('the read back did not verify the placement');
        const after = svc.settle(svc.store.upload(pid, a.id)!);
        if (!after.assetId || after.storedVerified !== true)
          throw new Error('the stored file was not verified');
        const b = await stageOnServer(fixture('alpha.png'), 'sandbox discard');
        const d = await svc.discard({ projectId: pid, row: b, origin, by: 'sandbox' });
        if (!('status' in d) || d.status !== 'discarded')
          throw new Error('discarding a server copy made a job');
        if (await svc.stagedImage(pid, b.id)) throw new Error('the server copy was not removed');
        return `placed ${after.assetId} (uploaded from the server, verified); discarded ${b.id} (server copy removed)`;
      },
    );

    // ---- 4. a nested destination
    await check('4', 'a nested destination is created in order under the throwaway folder', async () => {
      const { row } = await uploadBytes('nested', fixture('animated.gif'), 'sandbox nested', [
        root,
        'Characters',
        'Group',
        'Race',
        'Name',
      ]);
      return `${row.folderPath?.join(' / ')}`;
    });
  } finally {
    // ---- 5. clean-up: the throwaway folder (everything inside goes with it) and the run's staging folder
    const before = mark();
    const left: string[] = [];
    for (const name of [root, stagingName]) {
      const folders = rt.assets.queries.findFoldersByName(pid, name).data.filter((f) => f.parentId === null);
      for (const f of folders) {
        try {
          await run('deleteAsset', { path: { assetId: f.id } });
        } catch (e) {
          const m = (e as Error).message;
          if (!/404|NOT_FOUND|ALREADY_DELETED/i.test(m)) left.push(`${name} (${f.id}): ${m}`);
        }
      }
    }
    rt.projects.setSetting(pid, 'imageStagingFolder', null);
    record(
      '5',
      'clean-up: the throwaway and staging folders deleted (404 counts as cleaned)',
      left.length === 0 ? 'pass' : 'fail',
      `${left.length === 0 ? 'nothing left' : `left behind: ${left.join('; ')}. Delete by hand.`}; ${cost(before)}`,
    );
  }
  return findings;
}

class Unclear extends Error {}

function post(
  url: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  const req = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(
      u,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
          ...headers,
        },
        timeout: 120_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    r.on('error', (e) => {
      // The bridge refuses before reading and closes; the client may see the close while still sending.
      if (
        (e as NodeJS.ErrnoException).code === 'EPIPE' ||
        (e as NodeJS.ErrnoException).code === 'ECONNRESET'
      ) {
        resolve({
          status: 0,
          body: `connection closed by the server (${(e as NodeJS.ErrnoException).code})`,
        });
      } else reject(e);
    });
    r.end(body);
  });
}
