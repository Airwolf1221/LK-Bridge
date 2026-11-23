/**
 * v3 F7b (ADR 0071, D7): the bridge guide's "Seeing character art", one row for it in "How to decide" and nothing
 * more, and the tool's description stating its cost in the owner's words.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COST_LINE } from '../../src/art/view/get-art.js';

const guide = readFileSync(new URL('../../docs/bridge-guide.md', import.meta.url), 'utf8');
const section = guide.slice(guide.indexOf('### Seeing character art'), guide.indexOf('### Arkona appraisal'));
const decide = guide.slice(guide.indexOf('## How to decide'), guide.indexOf('\n## Find and read a page'));

describe('D7: Seeing character art', () => {
  it('says when to call it, that it is literal and the authority governs, how to view links, and never to substitute', () => {
    expect(section).toMatch(
      /Before you describe, draw on or write about a character's appearance, call `arkona_get_art`/,
    );
    expect(section).toMatch(/literal visual reference/);
    expect(section).toMatch(/The authority text governs/);
    expect(section).toMatch(/open each `url` with your \*\*web browsing tool\*\*,\s+never with code/);
    expect(section).toMatch(/Never use an image found elsewhere \(a web or image search/);
    expect(section).toMatch(/say that you could not see the art/);
  });
  it('"How to decide" has one row for it, and names it nowhere else', () => {
    expect(decide.match(/arkona_get_art/g)).toHaveLength(1);
    expect(decide).toMatch(/^\| See a character's art .*`arkona_get_art`.*\|$/m);
  });
  it('the description’s cost line is the owner’s sentence', () => {
    expect(COST_LINE).toBe('Cost: none for links; 1 read per image downloaded for inline (cached).');
  });
});
