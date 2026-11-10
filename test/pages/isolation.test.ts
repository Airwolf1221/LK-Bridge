/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * write_page with two projects (v2 A1's rules, v2 C1): a write must name its project; it reads, writes, journals,
 * remembers versions and proposes in that project only, and another project's pages are not in its repository.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LkBlock } from '../../src/markdown/index.js';
import { AssetModel } from '../assets/model.js';
import { buildModels } from '../discover/world.js';
import { IDS, NAMES, startTwoProjects, type Name, type TwoProjects } from '../projects/helpers.js';
import { TreeModel } from '../tree/model.js';

let t: TwoProjects;
let writer: Client;
let proposer: Client;
const docs = {} as Record<Name, string>;
const blocks = (name: Name): LkBlock[] => [
  { id: `${name}h1`, kind: 'heading', level: 2, content: [{ text: 'Notes' }] },
  { id: `${name}p1`, kind: 'paragraph', content: [{ text: `${name} notes.` }] },
];
const stored = (name: Name) => t.models[name].docs.get(docs[name])!;

beforeAll(async () => {
  t = await startTwoProjects();
  for (const name of NAMES) {
    // The bridge's tree of the project: an AI REPOSITORY with one page, "Shared Page" in both.
    const m = new TreeModel(() => Date.now());
    const root = m.seed({ id: `${name}root1`, name: 'AI REPOSITORY' });
    const page = m.seed({ id: `${name}page1`, name: '[BSRC] Shared Page', parentId: root.id });
    buildModels(t.stack, m, new AssetModel(() => Date.now()), IDS[name], root.id);
    docs[name] = m.liveDocs(page).find((d) => d.name === 'Main')!.id;
    // LegendKeeper's side (the project's own mock): the same page and document, with content.
    const lk = t.models[name];
    lk.seedResource(page.id, { name: page.name, blocks: blocks(name) });
    const d = lk.docs.get(`d_${page.id}`)!;
    lk.docs.delete(d.id);
    d.id = docs[name];
    lk.docs.set(d.id, d);
    lk.resources.get(page.id)!.documents = [d.id];
  }
  writer = (await t.connect('pages-two-writer', 'write')).client;
  proposer = (await t.connect('pages-two-proposer', 'propose')).client;
});
afterAll(() => t.close());

describe('write_page with two projects', () => {
  it('refuses a write that does not name its project, before anything is read', async () => {
    const before = t.mocks.alpha.calls.length + t.mocks.beta.calls.length;
    const r = await t.call(writer, 'write_page', { page: 'Shared Page', mode: 'append', markdown: 'x' });
    expect(r.body.error).toMatchObject({ code: 'PROJECT_REQUIRED' });
    expect(t.mocks.alpha.calls.length + t.mocks.beta.calls.length).toBe(before);
  });
  it('writes the named project’s page only: the same name in each resolves to its own page', async () => {
    const beta = t.writesAt('beta');
    const r = await t.call(writer, 'write_page', {
      project: 'alpha',
      page: 'Shared Page',
      mode: 'append_to_section',
      section: 'Notes',
      markdown: 'Alpha only.',
    });
    expect(r.body).toMatchObject({
      project: 'alpha',
      status: 'written',
      verified: true,
      page: { id: 'alphapage1' },
    });
    expect(r.footer).toMatch(/^budget \(alpha\)/);
    expect(t.writesAt('beta')).toBe(beta);
    expect(JSON.stringify(stored('alpha').blocks)).toContain('Alpha only.');
    expect(JSON.stringify(stored('beta').blocks)).not.toContain('Alpha only.');
    // The journal entry is alpha's.
    const ja = t.stack.runtime.engine.queries.journalLookup(IDS.alpha, { jobId: r.body.jobId });
    const jb = t.stack.runtime.engine.queries.journalLookup(IDS.beta, { jobId: r.body.jobId });
    expect(ja).toHaveLength(1);
    expect(jb).toHaveLength(0);
  });
  it('another project’s page is not in the repository', async () => {
    const r = await t.call(writer, 'write_page', {
      project: 'beta',
      page: 'alphapage1',
      mode: 'append',
      markdown: 'x',
    });
    expect(r.body.error.code).toBe('NOT_IN_REPOSITORY');
    expect(r.footer).toMatch(/^budget \(beta\)/);
  });
  it('remembers versions per project: a base read in one project means nothing in the other', async () => {
    const read = await t.call(writer, 'read_document', { project: 'beta', resource: 'Shared Page' });
    expect(read.body.version).toBe('v1');
    t.models.beta.outsideEdit(docs.beta, (b) =>
      b.unshift({ id: 'betax', kind: 'heading', level: 2, content: [{ text: 'Added in the app' }] }),
    );
    // Beta remembers v1: its unchanged Notes section lets the edit through.
    const ok = await t.call(writer, 'write_page', {
      project: 'beta',
      page: 'Shared Page',
      mode: 'replace_section',
      section: 'Notes',
      markdown: 'Beta notes, rewritten.',
      baseVersion: 'v1',
    });
    expect(ok.body, ok.text).toMatchObject({ status: 'written', previousVersion: 'v2' });
    // Alpha never read its page at that version from beta's read: a section edit there is base_unknown.
    const no = await t.call(writer, 'write_page', {
      project: 'alpha',
      page: 'Shared Page',
      mode: 'append_to_section',
      section: 'Notes',
      markdown: 'x',
      baseVersion: 'v0',
    });
    expect(no.body.error).toMatchObject({ code: 'VERSION_CONFLICT', reason: 'base_unknown' });
  });
  it('a proposal belongs to its project, and approving it writes there only', async () => {
    const alpha = t.writesAt('alpha');
    const r = await t.call(proposer, 'write_page', {
      project: 'beta',
      page: 'Shared Page',
      mode: 'append',
      markdown: 'Proposed for beta.',
    });
    expect(r.body).toMatchObject({ project: 'beta', status: 'proposal_captured' });
    const id = String(r.body.proposalId);
    const proposals = t.stack.runtime.policy.proposals;
    expect(proposals.list({ project: IDS.alpha }).map((p) => p.id)).not.toContain(id);
    expect(proposals.list({ project: IDS.beta }).map((p) => p.id)).toContain(id);
    await t.stack.runtime.policy.commands.approve('owner', id);
    for (let i = 0; i < 100 && proposals.get(id)!.state !== 'executed'; i++)
      await new Promise((res) => setTimeout(res, 20));
    expect(proposals.get(id)!.state).toBe('executed');
    expect(JSON.stringify(stored('beta').blocks)).toContain('Proposed for beta.');
    expect(t.writesAt('alpha')).toBe(alpha);
  });
});
