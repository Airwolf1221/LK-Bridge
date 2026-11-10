/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON replies */
/**
 * v2 A2: the dashboard side of the repository tree, on the real bridge with two projects: settings edited on the
 * Projects page (validated, audited), the root suggested by itself when the owner first looks, the build started,
 * shown with its estimate, confirmed, and the Repository Tree page's data (status, counts, browsing, correction log).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { until } from '../admin/helpers.js';
import { IDS, startTwoProjects, type TwoProjects } from '../projects/helpers.js';

let t: TwoProjects;
afterEach(async () => t?.close());

const waitFor = async (fn: () => Promise<boolean>, ms = 8000) => {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('Repository Tree page and project settings', () => {
  it('suggests the root, edits settings (audited), and builds with the estimate first', async () => {
    t = await startTwoProjects();
    const m = t.models.alpha;
    m.seedResource('arepo001', { name: 'AI REPOSITORY' });
    m.seedResource('achars01', { name: '[INDEX] Characters', parentId: 'arepo001' });
    m.seedResource('aasagiri', { name: '[BSRC] Asagiri Miyabi', parentId: 'achars01' });
    m.seedResource('aloose01', { name: 'Loose page', parentId: 'arepo001' });
    m.seedResource('aelse001', { name: 'Elsewhere', parentId: 'alpha_root' });
    await until(() => t.stack.runtime.projects.activeIds().length === 2);

    // Not configured: the page says so, and looks for the root by itself (one listing, in the background).
    const first = await t.admin.get('/tree?project=alpha');
    expect(first.status).toBe(200);
    expect(first.json.tree).toMatchObject({ status: 'not_configured', rootId: null });
    await waitFor(async () => (await t.admin.get('/tree?project=alpha')).json.suggestion !== null);
    const sug = (await t.admin.get('/tree?project=alpha')).json.suggestion;
    expect(sug).toMatchObject({
      suggested: 'arepo001',
      candidates: [{ id: 'arepo001', name: 'AI REPOSITORY' }],
    });

    // Settings: validated, audited, per project.
    const bad = await t.admin.put('/projects/alpha/settings', {
      key: 'aiRepositoryRootId',
      value: 'Not an id',
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('INVALID_SETTING');
    expect((await t.admin.put('/projects/alpha/settings', { key: 'nope', value: 'x' })).status).toBe(400);
    const set = await t.admin.put('/projects/alpha/settings', {
      key: 'aiRepositoryRootId',
      value: 'arepo001',
    });
    expect(set.status).toBe(200);
    expect(set.json.project.settings.aiRepositoryRootId).toBe('arepo001');
    expect(t.stack.audit('project.set_setting')[0]).toMatchObject({
      target: 'alpha',
      before: { key: 'aiRepositoryRootId', value: null },
      after: { key: 'aiRepositoryRootId', value: 'arepo001' },
    });
    const projects = await t.admin.get('/projects');
    expect(projects.json.settingKeys.map((k: any) => k.key)).toEqual(
      expect.arrayContaining(['aiRepositoryRootId', 'treePropertiesName', 'treeSweepEnabled']),
    );
    expect(projects.json.projects.find((p: any) => p.name === 'beta').settings).toEqual({});

    // The build: listing, then the estimate, waiting for the owner.
    expect((await t.admin.get('/tree?project=alpha')).json.tree.status).toBe('not_built');
    expect((await t.admin.post('/tree/build?project=alpha')).status).toBe(202);
    await waitFor(
      async () =>
        (await t.admin.get('/tree?project=alpha')).json.activePass?.status === 'awaiting_confirmation',
    );
    const waiting = (await t.admin.get('/tree?project=alpha')).json;
    expect(waiting.activePass.estimate).toMatchObject({ subtree: 4, reads: 4 });
    expect((await t.admin.post('/tree/build/confirm?project=alpha', {})).status).toBe(400); // needs confirm: true
    expect((await t.admin.post('/tree/build/confirm?project=alpha', { confirm: true })).status).toBe(200);
    await waitFor(async () => (await t.admin.get('/tree?project=alpha')).json.tree.status === 'ready');
    expect(t.stack.audit('tree.build_prepare')).toHaveLength(1);
    expect(t.stack.audit('tree.build_start')[0]!.after).toMatchObject({ estimate: { subtree: 4 } });

    const page = (await t.admin.get('/tree?project=alpha')).json;
    expect(page.counts).toMatchObject({
      total: 4,
      byKind: { root: 1, index: 1, bsrc: 1, unclassified: 1 },
      maxDepth: 2,
    });
    expect(page.unclassified.map((n: any) => n.id)).toEqual(['aloose01']);
    expect(page.lastBuild).toMatchObject({ status: 'succeeded', readOk: 4 });
    expect(page.project).toEqual({ id: IDS.alpha, name: 'alpha' });

    // Browsing: the root's children, then a node's, with its path.
    const top = (await t.admin.get('/tree/children?project=alpha')).json;
    expect(top.node).toMatchObject({ id: 'arepo001', kind: 'root' });
    expect(top.children.map((n: any) => n.id).sort()).toEqual(['achars01', 'aloose01']);
    const chars = (await t.admin.get('/tree/children?project=alpha&id=achars01')).json;
    expect(chars.path.map((p: any) => p.displayName)).toEqual(['AI REPOSITORY', 'Characters']);
    expect(chars.children.map((n: any) => n.displayName)).toEqual(['Asagiri Miyabi']);
    expect((await t.admin.get('/tree/corrections?project=alpha')).json).toEqual({ entries: [], next: null });

    // Nothing to cancel; beta is untouched.
    expect((await t.admin.post('/tree/build/cancel?project=alpha', { confirm: true })).json.error.code).toBe(
      'NOTHING_TO_CANCEL',
    );
    const beta = (await t.admin.get('/tree?project=beta')).json;
    expect(beta.tree.status).toBe('not_configured');
    expect(beta.counts.total).toBe(0);
    expect((await t.admin.post('/tree/build?project=beta')).json.error.code).toBe('NOT_CONFIGURED');
  }, 30_000);
});
