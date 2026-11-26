/* eslint-disable @typescript-eslint/no-explicit-any -- LK blocks are untyped JSON */
/**
 * The throwaway governance page's blocks (harness only; no product code): a pure function, so it is unit-tested without a
 * runtime (test/sandbox-mock/governance-blocks.test.ts). `ensureSandboxGovernance` (governance.ts) calls it.
 *
 * The page holds every heading the pack pins. A heading whose section the bridge PARSES must carry text that parses:
 *
 * - Reference Type Vocabulary: while the vocabulary is a draft the heading is left out ("unpublished", never refusing the
 *   approval); once published (the owner publishes it, and the sandbox copies the pack state) the section is rendered by
 *   the product's own `spliceSection`, under the heading the pack pins, from the lists the vocabulary holds.
 * - Navigation and Subject Index Tags: likewise, written as `indexTagSectionText` gives it (what f6b-nav N4 writes).
 * - The Approved Supplementary Tags and the block-id sweep paragraph: their known sentences.
 * - Any other pinned section with a parser would get a placeholder it cannot parse. That is refused here, naming the
 *   heading, rather than letting the pack's approval fail later with a confusing message.
 */
import { indexTagSectionText, parseIndexTagSection } from '../../src/packs/indextax/rules.js';
import {
  parseSection,
  sameVocabulary,
  spliceSection,
  type VocabularyLists,
} from '../../src/packs/reftypes/vocabulary.js';
import { headingKey, sectionBlocksOf } from '../../src/packs/sections.js';
import type { PackRules } from '../../src/packs/types.js';

type Obj = Record<string, any>;

/** The Tagging Standard's section as Arkona's page has it (23 November 2026), verbatim. */
export const SUPPLEMENTARY_SENTENCE =
  'Under the Exact Tag Grammar’s provision for a deliberately approved exception, the author has approved these existing tags as permitted supplementary tags on any eligible owner (author ruling, 23 November 2026): Cosmology, Chronology and Setting Framework. A permitted supplementary tag is kept, after the grammar’s slots, wherever it appears. It is not a primary category or a specialist function, it is never added to a page by inference or by an audit, and it is never proposed for removal as incidental. Adding a tag to this list, or removing one, is an author decision recorded here.';

/** The block-id sweep's paragraph, in the words the owner's brief quotes. */
export const SWEEP_SENTENCE =
  'Assign Block IDs Sweep (owner approval, 17 November 2026): enabling it is the activation, and this approval establishes no wider repair whitelist.';

/** The sections of a pack's rules that name a governance source (`source` and `section`), by the path of the rule. */
export function pinnedRuleSections(rules: unknown): { readonly path: string; readonly section: string }[] {
  const out: { path: string; section: string }[] = [];
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v) || typeof v !== 'object' || v === null) return;
    const o = v as Obj;
    if (typeof o.source === 'string' && typeof o.section === 'string') out.push({ path, section: o.section });
    for (const [k, x] of Object.entries(o)) walk(x, path === '' ? k : `${path}.${k}`);
  };
  walk(rules, '');
  return out;
}

/** The rule sections this builder writes in a form the bridge parses (by the path of the rule). */
const HANDLED = new Set(['referenceTypes', 'indexTaxonomy', 'retag.supplementary', 'automation']);

export interface GovernanceBlocksInput {
  readonly label: string;
  /** The pack's governance sources (only their pinned `sections` are read). */
  readonly sources: readonly { readonly sections?: readonly string[] | undefined }[];
  /** The pack's rules (as `rt.packs.get(id).rules`; only the rule sections are read). */
  readonly rules: Partial<Pick<PackRules, 'referenceTypes' | 'indexTaxonomy' | 'retag' | 'automation'>>;
  /**
   * The lists "Publish vocabulary" would write (`effectiveVocabulary(rules.referenceTypes, the decisions).lists`).
   * Required once the vocabulary is published; ignored while it is a draft.
   */
  readonly vocabulary?: VocabularyLists | null;
  /** The Approved Supplementary Tags paragraph, and the block-id sweep paragraph. */
  readonly supplementarySentence: string;
  readonly sweepSentence: string;
  /** The sweep's heading when the pack's own rules do not name one (the code's, for an older stored pack). */
  readonly fallbackSweepSection?: string | undefined;
}

export interface GovernanceBlocks {
  readonly blocks: Obj[];
  /** The pinned headings the page carries (the draft rules' headings left out; the published ones written for real). */
  readonly headings: readonly string[];
  /** What was written for the rules the owner has published, for the report. */
  readonly published: readonly string[];
}

const fail = (heading: string, why: string): never => {
  throw new Error(
    `the throwaway governance page cannot carry the section “${heading}”: ${why}. A placeholder paragraph would not parse, ` +
      'so the pack could not be approved; teach test/sandbox/governance-blocks.ts to write this section.',
  );
};

