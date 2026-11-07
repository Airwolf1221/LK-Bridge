import {
  Client,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
  StreamableHTTPClientTransport,
  auth,
} from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  type McpServerLike,
  type McpToolProvider,
  ToolRegistrationError,
  bridgeInfoStub,
  registerTools,
} from '../../src/mcp/server.js';
import { Browser, type TestBridge, decide, reachConsent, startBridge } from './helpers.js';

/**
 * Requirements 13 and 14: the Streamable HTTP transport through the official MCP client SDK, the
 * tool seam, and the SDK's own OAuth client (discovery, DCR or CIMD, PKCE, resource, iss check,
 * refresh) completing the flow against the bridge, as a claude.ai-equivalent client would.
 */

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const echoTool: McpToolProvider<z.ZodObject<{ text: z.ZodString }>> = {
  name: 'echo',
  title: 'Echo',
  description: 'Echoes text back with a tiny image.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object({ text: z.string().max(100) }),
  handler: ({ text }, ctx) => ({
    content: [
      { type: 'text', text: `${text} from ${ctx.caller?.kind ?? 'nobody'}` },
      { type: 'image', data: PNG_1PX, mimeType: 'image/png' },
    ],
  }),
};

const failingTool: McpToolProvider = {
  name: 'explode',
  description: 'Always throws.',
  inputSchema: z.object({}),
  handler: () => {
    throw new Error('kaboom');
  },
};

const scopedTool: McpToolProvider = {
  name: 'needs_admin',
  description: 'Needs a scope nobody has.',
  inputSchema: z.object({}),
  requiredScopes: ['admin'],
  handler: () => ({ content: [{ type: 'text', text: 'should not run' }] }),
};

let bridge: TestBridge;
beforeAll(async () => {
  bridge = await startBridge({
    tools: [
      bridgeInfoStub(() => ({ version: '0.1.0', projectId: 'proj_test', readOnly: true, writersMax: 2 })),
      echoTool,
      failingTool,
      scopedTool,
    ],
  });
});
afterAll(() => bridge.close());

/** `fetch` that sends public URLs to the local listener: the stand-in for DNS and Caddy. */
const viaProxy = (b: TestBridge) => (url: string | URL, init?: RequestInit) =>
  fetch(b.local(String(url)), init);

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'lk-bridge-tests', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(bridge.mcpUrl), {
    fetch: viaProxy(bridge),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

describe('the tool seam (requirement 14)', () => {
  it('serves every provider through the official client, with text and image content', async () => {
    const pat = bridge.services.pats.create({ name: 'sdk' }).token;
    const client = await connect(pat);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['bridge_info', 'echo', 'explode', 'needs_admin']);
      const echoDef = tools.find((t) => t.name === 'echo');
      // Title and every annotation reach tools/list (follow-up item E).
      expect(echoDef?.title).toBe('Echo');
      expect(echoDef?.annotations).toEqual({
        title: 'Echo',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      const infoDef = tools.find((t) => t.name === 'bridge_info');
      expect(infoDef?.title).toBe('Bridge information');
      expect(infoDef?.annotations).toEqual({
        title: 'Bridge information',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      // A tool that declares nothing sends no annotations at all.
      expect(tools.find((t) => t.name === 'explode')?.annotations).toBeUndefined();
      expect(echoDef?.inputSchema).toMatchObject({
        type: 'object',
        properties: { text: { type: 'string' } },
      });

      const info = await client.callTool({ name: 'bridge_info', arguments: {} });
      const body = JSON.parse((info.content as { text: string }[])[0]?.text ?? '{}') as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        project: 'proj_test',
        readOnly: true,
        writersMax: 2,
        caller: { kind: 'pat' },
      });

      const echo = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });
      expect(echo.content).toEqual([
        { type: 'text', text: 'hello from pat' },
        { type: 'image', data: PNG_1PX, mimeType: 'image/png' },
      ]);

      const bad = await client.callTool({ name: 'echo', arguments: { text: 42 } });
      expect(bad.isError).toBe(true);

      const failed = await client.callTool({ name: 'explode', arguments: {} });
      expect(failed.isError).toBe(true);
      expect((failed.content as { text: string }[])[0]?.text).toContain('kaboom');

      const scoped = await client.callTool({ name: 'needs_admin', arguments: {} });
      expect(scoped.isError).toBe(true);
      expect((scoped.content as { text: string }[])[0]?.text).toContain('admin');
    } finally {
      await client.close();
    }
  });

  it('refuses invalid and duplicate tool names', () => {
    const server: McpServerLike = { registerTool: () => undefined as never };
    const log = bridge.app.log;
    expect(() => registerTools(server, { tools: [{ ...failingTool, name: 'has space' }], log })).toThrow(
      ToolRegistrationError,
    );
    expect(() => registerTools(server, { tools: [failingTool, failingTool], log })).toThrow(/Duplicate/);
  });

  it('refuses contradictory or non-boolean annotations', () => {
    const server: McpServerLike = { registerTool: () => undefined as never };
    const log = bridge.app.log;
    expect(() =>
      registerTools(server, {
        tools: [{ ...failingTool, annotations: { readOnlyHint: true, destructiveHint: true } }],
        log,
      }),
    ).toThrow(/read-only tool cannot also be destructive/);
    expect(() =>
      registerTools(server, {
        tools: [{ ...failingTool, annotations: { readOnlyHint: 'yes' as unknown as boolean } }],
        log,
      }),
    ).toThrow(/must be a boolean/);
  });
});

