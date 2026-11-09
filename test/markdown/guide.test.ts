/**
 * docs/markdown.md is the guide agents read (B2 serves it through get_markdown_guide). Its examples must do what it
 * says: every fenced `markdown` example converts, and the error codes, warnings and editor rules it lists are exactly the
 * converter's.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EDITOR_RULES, fromMarkdown, stubResolver, toMarkdown } from '../../src/markdown/index.js';

const guide = readFileSync(new URL('../../docs/markdown.md', import.meta.url), 'utf8');
const errorsSource = readFileSync(new URL('../../src/markdown/errors.ts', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../../src/markdown/types.ts', import.meta.url), 'utf8');

/** Fenced ```markdown examples (the four-backtick one holds an lk-block). */
function examples(): string[] {
  const out: string[] = [];
  const re = /^(`{3,})markdown\n([\s\S]*?)^\1$/gm;
  for (let m = re.exec(guide); m; m = re.exec(guide)) out.push(m[2]!);
  return out;
}

describe('docs/markdown.md', () => {
  const ctx = {
    resolveMention: stubResolver({ 'Asagiri Kaede': 'sis00001', 'Page name': 'page0001' }),
    isProjectAsset: () => true,
  };

  it('every Markdown example converts, and converts back to the same Markdown', () => {
    const list = examples();
    expect(list.length).toBeGreaterThanOrEqual(7);
    for (const md of list) {
      if (md.includes('lk:keep')) continue; // a keep region needs its page: checked below
      const r = fromMarkdown(md, [], ctx);
      expect(r.blocks.length, md).toBeGreaterThan(0);
      // Reading the result gives Markdown that converts to the same blocks again.
      const again = fromMarkdown(toMarkdown(r.blocks).markdown, r.blocks, ctx);
      expect(again.plan.empty, md).toBe(true);
    }
  });

  it('the keep-region example is what an infobox looks like', () => {
    const md = toMarkdown([
      {
        id: 'infobx01',
        kind: 'infobox',
        rows: [
          { id: 'p1', kind: 'keyValue', title: 'PROPERTIES', rows: [{ key: 'Group', text: 'Beastkin' }] },
        ],
      },
    ]).markdown;
    expect(examples().find((e) => e.includes('lk:keep'))).toBe(md);
  });

  it('lists exactly the converter’s error codes, warnings and editor rules', () => {
    const codes = [...errorsSource.matchAll(/^\s+\| '([A-Z_]+)'/gm)].map((m) => m[1]!);
    const listed = (code: string) => guide.includes(`\`${code}\``);
    for (const c of codes.filter((c) => c !== 'RENDER_SELF_CHECK_FAILED')) expect(listed(c), c).toBe(true);
    const warnings = [
      ...typesSource.slice(typesSource.indexOf('MarkdownWarningCode =')).matchAll(/\| '([A-Z_]+)'/g),
    ].map((m) => m[1]!);
    expect(warnings.length).toBeGreaterThan(10);
    for (const w of warnings) expect(listed(w), w).toBe(true);
    for (const r of EDITOR_RULES) expect(guide, r.id).toContain(r.id);
  });
});
