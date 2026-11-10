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
import { mintClientId } from '../../src/jobs/index.js';
import { getSection, toMarkdown } from '../../src/markdown/index.js';
import { planPageWrite, sha256 } from '../../src/pages/index.js';

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
// v2 C1: a page for a write_page proposal (an infobox and an unsupported block: keep regions in the Markdown diff).
model.seedResource('res2', {
  name: 'Asagiri Miyabi',
  blocks: [
    { id: 'mh1', kind: 'heading', level: 2, content: [{ text: 'Biography' }] },
    { id: 'mp1', kind: 'paragraph', content: [{ text: 'Born on Kumikas 1st, 4A 881.' }] },
    { id: 'mib1', kind: 'infobox', layout: 'wrapRight', width: 40, rows: [] },
    { id: 'mh2', kind: 'heading', level: 2, content: [{ text: 'Relations' }] },
    { id: 'mp2', kind: 'paragraph', content: [{ text: 'Sister of Kaede.' }] },
    { id: 'mun1', kind: 'unsupported' },
  ],
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
  // OPS2: the encrypted secret store (a throwaway key made here).
  SECRETS_MASTER_KEY: secret(),
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

/**
 * v2 C1: a write_page proposal, planned as the tool plans one (B1's converter, the high-level operation with the page's
 * Markdown before and after), so the dashboard's Markdown diff can be seen in a real browser. The tool itself needs the
 * repository tree, which this harness does not build; test/pages covers the tool end to end.
 */
async function proposePageWrite(): Promise<string> {
  const path = { resourceId: 'res2', documentId: 'd_res2' };
  const who = {
    kind: 'mcp' as const,
    tool: 'write_page',
    principal: { principalId: proposer?.id ?? 'unknown', profile: profile.label, label: 'e2e proposer' },
  };
  const read = await engine.run('getDocumentBlocks', { path }, { project: PROJECT, origin: who });
  if (read.status !== 'succeeded') return 'none';
  const current = read.result as { version: string; blocks: never[] };
  const section = getSection(toMarkdown({ blocks: current.blocks }).markdown, 'Biography').markdown;
  const markdown = section.replace('Born on Kumikas 1st', 'Born at dawn on Kumikas 1st');
  const plan = planPageWrite(
    current,
    { mode: 'replace_section', section: 'Biography', markdown },
    { mintBlockId: mintClientId },
  );
  const r = await engine.run(
    'replaceDocumentBlocks',
    { path, ifMatch: plan.version, body: { blocks: plan.blocks } },
    {
      project: PROJECT,
      origin: who,
      verifyAfterWrite: true,
      journalOperation: {
        tool: 'write_page',
        mode: 'replace_section',
        section: 'Biography',
        markdownSha256: sha256(markdown),
      },
      proposal: {
        operation: {
          tool: 'write_page',
          page: { id: 'res2', name: 'Asagiri Miyabi' },
          document: { id: 'd_res2', name: 'Main' },
          mode: 'replace_section',
          section: 'Biography',
          markdown,
          plannedOn: plan.version,
          counts: plan.counts,
          before: plan.before,
          after: plan.after,
        },
        summary: 'write_page replace_section “Biography” on “Asagiri Miyabi” (Main)',
        prefetched: [{ op: 'getDocumentBlocks', path, body: read.result }],
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
    } else if (url.pathname === '/page-proposal') {
      res.end(JSON.stringify({ proposalId: await proposePageWrite() }));
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
