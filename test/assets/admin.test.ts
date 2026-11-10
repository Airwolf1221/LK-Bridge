/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON replies */
/**
 * v2 A4: the dashboard side of the asset tree, on the real bridge: the build started, shown with its estimate,
 * confirmed (audited), the Asset Tree page's data (status, counts, browsing, correction log), refresh now, the
 * read-only placement planner ("Try it"), and the setting that switches the regular refresh off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startAdminStack, until, type AdminStack } from '../admin/helpers.js';
import { AssetModel } from './model.js';

let stack: AdminStack | undefined;
afterEach(async () => stack?.close());

const waitFor = async (fn: () => Promise<boolean>, ms = 10_000) => {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** A small library: five folders, a few images. */
function smallWorld(m: AssetModel) {
  const w = {} as Record<'characters' | 'beastkin' | 'qishen' | 'mehrana' | 'maps', string>;
  w.characters = m.folder('Characters');
  w.beastkin = m.folder('Beastkin', w.characters);
  w.qishen = m.folder('Qishen', w.beastkin);
  w.mehrana = m.folder('Mehrana al-Khalid', w.qishen);
  w.maps = m.folder('Maps');
  m.image('Portrait 1', w.mehrana);
  m.image('Portrait 2', w.mehrana);
  m.image('Map', w.maps);
  m.image('Loose', null);
  return w;
}

