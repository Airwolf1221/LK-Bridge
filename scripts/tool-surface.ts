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

/** What a person reviewing the surface needs beside the numbers: the tool's family, what it overlaps, how agents misuse it. */
interface Note {
  readonly category: string;
  readonly overlaps: string;
  readonly mistakes: string;
}
const N = (category: string, overlaps: string, mistakes: string): Note => ({ category, overlaps, mistakes });
export const NOTES: Readonly<Record<string, Note>> = {
  list_projects: N(
    'Discover',
    'bridge_info (also lists projects)',
    'Calling it before every task; omitting `project` on a write.',
  ),
  browse_repository_tree: N(
    'Discover',
    'search; get_resource',
    'Browsing the whole root instead of searching; a huge `depth`.',
  ),
  browse_asset_tree: N(
    'Discover',
    'list_assets (`includeAssets`)',
    'Using it to list a folder’s images (list_assets has the urls).',
  ),
  search: N(
    'Discover',
    'browse_repository_tree; lk_api_read listResources',
    'Guessing a page name instead of searching; concluding from a `content: true` miss that a word is absent.',
  ),
  get_resource: N(
    'Discover',
    'read_document',
    'Using it for page text; skipping it before set_facts (no `factsVersion`); a character’s [INDEX] for its facts (they are on its Core).',
  ),
  list_tags: N('Discover', 'search `tag:`', 'Reading pages to count tags.'),
  list_templates: N(
    'Discover',
    'registry types (create_*)',
    'Inventing a template name for create_resource.',
  ),
  list_calendars: N('Discover', 'calendar_date', 'Computing dates from the calendar by hand.'),
  list_assets: N('Discover', 'browse_asset_tree', 'Passing a folder name that matches several folders.'),
  read_document: N(
    'Read',
    'get_resource; lk_api_read getDocumentBlocks',
    'Reading a whole long page when `section` or `outline` would do; writing back without the `version`.',
  ),
  write_page: N(
    'Pages',
    'lk_api_write replaceDocumentBlocks / insertBlock',
    '`replace` of the whole page; no `baseVersion`; writing before reading; retrying VERSION_CONFLICT unchanged.',
  ),
  set_facts: N(
    'Facts',
    'update_resource (tags, aliases); lk_api_write on properties',
    'No `baseFactsVersion`; several calls for several facts; `{markdown}` for plain text; Status to Authoritative (use promote_page).',
  ),
  create_index: N(
    'Resources',
    'create_resource; create_character (its own index)',
    'Making a character’s index by hand; an index under [INDEX] Working.',
  ),
  create_resource: N(
    'Resources',
    'create_bare_resource; create_many_resources; create_character',
    'Omitting `parent` for a character’s specialist page (lands flat); a character with this instead of create_character.',
  ),
  create_bare_resource: N(
    'Resources',
    'create_resource (the better default)',
    'Hidden by default (E3b). Using it when a template exists, so the page has no sidebar.',
  ),
  create_many_resources: N(
    'Resources',
    'create_resource ×N',
    'Nesting Working pages (they are flat); using it for characters.',
  ),
  update_resource: N(
    'Resources',
    'set_facts; move_resource; lifecycle tools',
    'Putting a prefix in `name`; changing a status tag (refused).',
  ),
  move_resource: N(
    'Resources',
    'lifecycle tools; lk_api_write moveResource',
    'Moving into [INDEX] Archived or Working (refused: use the lifecycle tool).',
  ),
  delete_resource: N(
    'Resources',
    'archive_page',
    'Deleting what should be archived; no `confirm` / `cascade`.',
  ),
  restore_resource: N(
    'Resources',
    'restore_snapshot (content)',
    'Not knowing the id (the delete’s result and the journal have it).',
  ),
  create_character: N(
    'Resources',
    'create_resource; create_bare_resource',
    'Specialist pages left flat under [INDEX] Working; an invented race; `authoritative` by default thinking.',
  ),
  arkona_create_character: N(
    'Packs',
    'create_character; create_resource; set_facts (one package instead)',
    'Separate creates on an Arkona project; a guessed identity value instead of asking the owner; typed tags; resubmitting the proposal.',
  ),
  archive_page: N(
    'Lifecycle',
    'delete_resource; move_resource',
    'One page of a set (HAS_SUBPAGES: needs `subtree`); retrying the proposal.',
  ),
  unarchive_page: N(
    'Lifecycle',
    'move_resource; restore_snapshot',
    'Missing `destination` when the old place is gone.',
  ),
  move_to_working: N(
    'Lifecycle',
    'archive_page; update_resource',
    'Using it on an Archived page (that is unarchive_page).',
  ),
  promote_page: N(
    'Lifecycle',
    'set_facts Status; move_resource',
    'Setting Status by hand; promoting only the Core of a set; no `destination`.',
  ),
  create_document: N(
    'Documents',
    'write_page (text); create_map_feature',
    'Creating a page document (page text is write_page).',
  ),
  update_document: N(
    'Documents',
    'write_page; create_map_feature',
    'Trying to change content; replacing a map image without telling the person the feature count.',
  ),
  delete_document: N('Documents', 'delete_resource', 'Deleting a page’s only page document.'),
  calendar_date: N(
    'Timelines',
    'list_calendars',
    'Not calling it before create_timeline_event; “Kumikas 1st, 4A 1” (does not exist).',
  ),
  create_timeline_event: N(
    'Timelines',
    'write_page on a table; lk_api_write createEvent',
    'Editing the table or timeline separately; passing `age` wrongly.',
  ),
  update_timeline_event: N(
    'Timelines',
    'sync_timeline_event',
    'Naming the event ambiguously; using it to repair drift.',
  ),
  delete_timeline_event: N('Timelines', 'delete_resource', 'No `confirm`; deleting only the table row.'),
  sync_timeline_event: N(
    'Timelines',
    'update_timeline_event',
    'Using it to change a date (it repairs the timeline from the table).',
  ),
  create_timeline_lane: N(
    'Timelines',
    'create_timeline_event',
    'Adding a lane to a chronology age timeline (refused).',
  ),
  create_map_feature: N(
    'Maps',
    'lk_api_write createFeature',
    'Converting pixels to lat/lng by hand; both systems at once; y counted from the bottom.',
  ),
  update_map_feature: N(
    'Maps',
    'lk_api_write updateFeature',
    'An ambiguous feature name without `featureFolder`; `link` omitted when meaning to clear it.',
  ),
  delete_map_feature: N(
    'Maps',
    'delete_document (whole map)',
    'Deleting a folder with features without `cascade`.',
  ),
  upload_image: N(
    'Assets',
    'lk_upload_image; prepare_image_upload',
    'Large `data_base64`; repeating a call that staged an image; creating folders by hand.',
  ),
  prepare_image_upload: N(
    'Assets',
    'upload_image `data_base64`',
    'Offered to assistants with no shell (they cannot run its script).',
  ),
  lk_upload_image: N(
    'Assets',
    'upload_image (a superset)',
    'Hidden by default (E3b). Picking the older tool: no conversion, folder planning or staging.',
  ),
  list_snapshots: N(
    'Snapshots',
    'bridge_journal_lookup',
    'Looking for a page by name when it is deleted (needs the id).',
  ),
  snapshot_diff: N('Snapshots', 'read_document', 'Comparing by reading both states.'),
  restore_snapshot: N(
    'Snapshots',
    'write_page; restore_resource',
    'Using a restore to edit; retrying the proposal.',
  ),
  audit_findings: N(
    'Audits',
    'lk_api_* scans',
    'Acting on a lifecycle or canon finding; fixing without reading the page; acknowledged findings.',
  ),
  bridge_info: N('Bridge', 'list_projects; bridge_budget', 'Calling it for the budget.'),
  bridge_budget: N('Bridge', 'bridge_estimate', 'Calling it in a loop to wait for budget.'),
  bridge_estimate: N('Bridge', 'bridge_budget', 'Not calling it before bulk reads.'),
  bridge_job_status: N(
    'Bridge',
    'none (bridge_job_wait was merged in, E3b)',
    'Polling it in a loop instead of `wait_seconds`; forgetting `done: false` means call again.',
  ),
  bridge_job_cancel: N('Bridge', 'none', 'Cancelling an approved job (owner only).'),
  bridge_errors_recent: N('Bridge', 'bridge_journal_lookup', 'Using it to decide whether to retry.'),
  bridge_journal_lookup: N(
    'Bridge',
    'list_snapshots; bridge_errors_recent',
    'Not knowing it holds the id of a deleted page.',
  ),
  bridge_result_page: N('Bridge', 'none', 'Re-running the tool instead of paging the handle.'),
  bridge_proposal_status: N(
    'Bridge',
    'none (bridge_proposals_mine was merged in, E3b)',
    'Repeating the write instead; wrong `project`.',
  ),
  get_bridge_guide: N('Guides', 'get_markdown_guide', 'Reading the whole guide instead of a `section`.'),
  get_markdown_guide: N('Guides', 'get_bridge_guide', 'Skipping it before write_page.'),
  lk_api_read: N(
    'Low-level',
    'every high-level read',
    'Reaching for it when a high-level tool exists; inventing an operation id.',
  ),
  lk_api_write: N(
    'Low-level',
    'every high-level write',
    'Reaching for it when a high-level tool exists; no `ifMatch`; retrying proposal_captured.',
  ),
  lk_api_batch: N('Low-level', 'a loop of lk_api_write', 'Resubmitting a queued batch.'),
  lk_api_list_operations: N(
    'Low-level',
    'the guide’s Operations list',
    'Hidden by default: the guide lists the ids.',
  ),
  lk_api_describe_operation: N('Low-level', 'none', 'Hidden by default.'),
  lk_api_paginate_all: N('Low-level', 'search; browse_repository_tree', 'Hidden by default.'),
};

