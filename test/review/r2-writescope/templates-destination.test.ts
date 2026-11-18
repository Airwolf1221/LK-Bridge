/**
 * W18 (the write-scope rehearsal, 17 November 2026): LegendKeeper accepts a move to the reserved parent `templates`, and
 * the page then reads with parentId "templates": out of the repository, among the templates. Only the bridge keeps pages
 * in the repository. Regression: every move route refuses `templates` as a destination, at every scope (read, propose,
 * write, and the owner's own dashboard work), and nothing is sent or proposed: `move_resource`, `lk_api_write`
 * `moveResource`, `lk_api_batch`, `lk_op_moveResource`, and a setting pack's `promoteNation`.
 */

import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverWorld, type DiscoverWorld } from '../../discover/world.js';
import { O, ownerText, ownersWorld, type OwnersWorld } from '../../packs/owners-world.js';
import { PROJECT } from '../../tools/helpers.js';
import { writeCallsSince } from './helpers.js';

type Scope = 'read' | 'propose' | 'write';
const SCOPES: readonly Scope[] = ['read', 'propose', 'write'];
const PAGE = 'loose001';

describe('the low-level and high-level move routes', () => {
  let w: DiscoverWorld;
  const clients = new Map<Scope, Client>();
  beforeAll(async () => {
    w = await discoverWorld({
      bulk: 20,
      env: {
        MCP_EXPOSE_PER_OP_TOOLS: 'true',
        LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }),
      },
      limits: { 'key-min': 5000, 'write-min': 2000 },
    });
    for (const scope of SCOPES) {
      const t = w.stack.newToken(`w18-${scope}`, scope);
      w.stack.runtime.policy.commands.setShowLowLevelTools('owner', t.profileId, true);
      clients.set(scope, await w.stack.connect(t.token));
    }
  }, 60_000);
  afterAll(async () => w?.close());

  const proposals = () =>
    (w.stack.db.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n;
  const routes: readonly [string, (to: string) => Record<string, unknown>][] = [
    ['move_resource', (to) => ({ page: PAGE, to })],
    [
      'lk_api_write',
      (to) => ({
        operationId: 'moveResource',
        params: { path: { resourceId: PAGE }, body: { parentId: to } },
      }),
    ],
    [
      'lk_api_batch',
      (to) => ({
        calls: [
          { operationId: 'moveResource', params: { path: { resourceId: PAGE }, body: { parentId: to } } },
        ],
      }),
    ],
    ['lk_op_moveResource', (to) => ({ path: { resourceId: PAGE }, body: { parentId: to } })],
  ];

  for (const scope of SCOPES)
    for (const [tool, args] of routes)
      for (const to of ['templates', ' Templates '])
        it(`${tool} at scope ${scope} to “${to}”: refused; nothing sent, nothing proposed`, async () => {
          const n = w.stack.mock.calls.length;
          const p = proposals();
          const r = await w.stack.call(clients.get(scope)!, tool, { project: 'test', ...args(to) });
          expect(r.isError, r.text).toBe(true);
          expect(r.body.status, r.text).not.toBe('proposal_captured');
          expect(writeCallsSince(w, n), r.text).toEqual([]);
          expect(proposals()).toBe(p);
          expect(w.repo.live(PAGE)!.parentId).not.toBe('templates');
        });

  it('the owner’s own work (the system principal) is refused too', async () => {
    const n = w.stack.mock.calls.length;
    await expect(
      w.stack.runtime.engine.run(
        'moveResource',
        { path: { resourceId: PAGE }, body: { parentId: 'templates' } },
        { project: PROJECT, origin: { kind: 'ui', client: 'owner' }, priority: 'P1' },
      ),
    ).rejects.toMatchObject({ code: 'TEMPLATES_DESTINATION' });
    expect(writeCallsSince(w, n)).toEqual([]);
  });

  it('the low-level refusal names the reason (TEMPLATES_DESTINATION)', async () => {
    const r = await w.stack.call(clients.get('write')!, 'lk_api_write', {
      project: 'test',
      operationId: 'moveResource',
      params: { path: { resourceId: PAGE }, body: { parentId: 'templates' } },
    });
    expect((r.body.error as { code?: string } | undefined)?.code, r.text).toBe('TEMPLATES_DESTINATION');
  });
});

describe('a setting pack’s promoteNation', () => {
  let w: OwnersWorld;
  beforeAll(async () => {
    w = await ownersWorld();
  }, 60_000);
  afterAll(async () => w?.close());

  for (const scope of ['propose', 'write'] as const)
    it(`at scope ${scope}, a nation “home” of “templates” is refused; nothing sent, nothing proposed`, async () => {
      const t = w.stack.newToken(`w18-pack-${scope}`, scope);
      const client = await w.stack.connect(t.token);
      const n = w.stack.mock.calls.length;
      const p = (w.stack.db.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n;
      for (const home of ['templates', 'Templates']) {
        const r = await w.stack.call(client, 'arkona_create_owner', {
          project: 'test',
          type: 'Institution',
          name: 'Court of Pearls',
          descriptor: 'Institution Reference',
          nation: 'Sultanate of Tarim',
          home,
          status: 'authoritative',
          referenceType: 'Institution Reference',
          scope: 'The pearl-divers’ court of the sultanate',
          temporalScope: '4A 100 - 4A 300',
          markdown: ownerText('The pearl court of Tarim.'),
          promoteNation: true,
        });
        expect(r.isError, r.text).toBe(true);
      }
      expect(w.stack.mock.calls.slice(n).filter((c) => c.method !== 'GET')).toEqual([]);
      expect((w.stack.db.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n).toBe(p);
      expect(w.repo.live(O.tarim)!.parentId).not.toBe('templates');
    });
});
