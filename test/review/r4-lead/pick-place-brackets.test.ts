/**
 * CR-2026-11-R4 (the lead, from the as-of builder's note; R4-11's class): "Pick the right value" edits the date at the
 * place the check recorded (`place.at`). The scan never reads a date inside a bracketed parenthetical (RC-2), but the
 * place was found as the first whole occurrence of the date's text after the phrasing's date group began: an identical
 * date inside a bracket before the date read was recorded as its place, so the pick would have edited the bracketed
 * note and left the value it read. Each test asserts the SAFE behaviour.
 *
 * - LD-09: "… was born in Altan-Saray (Camue 1st, 4A 100) on Camue 1st, 4A 100": the place is the second date. As R4-11
 *   was first fixed it was the bracketed one (42, the date read being at 64); on the reviewed code, which recorded no
 *   place, the pick edited the first occurrence of the date's text in the block, the bracketed one too.
 * - LD-09b (control): a date read inside brackets, with no other occurrence, keeps its place (the old search).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCalendar, DEFAULT_DATE_STYLE } from '../../../src/calendar/index.js';
import {
  compilePatterns,
  dateOffset,
  extractPageFacts,
  placeSha,
  type NameIndex,
} from '../../../src/consistency/extract.js';
import { ARKONA_PACK } from '../../../src/packs/arkona.js';
import { nameKeyOf } from '../../../src/packs/naming/namesakes.js';

const ORACLE = JSON.parse(
  readFileSync(new URL('../../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as { calendar: unknown };
const cal = createCalendar(ORACLE.calendar);
const compiled = compilePatterns(ARKONA_PACK.rules.consistency!);
const known = new Map<string, 'name' | 'given'>([[nameKeyOf('Rashad al-Khalid'), 'name']]);
const names: NameIndex = { lookup: (k) => known.get(k) ?? null };
const ctx = { compiled, names, cal, style: DEFAULT_DATE_STYLE };

function birthIn(sentence: string) {
  const { facts } = extractPageFacts(
    'p1',
    [
      {
        unit: 'name',
        text: 'Velara - Polity Reference',
        documentId: null,
        blockId: null,
        field: null,
        section: null,
      },
      { unit: 'text', text: sentence, documentId: 'doc1', blockId: 'b1', field: null, section: 'Purpose' },
    ],
    ctx,
  );
  return facts.find((f) => f.kind === 'birth' && f.source === 'prose');
}

describe('the pick’s place is the date the check read, never one in brackets before it (LD-09)', () => {
  it('LD-09: an identical date inside a bracket before the date read is not its place', () => {
    const sentence = 'Rashad al-Khalid was born in Altan-Saray (Camue 1st, 4A 100) on Camue 1st, 4A 100.';
    const f = birthIn(sentence);
    expect(f?.date?.text, JSON.stringify(f)).toBe('Camue 1st, 4A 100');
    const read = sentence.lastIndexOf('Camue 1st, 4A 100');
    expect(f?.place).toEqual({ sha: placeSha(sentence), at: read });
  });

  it('LD-09b (control): a date only inside brackets keeps the place the old search gave it', () => {
    const text = 'Born (Camue 1st, 4A 100)';
    expect(dateOffset(text, 0, 'Camue 1st, 4A 100')).toBe(6);
  });
});
