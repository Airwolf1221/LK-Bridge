/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- LK results are untyped JSON */
/**
 * CR-2026-11-R4 (the fourth review), opt-in, WRITES then cleans up: what this review's fixes assume of LegendKeeper and
 * no sandbox check confirms yet. Written for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- assumptions-r5
 *
 * Each check reports PASS, FAIL or NOTED (a fact recorded, never a failure):
 *
 * - **Z1** narrative-f4c N3's fix: a page made from a template holds a copy of each of the template's documents with its
 *   content; the one named Main (what a job's `documents.main.id` binds, and what `arkona_chapter_save` now reads back)
 *   holds the template's Main content; the order getResource lists them in is NOTED (ADR 0050 says it is not stated;
 *   another page document listed first is what made N3's read-back compare the wrong document).
 * - **Z2** the pick's field edit (CR-2026-11-R4): a key-value row written with three runs (plain, bold, plain) and then
 *   written back with only the bold run's text changed reads back with every run as sent, its bold kept.
 * - **Z3** the pick's sentence edit: a paragraph of three runs (plain, bold, plain) updated with only one run's text
 *   changed reads back as sent, and the generic verify (`compareStoredBlocks`) finds it so.
 *
 * Everything runs in the sandbox runtime's own temporary database, through the job engine and the governor (never a raw
 * request; each versioned write carries If-Match from the engine's read). The same guard as the other sandbox tests: a
 * registered sandbox project with its own key, refused otherwise before any request. What it makes: one throwaway page
 * `lk-bridge r5 check <time>` (plain name, no prefix, no status tag) with two page documents and a sidebar property,
 * a template saved from it, and a copy of that template under the page. All deleted at the end, even after a failure;
 * the report names what must be deleted by hand. Cost: about 15 writes and 15 reads.
 *
 * CR-2026-11-R4 (the owner's request S): the runner is run on the mock in the ordinary suite too
 * (`test/sandbox-mock/assumptions-r5.test.ts`), every item failing the build.
 */
import { mainDocumentId } from '../../src/jobs/engine.js';
import { mintClientId, type OpParams, type StepOptions } from '../../src/jobs/index.js';
import { compareStoredBlocks } from '../../src/jobs/verify-blocks.js';
import type { SoakRuntime } from './soak.js';

type Obj = Record<string, any>;

export interface AssumptionsR5Item {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail' | 'noted';
  readonly detail: string;
}

const runsText = (runs: readonly Obj[]) =>
  runs.map((r) => `${r.bold ? '**' : ''}${String(r.text ?? '')}${r.bold ? '**' : ''}`).join('');
const blockWords = (blocks: readonly Obj[]) =>
  blocks
    .map((b) => ((b.content ?? []) as Obj[]).map((r) => String(r.text ?? '')).join(''))
    .join(' ')
    .trim();

