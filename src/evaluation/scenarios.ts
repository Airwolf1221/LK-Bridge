/**
 * The evaluation scenarios as data (v2 E3, ADR 0045): docs/reviews/scenarios.json is the machine-readable copy of the
 * owner's script (docs/reviews/E3-evaluation.md, the human copy). The dashboard's Evaluation panel runs from it.
 *
 * A prompt never names a tool: choosing the tool is what is being tested (a test checks this against the real tool list).
 * `expectedTools` lists the tools that should appear; an inner list means "any one of these". The newer names are the
 * ones to write there: the grader treats the old names as aliases of them (src/evaluation/grade.ts).
 */
import { readFileSync } from 'node:fs';
import * as z from 'zod';

export const ASSISTANTS = ['chatgpt', 'claude'] as const;
export type Assistant = (typeof ASSISTANTS)[number];
export const ASSISTANT_LABEL: Readonly<Record<Assistant, string>> = { chatgpt: 'ChatGPT', claude: 'Claude' };

export const SCENARIO_SETS = ['core', 'all'] as const;
export type ScenarioSet = (typeof SCENARIO_SETS)[number];

const toolName = z.string().regex(/^[a-z][a-z0-9_]*$/, 'a tool name');
const text = z.string().min(1).max(20_000);

const scenarioSchema = z
  .object({
    id: z.number().int().min(1).max(999),
    section: text,
    title: text,
    /** The short name the results table uses ("Partial name"). */
    shortTitle: z.string().min(1).max(60),
    assistants: z.array(z.enum(ASSISTANTS)).min(1),
    /** ChatGPT (scope `propose`) needs the owner to approve or reject on the Proposals page before the next step. */
    needsApproval: z.boolean(),
    /** The result is a proposal for every assistant (canon and lifecycle changes, restores): reject it afterwards. */
    alwaysProposal: z.boolean(),
    /** In the owner's shortlist (run the core set first). */
    core: z.boolean(),
    /** Scenarios whose pages this one needs, so they are run first. */
    dependsOn: z.array(z.number().int().min(1)),
    /** False when the scenario continues the previous chat (no preamble, no new chat). */
    freshChat: z.boolean(),
    /** One per message the owner sends in the chat. The first follows the preamble when the chat is fresh. */
    prompts: z.array(text).min(1).max(4),
    /** What the owner does between two prompts, outside the assistant. */
    interlude: z.string().min(1).nullable(),
    setupNote: z.string().min(1).nullable(),
    expectedTools: z.array(z.union([toolName, z.array(toolName).min(2)])),
    optionalTools: z.array(toolName),
    mistakeTools: z.array(toolName),
    expectedNote: text,
    watchFor: text,
    toolCallsNote: text,
  })
  .strict();

const fileSchema = z
  .object({
    $comment: z.string().optional(),
    version: z.literal(1),
    source: z.string(),
    preamble: text,
    scenarios: z.array(scenarioSchema).min(1),
  })
  .strict()
  .superRefine((f, ctx) => {
    const ids = new Set<number>();
    for (const s of f.scenarios) {
      if (ids.has(s.id)) ctx.addIssue({ code: 'custom', message: `scenario ${s.id} appears twice` });
      ids.add(s.id);
    }
    for (const s of f.scenarios) {
      for (const d of s.dependsOn) {
        if (!ids.has(d) || d === s.id)
          ctx.addIssue({
            code: 'custom',
            message: `scenario ${s.id} depends on ${d}, which is not another scenario`,
          });
      }
    }
  });

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioFile = z.infer<typeof fileSchema>;

/** The docs folder: `src/evaluation` and `dist/evaluation` are both two levels below the repository root. */
const FILE = new URL('../../docs/reviews/scenarios.json', import.meta.url);

/** Parses and checks the scenarios (a text, so tests and tools can check a file of their own). */
export function parseScenarios(source: string): ScenarioFile {
  const r = fileSchema.safeParse(JSON.parse(source));
  if (!r.success) {
    throw new Error(
      `docs/reviews/scenarios.json is not valid: ${r.error.issues.map((i) => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ')}`,
    );
  }
  return r.data;
}

let cached: ScenarioFile | undefined;

/** The scenarios, read once from docs/reviews/scenarios.json (found from this file, so it works from src/ and dist/). */
export function loadScenarios(): ScenarioFile {
  if (cached) return cached;
  cached = parseScenarios(readFileSync(FILE, 'utf8'));
  return cached;
}

/** The scenarios of a set that the assistant takes part in, in order. */
export function scenariosFor(file: ScenarioFile, set: ScenarioSet, assistant: Assistant): Scenario[] {
  return file.scenarios.filter((s) => s.assistants.includes(assistant) && (set === 'all' || s.core));
}

/** What the owner pastes: the preamble first when the chat is fresh, then the scenario's prompt (one per message). */
export function promptsToCopy(file: ScenarioFile, s: Scenario): string[] {
  return s.prompts.map((p, i) => (i === 0 && s.freshChat ? `${file.preamble}\n\n${p}` : p));
}
