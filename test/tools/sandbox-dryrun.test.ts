import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { formatReport, runSmoke, SandboxGuardError, type SmokeTarget } from '../sandbox/smoke.js';
import { API_KEY, PROJECT, startStack, type Stack } from './helpers.js';
import { specRespond } from './spec-mock.js';

/** The sandbox script's own logic, run against the spec-driven mock (no real LegendKeeper involved). */
let stack: Stack;
const target = (): SmokeTarget => ({
  engine: stack.runtime.engine,
  lk: stack.runtime.lk,
  projectId: PROJECT,
  baseUrl: stack.mock.url,
  apiKey: API_KEY,
});

beforeAll(async () => {
  // listProjects must answer the sandbox project, as the real key's project would.
  stack = await startStack({
    respond: specRespond({
      listProjects: () => ({
        status: 200,
        body: { data: [{ id: PROJECT, name: 'Sandbox' }], hasMore: false, nextCursor: null },
      }),
    }),
    uploadGuard: {
      resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      allowAddress: (a) => a === '127.0.0.1',
    },
  });
});
afterAll(() => stack.close());

describe('sandbox smoke script (dry run)', () => {
  it('refuses to run against any project other than the one it was given', async () => {
    await expect(runSmoke(target(), 'proj_somebody_else')).rejects.toBeInstanceOf(SandboxGuardError);
    expect(stack.mock.calls.filter((c) => c.method !== 'GET')).toHaveLength(0); // nothing was written
  });

  it('refuses when the key can see a different project', async () => {
    const other = await startStack({
      respond: specRespond({
        listProjects: () => ({
          status: 200,
          body: { data: [{ id: 'proj_other' }], hasMore: false, nextCursor: null },
        }),
      }),
    });
    try {
      await expect(
        runSmoke(
          { ...target(), engine: other.runtime.engine, lk: other.runtime.lk, baseUrl: other.mock.url },
          PROJECT,
        ),
      ).rejects.toBeInstanceOf(SandboxGuardError);
      expect(other.mock.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('runs every check and family to completion, and reports each', async () => {
    const findings = await runSmoke(target(), PROJECT);
    const ids = findings.map((f) => f.id);
    for (const id of [
      'a',
      'b',
      'c',
      'd.resources',
      'd.documents',
      'd.blocks',
      'd.infobox',
      'd.properties',
      'd.timeline',
      'd.map',
      'd.board',
      'd.assets',
      'd.calendars',
      'e',
      'f',
      'cleanup',
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(findings.find((f) => f.id === 'c')!.verdict).toBe('skipped');
    // The mock does not echo x-request-id, so check (a) must say so rather than pass.
    expect(findings.find((f) => f.id === 'a')!.verdict).toBe('fail');
    expect(findings.find((f) => f.id === 'cleanup')!.verdict).toBe('pass');
    const failed = findings.filter((f) => f.verdict === 'fail').map((f) => `${f.id}: ${f.detail}`);
    writeFileSync('/tmp/dry.txt', formatReport(findings));
    // Checks that need real LK data or semantics (an echoed request id, block ids and versions, a real signed URL)
    // cannot pass against generated bodies; every other family must run clean.
    const needsRealLk = ['a:', 'b:', 'd.blocks:', 'd.infobox:', 'e:'];
    expect(failed.filter((f) => !needsRealLk.some((p) => f.startsWith(p)))).toEqual([]);
  });
});