export async function runAssumptionsR5(sb: SoakRuntime): Promise<AssumptionsR5Item[]> {
  const items: AssumptionsR5Item[] = [];
  const record = (id: string, title: string, verdict: AssumptionsR5Item['verdict'], detail: string) =>
    items.push({ id, title, verdict, detail });
  const run = async (op: string, params: OpParams, options: StepOptions = {}) => {
    const r = await sb.runtime.engine.run(op, params, {
      project: sb.projectId,
      origin: { kind: 'test', client: 'sandbox', tool: 'assumptions-r5' },
      priority: 'P2',
      ...options,
    });
    if (r.status !== 'succeeded') throw new Error(`${op}: ${r.status}; the whole answer: ${JSON.stringify(r)}`);
    return r.result as Obj;
  };
  const check = async (id: string, title: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      record(id, title, 'fail', `the check could not complete: ${(e as Error).message}`);
    }
  };
  const stamp = new Date().toISOString();
  let pageId: string | null = null;
  let templateId: string | null = null;
  try {
    const made = await run('createResource', {
      body: {
        id: mintClientId(8),
        name: `lk-bridge r5 check ${stamp}`,
        documents: [
          { name: 'Main', type: 'page' },
          { name: 'Notes', type: 'page' },
        ],
      },
    });
    pageId = String(made.id);
    const docs = (made.documents ?? []) as Obj[];
    const docOf = (name: string) => String(docs.find((d) => d.name === name)?.id ?? '');
    const MAIN_TEXT = 'The template’s own text.';
    const NOTES_TEXT = 'Notes kept beside it.';
    await run('replaceDocumentBlocks', {
      path: { resourceId: pageId, documentId: docOf('Main') },
      body: { blocks: [{ id: mintClientId(), kind: 'paragraph', content: [{ text: MAIN_TEXT }] }] },
    });
    await run('replaceDocumentBlocks', {
      path: { resourceId: pageId, documentId: docOf('Notes') },
      body: { blocks: [{ id: mintClientId(), kind: 'paragraph', content: [{ text: NOTES_TEXT }] }] },
    });

    await check('Z1', 'a template copy holds each of its documents; Main holds the template’s Main', async () => {
      const tpl = await run('saveResourceAsTemplate', {
        path: { resourceId: pageId! },
        body: { name: `lk-bridge r5 template ${stamp}` },
      });
      templateId = String(tpl.id);
      const copy = await run('createResourceFromTemplate', {
        body: { templateId, name: `lk-bridge r5 copy ${stamp}`, parentId: pageId },
      });
      const res = await run('getResource', { path: { resourceId: String(copy.id) } });
      const listed = ((res.documents ?? []) as Obj[]).filter((d) => !d.deletedAt);
      const order = listed.map((d) => `${String(d.name)} (${String(d.type)})`).join(', ');
      record('Z1', 'the order a template copy’s documents are listed in (NOTED)', 'noted', order);
      const main = mainDocumentId(listed);
      if (!main) {
        record('Z1', 'the copy has one document named Main', 'fail', `documents: ${order}`);
        return;
      }
      const read = async (documentId: string) =>
        blockWords(
          ((await run('getDocumentBlocks', { path: { resourceId: String(copy.id), documentId } })).blocks ??
            []) as Obj[],
        );
      const mainText = await read(main);
      const notes = listed.find((d) => d.name === 'Notes');
      const notesText = notes ? await read(String(notes.id)) : '(no Notes document)';
      const ok = mainText === MAIN_TEXT && notesText === NOTES_TEXT;
      record(
        'Z1',
        'a template copy holds each of its documents; Main holds the template’s Main',
        ok ? 'pass' : 'fail',
        `Main: “${mainText}”; Notes: “${notesText}”`,
      );
    });

    await check('Z2', 'a key-value row’s runs kept when one run’s text changes (bold kept)', async () => {
      const first = [{ text: 'Born ' }, { text: 'Camue 1st, 4A 100', bold: true }, { text: '; attested through 5A 931' }];
      // A key-value property is made with its rows (the spec requires them).
      const prop = await run('createProperty', {
        path: { resourceId: pageId! },
        body: { kind: 'keyValue', title: 'lk-bridge r5', rows: [{ key: 'Temporal Scope', content: first }] },
      });
      const propertyId = String(prop.id);
      const listed = await run('listPropertyRows', { path: { resourceId: pageId!, propertyId } });
      const row = ((listed.data ?? listed.rows ?? []) as Obj[]).find((r) => r.key === 'Temporal Scope');
      if (!row) throw new Error(`the row is not listed: ${JSON.stringify(listed)}`);
      const next = [{ text: 'Born ' }, { text: 'Camue 2nd, 4A 100', bold: true }, { text: '; attested through 5A 931' }];
      await run('updatePropertyRow', {
        path: { resourceId: pageId!, propertyId, rowId: String(row.id) },
        body: { content: next },
      });
      const rows = await run('listPropertyRows', { path: { resourceId: pageId!, propertyId } });
      const got = ((rows.data ?? rows.rows ?? []) as Obj[]).find((r) => r.id === row.id);
      const gotRuns = (got?.content ?? []) as Obj[];
      const ok = runsText(gotRuns) === runsText(next);
      record(
        'Z2',
        'a key-value row’s runs kept when one run’s text changes (bold kept)',
        ok ? 'pass' : 'fail',
        `sent ${runsText(next)}; read back ${runsText(gotRuns)} (${JSON.stringify(gotRuns)})`,
      );
    });

    await check('Z3', 'a paragraph’s runs kept when one run’s text changes; the generic verify agrees', async () => {
      const path = { resourceId: pageId!, documentId: docOf('Main') };
      const id = mintClientId();
      const block = (date: string) => ({
        id,
        kind: 'paragraph',
        content: [{ text: 'Ada was born on ' }, { text: date, bold: true }, { text: ' in Harrow.' }],
      });
      await run('replaceDocumentBlocks', { path, body: { blocks: [block('Camue 1st, 4A 100')] } });
      const sent = block('Camue 2nd, 4A 100');
      await run('replaceBlock', { path: { ...path, blockId: id }, body: sent });
      const after = await run('getDocumentBlocks', { path });
      const stored = ((after.blocks ?? []) as Obj[]).filter((b) => b.id === id);
      const cmp = compareStoredBlocks([sent], stored);
      record(
        'Z3',
        'a paragraph’s runs kept when one run’s text changes; the generic verify agrees',
        cmp.ok ? 'pass' : 'fail',
        cmp.ok
          ? `read back as sent: ${runsText(sent.content)}`
          : `${JSON.stringify(cmp)}; read back ${JSON.stringify(stored)}`,
      );
    });
  } finally {
    for (const [what, id, cascade] of [
      ['the throwaway template', templateId, false],
      ['the throwaway page (and the copy under it)', pageId, true],
    ] as const)
      if (id)
        try {
          await run(
            'deleteResource',
            { path: { resourceId: id }, ...(cascade ? { query: { cascade: true } } : {}) },
            cascade ? { confirm: 'cascade' } : {},
          );
        } catch (e) {
          record('cleanup', `${what} deleted`, 'fail', `${id}: ${(e as Error).message}. Delete it by hand.`);
        }
  }
  return items;
}

export function formatAssumptionsR5Report(items: readonly AssumptionsR5Item[]): string {
  const mark = { pass: 'PASS', fail: 'FAIL', noted: 'NOTED' } as const;
  return [
    '',
    'LK-Bridge sandbox: what the fourth review’s fixes assume of LegendKeeper (Z1–Z3)',
    '================================================================================',
    ...items.map((i) => `[${mark[i.verdict]}] (${i.id}) ${i.title}\n        ${i.detail}`),
    '',
  ].join('\n');
}
