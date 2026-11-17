/**
 * R2-revert, attack (b): lose `unsupported` blocks or `unsupported` sidebar content.
 *
 * Asagiri Miyabi's Main ends with an `unsupported` block (`unsup1`) and her sidebar has an `unsupported` TAGS property.
 * The attempts: a block-by-block revert; the whole-page fallback (a job that re-ordered blocks cannot be put back block
 * by block, so Revert writes the page before the job back whole, src/review/revert-plan.ts planText); an `unsupported`
 * block the owner adds after such a job; a facts revert next to TAGS. Controls: each should HOLD.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factsWorld, P, type FactsWorld } from '../../facts/world.js';
import { PROJECT, jobOf, revertAndWait, writeAgent } from './helpers.js';

type Obj = Record<string, unknown>;
let w: FactsWorld;
let agent: Client;

beforeAll(async () => {
  w = await factsWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  agent = (await writeAgent(w.stack, 'r2-unsupported-agent')).client;
});
afterAll(async () => w.close());

const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(agent, tool, { project: 'test', ...args });
const rt = () => w.stack.runtime;
const doc = () => w.repo.liveDocs(w.repo.live(P.miyabi)!).find((d) => d.name === 'Main')!.id;
const blocks = () => w.repo.blocks.get(doc())!.blocks as Obj[];
const ids = () => blocks().map((b) => String(b.id));
const tags = () => w.sidebars.pages.get(P.miyabi)!.props.find((p) => p.kind === 'unsupported') ?? null;

describe('unsupported content survives a revert', () => {
  it('a block-by-block revert keeps the unsupported block', async () => {
    const before = JSON.stringify(blocks());
    const r = await call('write_page', {
      page: P.miyabi,
      mode: 'append',
      markdown: 'A late note on the shrine.',
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    const { job } = await revertAndWait(w.stack, jobId);
    expect(job?.status).toBe('succeeded');
    expect(JSON.stringify(blocks())).toBe(before);
    expect(ids()).toContain('unsup1');
  });

  it('the whole-page fallback (blocks re-ordered by the job) writes the page back with the unsupported block', async () => {
    const before = ids();
    const swapped = structuredClone(blocks());
    const a = swapped.findIndex((b) => b.id === 'mp1');
    const b = swapped.findIndex((x) => x.id === 'mp2');
    [swapped[a], swapped[b]] = [swapped[b]!, swapped[a]!];
    const r = await call('lk_api_write', {
      operationId: 'replaceDocumentBlocks',
      params: { path: { resourceId: P.miyabi, documentId: doc() }, body: { blocks: swapped } },
    });
    expect(r.isError, r.text).toBe(false);
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    expect(ids()).not.toEqual(before);
    const preview = await rt().reverts.preview(PROJECT, jobId);
    expect(preview.targets[0]!.detail).toMatch(/written back whole/);
    const { job } = await revertAndWait(w.stack, jobId);
    expect(job?.status, JSON.stringify(job?.lastError)).toBe('succeeded');
    expect(ids()).toEqual(before);
    expect(ids()).toContain('unsup1');
  });

  it('an unsupported block the owner adds after such a job blocks the whole-page revert', async () => {
    const swapped = structuredClone(blocks());
    const a = swapped.findIndex((b) => b.id === 'mp3');
    const b = swapped.findIndex((x) => x.id === 'mp4');
    [swapped[a], swapped[b]] = [swapped[b]!, swapped[a]!];
    const r = await call('lk_api_write', {
      operationId: 'replaceDocumentBlocks',
      params: { path: { resourceId: P.miyabi, documentId: doc() }, body: { blocks: swapped } },
    });
    expect(r.isError, r.text).toBe(false);
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    // The owner embeds something the API cannot represent.
    const d = w.repo.blocks.get(doc())!;
    (d.blocks as Obj[]).splice(1, 0, { id: 'unsup2', kind: 'unsupported' });
    d.version++;
    const { r: rv } = await revertAndWait(w.stack, jobId);
    expect(rv.status).toBe('refused');
    expect(ids()).toEqual(expect.arrayContaining(['unsup1', 'unsup2']));
  });

  it('a facts revert leaves the unsupported TAGS property alone', async () => {
    const r = await call('set_facts', { page: P.miyabi, facts: { Notes: 'Changed for the TAGS check' } });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    const t = structuredClone(tags());
    const { job } = await revertAndWait(w.stack, jobId);
    expect(job?.status).toBe('succeeded');
    expect(tags()).toEqual(t);
  });
});
