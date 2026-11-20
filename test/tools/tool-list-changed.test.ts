/**
 * The owner's report (20 November 2026): after approving arkona-2026-11-20-f4b, a Claude session connected before the
 * approval kept the old tool list until the bridge restarted. Approving a pack version (or changing any setting) that
 * changes what is listed now sends `notifications/tools/list_changed` to every connected session listening for it, and
 * the session's next `tools/list` is worked out afresh. A change that lists the same tools sends nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import * as z from 'zod';
import { defineTool, READ_ANNOTATIONS } from '../../src/mcp/tools/define.js';
import type { McpToolProvider } from '../../src/mcp/server.js';
import { packWorld, type PackWorld } from '../packs/world.js';

let w: PackWorld;
let approvedAt = 0;

beforeAll(async () => {
  w = await packWorld();
  approvedAt = w.stack.runtime.packs.get('arkona')!.approved!.version;
  // A probe listed only once the owner has approved a LATER version of the pack than the one approved now: exactly how
  // a pack tool appears when its version is approved.
  const probe: McpToolProvider = defineTool({
    name: 'probe_after_approval',
    title: 'Probe',
    access: 'read',
    description: 'A test probe.',
    inputSchema: z.object({}),
    annotations: READ_ANNOTATIONS,
    listed: () => (w.stack.runtime.packs.get('arkona')?.approved?.version ?? 0) > approvedAt,
    handler: () => ({ content: [{ type: 'text', text: '{}' }] }),
  });
  (w.stack.runtime.tools as McpToolProvider[]).push(probe);
  w.stack.runtime.toolList.check();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

/** A client that keeps its list current from the notifications, as Claude does (2026-07-28, or a 2025-era one). */
async function listening(token = w.stack.token, era: 'modern' | 'legacy' = 'modern') {
  const changes: string[][] = [];
  const client = new Client(
    { name: 'lk-bridge-list-changed-test', version: '1.0.0' },
    {
      ...(era === 'modern' ? { versionNegotiation: { mode: 'auto' as const } } : {}),
      listChanged: {
        tools: {
          onChanged: (err, tools) => {
            if (!err && tools) changes.push(tools.map((t) => t.name));
          },
        },
      },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${w.stack.base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return { client, changes };
}

const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return ok();
};

describe('tools/list_changed (the owner’s report)', () => {
  it('advertises listChanged, and a pack approval that lists a new tool tells the connected session, whose list then has it', async () => {
    const { client, changes } = await listening();
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    const before = (await client.listTools()).tools.map((t) => t.name);
    expect(before).not.toContain('probe_after_approval');

    // A new version waiting for approval lists nothing new: no notification.
    w.stack.runtime.packs.commands.setTokens('owner', 'arkona', {
      race: { ...w.stack.runtime.packs.get('arkona')!.rules.tags.race, Kirin: 'Kirin' },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(changes).toEqual([]);

    // The owner approves it: the probe is listed, the session is told, and its list is worked out afresh.
    await w.stack.runtime.packs.commands.approve('owner', 'arkona');
    expect(await until(() => changes.length > 0)).toBe(true);
    expect(changes.at(-1)).toContain('probe_after_approval');
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('probe_after_approval');
    await client.close();
  });

  it('a profile’s scope change tells its sessions; the next list shows only what the new scope sees', async () => {
    const { token, profileId } = w.stack.newToken('list-changed-scope', 'write');
    const { client, changes } = await listening(token);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('write_page');
    w.stack.policy.store.updateScope(profileId, 'read');
    expect(await until(() => changes.length > 0)).toBe(true);
    expect(changes.at(-1)).not.toContain('write_page');
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('write_page');
    await client.close();
  });

  it('a 2025-era (stateless) session is told on its next request, on that request’s own response stream', async () => {
    const { token, profileId } = w.stack.newToken('list-changed-legacy', 'write');
    const { client, changes } = await listening(token, 'legacy');
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('write_page');
    // Nothing changed: an ordinary call carries no notification.
    await client.callTool({ name: 'list_projects', arguments: {} });
    await new Promise((r) => setTimeout(r, 200));
    expect(changes).toEqual([]);
    w.stack.policy.store.updateScope(profileId, 'read');
    // No stream is open, so nothing can arrive by itself; the next request carries it, and the list is re-read.
    await client.callTool({ name: 'list_projects', arguments: {} });
    expect(await until(() => changes.length > 0)).toBe(true);
    expect(changes.at(-1)).not.toContain('write_page');
    // Told once: the next call carries nothing more.
    const told = changes.length;
    await client.callTool({ name: 'list_projects', arguments: {} });
    await new Promise((r) => setTimeout(r, 200));
    expect(changes.length).toBe(told);
    await client.close();
  });

  it('a change that lists the same tools sends nothing', () => {
    const watch = w.stack.runtime.toolList;
    let told = 0;
    const off = watch.subscribe(() => told++);
    w.stack.runtime.packs.commands.setTokens('owner', 'arkona', {
      race: { ...w.stack.runtime.packs.get('arkona')!.rules.tags.race, Qilin: 'Qilin' },
    });
    expect(watch.check()).toBe(false);
    expect(told).toBe(0);
    off();
  });
});
