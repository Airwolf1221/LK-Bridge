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
import { MockLk, type MockRequest, type MockResponse } from '../contract/mock-lk.js';
import { SidebarModel } from '../facts/sidebar-model.js';
import { LkModel } from '../jobs/lk-model.js';
import { mintClientId } from '../../src/jobs/index.js';
import { getSection, toMarkdown } from '../../src/markdown/index.js';
import { planPageWrite, sha256 } from '../../src/pages/index.js';
import { observationFromResource } from '../../src/tree/classify.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

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
// v2 C2a: a page whose sidebar is modelled (versions, If-Match, rows), for a proposal that touches protected canon.
// v3 F3c (ADR 0051 decision 4): a Working page, made canon the only way the lifecycle guard allows (C2c): promote_page.
// So the fixture has the smallest AI REPOSITORY promote_page needs: its root, the two lifecycle indexes and a
// destination index, with Inae as a [BWRK] page under [INDEX] Working.
const ROOT = 'airoot01';
const INDEXES = { working: 'working1', archived: 'archive1', characters: 'charidx1' } as const;
model.seedResource(ROOT, { name: 'AI REPOSITORY', blocks: [] });
model.seedResource(INDEXES.working, { name: '[INDEX] Working', parentId: ROOT, blocks: [] });
model.seedResource(INDEXES.archived, { name: '[INDEX] Archived', parentId: ROOT, blocks: [] });
model.seedResource(INDEXES.characters, { name: '[INDEX] Characters', parentId: ROOT, blocks: [] });
model.seedResource('res3', { name: '[BWRK] Inae Mikumo', parentId: INDEXES.working, blocks: [] });
model.resources.get('res3')!.tags = ['Working'];
const sidebars = new SidebarModel(() => undefined);
sidebars.page('res3', [
  SidebarModel.kv('kvres301', 'PROPERTIES', [
    ['Reference Type', 'Character Core'],
    ['Status', 'Working'],
    ['Continuity Type', 'CANON'],
  ]),
]);
type Route = (req: MockRequest, parts: string[]) => MockResponse | undefined;
const lkRouter = model as unknown as { route: Route };
const ownRoute: Route = lkRouter.route.bind(model);
/** A resource as the model holds it now (its name, tags and parent change as promote_page writes them). */
const viewOf = (id: string) => {
  const r = model.resources.get(id);
  return r
    ? {
        id,
        name: r.name,
        tags: r.tags,
        ...(r.parentId ? { parentId: r.parentId } : {}),
        documents: r.documents.map((d) => ({ id: d, name: 'Main', type: 'page' })),
      }
    : undefined;
};
lkRouter.route = (req, parts) => sidebars.respond(req, viewOf) ?? ownRoute(req, parts);
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
const proposerPat = runtime.policy.store.getProfileByLabel('Scribe')
  ? new (await import('../../src/auth/pats.js')).PatService({
      store: new (await import('../../src/auth/store.js')).AuthStore(db),
      event: () => undefined,
      now: () => Math.floor(Date.now() / 1000),
    }).create({ name: 'e2e proposer', profileId: profile.id })
  : undefined;
const proposer = proposerPat?.pat;

// v3 F3c (ADR 0051 decision 4): the repository tree of the small AI REPOSITORY above, built as the tests' worlds build
// it (one observation per page), and the two lifecycle indexes confirmed as the owner does on the dashboard.
runtime.projects.setSetting(PROJECT, 'aiRepositoryRootId', ROOT);
let observedAt = Date.now() * 1000;
/** The tree observes these pages as the model holds them now. */
const observe = (ids: readonly string[]) => {
  const tree = runtime.tree;
  const ctx = { projectId: PROJECT, rootId: ROOT, settings: tree.settings(PROJECT), by: 'build' as const };
  observedAt = Math.max(observedAt, Date.now() * 1000);
  for (const id of ids) {
    const obs = observationFromResource(id === 'res3' ? { ...viewOf(id), properties: [] } : viewOf(id));
    if (obs) tree.store.applyObservation(ctx, obs, ++observedAt);
  }
  tree.store.recomputePaths(PROJECT, ROOT);
};
/** Inae back to Working ([BWRK] under [INDEX] Working, Status Working), so each run of the test promotes her afresh. */
const resetInae = () => {
  const r = model.resources.get('res3')!;
  r.name = '[BWRK] Inae Mikumo';
  r.parentId = INDEXES.working;
  r.tags = ['Working'];
  const status = sidebars.pages.get('res3')!.props[0]!.rows!.find((x) => x.key === 'Status')!;
  status.content = [{ text: 'Working' }];
  observe(['res3']);
};
{
  runtime.tree.store.ensureRoot(PROJECT, ROOT);
  observe([ROOT, INDEXES.working, INDEXES.archived, INDEXES.characters, 'res3']);
  runtime.tree.store.setConfirmed(PROJECT, Date.now(), 'build');
  const found = runtime.lifecycle.find(PROJECT);
  if (found.working.status !== 'found' || found.archived.status !== 'found')
    throw new Error(`e2e: lifecycle indexes not found: ${JSON.stringify(found)}`);
  runtime.lifecycle.update('owner', PROJECT, {
    workingIndexId: found.working.node!.id,
    archiveIndexId: found.archived.node!.id,
  });
}

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

/**
 * v2 C2a: an agent at scope propose makes Inae canon (Status Working → Authoritative): a proposal only "accept as canon"
 * can run. v3 F3c (ADR 0051 decision 4): through promote_page, over MCP with the proposer's token, as an agent does.
 * Writing the Status row directly is refused by the C2c lifecycle guard (a lifecycle change goes through its tools).
 */
