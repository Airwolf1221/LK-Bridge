/**
 * The tool-surface report (v2 E3, ADR 0045): lists the tools exactly as each kind of client receives them and measures
 * them, so the whole surface can be looked at from an agent's side.
 *
 *   npx tsx scripts/tool-surface.ts            # prints the report as Markdown
 *   npx tsx scripts/tool-surface.ts --json     # prints the raw numbers
 *
 * It starts the real server on a local port against the MOCK LegendKeeper (test/contract/mock-lk.ts) and connects with
 * the official MCP client, once per profile. Nothing here touches a live LegendKeeper project or the owner's bridge.
 *
 * "Tokens" are an estimate: characters divided by four, rounded. Real tokenisers differ (JSON schemas usually cost a
 * little more per character than prose), so read the figures as a size, not a bill.
 */
import { startStack } from '../test/tools/helpers.js';
import type { Scope } from '../src/policy/index.js';

export interface ToolRow {
  readonly name: string;
  readonly descriptionChars: number;
  readonly schemaChars: number;
  /** The whole entry as `tools/list` sends it (name, title, description, schema, annotations). */
  readonly entryChars: number;
  readonly readOnly: boolean;
}

export interface ProfileList {
  readonly profile: string;
  readonly scope: Scope;
  readonly lowLevel: boolean;
  readonly tools: readonly ToolRow[];
  readonly totalChars: number;
}

export interface SurfaceReport {
  readonly instructionsChars: number;
  readonly profiles: readonly ProfileList[];
  /** Every tool seen at any profile (the superset, for the inventory). */
  readonly all: readonly ToolRow[];
}

export const tokens = (chars: number): number => Math.round(chars / 4);

export async function measureSurface(): Promise<SurfaceReport> {
  const stack = await startStack({ env: { MCP_EXPOSE_PER_OP_TOOLS: 'true' } });
  try {
    const profiles: ProfileList[] = [];
    const all = new Map<string, ToolRow>();
    let instructionsChars = 0;
    for (const scope of ['read', 'propose', 'write'] as const) {
      for (const lowLevel of [false, true]) {
        const label = `e3-${scope}-${lowLevel ? 'low' : 'default'}`;
        const t = stack.newToken(label, scope);
        stack.policy.commands.setShowLowLevelTools('owner', t.profileId, lowLevel);
        const client = await stack.connect(t.token);
        if (instructionsChars === 0) instructionsChars = (client.getInstructions() ?? '').length;
        const { tools } = await client.listTools();
        const rows: ToolRow[] = tools.map((tool) => {
          const row: ToolRow = {
            name: tool.name,
            descriptionChars: (tool.description ?? '').length,
            schemaChars: JSON.stringify(tool.inputSchema ?? {}).length,
            entryChars: JSON.stringify(tool).length,
            readOnly: tool.annotations?.readOnlyHint === true,
          };
          all.set(tool.name, row);
          return row;
        });
        profiles.push({
          profile: label,
          scope,
          lowLevel,
          tools: rows,
          totalChars: rows.reduce((s, r) => s + r.entryChars, 0),
        });
      }
    }
    return { instructionsChars, profiles, all: [...all.values()] };
  } finally {
    await stack.close();
  }
}

function summary(report: SurfaceReport): string {
  const lines = [
    '| Profile | Tools | Characters | ≈ Tokens |',
    '| ------- | ----: | ---------: | -------: |',
  ];
  for (const p of report.profiles) {
    const name = `${p.scope}${p.lowLevel ? ' + low-level' : ''}`;
    lines.push(
      `| ${name} | ${p.tools.length} | ${p.totalChars.toLocaleString('en-GB')} | ${tokens(p.totalChars).toLocaleString('en-GB')} |`,
    );
  }
  lines.push(
    '',
    `Server instructions: ${report.instructionsChars} characters (≈ ${tokens(report.instructionsChars)} tokens).`,
  );
  return lines.join('\n');
}

if (process.argv[1] && /tool-surface\.ts$/.test(process.argv[1])) {
  const report = await measureSurface();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(summary(report));
  process.exit(0);
}
