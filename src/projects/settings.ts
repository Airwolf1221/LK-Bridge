/**
 * Per-project settings (v2 A1): the JSON `settings` column of `projects`. Later sessions fill these in (A2 the AI
 * REPOSITORY root and the names the tree reads, C2 the Characters root and template ids, D1 the chronology resource).
 * Unknown keys are kept as they are, so a newer release's settings survive a rollback.
 *
 * v2 A2: the settings are editable, one key at a time, on the dashboard's Projects page (audited
 * `project.set_setting`) and with `npm run projects -- set <project> <key> <value>`. `parseSettingValue` is the one
 * validator both use.
 */
import * as z from 'zod';

const id = z.string().min(1).max(64);
const label = z.string().trim().min(1).max(256);

export const projectSettingsSchema = z
  .object({
    /** The project's `AI REPOSITORY` page: the root of everything the high-level tools touch (PLAN-v2 4.2). */
    aiRepositoryRootId: id.optional(),
    /** `[INDEX] Characters` (PLAN-v2 section 9). */
    charactersRootId: id.optional(),
    /** The Universal Chronology resource (PLAN-v2 4.9). */
    chronologyResourceId: id.optional(),
    /** Template ids by role, for example `{ "index": "…", "characterCore": "…" }` (PLAN-v2 4.3). */
    templateIds: z.record(z.string().min(1).max(64), id).optional(),
    /** v2 A2: the title of the key-value sidebar property the tree reads its catalogue fields from. */
    treePropertiesName: label.optional(),
    /** v2 A2: the keys of the rows the tree reads from that property. */
    treeReferenceTypeRow: label.optional(),
    treeScopeRow: label.optional(),
    treeIndexScopeRow: label.optional(),
    treeCanonicalNameRow: label.optional(),
    /** v2 A2: whether the hourly structural sweep runs for this project (default on). */
    treeSweepEnabled: z.boolean().optional(),
    /** v2 A4: whether the regular asset-tree refresh (every 6 hours by default) runs for this project (default on). */
    assetRefreshEnabled: z.boolean().optional(),
    /** v2 C2a: the title of the key-value property set_facts writes facts to when the call names none. */
    factsPropertyName: label.optional(),
    /**
     * v2 C2a (ADR 0032): the protected canonical facts rules (src/facts/rules.ts). Absent: the defaults. Validated by
     * the facts module when used (an invalid list falls back to the defaults), so it is kept loose here.
     */
    canonicalRules: z.array(z.unknown()).max(50).optional(),
    /** v2 C2a: the Status of pages agents create (C2b uses it). Default "Working". */
    agentDefaultStatus: label.optional(),
    /**
     * v2 C2c (ADR 0035): the page lifecycle's settings (src/lifecycle/settings.ts): the Working and Archive indexes the
     * owner confirmed, the status values, tags, field names, Continuity Types and archive texts. Validated by the
     * lifecycle module when used (an invalid value falls back to the defaults, with the indexes unconfirmed).
     */
    lifecycle: z.record(z.string(), z.unknown()).optional(),
    /**
     * v2 D1.1 (ADR 0039): whether a write that answers with no version in its body (a property row write, a delete)
     * but with an `ETag` header has that ETag used as its new version for the next chained If-Match (default on).
     * Off: the bridge re-reads, as before. The owner can switch it off without a deploy if the sandbox's B12 fails.
     */
    useEtagVersions: z.boolean().optional(),
    /**
     * v2 D3 (ADR 0041): the name of the asset folder (in the library's root) staged images went to. v3 F2 (ADR 0049):
     * staged images wait on the bridge's server now; the setting only names the old folder for migrate-staging, and
     * retires once that folder is gone.
     */
    imageStagingFolder: label.optional(),
    /** v3 F2: days an unplaced staged image is kept on the server (default IMAGE_STAGING_MAX_DAYS). */
    imageStagingMaxDays: z.number().int().min(1).max(3650).optional(),
    /**
     * ADR 0057 decision 7 (the owner's, 17 November 2026): whether ChatGPT's file source (`file.download_url`) is
     * fetched, through the same guarded download as `url` (default on). Separate from UPLOAD_ALLOW_URL_SOURCE (`url`
     * only). Switching it on needs the owner's re-authentication; switching it off is one click. Audited.
     */
    fileSourceEnabled: z.boolean().optional(),
    /**
     * v3 F2 (ADR 0049 decision 2): which edits set a page's Last Major Revision, one switch per category (src/lmr/),
     * and the housekeeping keys a set_facts change of which alone is not an edit (`;`-separated).
     */
    lmrWritePage: z.boolean().optional(),
    lmrBlockEdits: z.boolean().optional(),
    lmrChronologyTable: z.boolean().optional(),
    lmrRestore: z.boolean().optional(),
    lmrPackTools: z.boolean().optional(),
    lmrFacts: z.boolean().optional(),
    lmrNamesTagsMoves: z.boolean().optional(),
    lmrLinkCollections: z.boolean().optional(),
    lmrTimelineMap: z.boolean().optional(),
    lmrAuditSplit: z.boolean().optional(),
    lmrHousekeepingKeys: z.string().max(2000).optional(),
  })
  .loose();

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export type SettingKind =
  'resource id' | 'name' | 'names' | 'days' | 'on/off' | 'role → template id' | 'rules';