export interface Baseline {
  readonly profiles: readonly ProfileList[];
}

const tok = (chars: number): string => tokens(chars).toLocaleString('en-GB');
const num = (n: number): string => n.toLocaleString('en-GB');

/** The Markdown inventory: one row per tool, with sizes now and (given a baseline) before. */
export function inventory(report: SurfaceReport, baseline?: Baseline): string {
  const by = (list: readonly ProfileList[], scope: Scope, low: boolean) =>
    new Map(list.find((p) => p.scope === scope && p.lowLevel === low)?.tools.map((t) => [t.name, t]) ?? []);
  const seen = {
    read: by(report.profiles, 'read', false),
    propose: by(report.profiles, 'propose', false),
    write: by(report.profiles, 'write', false),
    low: by(report.profiles, 'write', true),
  };
  const before = baseline ? by(baseline.profiles, 'write', true) : null;
  const names = [...seen.low.keys()].filter((n) => !n.startsWith('lk_op_'));
  const order = [
    'Discover',
    'Read',
    'Pages',
    'Facts',
    'Resources',
    'Packs',
    'Lifecycle',
    'Documents',
    'Timelines',
    'Maps',
    'Assets',
    'Snapshots',
    'Audits',
    'Bridge',
    'Guides',
    'Low-level',
  ];
  const cat = (n: string) => NOTES[n]?.category ?? '?';
  names.sort((a, b) => order.indexOf(cat(a)) - order.indexOf(cat(b)) || a.localeCompare(b));
  const rows = [
    `| Tool | Category | Access | Seen by | Description (chars) | Schema (chars) | ≈ Tokens${before ? ' (before → after)' : ''} | Overlaps | Usual mistakes |`,
    '| ---- | -------- | ------ | ------- | ------------------: | -------------: | ------: | -------- | -------------- |',
  ];
  for (const n of names) {
    const t = seen.low.get(n)!;
    const who = seen.read.has(n)
      ? 'read, propose, write'
      : seen.propose.has(n)
        ? 'propose, write'
        : 'any profile with “show low-level and rarely used tools”';
    const note = NOTES[n];
    const b = before?.get(n);
    rows.push(
      `| \`${n}\` | ${note?.category ?? '?'} | ${t.readOnly ? 'read' : 'write'} | ${who} | ${num(t.descriptionChars)} | ${num(t.schemaChars)} | ${b ? `${tok(b.entryChars)} → ` : ''}${tok(t.entryChars)} | ${note?.overlaps ?? ''} | ${note?.mistakes ?? ''} |`,
    );
  }
  const op =
    report.profiles
      .find((p) => p.scope === 'write' && p.lowLevel)
      ?.tools.filter((t) => t.name.startsWith('lk_op_')) ?? [];
  if (op.length > 0) {
    const chars = op.reduce((s, t) => s + t.entryChars, 0);
    rows.push(
      `| \`lk_op_<operationId>\` (${op.length}) | Low-level | per operation | only with \`MCP_EXPOSE_PER_OP_TOOLS=true\` and “show low-level and rarely used tools” | – | – | ${tok(chars)} in all | the lk_api_* tools | Off by default. |`,
    );
  }
  return rows.join('\n');
}