/** The blocks of the throwaway governance page. Throws, naming the heading, when a parsed section cannot be written. */
export function buildGovernanceBlocks(o: GovernanceBlocksInput): GovernanceBlocks {
  const { rules } = o;
  // 3. Every pinned rule section is one this builder writes in a parsed form: else refuse, naming the heading.
  for (const p of pinnedRuleSections(rules))
    if (!HANDLED.has(p.path)) fail(p.section, `the pack's rule “${p.path}” pins it and the bridge parses it`);

  const vocab = rules.referenceTypes;
  const tags = rules.indexTaxonomy;
  const vocabDraft = vocab?.status === 'draft';
  const vocabPublished = vocab?.status === 'published';
  const tagsDraft = tags?.status === 'draft';
  const tagsPublished = tags?.status === 'published';
  const supplementary = rules.retag?.supplementary?.section;
  const sweep = rules.automation?.section ?? o.fallbackSweepSection;

  // The headings the page carries as plain sections: the vocabulary's and the tag rule's are written separately.
  const leftOut = new Set<string>();
  if (vocab) leftOut.add(vocab.section);
  if (tags) leftOut.add(tags.section);
  const headings = [...new Set(o.sources.flatMap((g) => g.sections ?? []))].filter((h) => !leftOut.has(h));
  // The section the vocabulary is published under (a draft's check publishes it there; a published one is spliced in).
  if (vocab && !headings.includes(vocab.under)) headings.push(vocab.under);

  let blocks: Obj[] = [{ kind: 'heading', level: 1, content: [{ text: o.label }] }];
  for (const h of headings)
    blocks.push(
      { kind: 'heading', level: 2, content: [{ text: h }] },
      {
        kind: 'paragraph',
        content: [
          {
            text:
              h === supplementary
                ? o.supplementarySentence
                : h === sweep
                  ? o.sweepSentence
                  : `The rules of ${h}.`,
          },
        ],
      },
    );

  const published: string[] = [];
  // 1. The Reference Type Vocabulary, published: the product's own rendering, under the pinned heading.
  if (vocab && vocabPublished) {
    if (!o.vocabulary)
      return fail(vocab.section, 'the vocabulary is published but no lists were given to render');
    const spliced = spliceSection(blocks, vocab.under, vocab.section, o.vocabulary);
    if (!spliced.ok) return fail(vocab.section, spliced.reason);
    blocks = spliced.blocks;
    const back = parseSection(sectionBlocksOf(blocks, vocab.section));
    if (!back.ok) return fail(vocab.section, `the rendered section does not read back (${back.reason})`);
    if (!sameVocabulary(back.vocabulary, o.vocabulary))
      return fail(vocab.section, 'the rendered section reads back as a different vocabulary');
    published.push(
      `${vocab.section} (published: ${back.vocabulary.categories.length} categories, level ${spliced.level})`,
    );
  } else if (vocab && !vocabDraft) {
    fail(vocab.section, `its status is “${String((vocab as Obj).status)}”`);
  }

  // 2. The Navigation and Subject Index Tags, published: the section's text as the pack holds it (as f6b-nav N4 wrote it).
  if (tags && tagsPublished) {
    blocks.push(
      { kind: 'heading', level: 2, content: [{ text: tags.section }] },
      ...indexTagSectionText(tags).map((text) => ({ kind: 'paragraph', content: [{ text }] })),
    );
    const back = parseIndexTagSection(sectionBlocksOf(blocks, tags.section));
    if (!back.ok) return fail(tags.section, `the written section does not read back (${back.reason})`);
    published.push(`${tags.section} (published: ${back.navTag})`);
  } else if (tags && !tagsDraft) {
    fail(tags.section, `its status is “${String((tags as Obj).status)}”`);
  }

  // Nothing the bridge parses may be left as a placeholder (a heading shared with a placeholder one, by key).
  const parsed = [vocab?.section, tags?.section].filter((h): h is string => typeof h === 'string');
  for (const h of headings)
    if (parsed.some((p) => headingKey(p) === headingKey(h)))
      fail(h, 'it is also pinned as a plain section, so it would get a placeholder paragraph');
  return { blocks, headings, published };
}

/** Whether the written index tag section states the rule the pack holds (N4's read-back, with the pack's own tags). */
export function indexTagSectionMatches(
  blocks: unknown,
  rules: NonNullable<GovernanceBlocksInput['rules']['indexTaxonomy']>,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const back = parseIndexTagSection(sectionBlocksOf(blocks, rules.section));
  if (!back.ok) return { ok: false, reason: back.reason };
  if (back.navTag !== rules.navTag)
    return {
      ok: false,
      reason: `the navigation tag reads “${back.navTag}”, the pack holds “${rules.navTag}”`,
    };
  for (const [k, v] of Object.entries(back.subjectTags))
    if ((rules.subjectTags as Obj)[k] !== v)
      return {
        ok: false,
        reason: `the ${k} index tag reads “${v}”, the pack holds “${String((rules.subjectTags as Obj)[k])}”`,
      };
  return { ok: true };
}
