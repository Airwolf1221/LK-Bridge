/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- tool results and the pack's rules are JSON */
/**
 * CR-2026-11-R4, the lead reviewer's reading of `tools/list_changed` (F4c's commit 79b1700, merged with #78) and the
 * tool lists it recomputes. Each test asserts the SAFE behaviour: no tool is listed to a session that may not use it,
 * before or after an approval, and a session whose list changed is told, in either protocol version.
 *
 * - LD-01: the narrative and consistency tools while the version that defines them waits for the owner's approval.
 *   ADR 0064 and ADR 0065 (and the CHANGELOG) say "until then the tools are not listed"; they refuse at the call.
 * - LD-02: the reverse: a newer version waiting for approval that drops the rules; the approved version still has them,
 *   so the tools still work, and they stay listed.
 * - LD-03, LD-04: the owner moves a connection to another profile (up to `write`, down to `read`): a 2026-07-28 session
 *   listening for changes is told, and its next list is the new profile's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { PackRules } from '../../../src/packs/types.js';
import { narrativeWorld, type NarrativeWorld } from '../../narrative/world.js';

let w: NarrativeWorld;
beforeAll(async () => {
  w = await narrativeWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const NARRATIVE = [
  'arkona_story_create',
  'arkona_chapter_save',
  'arkona_chapter_context',
  'arkona_chapter_check',
];
const CONSISTENCY = [
  'arkona_consistency',
  'arkona_as_of',
  'arkona_as_of_coverage',
  'arkona_consistency_suggest',
];

async function listening(token: string, era: 'modern' | 'legacy' = 'modern') {
  const changes: string[][] = [];
  const client = new Client(
    { name: 'lk-bridge-r4-lead', version: '1.0.0' },
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

const until = async (ok: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return ok();
};

const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);

describe('the tool lists follow the approved version (LD-01, LD-02)', () => {
  it('LD-01: the narrative and consistency tools are not listed while the version defining them waits for approval', async () => {
    const packs = w.stack.runtime.packs;
    const full = packs.get('arkona')!.rules;
    const c0 = await w.stack.connect();
    // Control: approved as the world sets it up, the tools are listed.
    const listedTools = (await c0.listTools()).tools;
    const before = listedTools.map((t) => t.name);
    for (const t of [...NARRATIVE, ...CONSISTENCY]) expect(before, t).toContain(t);
    // The read-only consistency tools say so (moved here from test/tools/e2e.test.ts, whose stack does not approve).
    for (const n of ['arkona_consistency', 'arkona_as_of', 'arkona_as_of_coverage'])
      expect(listedTools.find((t) => t.name === n)?.annotations?.readOnlyHint, n).toBe(true);
    await c0.close();

    // The owner approves a version without the narrative and consistency rules, then a newer one restores them and
    // waits for approval: the tools cannot be used (they read the approved version).
    const { narrative: _n, consistency: _c, ...without } = full as PackRules & Record<string, unknown>;
    expect(full.narrative, 'the approved version has the narrative rules').toBeDefined();
    packs.commands.replaceRules('owner', 'arkona', without, 'R4 LD-01: no narrative rules');
    await packs.commands.approve('owner', 'arkona');
    packs.commands.replaceRules('owner', 'arkona', full, 'R4 LD-01: the rules back, waiting');
    expect(packs.get('arkona')!.approved!.version).toBeLessThan(packs.get('arkona')!.version);

    let listed: string[] | undefined;
    try {
      const c1 = await w.stack.connect();
      listed = (await c1.listTools()).tools.map((t) => t.name);
      await c1.close();
      // Held: a call refuses (the approved version has no narrative rules).
      const story = await w.tool('arkona_story_create', {
        continuity: 'Main CANON',
        title: 'R4 LD-01 probe',
      });
      expect(JSON.stringify(story)).toMatch(/PACK_NOT_CURRENT/);
      const asOf = await w.tool('arkona_as_of', { characters: ['Yasmin al-Naim'], date: 'now' });
      expect(JSON.stringify(asOf)).toMatch(/no consistency rules/i);
    } finally {
      // Approved again whatever happened, so the next test starts from the world's state.
      await packs.commands.approve('owner', 'arkona');
    }
    // SAFE: not listed while they cannot be used.
    expect(
      (listed ?? []).filter((t) => [...NARRATIVE, ...CONSISTENCY].includes(t)),
      'tools listed although the approved version has none of their rules',
    ).toEqual([]);

    // Approved: listed again.
    const c2 = await w.stack.connect();
    const after = (await c2.listTools()).tools.map((t) => t.name);
    await c2.close();
    for (const t of [...NARRATIVE, ...CONSISTENCY]) expect(after, t).toContain(t);
  });

  it('LD-02: a newer version waiting for approval that drops the rules does not hide tools the approved version still serves', async () => {
    const packs = w.stack.runtime.packs;
    if (packs.get('arkona')!.approved!.version !== packs.get('arkona')!.version)
      await packs.commands.approve('owner', 'arkona');
    const full = packs.get('arkona')!.rules;
    expect(full.narrative, 'the approved version has the narrative rules').toBeDefined();
    const { narrative: _n, consistency: _c, ...without } = full as PackRules & Record<string, unknown>;
    packs.commands.replaceRules('owner', 'arkona', without, 'R4 LD-02: dropped, waiting');
    try {
      const c = await w.stack.connect();
      const listed = (await c.listTools()).tools.map((t) => t.name);
      await c.close();
      // The approved version still has the rules: the tools work…
      const asOf = await w.tool('arkona_as_of', { characters: ['Yasmin al-Naim'], date: 'now' });
      expect(JSON.stringify(asOf)).not.toMatch(/no consistency rules/i);
      // …so they are listed (SAFE: the list follows the approved version, as the calls do).
      for (const t of [...NARRATIVE, ...CONSISTENCY]) expect(listed, t).toContain(t);
    } finally {
      packs.commands.replaceRules('owner', 'arkona', full, 'R4 LD-02: restored');
      await packs.commands.approve('owner', 'arkona');
    }
  });
});

describe('a connection moved to another profile is told (LD-03, LD-04)', () => {
  it('LD-03: moved up from a read profile to a write profile, a 2026-07-28 session is told and its next list has the write tools', async () => {
    const reader = w.stack.newToken('r4-ld03-read', 'read');
    const writer = w.stack.newToken('r4-ld03-write', 'write');
    const { client, changes } = await listening(reader.token);
    expect(await names(client)).not.toContain('write_page');
    w.stack.runtime.policy.commands.setConnectionProfile('owner', reader.patId, writer.profileId);
    const told = await until(() => changes.length > 0);
    const now = await names(client);
    await client.close();
    expect(now, 'the recomputed list').toContain('write_page');
    expect(told, 'the session was not told its list changed').toBe(true);
  });

  it('LD-04: moved down from a write profile to a read profile, the session is told, its list loses the write tools, and a write is refused', async () => {
    const reader = w.stack.newToken('r4-ld04-read', 'read');
    const writer = w.stack.newToken('r4-ld04-write', 'write');
    const { client, changes } = await listening(writer.token);
    expect(await names(client)).toContain('write_page');
    w.stack.runtime.policy.commands.setConnectionProfile('owner', writer.patId, reader.profileId);
    const told = await until(() => changes.length > 0);
    // Held: the call is refused at once, whatever the client's list says.
    const r: any = await client.callTool({
      name: 'write_page',
      arguments: { page: 'Nowhere', mode: 'append', markdown: 'R4 LD-04 probe' },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/read-only/i);
    expect(await names(client)).not.toContain('write_page');
    await client.close();
    expect(told, 'the session was not told its list changed').toBe(true);
  });
});

describe('the cost of a tool list (LD-07)', () => {
  it('LD-07: once warm, a tools/list and an ordinary call parse the pack’s rules no more (the reviewed code: 18 times each)', async () => {
    const store = (w.stack.runtime.packs as unknown as { store: { get(id: string): unknown } }).store;
    let gets = 0;
    const orig = store.get.bind(store);
    store.get = (id: string) => {
      gets++;
      return orig(id);
    };
    try {
      const c = await w.stack.connect();
      await c.listTools();
      gets = 0;
      await c.listTools();
      const perList = gets;
      gets = 0;
      await c.callTool({ name: 'list_projects', arguments: {} });
      const perCall = gets;
      await c.close();
      expect({ perList, perCall }).toEqual({ perList: 0, perCall: 0 });
      // A change is seen at once: the next list reads the pack again.
      w.stack.runtime.packs.commands.setTokens('owner', 'arkona', {
        race: { ...w.stack.runtime.packs.get('arkona')!.rules.tags.race, Qilin: 'Qilin' },
      });
      gets = 0;
      const c2 = await w.stack.connect();
      await c2.listTools();
      await c2.close();
      expect(gets).toBeGreaterThan(0);
    } finally {
      store.get = orig;
      await w.stack.runtime.packs.commands.approve('owner', 'arkona');
    }
  });
});