/** The settings the dashboard and later sessions may rely on, by key, with what each is for. */
export const PROJECT_SETTING_KEYS: readonly {
  readonly key: Extract<keyof ProjectSettings, string>;
  readonly label: string;
  readonly kind: SettingKind;
  /** The value used while none is stored. */
  readonly default?: string | boolean;
  /** Editable on the dashboard and with `npm run projects -- set`. */
  readonly editable: boolean;
  readonly help?: string;
}[] = [
  {
    key: 'aiRepositoryRootId',
    label: 'AI REPOSITORY root',
    kind: 'resource id',
    editable: true,
    help: 'The resource id of the AI REPOSITORY page. Until it is set, the repository tree is not configured. Changing it discards the stored tree.',
  },
  { key: 'charactersRootId', label: 'Characters root', kind: 'resource id', editable: true },
  { key: 'chronologyResourceId', label: 'Chronology resource', kind: 'resource id', editable: true },
  { key: 'templateIds', label: 'Template ids', kind: 'role → template id', editable: false },
  {
    key: 'treePropertiesName',
    label: 'Tree: key-value property',
    kind: 'name',
    default: 'PROPERTIES',
    editable: true,
    help: 'The title of the key-value sidebar property the tree reads its catalogue fields from.',
  },
  {
    key: 'treeReferenceTypeRow',
    label: 'Tree: Reference Type row',
    kind: 'name',
    default: 'Reference Type',
    editable: true,
  },
  { key: 'treeScopeRow', label: 'Tree: Scope row', kind: 'name', default: 'Scope', editable: true },
  {
    key: 'treeIndexScopeRow',
    label: 'Tree: Index Scope row',
    kind: 'name',
    default: 'Index Scope',
    editable: true,
  },
  {
    key: 'treeCanonicalNameRow',
    label: 'Tree: Canonical Display Name row',
    kind: 'name',
    default: 'Canonical Display Name',
    editable: true,
  },
  {
    key: 'treeSweepEnabled',
    label: 'Tree: hourly structural sweep',
    kind: 'on/off',
    default: true,
    editable: true,
    help: 'Off: the hourly sweep skips this project; the daily consistency check still runs.',
  },
  {
    key: 'factsPropertyName',
    label: 'Facts: key-value property',
    kind: 'name',
    default: 'PROPERTIES',
    editable: true,
    help: 'The title of the key-value sidebar property set_facts writes to when a call names none.',
  },
  {
    key: 'agentDefaultStatus',
    label: 'Canon: Status of pages agents create',
    kind: 'name',
    default: 'Working',
    editable: true,
    help: 'The Status the creation tools give a new page. Setting a page to a protected Status still needs canonical approval.',
  },
  {
    key: 'canonicalRules',
    label: 'Canon: protected facts',
    kind: 'rules',
    editable: false,
    help: 'Edited in the Canon section of this page (each change is audited).',
  },
  {
    key: 'lifecycle',
    label: 'Lifecycle: indexes, statuses, tags and texts',
    kind: 'rules',
    editable: false,
    help: 'Edited in the Lifecycle section of this page (each change is audited).',
  },
  {
    key: 'useEtagVersions',
    label: 'Writes: use the ETag as the new version',
    kind: 'on/off',
    default: true,
    editable: true,
    help: 'On: a row write or delete that gives no version in its body but sends an ETag has that ETag used as If-Match for the next write in the job, saving a read each. Off: the bridge re-reads instead (switch off if the sandbox’s B12 check fails).',
  },
  {
    key: 'assetRefreshEnabled',
    label: 'Asset tree: regular refresh',
    kind: 'on/off',
    default: true,
    editable: true,
    help: 'Off: the regular asset-tree refresh (every 6 hours by default) skips this project; the nightly asset check still runs.',
  },
  {
    key: 'imageStagingFolder',
    label: 'Images: staging folder',
    kind: 'name',
    default: 'LK-Bridge staging',
    editable: true,
    help: 'Retiring (v3 F2): staged images now wait on the bridge’s server. This names the old LegendKeeper staging folder, for npm run images -- migrate-staging; it can be cleared once that folder is gone.',
  },
  {
    key: 'imageStagingMaxDays',
    label: 'Images: days an unplaced staged image is kept',
    kind: 'days',
    editable: true,
    help: 'After this many days an unplaced staged image is removed from the bridge’s server, a week after the Staging page first warned about it. Default IMAGE_STAGING_MAX_DAYS (90).',
  },
  {
    key: 'fileSourceEnabled',
    label: 'Images: ChatGPT’s file source',
    kind: 'on/off',
    default: true,
    editable: true,
    help: 'On: upload_image and the setting-pack tools download a ChatGPT attachment (`file`), through the same guarded download as a `url` (https, public addresses, the port allow-list). Off: refused before anything is fetched (UPLOAD_FILE_SOURCE_DISABLED). Separate from UPLOAD_ALLOW_URL_SOURCE, which covers `url` only. Switching it on asks for your password again.',
  },
  {
    key: 'lmrWritePage',
    label: 'Last Major Revision: write_page',
    kind: 'on/off',
    default: true,
    editable: true,
    help: 'On: a write_page edit (any mode) that is a major revision (8 words or more of page text, or a heading’s wording; ADR 0051) also sets the page’s Last Major Revision to today, in the same job or proposal.',
  },
  {
    key: 'lmrBlockEdits',
    label: 'Last Major Revision: block edits',
    kind: 'on/off',
    default: true,
    editable: true,
    help: 'Block edits through lk_api_write and lk_api_batch (insert, replace, update or delete a block; replaceDocumentBlocks), and the dashboard’s own fixes that edit text.',
  },
  {
    key: 'lmrChronologyTable',
    label: 'Last Major Revision: chronology tables',
    kind: 'on/off',
    default: true,
    editable: true,
    help: 'A chronology table row created, changed or deleted, and the Main count fix (on the chronology page).',
  },
  {
    key: 'lmrRestore',
    label: 'Last Major Revision: restores',
    kind: 'on/off',
    default: true,
    editable: true,
    help: 'A restore that changes a page’s text.',
  },
  {
    key: 'lmrPackTools',
    label: 'Last Major Revision: setting-pack tools',
    kind: 'on/off',
    default: true,
    editable: true,
  },
  {
    key: 'lmrFacts',
    label: 'Last Major Revision: set_facts',
    kind: 'on/off',
    default: true,
    editable: true,
    help: 'A sidebar fact’s value changed through set_facts, except the housekeeping keys below and the minor cases (a trim, punctuation, a typo fix); and a Dependency added or removed.',
  },
  {
    key: 'lmrHousekeepingKeys',
    label: 'Last Major Revision: housekeeping keys',
    kind: 'names',
    default: 'Last Major Revision; Reference Type; Supersedes; Status',
    editable: true,
    help: 'Fact keys, separated by “;”, whose change alone through set_facts does not set Last Major Revision. The lifecycle tools set it themselves.',
  },
  {
    key: 'lmrNamesTagsMoves',
    label: 'Last Major Revision: names, tags and moves',
    kind: 'on/off',
    default: false,
    editable: true,
    help: 'Tag, alias, icon or name changes; moves and re-orders (of pages and blocks).',
  },
  {
    key: 'lmrLinkCollections',
    label: 'Last Major Revision: link collections',
    kind: 'on/off',
    default: false,
    editable: true,
    help: 'Changes only to link collections other than Dependencies (Related Sources). Adding or removing a Dependency is a sidebar change the rule counts (under set_facts).',
  },
  {
    key: 'lmrTimelineMap',
    label: 'Last Major Revision: timeline events and map features',
    kind: 'on/off',
    default: false,
    editable: true,
    help: 'Timeline events and map features on their own (they are not the page’s text).',
  },
  {
    key: 'lmrAuditSplit',
    label: 'Last Major Revision: an audit’s paragraph split',
    kind: 'on/off',
    default: false,
    editable: true,
    help: 'The audits’ paragraph split leaves the content unchanged.',
  },
];

