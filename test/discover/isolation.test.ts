/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON tool results */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssetModel } from '../assets/model.js';
import { startTwoProjects, IDS, type TwoProjects } from '../projects/helpers.js';
import { TreeModel } from '../tree/model.js';
import { buildModels } from './world.js';

let t: TwoProjects;
let c: Client;
const call = (name: string, args: Record<string, unknown> = {}) => t.call(c, name, args);

function repoFor(name: 'alpha' | 'beta') {
  const m = new TreeModel(() => Date.now());
  const root = m.seed({ id: `${name}root1`, name: 'AI REPOSITORY' });
  const idx = m.seed({ id: `${name}idx01`, name: '[INDEX] Heroes', parentId: root.id });
  m.seed({
    id: `${name}hero01`,
    name: `[BSRC] ${name === 'alpha' ? 'Alpha' : 'Beta'} Hero`,
    parentId: idx.id,
    tags: [`${name}-tag`, 'shared-tag'],
  });
  m.seed({ id: `${name}shr001`, name: '[BSRC] Shared Name', parentId: idx.id, scope: `only in ${name}` });
  if (name === 'beta') m.seed({ id: 'betaextr', name: '[BSRC] Beta Only Extra', parentId: idx.id });
  return { m, rootId: root.id };
}

beforeAll(async () => {
  t = await startTwoProjects();
  const a = new AssetModel(() => Date.now());
  a.folder('Alpha Folder');
  a.image('alpha-pic', null);
  const alpha = repoFor('alpha');
  buildModels(t.stack, alpha.m, a, IDS.alpha, alpha.rootId);
  // Beta's repository is built; its asset tree is not.
  const beta = repoFor('beta');
  const emptyAssets = new AssetModel(() => Date.now());
  buildModels(t.stack, beta.m, emptyAssets, IDS.beta, beta.rootId);
  t.stack.db.prepare('DELETE FROM asset_state WHERE project_id = ?').run(IDS.beta);
  c = (await t.connect('discover-two', 'read')).client;
});
afterAll(() => t.close());

describe('two projects stay apart', () => {
  it('search, browse and get_resource answer for the asked project only, and name it', async () => {
    const a = await call('search', { query: 'hero', project: 'alpha' });
    const b = await call('search', { query: 'hero', project: 'beta' });
    expect(a.body.project).toBe('alpha');
    expect(b.body.project).toBe('beta');
    expect(a.body.results.map((x: any) => x.name)).toEqual(['Heroes', 'Alpha Hero']);
    expect(b.body.results.map((x: any) => x.name)).toEqual(['Heroes', 'Beta Hero']);
    expect(a.footer).toMatch(/^budget \(alpha\)/);
    expect(b.footer).toMatch(/^budget \(beta\)/);
    // Reads without project use the default project (alpha).
    const d = await call('search', { query: 'hero' });
    expect(d.body.project).toBe('alpha');
    expect(d.body.results.map((x: any) => x.id)).toEqual(['alphaidx01', 'alphahero01']);
    const browse = await call('browse_repository_tree', { project: 'beta', depth: 3 });
    expect(JSON.stringify(browse.body.node)).toContain('Beta Only Extra');
    expect(
      JSON.stringify((await call('browse_repository_tree', { project: 'alpha', depth: 3 })).body.node),
    ).not.toContain('Beta');
  });
  it('another project’s ids are not in the repository, and a shared name resolves in each on its own', async () => {
    const foreign = await call('get_resource', { resource: 'alphahero01', project: 'beta', live: false });
    expect(foreign.isError).toBe(true);
    expect(foreign.body.error.code).toBe('NOT_IN_REPOSITORY');
    expect(foreign.footer).toMatch(/^budget \(beta\)/);
    const read = await call('read_document', { resource: 'betahero01', project: 'alpha' });
    expect(read.body.error.code).toBe('NOT_IN_REPOSITORY');
    const sa = await call('get_resource', { resource: 'Shared Name', project: 'alpha', live: false });
    const sb = await call('get_resource', { resource: 'Shared Name', project: 'beta', live: false });
    expect(sa.body.resource).toMatchObject({ id: 'alphashr001', scope: 'only in alpha' });
    expect(sb.body.resource.scope).toBe('only in beta');
    expect(sa.body.resource.id).not.toBe(sb.body.resource.id);
    const under = await call('search', { query: 'under:"Beta Hero"', project: 'alpha' });
    expect(under.body.error.code).toBe('NOT_FOUND');
  });
  it('tags and templates are per project; each has its own tree and asset tree status', async () => {
    const ta = (await call('list_tags', { project: 'alpha' })).body.tags.map((x: any) => x.tag).sort();
    const tb = (await call('list_tags', { project: 'beta' })).body.tags.map((x: any) => x.tag).sort();
    expect(ta).toEqual(['alpha-tag', 'shared-tag']);
    expect(tb).toEqual(['beta-tag', 'shared-tag']);
    const assetsA = await call('browse_asset_tree', { project: 'alpha', depth: 1 });
    expect(assetsA.body.folder.folders.map((f: any) => f.name)).toEqual(['Alpha Folder']);
    expect(assetsA.body.assetTree.status).toBe('ready');
    const assetsB = await call('browse_asset_tree', { project: 'beta' });
    expect(assetsB.body.error.code).toBe('ASSET_TREE_NOT_READY'); // one project's gap does not touch the other
    expect(assetsB.footer).toMatch(/^budget \(beta\)/);
  });
  it('a project whose tree is not built does not affect the other', async () => {
    t.stack.db.prepare('UPDATE tree_state SET built_at = NULL WHERE project_id = ?').run(IDS.beta);
    const b = await call('search', { query: 'hero', project: 'beta' });
    expect(b.body.error.code).toBe('TREE_NOT_READY');
    const a = await call('search', { query: 'hero', project: 'alpha' });
    expect(a.isError).toBe(false);
  });
});
