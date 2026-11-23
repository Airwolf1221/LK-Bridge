/**
 * v3 F7b (ADR 0071, D2): reading an image's written authority from a page's blocks: the image's alt text as its label,
 * the section above it, and the text under it up to the next image or heading, trimmed to 1,200 characters; and the
 * order of several pages (Authoritative first, owner pages first within a lifecycle).
 */
import { describe, expect, it } from 'vitest';
import {
  embeddingsIn,
  imageUrlsIn,
  sortAuthority,
  type AuthorityPage,
} from '../../src/art/view/authority.js';

const URL1 =
  'https://assets.legendkeeper.com/cmretrj150aph43prgyxsdbsn_5aa52e7d-b052-48b2-a5f6-566a113b391f.webp';
const URL2 = 'https://assets.legendkeeper.com/64b8054d-5986-4027-bfb2-8acc55c23035.webp';
const h = (id: string, level: number, text: string) => ({ id, kind: 'heading', level, content: [{ text }] });
const p = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });
const img = (id: string, url: string, alt?: string) => ({ id, kind: 'image', url, ...(alt ? { alt } : {}) });

describe('embeddingsIn', () => {
  it('reads the label (alt text), the section and the paragraphs under the image', () => {
    const blocks = [
      h('h1', 2, 'Purpose'),
      p('p1', 'Her approved visual references.'),
      h('h2', 2, 'Reference Images'),
      h('h3', 3, 'Primary Reference - Character Portrait'),
      img('i1', URL1, 'Primary Reference - Character Portrait'),
      p('p2', 'Establishes her face.'),
      p('p3', 'Takes precedence over prose descriptions of her features; it does not establish her height.'),
      img('i2', URL2, 'Outfit Reference - Front'),
      p('p4', 'Another image’s text.'),
    ];
    const e = embeddingsIn(blocks, new URL(URL1).pathname, 1200);
    expect(e).toEqual([
      {
        blockId: 'i1',
        section: 'Reference Images > Primary Reference - Character Portrait',
        label: 'Primary Reference - Character Portrait',
        text: 'Establishes her face.\n\nTakes precedence over prose descriptions of her features; it does not establish her height.',
        truncated: false,
      },
    ]);
  });

  it('stops at the next heading; matches the same file on assets2; reads inside a container', () => {
    const blocks = [
      h('h1', 2, 'Gallery'),
      {
        id: 'c1',
        kind: 'callout',
        children: [h('h2', 3, 'Inner'), img('i1', URL2.replace('assets.', 'assets2.')), p('p1', 'Inside.')],
      },
      p('p2', 'After the container: not the image’s.'),
      img('i2', URL2),
      h('h3', 2, 'Next'),
      p('p3', 'Under another heading.'),
    ];
    const e = embeddingsIn(blocks, new URL(URL2).pathname, 1200);
    expect(e.map((x) => [x.blockId, x.section, x.label, x.text])).toEqual([
      ['i1', 'Gallery > Inner', null, 'Inside.'],
      ['i2', 'Gallery', null, ''],
    ]);
  });

  it('trims the text to 1,200 characters with truncated: true', () => {
    const long = 'x'.repeat(900);
    const blocks = [img('i1', URL1, 'Label'), p('p1', long), p('p2', long)];
    const [e] = embeddingsIn(blocks, new URL(URL1).pathname, 1200);
    expect(e!.truncated).toBe(true);
    expect(e!.text).toHaveLength(1200);
    expect(e!.text.endsWith('…')).toBe(true);
    const [short] = embeddingsIn([img('i1', URL1), p('p1', 'x'.repeat(1200))], new URL(URL1).pathname, 1200);
    expect(short!.truncated).toBe(false);
    expect(short!.text).toHaveLength(1200);
  });

  it('imageUrlsIn lists every image block in document order, nested ones in place', () => {
    const blocks = [
      img('i1', URL1),
      {
        id: 'c',
        kind: 'layout',
        children: [{ id: 'col', kind: 'column', children: [img('i2', URL2, 'B')] }],
      },
      p('p', 't'),
      img('i3', URL1),
    ];
    expect(imageUrlsIn(blocks).map((x) => [x.blockId, x.alt])).toEqual([
      ['i1', null],
      ['i2', 'B'],
      ['i3', null],
    ]);
  });
});

describe('sortAuthority', () => {
  const page = (id: string, lifecycle: AuthorityPage['lifecycle'], ownerPage: boolean): AuthorityPage => ({
    page: { id, name: id, path: `AI REPOSITORY / ${id}` },
    document: { id: 'd', name: 'Main' },
    section: null,
    lifecycle,
    ownerPage,
    blockId: null,
    label: null,
    text: '',
    from: 'snapshot',
  });
  it('puts Authoritative pages first, then none, Working, Archived; owner pages first within each', () => {
    const sorted = sortAuthority([
      page('w-notes', 'Working', false),
      page('a-core', 'Authoritative', false),
      page('x-old', 'Archived', true),
      page('z-art', 'Authoritative', true),
      page('i-index', null, false),
      page('w-art', 'Working', true),
    ]);
    expect(sorted.map((x) => x.page.id)).toEqual(['z-art', 'a-core', 'i-index', 'w-art', 'w-notes', 'x-old']);
  });
});
