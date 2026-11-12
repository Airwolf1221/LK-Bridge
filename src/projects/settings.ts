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
    /** v2 D3 (ADR 0041): the name of the asset folder (in the library's root) staged images go to. */
    imageStagingFolder: label.optional(),
    /**
     * v2 E1a (ADR 0042): the daily changed-pages snapshot (default OFF): pages whose `updatedAt` moved are snapshotted
     * between the weekly full snapshots. On only once the owner's sandbox run confirms `updatedAt` moves with content.
     */
    snapshotDailyPass: z.boolean().optional(),
    /** v2 E1a: the daily pass also lists each page's documents (one request per page) and compares their `updatedAt`. */
    snapshotDailyPassDocuments: z.boolean().optional(),
  })
  .loose();

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export type SettingKind = 'resource id' | 'name' | 'on/off' | 'role → template id' | 'rules';

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
    help: 'The asset folder, in the library’s root, that staged images go to (hidden until placed). Found by name, or created on first use.',
  },
  {
    key: 'snapshotDailyPass',
    label: 'Snapshots: daily changed-pages pass',
    kind: 'on/off',
    default: false,
    editable: true,
    help: 'On: every night the resources are listed and the pages whose updatedAt moved since a snapshot saw them are snapshotted (edits made in the app between the weekly full snapshots). Switch on only once the sandbox run’s updatedAt checks (snapshots, U1 to U5) pass.',
  },
  {
    key: 'snapshotDailyPassDocuments',
    label: 'Snapshots: daily pass reads documents too',
    kind: 'on/off',
    default: false,
    editable: true,
    help: 'On: the daily pass also lists each page’s documents (one request per page) and compares their updatedAt. Needed only if the sandbox run shows a document change does not move its page’s updatedAt.',
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
export function parseSettingValue(key: string, value: unknown): string | boolean | null {
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
  if (t.length === 0 || t.length > 256) throw new SettingValueError(`"${key}" must be 1 to 256 characters.`);
  return t;
}
