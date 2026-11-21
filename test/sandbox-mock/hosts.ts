/**
 * CR-2026-11-R4 (the owner's request S): the sandbox runtime on the mock exactly as `sandboxOnMock` (harness.ts) makes
 * it, given the mock world's own asset and upload hosts as well. On the server the sandbox runtime downloads images
 * from LegendKeeper's asset hosts and PUTs uploads to its storage host, on port 443, through the production address
 * guard; the mock's are on loopback, on a port of their own, with a test certificate, so the production guard refuses
 * them ("Only port 443 is allowed"): the snapshot and audits checks' image upload and their full snapshot's library
 * downloads stopped there. This passes the world's guard and hosts, as the sandbox dry runs of assumptions-r2 and of
 * the write-scope rehearsal did before (harness.ts could take the two options; this file is then not needed).
 */
import { Writable } from 'node:stream';
import type { GuardOptions } from '../../src/mcp/tools/upload-http.js';
import { ProjectStore } from '../../src/projects/index.js';
import { rawLk } from '../sandbox/f4b-probe.js';
import { createSoakRuntime } from '../sandbox/soak.js';
import { API_KEY, PROJECT, type Stack } from '../tools/helpers.js';
import { MOCK_LIMITS, type OnMock } from './harness.js';

const quiet = new Writable({
  write(_chunk: Buffer, _enc, done) {
    done();
  },
});

/** As `sandboxOnMock`, with the world's address guard and asset hosts (loopback only). */
export async function sandboxOnMockWithHosts(
  stack: Stack,
  hosts: { readonly uploadGuard: GuardOptions; readonly assetHosts: readonly string[] },
): Promise<OnMock> {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(stack.mock.url))
    throw new Error(`the mock LegendKeeper must be on loopback, not ${stack.mock.url}`);
  new ProjectStore(stack.db).setSandbox(PROJECT, true);
  const sb = await createSoakRuntime({
    logStream: quiet,
    apiKey: API_KEY,
    project: 'test',
    baseUrl: stack.mock.url,
    env: {
      WRITE_SPACING_MS: '0',
      WRITE_SPACING_STRETCHED_MS: '0',
      LK_TIER_LIMITS: JSON.stringify(MOCK_LIMITS),
    },
    uploadGuard: hosts.uploadGuard,
    images: { assetHosts: [...hosts.assetHosts] },
  });
  const raw = rawLk({ lk: sb.lk, projectId: sb.projectId, apiKey: API_KEY, baseUrl: stack.mock.url });
  return { sb, raw, bridgeDbPath: stack.dbPath, close: () => sb.close() };
}