export interface ParsedSettings {
  readonly settings: ProjectSettings;
  /** Why the stored text could not be used as it is (it is then treated as empty), or null. */
  readonly problem: string | null;
}

/** Parses the stored JSON. Never throws: unreadable or invalid settings read as `{}` with the reason. */
export function parseProjectSettings(text: string | null | undefined): ParsedSettings {
  if (text === null || text === undefined || text.trim() === '') return { settings: {}, problem: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { settings: {}, problem: 'the stored settings are not valid JSON' };
  }
  const r = projectSettingsSchema.safeParse(raw);
  if (!r.success) {
    return {
      settings: {},
      problem: r.error.issues.map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; '),
    };
  }
  return { settings: r.data, problem: null };
}

/** A typed accessor for one setting: `projectSetting(settings, 'charactersRootId')`. */
export function projectSetting<K extends keyof ProjectSettings>(
  settings: ProjectSettings,
  key: K,
): ProjectSettings[K] | undefined {
  return settings[key];
}

/** A LegendKeeper resource id as the API writes them (cuid2-style: a lowercase letter, then letters and digits). */
const RESOURCE_ID = /^[a-z][0-9a-z]{1,63}$/;

export class SettingValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingValueError';
  }
}

/**
 * Validates one editable setting from text (the CLI) or JSON (the dashboard). `null` (or the text `-`) clears it, so
 * the default applies again. Throws `SettingValueError` with a plain-language reason.
 */