/** An OAuth client provider whose "browser" is the scripted owner: sign in and approve. */
class ScriptedProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authorization: URL | undefined;
  clientMetadataUrl?: string;

  constructor(
    readonly redirect: string,
    cimd?: string,
  ) {
    if (cimd) this.clientMetadataUrl = cimd;
  }

  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'SDK test client',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: OAuthTokens) {
    this.saved = t;
  }
  redirectToAuthorization(url: URL) {
    this.authorization = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

async function ownerApproves(url: URL): Promise<URL> {
  const browser = new Browser(bridge);
  const page = await reachConsent(browser, url.toString());
  if (page instanceof Response) throw new Error(`no consent page: ${page.status} ${await page.text()}`);
  return (await decide(browser, page, 'approve')).location;
}

describe('the official MCP SDK OAuth client completes the flow (requirement 13)', () => {
  it('with Dynamic Client Registration and the claude.ai callback', async () => {
    const provider = new ScriptedProvider('https://claude.ai/api/mcp/auth_callback');
    const fetchFn = viaProxy(bridge);
    expect(await auth(provider, { serverUrl: bridge.mcpUrl, fetchFn })).toBe('REDIRECT');
    const url = provider.authorization as URL;
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(bridge.mcpUrl);
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(provider.info?.client_id).toMatch(/^lkb_c_/);

    const callback = await ownerApproves(url);
    expect(
      await auth(provider, {
        serverUrl: bridge.mcpUrl,
        fetchFn,
        authorizationCode: callback.searchParams.get('code') as string,
        iss: callback.searchParams.get('iss') as string,
      }),
    ).toBe('AUTHORIZED');
    const first = provider.saved as OAuthTokens;
    expect(first.refresh_token).toBeDefined();

    const client = await connect(first.access_token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();

    // The SDK refreshes, and receives a rotated refresh token.
    provider.saved = { ...first, access_token: 'expired' };
    expect(await auth(provider, { serverUrl: bridge.mcpUrl, fetchFn })).toBe('AUTHORIZED');
    expect(provider.saved.refresh_token).not.toBe(first.refresh_token);
    const again = await connect(provider.saved.access_token);
    await again.close();
  });

  it('with a Client ID Metadata Document and a loopback callback', async () => {
    const cimdBridge = await startBridge({
      authOverrides: {
        fetchJson: (url) =>
          Promise.resolve({
            body: {
              client_id: url,
              client_name: 'SDK CIMD client',
              redirect_uris: ['http://127.0.0.1/callback'],
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
            },
            headers: {},
          }),
      },
    });
    try {
      const provider = new ScriptedProvider(
        'http://127.0.0.1:43210/callback',
        'https://client.example/oauth/metadata.json',
      );
      const fetchFn = viaProxy(cimdBridge);
      expect(await auth(provider, { serverUrl: cimdBridge.mcpUrl, fetchFn })).toBe('REDIRECT');
      const url = provider.authorization as URL;
      expect(url.searchParams.get('client_id')).toBe('https://client.example/oauth/metadata.json');
      const browser = new Browser(cimdBridge);
      const page = await reachConsent(browser, url.toString());
      if (page instanceof Response) throw new Error(`no consent page: ${page.status}`);
      expect(page.html).toContain('<p class="host">client.example</p>');
      const callback = (await decide(browser, page, 'approve')).location;
      expect(
        await auth(provider, {
          serverUrl: cimdBridge.mcpUrl,
          fetchFn,
          authorizationCode: callback.searchParams.get('code') as string,
          iss: callback.searchParams.get('iss') as string,
        }),
      ).toBe('AUTHORIZED');
      expect(provider.saved?.access_token).toBeDefined();
    } finally {
      await cimdBridge.close();
    }
  });
});
