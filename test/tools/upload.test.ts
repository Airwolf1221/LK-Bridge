/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { DEFAULT_TOOLS_SETTINGS } from '../../src/config/tools.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { createRuntime } from '../../src/runtime.js';
import type { GuardOptions } from '../../src/mcp/tools/upload-http.js';
import { MockLk, type MockRequest } from '../contract/mock-lk.js';
import { systemClock } from '../../src/lk/index.js';
import { API_KEY, PROJECT, startStack, type Stack } from './helpers.js';
import { specRespond } from './spec-mock.js';

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_1PX, 'base64');
const SECRET_SIG = 'SIGNATURE-must-never-appear';

// ---------------------------------------------------------------------------------------------- fixtures

let dir: string;
let cert: string;
let storage: Server;
let port: number;

interface Put {
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}
const puts: Put[] = [];
/** Scripted storage behaviour for the next PUTs: a status, or 'hang'. */
const script: (number | 'hang' | { status: number; retryAfter: string })[] = [];
const images = new Map<string, { type: string; body: Buffer }>();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lkb-upload-'));
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
      '/CN=storage.test',
      '-addext',
      'subjectAltName=DNS:storage.test,DNS:images.test',
    ],
    { stdio: 'ignore' },
  );
  cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
  storage = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'GET') {
        const img = images.get((req.url ?? '').split('?')[0]!);
        if (!img) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': img.type, 'content-length': img.body.length });
        return void res.end(img.body);
      }
      puts.push({ path: req.url ?? '', headers: req.headers, body });
      const next = script.shift() ?? 200;
      if (next === 'hang') return;
      const status = typeof next === 'number' ? next : next.status;
      res.writeHead(status, {
        ...(typeof next === 'object' ? { 'retry-after': next.retryAfter } : {}),
        'content-type': 'application/xml',
      });
      res.end(
        status >= 400 ? `<Error><Detail>${SECRET_SIG} and the key id AKIAEXAMPLE</Detail></Error>` : '',
      );
    });
  });
  await new Promise<void>((r) => storage.listen(0, '127.0.0.1', r));
  port = (storage.address() as AddressInfo).port;
});
afterAll(async () => {
  storage.closeAllConnections();
  await new Promise((r) => storage.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const toLoopback = (host: string) =>
  Promise.resolve(host.endsWith('.test') ? [{ address: '127.0.0.1', family: 4 as const }] : []);
const testGuard = (): GuardOptions => ({
  resolve: toLoopback,
  ca: cert,
  allowAddress: (a) => a === '127.0.0.1',
});

let uploadUrl = (): string => `https://storage.test:${port}/put/abc?sig=${SECRET_SIG}`;
const assetBodies: unknown[] = [];

function lkResponder() {
  return specRespond({
    createImageUpload: (req: MockRequest) => ({
      status: 201,
      body: {
        uploadKey: 'upload-key-1',
        uploadUrl: uploadUrl(),
        method: 'PUT',
        headers: {
          'content-type': (req.body as { contentType: string }).contentType,
          'x-upload-token': 't-1',
        },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    }),
    createImageAsset: (req: MockRequest) => {
      assetBodies.push(req.body);
      return {
        status: 201,
        body: {
          id: 'asset1',
          name: (req.body as { name: string }).name,
          type: 'IMAGE',
          url: 'https://assets.example/a.png',
          width: 1,
          height: 1,
        },
      };
    },
  });
}

async function uploadStack(
  o: Parameters<typeof startStack>[0] = {},
): Promise<{ stack: Stack; client: Client }> {
  const stack = await startStack({ respond: lkResponder(), uploadGuard: testGuard(), ...o });
  return { stack, client: await stack.connect() };
}

const wireOf = (s: Stack, re: RegExp, method = 'POST') =>
  s.mock.calls.filter((c) => c.method === method && re.test(c.path));

// ---------------------------------------------------------------------------------------------- success

describe('lk_upload_image', () => {
  it('uploads end to end: createImageUpload, the signed PUT, createImageAsset', async () => {
    puts.length = 0;
    assetBodies.length = 0;
    const { stack, client } = await uploadStack();
    try {
      const r = await stack.call(client, 'lk_upload_image', {
        name: 'Map of the realm',
        base64: PNG_1PX,
        description: 'd',
      });
      expect(r.isError, r.text).toBe(false);
      expect(r.body.status).toBe('succeeded');
      expect(r.body.asset).toMatchObject({ id: 'asset1', name: 'Map of the realm', type: 'IMAGE' });
      expect(r.footer).toMatch(/^budget:/);
      // LK: one createImageUpload with size, type and hash; one createImageAsset with the key LK returned.
      expect(wireOf(stack, /assets\/uploads/)).toHaveLength(1);
      expect(wireOf(stack, /assets\/images/)).toHaveLength(1);
      expect(assetBodies).toEqual([
        { uploadKey: 'upload-key-1', name: 'Map of the realm', description: 'd' },
      ]);
      // Storage: the exact bytes, the headers LK named, on its own host.
      expect(puts).toHaveLength(1);
      expect(puts[0]!.body.equals(PNG_BYTES)).toBe(true);
      expect(puts[0]!.headers['content-type']).toBe('image/png');
      expect(puts[0]!.headers['x-upload-token']).toBe('t-1');
      expect(puts[0]!.headers.authorization).toBeUndefined();
      // The mock LK never saw the storage request.
      expect(stack.mock.calls.every((c) => !c.path.includes('/put/'))).toBe(true);
      // The job is a three-step upload_image job, and the image bytes were discarded after the PUT.
      const job = stack.runtime.engine.queries.getJob(r.body.jobId)!;
      expect(job.kind).toBe('upload_image');
      expect(job.steps.map((s) => s.opId)).toEqual([
        'createImageUpload',
        'upload_image.put',
        'createImageAsset',
      ]);
      expect(job.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
      expect(job.origin.tool).toBe('lk_upload_image');
      const stored = stack.db
        .prepare('SELECT params FROM steps WHERE job_id = ? AND step_no = 2')
        .get(job.id) as { params: string | null };
      const art = stack.db
        .prepare("SELECT data FROM job_artifacts WHERE job_id = ? AND kind = 'params'")
        .all(job.id) as { data: string }[];
      expect(JSON.stringify([stored, art])).not.toContain(PNG_1PX);
      // The signed URL is not shown by any tool.
      const status = await stack.call(client, 'bridge_job_status', { jobId: r.body.jobId, steps: true });
      expect(status.text).not.toContain(SECRET_SIG);
      expect(status.text).not.toContain('upload-key-1');
      const errors = await stack.call(client, 'bridge_errors_recent', { grouped: false });
      expect(errors.text).not.toContain(SECRET_SIG);
    } finally {
      await stack.close();
    }
  });

  it('fetches a public https URL with the same guard, and caps size and type', async () => {
    images.set('/ok.png', { type: 'image/png', body: PNG_BYTES });
    images.set('/lie.png', { type: 'image/png', body: Buffer.from('<html>not an image</html>') });
    images.set('/text', { type: 'text/html', body: PNG_BYTES });
    images.set('/big.png', { type: 'image/png', body: Buffer.concat([PNG_BYTES, Buffer.alloc(5000)]) });
    puts.length = 0;
    const { stack, client } = await uploadStack({
      tools: { upload: { ...DEFAULT_TOOLS_SETTINGS.upload, maxBytes: 2000 } },
    });
    try {
      const ok = await stack.call(client, 'lk_upload_image', {
        name: 'from url',
        url: `https://images.test:${port}/ok.png`,
      });
      expect(ok.body.status, ok.text).toBe('succeeded');
      expect(puts[0]!.body.equals(PNG_BYTES)).toBe(true);
      const jobsBefore = stack.runtime.engine.queries.listJobs({}).length;
      const cases: [string, string][] = [
        [`https://images.test:${port}/lie.png`, 'UPLOAD_NOT_AN_IMAGE'],
        [`https://images.test:${port}/text`, 'UPLOAD_NOT_AN_IMAGE'],
        [`https://images.test:${port}/big.png`, 'UPLOAD_TOO_LARGE'],
      ];
      for (const [url, code] of cases) {
        const r = await stack.call(client, 'lk_upload_image', { name: 'x', url });
        expect(r.isError, url).toBe(true);
        expect(r.body.error.code, url).toBe(code);
      }
      // Oversized and non-image base64 never start a job.
      const big = await stack.call(client, 'lk_upload_image', {
        name: 'x',
        base64: Buffer.concat([PNG_BYTES, Buffer.alloc(3000)]).toString('base64'),
      });
      expect(big.body.error.code).toBe('UPLOAD_TOO_LARGE');
      const junk = await stack.call(client, 'lk_upload_image', {
        name: 'x',
        base64: Buffer.from('hello world').toString('base64'),
      });
      expect(junk.body.error.code).toBe('UPLOAD_NOT_AN_IMAGE');
      const mismatch = await stack.call(client, 'lk_upload_image', {
        name: 'x',
        base64: PNG_1PX,
        contentType: 'image/jpeg',
      });
      expect(mismatch.body.error.code).toBe('UPLOAD_NOT_AN_IMAGE');
      const both = await stack.call(client, 'lk_upload_image', {
        name: 'x',
        base64: PNG_1PX,
        url: 'https://x.test/a.png',
      });
      expect(both.body.error.code).toBe('UPLOAD_SOURCE_INVALID');
      expect(stack.runtime.engine.queries.listJobs({}).length).toBe(jobsBefore);
    } finally {
      await stack.close();
    }
  });

  it('URL sources can be switched off', async () => {
    const { stack, client } = await uploadStack({
      tools: { upload: { ...DEFAULT_TOOLS_SETTINGS.upload, allowUrlSource: false } },
    });
    try {
      const r = await stack.call(client, 'lk_upload_image', {
        name: 'x',
        url: `https://images.test:${port}/ok.png`,
      });
      expect(r.body.error.code).toBe('UPLOAD_URL_SOURCE_DISABLED');
      const ok = await stack.call(client, 'lk_upload_image', { name: 'x', base64: PNG_1PX });
      expect(ok.body.status).toBe('succeeded');
    } finally {
      await stack.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------- SSRF

describe('SSRF refusals', () => {
  const urls = [
    'http://storage.test/a.png', // not https
    'https://127.0.0.1/a.png',
    'https://[::1]/a.png',
    'https://169.254.169.254/latest/meta-data',
    'https://10.1.2.3/a.png',
    'https://192.168.0.10/a.png',
    'https://user:pw@images.test/a.png',
    'https://internal.test/a.png', // resolves to a private address
    'file:///etc/passwd',
  ];

  it('refuses private, loopback, link-local and non-https image URLs without starting a job', async () => {
    // Production guard (no allowAddress), with DNS answering a private address for any name.
    const { stack, client } = await uploadStack({
      uploadGuard: { resolve: () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]) },
    });
    try {
      for (const url of urls) {
        const r = await stack.call(client, 'lk_upload_image', { name: 'x', url });
        expect(r.isError, url).toBe(true);
        expect(r.body.error.code, url).toBe('UPLOAD_URL_REFUSED');
      }
      expect(stack.runtime.engine.queries.listJobs({}).length).toBe(0);
    } finally {
      await stack.close();
    }
  });

  it('refuses a signed upload URL that points at a private address, and never contacts it', async () => {
    puts.length = 0;
    const targets = [
      'http://storage.test/put',
      'https://127.0.0.1:' + port + `/put?sig=${SECRET_SIG}`,
      'https://[::1]/put',
      'https://169.254.169.254/put',
      'https://10.9.9.9/put',
      'https://rebind.test/put', // resolves to a private address
    ];
    const { stack, client } = await uploadStack({
      uploadGuard: { resolve: () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]) },
    });
    try {
      for (const t of targets) {
        uploadUrl = () => t;
        const r = await stack.call(client, 'lk_upload_image', { name: 'x', base64: PNG_1PX });
        expect(r.isError, t).toBe(true);
        expect(r.body.error.lkCode ?? r.body.error.code, t).toMatch(
          /UPLOAD_TARGET_REFUSED|UPLOAD_FAILED|LK_ERROR/,
        );
        expect(r.text, t).not.toContain(SECRET_SIG);
        expect(r.text, t).not.toContain('127.0.0.1');
        const job = stack.runtime.engine.queries.listJobs({ kind: 'upload_image', limit: 1 })[0]!;
        expect(job.status).toBe('failed');
        expect(job.lastError?.code).toBe('LK_ERROR');
        expect(JSON.stringify(job.lastError)).toContain('UPLOAD_TARGET_REFUSED');
        // createImageAsset was never sent.
      }
      expect(wireOf(stack, /assets\/images/)).toHaveLength(0);
      expect(puts).toHaveLength(0);
    } finally {
      uploadUrl = () => `https://storage.test:${port}/put/abc?sig=${SECRET_SIG}`;
      await stack.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------- backoff

describe('the PUT step under the governor', () => {
  it('retries a 503 with backoff and succeeds', async () => {
    puts.length = 0;
    script.push(503, 503);
    const { stack, client } = await uploadStack();
    try {
      const r = await stack.call(client, 'lk_upload_image', {
        name: 'flaky',
        base64: PNG_1PX,
        waitSeconds: 20,
      });
      expect(r.body.status, r.text).toBe('succeeded');
      expect(puts).toHaveLength(3);
      expect(wireOf(stack, /assets\/uploads/)).toHaveLength(1); // the LK call was not repeated
    } finally {
      await stack.close();
    }
  });

  it('treats a 429 from the storage host as the upload tier’s reactive backoff', async () => {
    puts.length = 0;
    script.push({ status: 429, retryAfter: '1' });
    const { stack, client } = await uploadStack();
    const throttled: { tiers: readonly string[]; opId: string }[] = [];
    stack.runtime.lk.governor.on('throttled', (e) => throttled.push({ tiers: e.tiers, opId: e.opId }));
    try {
      const r = await stack.call(client, 'lk_upload_image', {
        name: 'slow',
        base64: PNG_1PX,
        waitSeconds: 20,
      });
      expect(r.body.status, r.text).toBe('succeeded');
      expect(puts).toHaveLength(2);
      // The governor may report the block twice (header and retry paths); what matters is the tier and the call.
      expect(throttled.length).toBeGreaterThan(0);
      for (const e of throttled) expect(e).toEqual({ tiers: ['upload'], opId: 'upload_image.put' });
    } finally {
      await stack.close();
    }
  });

  it('a refusal from storage fails the job without leaking the response body', async () => {
    puts.length = 0;
    script.push(403);
    const { stack, client } = await uploadStack();
    try {
      const r = await stack.call(client, 'lk_upload_image', { name: 'denied', base64: PNG_1PX });
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain(SECRET_SIG);
      expect(r.text).not.toContain('AKIAEXAMPLE');
      expect(r.body.status).toBe('failed');
      expect(wireOf(stack, /assets\/images/)).toHaveLength(0);
    } finally {
      await stack.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------- crash and resume

describe('mid-job crash and resume', () => {
  async function crashScenario(hang: 'asset' | 'put') {
    puts.length = 0;
    assetBodies.length = 0;
    script.length = 0;
    const mock = new MockLk({ clock: systemClock, apiKey: API_KEY, respond: lkResponder() });
    const lkUrl = await mock.start();
    const d = mkdtempSync(join(tmpdir(), 'lkb-crash-'));
    const dbPath = join(d, 'bridge.db');
    const config = loadConfig({
      BRIDGE_PUBLIC_URL: 'https://lk.example.test',
      LK_API_KEY: API_KEY,
      LK_PROJECT_ID: PROJECT,
      LK_BASE_URL: lkUrl,
      LK_READ_ONLY: 'false',
      WRITE_SPACING_MS: '0',
      WRITE_SPACING_STRETCHED_MS: '0',
      LOG_LEVEL: 'silent',
      SESSION_SECRET: 'x'.repeat(40),
      JWT_SIGNING_KEY: 'y'.repeat(40),
    });
    const boot = () => {
      const db = openDatabase(dbPath);
      runMigrations(db);
      const runtime = createRuntime({
        config,
        toolsSettings: DEFAULT_TOOLS_SETTINGS,
        db,
        version: 't',
        lkTransport: (i, init) => fetch(i, init),
        uploadGuard: testGuard(),
      });
      return { db, runtime };
    };
    const a = boot();
    if (hang === 'asset')
      mock.inject((c) => c.method === 'POST' && /assets\/images/.test(c.path), { kind: 'hang' });
    else script.push('hang');
    const submitted = await a.runtime.engine.submit({
      kind: 'upload_image',
      contentType: 'image/png',
      contentLength: PNG_BYTES.length,
      dataBase64: PNG_1PX,
      name: 'crash me',
      origin: { kind: 'test' },
      priority: 'P1',
    });
    if (!('jobId' in submitted)) throw new Error('expected a job');
    // Wait until the process would be stuck at the chosen point, then "die": the database handle goes away.
    const stuck = async () => {
      for (let i = 0; i < 400; i++) {
        if (hang === 'asset' ? mock.calls.some((c) => /assets\/images/.test(c.path)) : puts.length > 0)
          return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('never reached the crash point');
    };
    await stuck();
    a.db.close();
    // The next process starts on the same database file.
    const b = boot();
    for (let i = 0; i < 800; i++) {
      const j = b.runtime.engine.queries.getJob(submitted.jobId)!;
      if (['succeeded', 'failed'].includes(j.status)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const job = b.runtime.engine.queries.getJob(submitted.jobId)!;
    const out = { job, mock, assetBodies: [...assetBodies], puts: puts.length };
    await b.runtime.shutdown(200);
    b.db.close();
    mock.app.server.closeAllConnections(); // the crashed process's hung request
    await mock.stop();
    rmSync(d, { recursive: true, force: true });
    return out;
  }

  it('crash after the PUT, before createImageAsset: resumes with no duplicate LK calls', async () => {
    const { job, mock, assetBodies: assets, puts: nPuts } = await crashScenario('asset');
    expect(job.status).toBe('succeeded');
    expect(job.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(nPuts).toBe(1); // the PUT was not repeated: it had finished
    expect(mock.calls.filter((c) => /assets\/uploads/.test(c.path))).toHaveLength(1);
    // createImageAsset was sent twice (the first never answered) under the SAME idempotency key, with the same key.
    const images = mock.calls.filter((c) => /assets\/images/.test(c.path));
    expect(new Set(images.map((c) => c.idempotencyKey)).size).toBe(1);
    expect(assets[0]).toMatchObject({ uploadKey: 'upload-key-1', name: 'crash me' });
  });

  it('crash during the PUT: the PUT is sent again (harmless) and the job finishes once', async () => {
    const { job, mock, puts: nPuts } = await crashScenario('put');
    expect(job.status, JSON.stringify(job.lastError)).toBe('succeeded');
    expect(nPuts).toBe(2);
    expect(mock.calls.filter((c) => /assets\/uploads/.test(c.path))).toHaveLength(1);
    expect(mock.calls.filter((c) => /assets\/images/.test(c.path))).toHaveLength(1);
  });
});
