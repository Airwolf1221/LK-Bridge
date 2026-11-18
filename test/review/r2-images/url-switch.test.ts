/**
 * CR2 images, attack A8 (an outside fetch the owner switched off). `.env.example` documents
 * `UPLOAD_ALLOW_URL_SOURCE=false` as "base64 only, no fetching of image URLs" (and docs/tools.md's settings table as
 * "false: base64 only"). ADR 0049 decision 11 makes `file.download_url` fetch "whatever UPLOAD_ALLOW_URL_SOURCE says"
 * (src/mcp/tools/upload-source.ts: the `fileUrl` branch never reads `allowUrlSource`), and `file` is accepted from any
 * connection, for any https host (nothing ties it to ChatGPT's file store).
 *
 * The owner's switch is the claim checked here: with it off, an agent cannot make the bridge fetch a URL it chose.
 * ADR 0057 decision 7 (the owner's, 17 November 2026): `file` gets a switch of its own, the project setting
 * `fileSourceEnabled` (on by default; switching it on needs re-authentication, test/admin/r2-scope-reauth.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TOOLS_SETTINGS } from '../../../src/config/index.js';
import { fixture, imagesWorld, type ImagesWorld } from '../../images/world.js';
import { PROJECT } from '../../tools/helpers.js';

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

  // ADR 0057 decision 7 (R2-45): ChatGPT's file source has its own switch, the project's `fileSourceEnabled` (on by
  // default), separate from UPLOAD_ALLOW_URL_SOURCE (which covers `url` only).
  const fileCall = async (world: ImagesWorld) => {
    world.files.set('anything', { status: 200, type: 'text/html', body: fixture('alpha.png') });
    const { token } = world.stack.newToken('claude-code', 'write');
    return call(
      world,
      {
        file: {
          download_url: `https://storage.test:${world.port}/f/anything?any=thing`,
          file_id: 'not-a-chatgpt-file',
        },
        name: 'Fetched anyway',
        stage: true,
      },
      token,
    );
  };

  it('file.download_url with the file source switched off: nothing is fetched (UPLOAD_FILE_SOURCE_DISABLED)', async () => {
    w = await imagesWorld({
      tools: { upload: { ...DEFAULT_TOOLS_SETTINGS.upload, allowUrlSource: false } },
    });
    w.stack.runtime.projects.setSetting(PROJECT, 'fileSourceEnabled', false);
    const r = await fileCall(w);
    expect({ fetched: w.fileStats.requests.length, outcome: code(r) ?? String(r.body.status) }).toEqual({
      fetched: 0,
      outcome: 'UPLOAD_FILE_SOURCE_DISABLED',
    });
  });

  it('the switches are separate: URL sources off, the file source on (the default), the file is fetched', async () => {
    w = await imagesWorld({
      tools: { upload: { ...DEFAULT_TOOLS_SETTINGS.upload, allowUrlSource: false } },
    });
    const r = await fileCall(w);
    expect(w.fileStats.requests.length, r.text).toBe(1);
    expect(code(r), r.text).toBeUndefined();
  });

  it('URL sources on, the file source off: url is fetched, file is not', async () => {
    w = await imagesWorld();
    w.stack.runtime.projects.setSetting(PROJECT, 'fileSourceEnabled', false);
    const r = await fileCall(w);
    expect(code(r), r.text).toBe('UPLOAD_FILE_SOURCE_DISABLED');
    w.web.set('pic.png', { type: 'image/png', body: fixture('alpha.png') });
    const u = await call(w, { url: `https://assets.test:${w.port}/img/pic.png`, name: 'Pic', stage: true });
    expect(code(u), u.text).toBeUndefined();
    expect(w.fileStats.requests.length).toBe(0);
  });
});