async function proposeCanon(): Promise<string> {
  if (!proposerPat) return 'none';
  resetInae();
  const client = new Client({ name: 'lk-bridge-e2e', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${proposerPat.token}` } },
    }),
  );
  try {
    const res = await client.callTool({
      name: 'promote_page',
      arguments: { page: 'res3', destination: INDEXES.characters, project: 'test' },
    });
    const text = (res.content as { type: string; text?: string }[])[0]?.text ?? '';
    const body = JSON.parse(text.split('\n').slice(0, -1).join('\n')) as {
      status?: string;
      proposalId?: string;
      requiresCanonicalApproval?: boolean;
    };
    return body.status === 'proposal_captured' && typeof body.proposalId === 'string'
      ? body.proposalId
      : `none: ${text.slice(0, 500)}`;
  } finally {
    await client.close();
  }
}

/**
 * v3 F5b (ADR 0068): the Arkona pack's governance for the Automation page's tests, on first use: one governance page
 * holding every pinned section (as the sandbox checks do), "Approved Narrow Automations" LAST with the block-id sweep's
 * paragraph at its end (the model appends inserted blocks), every source pointed at it, and the pack approved.
 */
let automationReady: Promise<void> | null = null;
function setUpAutomation(): Promise<void> {
  automationReady ??= (async () => {
    const packs = runtime.packs;
    packs.ensureSeeded();
    const pack = packs.get('arkona')!;
    const sweep =
      'Assign Block IDs Sweep (owner approval, 17 November 2026): enabling it is the activation, and this approval establishes no wider repair whitelist.';
    const supplementary =
      'Under the Exact Tag Grammar’s provision for a deliberately approved exception, the author has approved these existing tags as permitted supplementary tags on any eligible owner (author ruling, 23 November 2026): Cosmology, Chronology and Setting Framework.';
    const headings = [...new Set(pack.governance.flatMap((g) => g.sections ?? []))].filter(
      (h) => h !== 'Approved Narrow Automations',
    );
    let n = 0;
    const blocks: { id: string; kind: string; level?: number; content: { text: string }[] }[] = [
      { id: `gv${n++}`, kind: 'heading', level: 1, content: [{ text: 'e2e governance' }] },
    ];
    for (const h of headings)
      blocks.push(
        { id: `gv${n++}`, kind: 'heading', level: 2, content: [{ text: h }] },
        {
          id: `gv${n++}`,
          kind: 'paragraph',
          content: [{ text: h === 'Approved Supplementary Tags' ? supplementary : `The rules of ${h}.` }],
        },
      );
    blocks.push(
      { id: `gv${n++}`, kind: 'heading', level: 2, content: [{ text: 'Approved Narrow Automations' }] },
      { id: `gv${n}`, kind: 'paragraph', content: [{ text: sweep }] },
    );
    const gov = model.seedResource('gov00001', { name: 'Repository Automation', parentId: ROOT, blocks });
    packs.store.setGovernance(
      'arkona',
      pack.governance.map((g) => ({
        ...g,
        project: 'test',
        resourceId: gov.resourceId,
        documentId: gov.documentId,
      })),
    );
    await packs.commands.approve('owner', 'arkona');
  })();
  return automationReady;
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
    } else if (url.pathname === '/canon-proposal') {
      res.end(JSON.stringify({ proposalId: await proposeCanon() }));
    } else if (url.pathname === '/canon-status') {
      res.end(
        JSON.stringify({ status: sidebars.rows('res3').find((r) => r.key === 'Status')?.text ?? null }),
      );
    } else if (url.pathname === '/page-proposal') {
      res.end(JSON.stringify({ proposalId: await proposePageWrite() }));
    } else if (url.pathname === '/automation-setup') {
      await setUpAutomation();
      res.end(JSON.stringify({ ok: (await runtime.automation.governanceState(PROJECT)).ok }));
    } else if (url.pathname === '/automation-fixture') {
      // v3 F5b: a night's run as the Overview's tile shows it (one page applied, two proposed).
      const a = runtime.automation;
      const runId = `aut_${randomBytes(8).toString('hex')}`;
      a.store.startRun(runId, PROJECT, 'nightly');
      a.store.addItem({
        runId,
        projectId: PROJECT,
        code: 'blank_paragraphs',
        pageId: 'res1',
        pageName: 'Kingdom',
        outcome: 'applied',
        reasonCode: null,
        reason: 'written, read back and verified',
        jobId: 'jfixture00000001',
        proposalId: null,
      });
      for (const page of ['res2', 'res3'])
        a.store.addItem({
          runId,
          projectId: PROJECT,
          code: 'out_of_order',
          pageId: page,
          pageName: page,
          outcome: 'proposed',
          reasonCode: null,
          reason: null,
          jobId: null,
          proposalId: 'pfixture00000001',
        });
      a.store.finishRun(runId, 'succeeded', 'blank_paragraphs: 1 page; out_of_order: 2 pages', null);
      res.end(JSON.stringify({ runId }));
    } else if (url.pathname === '/workstream-fixture') {
      // v3 F5c (ADR 0069, H8): a write recorded under a workstream label, as an agent's would be.
      const r = await engine.submit({
        project: PROJECT,
        kind: 'batch_ops',
        title: 'E2E workstream write',
        origin: { ...origin, workstream: 'E2E stream' },
        steps: [
          {
            op: 'replaceDocumentBlocks',
            params: {
              path: { resourceId: 'res1', documentId: 'd_res1' },
              body: { blocks: [{ kind: 'paragraph', content: [{ text: 'Workstream text' }] }] },
            },
          },
        ],
      });
      if ('jobId' in r) await engine.wait(PROJECT, r.jobId, 10_000);
      res.end(JSON.stringify(r));
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