export function parseSettingValue(key: string, value: unknown): string | number | boolean | null {
  const def = PROJECT_SETTING_KEYS.find((k) => k.key === key);
  if (!def) {
    const known = PROJECT_SETTING_KEYS.filter((k) => k.editable).map((k) => k.key);
    throw new SettingValueError(`Unknown setting "${key}". Editable settings: ${known.join(', ')}.`);
  }
  if (!def.editable) throw new SettingValueError(`"${key}" cannot be edited here yet.`);
  if (value === null || value === undefined || value === '-') return null;
  if (def.kind === 'on/off') {
    if (typeof value === 'boolean') return value;
    const t = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (['on', 'true', 'yes', '1'].includes(t)) return true;
    if (['off', 'false', 'no', '0'].includes(t)) return false;
    throw new SettingValueError(`"${key}" is on or off.`);
  }
  if (def.kind === 'days') {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 3650)
      throw new SettingValueError(`"${key}" is a whole number of days, 1 to 3650.`);
    return n;
  }
  if (typeof value !== 'string') throw new SettingValueError(`"${key}" must be text.`);
  const t = value.trim();
  if (def.kind === 'resource id') {
    if (!RESOURCE_ID.test(t)) {
      throw new SettingValueError(
        `"${key}" must be a LegendKeeper resource id (lowercase letters and digits, starting with a letter).`,
      );
    }
    return t;
  }
  if (def.kind === 'names') {
    if (t.length === 0 || t.length > 2000)
      throw new SettingValueError(`"${key}" must be 1 to 2,000 characters.`);
    return t
      .split(';')
      .map((x) => x.trim())
      .filter((x) => x !== '')
      .join('; ');
  }
  if (t.length === 0 || t.length > 256) throw new SettingValueError(`"${key}" must be 1 to 256 characters.`);
  return t;
}