/** The per-profile totals, tools with no `lk_op_*` (per-operation tools are off in production) and with them. */
function summary(report: SurfaceReport, baseline?: Baseline): string {
  const lines = [
    `| Profile | Tools | Characters | ≈ Tokens${baseline ? ' (before → after)' : ''} |`,
    '| ------- | ----: | ---------: | -------: |',
  ];
  for (const p of report.profiles) {
    const plain = p.tools.filter((t) => !t.name.startsWith('lk_op_'));
    const chars = plain.reduce((s, t) => s + t.entryChars, 0);
    const b = baseline?.profiles.find((x) => x.profile === p.profile);
    const bchars = b
      ? b.tools.filter((t) => !t.name.startsWith('lk_op_')).reduce((s, t) => s + t.entryChars, 0)
      : null;
    const name = `${p.scope}${p.lowLevel ? ' + low-level and rarely used setting' : ''}`;
    lines.push(
      `| ${name} | ${plain.length} | ${num(bchars !== null ? bchars : chars)}${bchars !== null ? ` → ${num(chars)}` : ''} | ${bchars !== null ? `${tok(bchars)} → ` : ''}${tok(chars)} |`,
    );
  }
  const all = report.profiles.find((p) => p.scope === 'write' && p.lowLevel);
  const op = all?.tools.filter((t) => t.name.startsWith('lk_op_')) ?? [];
  if (op.length > 0) {
    const chars = op.reduce((s, t) => s + t.entryChars, 0);
    lines.push(
      `| write + low-level and rarely used + \`MCP_EXPOSE_PER_OP_TOOLS=true\` | +${op.length} | +${num(chars)} | +${tok(chars)} |`,
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
  const bi = process.argv.indexOf('--baseline');
  const baseline =
    bi > 0
      ? (JSON.parse((await import('node:fs')).readFileSync(process.argv[bi + 1]!, 'utf8')) as Baseline)
      : undefined;
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else if (process.argv.includes('--inventory')) console.log(inventory(report, baseline));
  else console.log(summary(report, baseline));
  process.exit(0);
}
