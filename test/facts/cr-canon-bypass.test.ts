/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * Adversarial review: ways an agent can make a protected canonical change WITHOUT the owner's "Approve and accept as
 * canon". Each test asserts the SAFE behaviour; a failing test is a confirmed bypass. Every attack has its own pages.
 * v3 F12 (ADR 0081): at scope `write` a protected change is direct, so the agent here is at scope `propose`, where a
 * protected change must still become a CANONICAL proposal (one an ordinary Approve cannot run).
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROOT } from '../discover/world.js';
import { PROJECT } from '../tools/helpers.js';
import { factsWorld, kvText, SidebarModel, type FactsWorld } from './world.js';

/** Fresh pages: `a*` Authoritative, `o*` Status Outline (no lifecycle state, so only the canon guard is in play). */
const PAGES = {
  f1a: ['crf1auth', '[BSRC] F1 Canon', 'Authoritative'],
  f1o: ['crf1outl', '[BSRC] F1 Outline', 'Outline'],
  f2a: ['crf2auth', '[BSRC] F2 Canon', 'Authoritative'],
  f2o: ['crf2outl', '[BSRC] F2 Outline', 'Outline'],
  f3o: ['crf3outl', '[BSRC] F3 Outline', 'Outline'],
  f1b: ['crf1bout', '[BSRC] F1b Outline', 'Outline'],
  f2c: ['crf2cout', '[BSRC] F2c Outline', 'Outline'],
} as const;
const kvId = (page: string) => `kv${page.slice(2)}`;

/**
 * The safe outcome of a protected change by a side route: a canonical proposal, or (when the lifecycle guard sees a
 * lifecycle change in it) a refusal. Either way nothing was written.
 */
