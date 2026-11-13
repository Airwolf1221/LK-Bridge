/**
 * The INNER half of test/tools/sandbox-runtime-readonly.test.ts (the owner's sandbox run of 12 November 2026). It does
 * nothing on its own: it runs only when the outer test starts it under Node's permission model, with every file write
 * outside one temporary directory refused and the working directory (the "app folder") read-only.
 *
 * It builds the sandbox runtime exactly as the five sandbox files do (`createSoakRuntime`), and the real boot path with
 * the DEFAULT tool settings (`images.dataDir: null`, the case that failed: "`images/` next to the database" was resolved
 * from the config's `./data/bridge.db`, under the app folder, and `mkdir upload-tmp` died with EACCES).
 */
import { mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/lk/index.js';
import { MockLk } from '../contract/mock-lk.js';
import { API_KEY, PROJECT, startStack, type Stack } from '../tools/helpers.js';
import { specRespond } from '../tools/spec-mock.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';

const restricted = process.env.LKB_FS_RESTRICTED === '1';

let mock: MockLk | undefined;
let soak: SoakRuntime | undefined;
let stack: Stack | undefined;
afterEach(async () => {
  await soak?.close();
  await stack?.close();
  await mock?.stop();
  soak = stack = undefined;
  mock = undefined;
});

describe.skipIf(!restricted)(
  'the sandbox runtime where nothing but a temporary directory may be written',
  () => {
    it('control: the working directory really is read-only here', () => {
      expect(() =>
        mkdirSync(join(process.cwd(), 'data', 'images', 'upload-tmp'), { recursive: true }),
      ).toThrow(/ERR_ACCESS_DENIED|Access to this API has been restricted/);
    });

    it('createSoakRuntime starts, and its image directory is inside its own temporary directory, not yet created', async () => {
      mock = new MockLk({
        clock: systemClock,
        apiKey: API_KEY,
        respond: specRespond({
          listProjects: () => ({
            status: 200,
            body: { data: [{ id: PROJECT, name: 'Test world' }], hasMore: false, nextCursor: null },
          }),
        }),
      });
      const url = await mock.start();
      soak = await createSoakRuntime({
        apiKey: API_KEY,
        project: 'sandbox',
        baseUrl: url,
        env: { WRITE_SPACING_MS: '0', WRITE_SPACING_STRETCHED_MS: '0' },
      });
      const images = soak.runtime.images;
      expect(images.dir.startsWith(join(tmpdir(), 'lkb-soak-'))).toBe(true);
      expect(images.dir).not.toContain(process.cwd());
      expect(existsSync(images.dir)).toBe(false); // a runtime that handles no upload touches no folder
      // v2 E1a: the snapshot store is inside the same temporary directory (it is created at start-up).
      const snaps = soak.runtime.snapshots;
      await snaps.settled();
      expect(snaps.store.dir.startsWith(join(tmpdir(), 'lkb-soak-'))).toBe(true);
      expect(snaps.store.dir).not.toContain(process.cwd());
    });

    it('the real boot path with the default tool settings derives its directory from the database it was given', async () => {
      stack = await startStack();
      const images = stack.runtime.images;
      expect(stack.runtime.config.server.dbPath).toBe('./data/bridge.db'); // the config's default: under the app folder
      expect(images.dir.startsWith(tmpdir())).toBe(true);
      expect(images.dir).not.toContain(process.cwd());
      expect(existsSync(images.dir)).toBe(false);
      await stack.runtime.snapshots.settled();
      expect(stack.runtime.snapshots.store.dir.startsWith(tmpdir())).toBe(true);
      expect(stack.runtime.snapshots.store.dir).not.toContain(process.cwd());
    });
  },
);
