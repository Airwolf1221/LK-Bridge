/**
 * The parts of write_page that are pure or small: the verify comparison (src/jobs/verify-blocks.ts), the Markdown diff
 * with keep-region placeholders (src/pages/diff.ts), the bridge's memory of page versions (src/pages/versions.ts), and
 * the finding recorded in ADR 0031 that a newline inside a text run cannot be written as `<br>` without changing it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase } from '../../src/db/open.js';
import { compareStoredBlocks, normaliseRuns, VERIFY_IGNORED_FIELDS } from '../../src/jobs/index.js';
import { fromMarkdown, toMarkdown, type LkBlock } from '../../src/markdown/index.js';
import { DocumentVersions, markdownDiff, unifiedText, withPlaceholders } from '../../src/pages/index.js';
import { richPage } from '../markdown/fixtures.js';

describe('verify: the stored blocks against the blocks sent', () => {
  const sent: LkBlock[] = [
    { id: 'h1', kind: 'heading', level: 2, content: [{ text: 'Title' }] },
    {
      id: 'p1',
      kind: 'paragraph',
      content: [{ text: 'See ' }, { mention: { resourceId: 'kaede001', text: 'Kaede' } }, { text: '.' }],
    },
    { kind: 'paragraph', content: [{ text: 'A legacy block without an id.' }] },
    { id: 'q1', kind: 'quote', children: [{ id: 'q1p', kind: 'paragraph', content: [{ text: 'Q' }] }] },
  ];
  it('ignores exactly what LegendKeeper legitimately changes, listed explicitly', () => {
    const stored = structuredClone(sent) as Record<string, unknown>[];
    stored[0]!.version = 'b7'; // per-block version (read-only)
    (stored[1]!.content as Record<string, unknown>[])[1] = {
      mention: { resourceId: 'kaede001', text: 'Kaede', name: 'Asagiri Kaede' }, // read-only name
    };
    stored[2]!.id = 'lkminted'; // a block sent without an id is given one
    (stored[3]!.children as Record<string, unknown>[])[0]!.version = 'b9';
    expect(compareStoredBlocks(sent, stored)).toEqual({ ok: true, differences: [], count: 0 });
    expect(VERIFY_IGNORED_FIELDS).toHaveLength(6);
  });
  it('normalises runs as LegendKeeper does on write: empty text dropped, same-mark neighbours merged', () => {
    expect(
      normaliseRuns([
        { text: 'a' },
        { text: '' },
        { text: 'b' },
        { text: 'c', bold: true },
        { text: 'd', bold: true },
      ]),
    ).toEqual([{ text: 'ab' }, { text: 'cd', bold: true }]);
    const stored = [{ id: 'p', kind: 'paragraph', content: [{ text: 'ab' }] }];
    expect(
      compareStoredBlocks([{ id: 'p', kind: 'paragraph', content: [{ text: 'a' }, { text: 'b' }] }], stored)
        .ok,
    ).toBe(true);
  });
  it('reports every other difference with its path: text, ids, order, a missing or extra block', () => {
    const text = structuredClone(sent) as Record<string, unknown>[];
    (text[3]!.children as Record<string, unknown>[])[0]!.content = [{ text: 'Changed outside' }];
    const r = compareStoredBlocks(sent, text);
    expect(r.ok).toBe(false);
    expect(r.differences[0]).toMatchObject({
      path: '[3].children[0].content[0].text',
      expected: 'Q',
      actual: 'Changed outside',
    });
    const ids = structuredClone(sent) as Record<string, unknown>[];
    ids[0]!.id = 'other';
    expect(compareStoredBlocks(sent, ids).differences[0]).toMatchObject({
      path: '[0].id',
      expected: 'h1',
      actual: 'other',
    });
    const extra = [...structuredClone(sent), { id: 'x', kind: 'rule' }];
    expect(compareStoredBlocks(sent, extra).differences[0]).toMatchObject({
      path: '[4]',
      expected: '(nothing)',
    });
    const missing = structuredClone(sent).slice(0, 3);
    expect(compareStoredBlocks(sent, missing).count).toBe(1);
    const field = structuredClone(sent) as Record<string, unknown>[];
    field[0]!.level = 3;
    expect(compareStoredBlocks(sent, field).differences[0]!.path).toBe('[0].level');
  });
});

describe('the Markdown diff', () => {
  it('shows each keep region as one labelled placeholder line, and diffs line by line in hunks', () => {
    const before = toMarkdown(richPage()).markdown;
    expect(withPlaceholders(before)).toContain('[keep region: infobox infobx01]');
    expect(withPlaceholders(before).join('\n')).not.toContain('lk:keep');
    const after = before.replace('Offerings are left at dawn.', 'Offerings are left at dusk.');
    const d = markdownDiff(before, after);
    expect(d).toMatchObject({ added: 1, removed: 1 });
    expect(d.hunks).toHaveLength(1);
    const text = unifiedText(d);
    expect(text).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(text).toContain('-Offerings are left at dawn.');
    expect(text).toContain('+Offerings are left at dusk.');
    expect(text).toContain(' [keep region: unsupported unsup001]'); // context around the change
    // A dropped region shows as one removed placeholder line.
    const dropped = before.replace(/<!-- lk:keep id="coll0001"[\s\S]*?<!-- \/lk:keep -->\n\n/, '');
    expect(unifiedText(markdownDiff(before, dropped))).toContain(
      '-[keep region: resourceCollection coll0001]',
    );
  });
  it('separate changes far apart make separate hunks; no change makes none', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[2] = 'first change';
    changed[35] = 'second change';
    const d = markdownDiff(lines.join('\n'), changed.join('\n'));
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[1]).toMatchObject({ beforeStart: 33, afterStart: 33 });
    expect(markdownDiff('a\nb', 'a\nb').hunks).toEqual([]);
  });
});

describe('the memory of page versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lkb-versions-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('remembers a few versions per document and project, for a few days', () => {
    const db = openDatabase(join(dir, 'v.db'));
    runMigrations(db);
    let now = 1_000_000;
    const v = new DocumentVersions(db, () => now, { perDocument: 3, maxAgeMs: 10_000, maxBytes: 100 });
    for (let i = 1; i <= 5; i++) {
      now += 1;
      v.remember('pa', 'doc1', `v${i}`, `# Page at ${i}`);
    }
    expect(v.markdownAt('pa', 'doc1', 'v5')).toBe('# Page at 5');
    expect(v.markdownAt('pa', 'doc1', 'v2')).toBeUndefined(); // only the newest three
    expect(v.markdownAt('pb', 'doc1', 'v5')).toBeUndefined(); // another project's document
    v.remember('pa', 'doc2', 'v1', 'x'.repeat(101)); // too large to keep
    expect(v.markdownAt('pa', 'doc2', 'v1')).toBeUndefined();
    now += 20_000;
    expect(v.markdownAt('pa', 'doc1', 'v5')).toBeUndefined(); // too old
    db.close();
  });
});

describe('a newline inside a text run written as <br> (ADR 0031: not proposed, it does not round-trip)', () => {
  const withNewline: LkBlock = {
    id: 'pnl00001',
    kind: 'paragraph',
    content: [{ text: 'first line\nsecond line' }],
  };
  const withBreak: LkBlock = {
    id: 'pbr00001',
    kind: 'paragraph',
    content: [{ text: 'first line' }, { break: true }, { text: 'second line' }],
  };
  it('today the paragraph is a keep region, so it is restored exactly', () => {
    expect(toMarkdown([withNewline]).regions).toEqual([
      { id: 'pnl00001', kind: 'paragraph', reason: 'text holds a line break or control character' },
    ]);
  });
  it('<br> already means LegendKeeper’s own line-break run, and reads back as one: the block would change', () => {
    expect(toMarkdown([withBreak]).markdown).toBe('first line<br>second line\n');
    const back = fromMarkdown('first line<br>second line', []).blocks[0]!;
    expect(back.content).toEqual(withBreak.content);
    expect(back.content).not.toEqual(withNewline.content);
  });
  it('nor does a character reference keep it (&#10; reads as a space)', () => {
    expect(fromMarkdown('first line&#10;second line', []).blocks[0]!.content).toEqual([
      { text: 'first line second line' },
    ]);
  });
});
