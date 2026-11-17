/**
 * CR2 images, attack A8 (an outside fetch the owner switched off). `.env.example` documents
 * `UPLOAD_ALLOW_URL_SOURCE=false` as "base64 only, no fetching of image URLs" (and docs/tools.md's settings table as
 * "false: base64 only"). ADR 0049 decision 11 makes `file.download_url` fetch "whatever UPLOAD_ALLOW_URL_SOURCE says"
 * (src/mcp/tools/upload-source.ts: the `fileUrl` branch never reads `allowUrlSource`), and `file` is accepted from any
 * connection, for any https host (nothing ties it to ChatGPT's file store).
 *
 * The owner's switch is the claim checked here: with it off, an agent cannot make the bridge fetch a URL it chose.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TOOLS_SETTINGS } from '../../../src/config/index.js';
import { fixture, imagesWorld, type ImagesWorld } from '../../images/world.js';

let w: ImagesWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function call(world: ImagesWorld, args: Record<string, unknown>, token?: string) {
  const c = await world.stack.connect(token);
  return world.stack.call(c, 'upload_image', { project: 'test', ...args });
}
const code = (r: { body: Record<string, unknown> }) => (r.body.error as { code?: string } | undefined)?.code;

describe('A8: UPLOAD_ALLOW_URL_SOURCE=false', () => {
  it('url is refused before anything is fetched (HELD)', async () => {
    w = await imagesWorld({
      tools: { upload: { ...DEFAULT_TOOLS_SETTINGS.upload, allowUrlSource: false } },
    });
    w.web.set('pic.png', { type: 'image/png', body: fixture('alpha.png') });
    const r = await call(w, { url: `https://assets.test:${w.port}/img/pic.png`, name: 'Pic', stage: true });
    expect(code(r)).toBe('UPLOAD_URL_SOURCE_DISABLED');
  });

  // Open (CR-2026-11-R2 section 7): ADR 0049 decision 11 exempts `file` from the switch, .env.example says "base64 only"; the owner decides.
  it.fails(
    'file.download_url, given by any connection (a Claude token, not ChatGPT), to any host: nothing is fetched',
    async () => {
      w = await imagesWorld({
        tools: { upload: { ...DEFAULT_TOOLS_SETTINGS.upload, allowUrlSource: false } },
      });
      // Any https host the agent picks; the world's test seam resolves *.test to its loopback server.
      w.files.set('anything', { status: 200, type: 'text/html', body: fixture('alpha.png') });
      const { token } = w.stack.newToken('claude-code', 'write');
      const r = await call(
        w,
        {
          file: {
            download_url: `https://storage.test:${w.port}/f/anything?any=thing`,
            file_id: 'not-a-chatgpt-file',
          },
          name: 'Fetched anyway',
          stage: true,
        },
        token,
      );
      const fetched = w.fileStats.requests.length;
      expect({ fetched, outcome: code(r) ?? String(r.body.status) }).toEqual({
        fetched: 0,
        outcome: 'UPLOAD_URL_SOURCE_DISABLED',
      });
    },
  );
});
