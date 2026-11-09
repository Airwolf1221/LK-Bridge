/**
 * Fixture for the Playwright smoke test (`npm run test:e2e`): the REAL bridge (auth, runtime, admin API, the built
 * dashboard in `ui/dist`) on 127.0.0.1, a mock LegendKeeper behind it whose writes are slowed down so a job can be
 * watched, and a tiny control server (port + 1) the test uses to start work. Throwaway secrets only; nothing real.
 */
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../../src/auth/password.js';
import { loadAuthConfig } from '../../src/config/auth.js';
import { DEFAULT_TOOLS_SETTINGS, defaultAdminSettings, loadConfig } from '../../src/config/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { systemClock } from '../../src/lk/index.js';
import { createBridge } from '../../src/server.js';
import { randomBytes } from 'node:crypto';
import { MockLk } from '../contract/mock-lk.js';
import { LkModel } from '../jobs/lk-model.js';

const PORT = Number(process.env.E2E_PORT ?? 8799);
export const OWNER_PASSWORD = 'e2e-password-not-a-secret';
const API_KEY = 'mock-key-not-real';
/** The mock project's LegendKeeper id (served as project "test", the single-project form's default name). */
const PROJECT = 'proj_mock';
const secret = () => randomBytes(48).toString('base64');
const delay = Number(process.env.E2E_WRITE_DELAY_MS ?? 700);

const model = new LkModel(() => systemClock.now());
model.seedResource('res1', {
  name: 'Kingdom',
  blocks: [{ kind: 'paragraph', content: [{ text: 'Hello' }] }],
});
const mock = new MockLk({ clock: systemClock, apiKey: API_KEY, respond: model.respond });
const lkUrl = await mock.start();

const dir = mkdtempSync(join(tmpdir(), 'lkb-e2e-'));
const db = openDatabase(join(dir, 'bridge.db'));
runMigrations(db);
const publicUrl = `http://127.0.0.1:${PORT}`;
const config = loadConfig({
  BRIDGE_PUBLIC_URL: publicUrl,
  LK_API_KEY: API_KEY,
  LK_PROJECT_ID: 'proj_mock',
  LK_BASE_URL: lkUrl,
  LK_READ_ONLY: 'false',
  WRITE_SPACING_MS: '0',
  WRITE_SPACING_STRETCHED_MS: '0',
  LOG_LEVEL: 'silent',
  SESSION_SECRET: secret(),
  JWT_SIGNING_KEY: secret(),
});
const authConfig = loadAuthConfig({
  BRIDGE_PUBLIC_URL: publicUrl,
  OWNER_PASSWORD_HASH: await hashPassword(OWNER_PASSWORD, { memoryCost: 1024, timeCost: 1, parallelism: 1 }),
  SESSION_SECRET: secret(),
  JWT_SIGNING_KEY: secret(),
});
const { app, runtime } = await createBridge({
  config,
  authConfig,
  toolsSettings: DEFAULT_TOOLS_SETTINGS,
  db,
  version: 'e2e',
  logLevel: 'silent',
  pruneIntervalMs: 0,
  adminSettings: defaultAdminSettings({ budgetPushMs: 1000 }),
  lkTransport: async (input, init) => {
    if ((init?.method ?? 'GET').toUpperCase() !== 'GET') await new Promise((r) => setTimeout(r, delay));
    return fetch(input, init);
  },
});
await app.listen({ host: '127.0.0.1', port: PORT });

const engine = runtime.engine;
const origin = { kind: 'ui', tool: 'e2e' } as const;
const profile =
  runtime.policy.store.getProfileByLabel('Scribe') ??
  runtime.policy.commands.createProfile('owner', { label: 'Scribe', kind: 'claude', scope: 'propose' });

// The proposer is a real personal access token on the "Scribe" profile: the policy gate only knows real principals.
const proposer = runtime.policy.store.getProfileByLabel('Scribe')
  ? new (await import('../../src/auth/pats.js')).PatService({
      store: new (await import('../../src/auth/store.js')).AuthStore(db),
      event: () => undefined,
      now: () => Math.floor(Date.now() / 1000),
    }).create({ name: 'e2e proposer', profileId: profile.id }).pat
  : undefined;

async function propose(text: string): Promise<string> {
  const r = await engine.run(
    'replaceDocumentBlocks',
    {
      path: { resourceId: 'res1', documentId: 'd_res1' },
      body: {
        blocks: [
          { kind: 'paragraph', content: [{ text }] },
          { kind: 'paragraph', content: [{ text: 'A second paragraph' }] },
        ],
      },
    },
    {
      project: PROJECT,
      origin: {
        kind: 'mcp',
        tool: 'lk_api_write',
        principal: { principalId: proposer?.id ?? 'unknown', profile: profile.label, label: 'e2e proposer' },
      },
    },
  );
  return r.status === 'proposal_captured' ? r.proposalId : 'none';
}

// Control server: the test starts work here. Loopback only.
createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/job') {
      const steps = Number(url.searchParams.get('steps') ?? 5);
      const r = await engine.submit({
        project: PROJECT,
        kind: 'batch_ops',
        title: url.searchParams.get('title') ?? 'E2E batch',
        origin,
        steps: Array.from({ length: steps }, (_, i) => ({
          op: 'replaceDocumentBlocks',
          params: {
            path: { resourceId: 'res1', documentId: 'd_res1' },
            body: { blocks: [{ kind: 'paragraph', content: [{ text: `Step ${i}` }] }] },
          },
        })),
      });
      res.end(JSON.stringify(r));
    } else if (url.pathname === '/proposal') {
      res.end(JSON.stringify({ proposalId: await propose(url.searchParams.get('text') ?? 'Proposed text') }));
    } else if (url.pathname === '/ready') {
      res.end('{"ready":true}');
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  })().catch((e: unknown) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e) }));
  });
}).listen(PORT + 1, '127.0.0.1');

process.stdout.write(`e2e bridge ready at ${publicUrl}\n`);
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    void runtime
      .shutdown(500)
      .then(() => app.close())
      .then(() => process.exit(0));
  });
}