const proposedOrRefused = (body: Record<string, unknown>, text: string) => {
  const err = body.error as { code?: string } | undefined;
  if (err) expect(err.code, text).toBe('POLICY_DENIED');
  else expect(body, text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
};

let w: FactsWorld;
let writer: Client;
/** A connection at scope write, for the pages an attack needs to exist first (made directly, as any writer can). */
let setup: Client;
let mark = 0;
const writesSince = () => w.sidebars.requests.slice(mark).filter((x) => x.method !== 'GET');
const rowId = (page: string, key: string) => w.sidebars.rows(page).find((r) => r.key === key)!.id;
const rowPath = (page: string, key: string) => ({
  resourceId: page,
  propertyId: kvId(page),
  rowId: rowId(page, key),
});
/** The rows' version, read the way an agent reads it (lk_api_read listPropertyRows). */
const rowsVersion = async (page: string): Promise<string> => {
  const r = await w.stack.call(writer, 'lk_api_read', {
    operationId: 'listPropertyRows',
    params: { path: { resourceId: page, propertyId: kvId(page) } },
    detail: 'full',
  });
  const v = (r.body.result?.version ?? r.body.version) as string | undefined;
  expect(v, r.text).toMatch(/^v\d+$/);
  return v!;
};
const waitJob = async (jobId: string) => w.stack.runtime.engine.wait(PROJECT, jobId, 10_000);

beforeAll(async () => {
  w = await factsWorld({
    env: { MCP_EXPOSE_PER_OP_TOOLS: 'true' },
    seed: (world) => {
      for (const [id, name] of Object.values(PAGES)) world.repo.seed({ id, name, parentId: ROOT });
    },
  });
  for (const [id, , status] of Object.values(PAGES)) {
    w.sidebars.page(id, [
      SidebarModel.kv(kvId(id), 'PROPERTIES', [
        ['Reference Type', 'General Source'],
        ['Status', status],
        ['Scope', 'A test page'],
      ]),
    ]);
  }
  writer = await w.stack.connect(w.stack.newToken('cr-canon-propose', 'propose').token);
  setup = await w.stack.connect();
});
afterAll(async () => w.close());
beforeEach(() => {
  mark = w.sidebars.requests.length;
});

describe('F1: a failing createResourceFromTemplate whose body.id names an EXISTING page blinds the entry check', () => {
  // canonical.ts seeds `sidebars.set(body.id, template)` before LegendKeeper has created anything. With onError
  // "continue", the create fails (409 DUPLICATE_ID / 404) and the next steps run against the REAL page; a row write that
  // carries the agent's own ifMatch is never re-checked inside the lock (canonical.ts inLock: ifMatch on *PropertyRow).
  it('Status FROM Authoritative without canonical approval', async () => {
    const page = PAGES.f1a[0];
    const v = await rowsVersion(page);
    mark = w.sidebars.requests.length;
    const r = await w.stack.call(writer, 'lk_api_batch', {
      onError: 'continue',
      calls: [
        // any template id works; one that does not exist reads as an empty sidebar (404 => [])
        { operationId: 'createResourceFromTemplate', params: { body: { templateId: 'nosuchtp', id: page } } },
        {
          operationId: 'updatePropertyRow',
          params: { path: rowPath(page, 'Status'), ifMatch: v, body: { content: [{ text: 'Outline' }] } },
        },
      ],
    });
    if (r.body.jobId) await waitJob(String(r.body.jobId));
    // SAFE: a canonical proposal (or a refusal); nothing written either way.
    expect(kvText(w.sidebars.rows(page))).toContain('Status=Authoritative');
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
  });

  it('Status TO Authoritative the same way', async () => {
    const page = PAGES.f1o[0];
    const v = await rowsVersion(page);
    const r = await w.stack.call(writer, 'lk_api_batch', {
      onError: 'continue',
      calls: [
        { operationId: 'createResourceFromTemplate', params: { body: { templateId: 'nosuchtp', id: page } } },
        {
          operationId: 'updatePropertyRow',
          params: {
            path: rowPath(page, 'Status'),
            ifMatch: v,
            body: { content: [{ text: 'Authoritative' }] },
          },
        },
      ],
    });
    if (r.body.jobId) await waitJob(String(r.body.jobId));
    expect(kvText(w.sidebars.rows(page))).not.toContain('Status=Authoritative');
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
  });

  it('F1b (no template needed): a step that FAILS still changes the simulated sidebar, blinding the next step', async () => {
    // Step 1 deletes the (non-protected) Status Outline row with a stale ifMatch: the entry simulation removes the row,
    // so step 2 "targets a row that is not there" (applySidebarWrite => null => skipped). At run time step 1 fails
    // (VERSION_CONFLICT, nothing sent), onError "continue" runs step 2, whose own ifMatch skips the in-lock check, and
    // LegendKeeper accepts it (the version did not move).
    const page = PAGES.f1b[0];
    const v = await rowsVersion(page);
    const status = rowPath(page, 'Status');
    const r = await w.stack.call(writer, 'lk_api_batch', {
      onError: 'continue',
      calls: [
        { operationId: 'deletePropertyRow', params: { path: status, ifMatch: 'v999' } },
        {
          operationId: 'updatePropertyRow',
          params: { path: status, ifMatch: v, body: { content: [{ text: 'Authoritative' }] } },
        },
      ],
    });
    if (r.body.jobId) await waitJob(String(r.body.jobId));
    expect(kvText(w.sidebars.rows(page))).not.toContain('Status=Authoritative');
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
  });
});

describe('F2: a mention run’s read-only `name` (and a label-less mention) is judged as text the agent chose', () => {
  // valueText() reads mention.text ?? mention.name ?? mention.resourceId. LegendKeeper's spec (Run): "`name` is the
  // resource's current name; it is read-only." The guard judges what the AGENT sent; LegendKeeper stores the mention and
  // reads back the real name. Model LegendKeeper faithfully: after every row write, a mention's name is the page's name.
  const realNames = () => {
    w.sidebars.mangle = (_req, sb) => {
      for (const p of sb.props)
        for (const row of p.rows ?? [])
          for (const run of row.content) {
            const m = run.mention as { resourceId?: string; name?: string } | undefined;
            if (!m?.resourceId) continue;
            const n = w.sidebars.names(m.resourceId);
            if (n === undefined) delete m.name;
            else m.name = n;
          }
    };
  };

  it('Status FROM Authoritative in one plain lk_api_write (entry and in-lock check both fooled)', async () => {
    const page = PAGES.f2a[0];
    realNames();
    try {
      const r = await w.stack.call(writer, 'lk_api_write', {
        operationId: 'updatePropertyRow',
        params: {
          path: rowPath(page, 'Status'),
          // a mention of another page, with a forged read-only name
          body: { content: [{ mention: { resourceId: PAGES.f3o[0], name: 'Authoritative' } }] },
        },
      });
      const after = kvText(w.sidebars.rows(page));
      expect(after, JSON.stringify(r.body)).toContain('Status=Authoritative');
      proposedOrRefused(r.body, r.text);
    } finally {
      w.sidebars.mangle = null;
    }
  });

  it('Status TO Authoritative: a label-less mention of a page named “Authoritative”', async () => {
    const page = PAGES.f2o[0];
    realNames();
    try {
      // The agent makes a page named exactly “Authoritative” (no fact is written; nothing guards a name)…
      const target = await w.stack.call(setup, 'lk_api_write', {
        operationId: 'createResource',
        params: { body: { id: 'authpg01', name: 'Authoritative' } },
      });
      expect(target.body, target.text).toMatchObject({ status: 'succeeded' });
      // …then points the Status at it. The guard judges the run as its resourceId (“authpg01”).
      const r = await w.stack.call(writer, 'lk_api_write', {
        operationId: 'updatePropertyRow',
        params: {
          path: rowPath(page, 'Status'),
          body: { content: [{ mention: { resourceId: 'authpg01' } }] },
        },
      });
      const after = kvText(w.sidebars.rows(page));
      expect(after, JSON.stringify(r.body)).not.toContain('Status=Authoritative');
      proposedOrRefused(r.body, r.text);
    } finally {
      w.sidebars.mangle = null;
    }
  });

  it('F2c: even without a forged name, renaming the mentioned page later turns the Status into Authoritative', async () => {
    const page = PAGES.f2c[0];
    realNames();
    try {
      const target = await w.stack.call(setup, 'lk_api_write', {
        operationId: 'createResource',
        params: { body: { id: 'draftpg1', name: 'Draft' } },
      });
      expect(target.body, target.text).toMatchObject({ status: 'succeeded' });
      // Status Outline -> a mention of “Draft”: no rule touches it, written directly.
      const point = await w.stack.call(writer, 'lk_api_write', {
        operationId: 'updatePropertyRow',
        params: {
          path: rowPath(page, 'Status'),
          body: { content: [{ mention: { resourceId: 'draftpg1' } }] },
        },
      });
      // CR-2026-11 (CR-11): a page mention in a protected fact is itself a protected change (and refused for Status).
      proposedOrRefused(point.body, point.text);
      // A rename is no sidebar write: the canon guard never looks at it.
      const rename = await w.stack.call(setup, 'lk_api_write', {
        operationId: 'updateResource',
        params: { path: { resourceId: 'draftpg1' }, body: { name: 'Authoritative' } },
      });
      // LegendKeeper reads a mention's name live: refresh the stored names as a read would show them.
      w.sidebars.mangle!({} as never, w.sidebars.pages.get(page)!);
      const after = kvText(w.sidebars.rows(page));
      expect(after, JSON.stringify(rename.body)).not.toContain('Status=Authoritative');
    } finally {
      w.sidebars.mangle = null;
    }
  });

  it('…and the bridge itself then treats that page as Authoritative (its delete now needs canon approval)', async () => {
    // Shows the previous write produced bridge-recognised canon (not just a cosmetic label).
    const page = PAGES.f2o[0];
    const dry = await w.stack.call(writer, 'lk_api_write', {
      operationId: 'deleteResource',
      params: { path: { resourceId: page } },
    });
    // If F2-to was blocked (fixed), the page is not Authoritative and the delete goes through; either outcome is
    // consistent. Only the combination "F2-to written" + "delete now canonical" demonstrates the bypass.
    if (kvText(w.sidebars.rows(page)).includes('Status=Authoritative')) {
      expect(dry.body).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    }
  });
});

describe('F3: Unicode look-alike keys and values are not normalised', () => {
  // factKey / factValueKey only trim, collapse \s and lower-case: no NFKC, no removal of format characters (U+200B,
  // U+200D, U+00AD are not \s). LegendKeeper shows “Status: Authoritative”.
  const cases: [string, string, string][] = [
    ['zero-width space in the key', 'Status\u200B', 'Authoritative'],
    ['fullwidth key', '\uFF33\uFF54\uFF41\uFF54\uFF55\uFF53', 'Authoritative'],
    ['Cyrillic u (U+0443) in the key', 'Stat\u0443s', 'Authoritative'],
    ['zero-width joiner inside the value', 'Status', 'Authori\u200Dtative'],
    ['soft hyphen inside the value', 'Status', 'Authori\u00ADtative'],
    [
      'fullwidth value',
      'Status',
      '\uFF21\uFF55\uFF54\uFF48\uFF4F\uFF52\uFF49\uFF54\uFF41\uFF54\uFF49\uFF56\uFF45',
    ],
  ];
  for (const [label, key, value] of cases) {
    // v3 F12 follow-up (ADR 0081 amendment 1, decision 2): a disguised VALUE is an invalid value, refused outright (the
    // allowed values listed); a disguised KEY with the plain value is Status Authoritative, as before.
    const disguisedValue = value !== 'Authoritative';
    it(`a new row (${label}) is ${disguisedValue ? 'refused as a look-alike of Authoritative' : 'judged as Status Authoritative'}`, async () => {
      const page = PAGES.f3o[0];
      const r = await w.stack.call(writer, 'lk_api_write', {
        operationId: 'createPropertyRow',
        params: { path: { resourceId: page, propertyId: kvId(page) }, body: { key, text: value } },
      });
      if (disguisedValue) {
        expect(r.body.error?.code, r.text).toBe('POLICY_DENIED');
        expect(r.body.error?.message, r.text).toMatch(
          /only looks like “Authoritative”.*not an allowed value/,
        );
      } else
        expect(r.body, r.text).toMatchObject({
          status: 'proposal_captured',
          requiresCanonicalApproval: true,
        });
      expect(writesSince()).toHaveLength(0);
    });
  }
});
