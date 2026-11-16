import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadScenarios,
  parseScenarios,
  promptsToCopy,
  scenariosFor,
} from '../../src/evaluation/scenarios.js';
import { TOOL_ALIASES } from '../../src/evaluation/grade.js';
import { startStack, type Stack } from '../tools/helpers.js';

/** v2 E3 (ADR 0045): docs/reviews/scenarios.json is the owner's script as data; a prompt never names a tool. */

const file = loadScenarios();
const byId = (id: number) => file.scenarios.find((s) => s.id === id)!;

/** Names the lead is merging away, and tools that may be hidden from a profile: a prompt may not name these either. */
const OLD_OR_HIDDEN = [
  'get_resources',
  'bridge_proposals_mine',
  'bridge_job_wait',
  'prepare_image_upload',
  'lk_upload_image',
  'create_bare_resource',
];

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.close());

describe('docs/reviews/scenarios.json', () => {
  it('loads and is valid: the 30 scenarios of the E3 script and v3 F3a’s four, numbered 1 to 34', () => {
    expect(file.scenarios.map((s) => s.id)).toEqual(Array.from({ length: 34 }, (_, i) => i + 1));
    expect(file.preamble).toMatch(/^I am testing a LegendKeeper connector called LK-Bridge/);
    expect(file.preamble).toContain('Work only in the project named `test`');
    for (const s of file.scenarios) {
      expect(s.prompts.length, `scenario ${s.id}`).toBeGreaterThan(0);
      expect(s.shortTitle.length).toBeGreaterThan(0);
    }
  });

  it('rejects a file that is not valid (a duplicate, an unknown dependency, an extra key)', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../../docs/reviews/scenarios.json', import.meta.url), 'utf8'),
    ) as {
      scenarios: Record<string, unknown>[];
    };
    const bad = (mutate: (f: typeof raw) => void) => {
      const copy = structuredClone(raw);
      mutate(copy);
      return () => parseScenarios(JSON.stringify(copy));
    };
    expect(bad((f) => (f.scenarios[1]!.id = 1))).toThrow(/appears twice/);
    expect(bad((f) => (f.scenarios[1]!.dependsOn = [99]))).toThrow(/depends on 99/);
    expect(bad((f) => (f.scenarios[1]!.surprise = true))).toThrow(/not valid/);
    expect(bad((f) => (f.scenarios[1]!.assistants = []))).toThrow(/not valid/);
  });

  it('marks exactly the owner’s shortlist as core: 9, 10, 11, 13, 14, 16, 18, 21, 26, 28, 29 plus 1, 4, 5, 6, 7, 8', () => {
    const core = file.scenarios.filter((s) => s.core).map((s) => s.id);
    expect(core).toEqual([1, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 16, 18, 21, 26, 28, 29]);
  });

  it('never names a tool in a prompt or in the preamble', () => {
    const real = stack.runtime.tools.map((t) => t.name);
    expect(real).toContain('search');
    const names = [...new Set([...real, ...OLD_OR_HIDDEN, ...Object.keys(TOOL_ALIASES)])];
    const texts = [
      file.preamble,
      ...file.scenarios.flatMap((s) => [...s.prompts, ...promptsToCopy(file, s)]),
    ];
    for (const name of names) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'i');
      for (const t of texts) expect(re.test(t), `“${name}” appears in: ${t.slice(0, 80)}`).toBe(false);
    }
  });

  it('names only tools that exist (or aliases of them) in expected and mistake lists', () => {
    const real = new Set(stack.runtime.tools.map((t) => t.name));
    const known = new Set([...real, ...Object.keys(TOOL_ALIASES)]);
    for (const s of file.scenarios) {
      const expected = s.expectedTools.flat();
      for (const t of [...expected, ...s.optionalTools, ...s.mistakeTools])
        expect(known.has(t), `scenario ${s.id}: ${t}`).toBe(true);
    }
  });

  it('expects the merged tools’ new names: get_resource for scenario 5 and bridge_proposal_status for scenario 25', () => {
    expect(byId(5).expectedTools).toEqual(['get_resource']);
    expect(byId(25).expectedTools).toEqual(['bridge_proposal_status']);
    for (const s of file.scenarios)
      for (const t of s.expectedTools.flat())
        expect(Object.keys(TOOL_ALIASES), `scenario ${s.id} names the old ${t}`).not.toContain(t);
  });

  it('names the tools the E3 script says would be a mistake', () => {
    expect(byId(1).mistakeTools).toContain('lk_api_read');
    expect(byId(14).mistakeTools).toContain('create_bare_resource');
    expect(byId(21).mistakeTools).toEqual(
      expect.arrayContaining(['lk_upload_image', 'prepare_image_upload']),
    );
    expect(byId(28).expectedTools).toEqual(['get_bridge_guide', 'lk_api_read']);
    expect(byId(29).expectedTools).toEqual([]);
  });

  it('says which assistants take part, what continues what, and what needs the owner’s approval', () => {
    expect(file.scenarios.every((s) => s.assistants.includes('claude'))).toBe(true);
    expect(byId(7).dependsOn).toEqual([6]);
    expect(byId(8).dependsOn).toEqual([7]);
    expect(byId(15).dependsOn).toEqual(expect.arrayContaining([14]));
    expect(byId(19).dependsOn).toEqual([18]);
    for (const id of [5, 9, 10, 11, 12, 13, 14, 15, 16, 21, 22])
      expect(byId(id).dependsOn, `scenario ${id}`).toEqual(expect.arrayContaining([6, 7]));
    expect(byId(10).needsApproval).toBe(true);
    expect(byId(1).needsApproval).toBe(false);
    expect(byId(8).alwaysProposal).toBe(true);
    // The core set holds everything its scenarios depend on.
    const core = new Set(file.scenarios.filter((s) => s.core).map((s) => s.id));
    for (const s of file.scenarios.filter((x) => x.core))
      for (const d of s.dependsOn) expect(core.has(d), `core ${s.id} needs ${d}`).toBe(true);
  });

  it('keeps the two prompts of scenario 13 and the base64 image of scenario 21 exactly', () => {
    expect(byId(13).prompts).toHaveLength(2);
    expect(byId(13).interlude).toMatch(/LegendKeeper app/);
    const md = readFileSync(new URL('../../docs/reviews/E3-evaluation.md', import.meta.url), 'utf8');
    const png = /`(iVBORw0KGgo[A-Za-z0-9+/=]+)`/.exec(md)![1]!;
    expect(byId(21).prompts[0]).toContain(png);
    expect(byId(21).prompts[0]!.endsWith(png)).toBe(true);
    expect(png.length).toBe(128);
  });

  it('puts the preamble before the first prompt of a fresh chat only', () => {
    expect(promptsToCopy(file, byId(1))[0]).toBe(`${file.preamble}\n\n${byId(1).prompts[0]}`);
    expect(promptsToCopy(file, byId(13))[0]!.startsWith(file.preamble)).toBe(true);
    expect(promptsToCopy(file, byId(13))[1]).toBe(byId(13).prompts[1]);
    expect(byId(7).freshChat).toBe(false);
    expect(promptsToCopy(file, byId(7))[0]).toBe(byId(7).prompts[0]);
  });

  it('lists the scenarios of a set for an assistant', () => {
    expect(scenariosFor(file, 'all', 'chatgpt')).toHaveLength(34);
    expect(scenariosFor(file, 'core', 'claude')).toHaveLength(17);
  });

  it('E4: scenario 4 asks for a section by its place, never a heading the test page lacks', () => {
    // The owner's run of 15 November 2026: "Biography" is not a heading of the page, so the right tools ended in
    // SECTION_NOT_FOUND. The repository holds no copy of the page's real headings, so the prompt names the first one.
    const p = byId(4).prompts[0]!;
    expect(p).not.toMatch(/Biography/);
    expect(p).toMatch(/first section/);
    expect(byId(4).expectedTools).toEqual(['read_document']);
    const md = readFileSync(new URL('../../docs/reviews/E3-evaluation.md', import.meta.url), 'utf8');
    expect(md).toContain('Read only the first section of Asagiri Miyabi');
  });

  it('E4: scenario 21 records `deduplicated` on a repeat run as an expected, correct outcome', () => {
    const s = byId(21);
    for (const note of [s.expectedNote, s.toolCallsNote, s.setupNote ?? ''])
      expect(note, note).toMatch(/deduplicated/);
    expect(s.watchFor).toMatch(/deduplicate: false/);
  });

  it('v3 F3a: the four Arkona pack scenarios are marked with their pack and expect the pack tool', () => {
    const pack = file.scenarios.filter((s) => s.pack !== undefined);
    expect(pack.map((s) => [s.id, s.pack])).toEqual([
      [31, 'arkona'],
      [32, 'arkona'],
      [33, 'arkona'],
      [34, 'arkona'],
    ]);
    for (const s of pack) {
      expect(s.expectedTools.flat(), `scenario ${s.id}`).toContain('arkona_create_character');
      expect(s.mistakeTools, `scenario ${s.id}`).toContain('create_character');
      expect(s.core, `scenario ${s.id}`).toBe(false);
    }
    // The developed character stages its image first; the missing culture proposes nothing; the extension needs 31.
    expect(byId(32).expectedTools).toEqual(['upload_image', 'arkona_create_character']);
    expect(byId(33).alwaysProposal).toBe(false);
    expect(byId(34).dependsOn).toEqual([31]);
    // The human copy lists them too, with the same prompts.
    const md = readFileSync(new URL('../../docs/reviews/E3-evaluation.md', import.meta.url), 'utf8');
    for (const s of pack) for (const p of s.prompts) expect(md, `scenario ${s.id}`).toContain(p);
  });

  it('is pointed to from the human copy', () => {
    const md = readFileSync(new URL('../../docs/reviews/E3-evaluation.md', import.meta.url), 'utf8');
    expect(md.slice(0, 1200)).toContain('scenarios.json');
  });
});