describe('Asset Tree page', () => {
  it('builds with the estimate first, browses, refreshes, plans, and audits the owner’s actions', async () => {
    const model = new AssetModel(() => Date.now());
    const w = smallWorld(model);
    stack = await startAdminStack({ respond: model.respond });
    await until(() => stack!.runtime.projects.activeIds().length === 1);
    const get = (p: string) => stack!.get(`/api/admin${p}`);
    const post = (p: string, body?: unknown) => stack!.post(`/api/admin${p}`, body);

    // Not built yet: the page says so.
    const first = (await get('/asset-tree')).json;
    expect(first.tree).toMatchObject({ status: 'not_built' });
    expect(first.counts).toMatchObject({ folders: 0, assets: 0 });
    expect(first.settings).toMatchObject({ refreshEnabled: true });
    expect(first.activePass).toBeNull();

    // The build lists the root level and waits for the owner.
    expect((await post('/asset-tree/build')).status).toBe(202);
    await waitFor(async () => (await get('/asset-tree')).json.activePass?.status === 'awaiting_confirmation');
    const waiting = (await get('/asset-tree')).json;
    expect(waiting.activePass.estimate).toMatchObject({
      rootFolders: 2,
      rootAssets: 1,
      requestsSoFar: 1,
      minRequestsRemaining: 2,
      basis: 'root level only',
    });
    expect(model.listCalls).toHaveLength(1);
    expect((await post('/asset-tree/build/confirm', {})).status).toBe(400); // needs confirm: true
    expect((await post('/asset-tree/build/confirm', { confirm: true })).status).toBe(200);
    await waitFor(async () => (await get('/asset-tree')).json.tree.status === 'ready');
    expect(stack.audit('assets.build_prepare')).toHaveLength(1);
    expect(stack.audit('assets.build_start')[0]!.after).toMatchObject({ estimate: { rootFolders: 2 } });

    const page = (await get('/asset-tree')).json;
    expect(page.counts).toMatchObject({ folders: 5, assets: 4, byType: { IMAGE: 4 }, maxDepth: 4, stale: 0 });
    expect(page.lastBuild).toMatchObject({ status: 'succeeded', foldersFound: 5 });
    expect(page.lastBuild.summary).toMatch(/5 folders and 4 assets/);
    expect(page.project).toMatchObject({ name: expect.any(String) });
    expect(model.listCalls).toHaveLength(6);

    // Browsing: the root, then a folder with its path, subfolders and assets.
    const top = (await get('/asset-tree/children')).json;
    expect(top.folder).toBeNull();
    expect(top.folders.map((f: any) => f.name)).toEqual(['Characters', 'Maps']);
    expect(top.assets.assets.map((a: any) => a.name)).toEqual(['Loose']);
    const deep = (await get(`/asset-tree/children?id=${w.mehrana}`)).json;
    expect(deep.path.map((p: any) => p.name)).toEqual([
      'Characters',
      'Beastkin',
      'Qishen',
      'Mehrana al-Khalid',
    ]);
    expect(deep.folders).toEqual([]);
    expect(deep.assets).toMatchObject({ total: 2 });
    expect(deep.assets.assets[0]).toMatchObject({
      name: 'Portrait 1',
      type: 'IMAGE',
      width: 512,
      sha256: null,
    });
    expect((await get('/asset-tree/corrections')).json).toEqual({ entries: [], next: null });

    // Refresh now: runs in the background, finds the outside change, and the correction log shows it.
    model.outsideRename(w.maps, 'Maps, renamed');
    expect((await post('/asset-tree/refresh')).status).toBe(202);
    await waitFor(async () => (await get('/asset-tree')).json.lastRefresh?.status === 'succeeded');
    expect(stack.audit('assets.refresh_now')).toHaveLength(1);
    const log = (await get('/asset-tree/corrections')).json;
    expect(log.entries[0]).toMatchObject({
      itemId: w.maps,
      field: 'name',
      oldValue: 'Maps',
      newValue: 'Maps, renamed',
      source: 'refresh',
    });
    expect((await get('/asset-tree/corrections?source=check')).json.entries).toEqual([]);

    // "Try it": a read-only plan. Nothing is requested from LegendKeeper and nothing is audited.
    const requests = model.listCalls.length;
    const auditRows = stack.audit().length;
    const reuse = (
      await post('/asset-tree/plan', { characterName: 'Mehrana al-Khalid', subfolders: ['Art'] })
    ).json;
    expect(reuse.result.ok).toBe(true);
    expect(reuse.result.plan.steps.map((s: any) => `${s.action} ${s.name}`)).toEqual([
      'reuse Characters',
      'reuse Beastkin',
      'reuse Qishen',
      'reuse Mehrana al-Khalid',
      'create Art',
    ]);
    const literal = (await post('/asset-tree/plan', { folderPath: ['Maps, renamed', 'Dungeons'] })).json;
    expect(literal.result.plan.wouldCreate.map((s: any) => s.name)).toEqual(['Dungeons']);
    // The repository tree is not set up here, so a race cannot be read: a typed refusal, not a guess.
    const refused = (await post('/asset-tree/plan', { characterName: 'Somebody New' })).json;
    expect(refused.result).toMatchObject({ ok: false, error: { code: 'REPOSITORY_TREE_NOT_READY' } });
    const invalid = (await post('/asset-tree/plan', { characterName: 'x', subfolders: ['a/b'] })).json;
    expect(invalid.result.error.code).toBe('INVALID_NAME');
    expect((await post('/asset-tree/plan', { characterName: 'x', nonsense: true })).status).toBe(400);
    expect(model.listCalls.length).toBe(requests);
    expect(stack.audit().length).toBe(auditRows);

    // Nothing to cancel.
    expect((await post('/asset-tree/build/cancel', { confirm: true })).json.error.code).toBe(
      'NOTHING_TO_CANCEL',
    );
    expect((await post('/asset-tree/build/confirm', { confirm: true })).json.error.code).toBe(
      'NOTHING_TO_CONFIRM',
    );
  }, 60_000);

  it('the regular refresh can be switched off for the project (a validated, audited setting)', async () => {
    const model = new AssetModel(() => Date.now());
    smallWorld(model);
    stack = await startAdminStack({ respond: model.respond });
    await until(() => stack!.runtime.projects.activeIds().length === 1);
    const project = stack.runtime.projects.defaultProject().name;
    const put = (v: unknown) =>
      stack!.put(`/api/admin/projects/${project}/settings`, { key: 'assetRefreshEnabled', value: v });
    expect((await put('maybe')).status).toBe(400);
    expect((await put(false)).status).toBe(200);
    expect((await stack.get('/api/admin/asset-tree')).json.settings.refreshEnabled).toBe(false);
    expect(stack.audit('project.set_setting')[0]).toMatchObject({
      before: { key: 'assetRefreshEnabled', value: null },
      after: { key: 'assetRefreshEnabled', value: false },
    });
    const projects = (await stack.get('/api/admin/projects')).json;
    expect(projects.settingKeys.map((k: any) => k.key)).toContain('assetRefreshEnabled');
    expect((await put(null)).status).toBe(200);
    expect((await stack.get('/api/admin/asset-tree')).json.settings.refreshEnabled).toBe(true);
  }, 30_000);

  it('refuses writes without the dashboard’s CSRF token and reads without a session', async () => {
    const model = new AssetModel(() => Date.now());
    smallWorld(model);
    stack = await startAdminStack({ respond: model.respond });
    await until(() => stack!.runtime.projects.activeIds().length === 1);
    expect((await stack.post('/api/admin/asset-tree/build', undefined, { csrf: null })).status).toBe(403);
    expect((await stack.get('/api/admin/asset-tree', { cookie: null })).status).toBe(401);
    expect(model.listCalls).toHaveLength(0);
  }, 30_000);
});
