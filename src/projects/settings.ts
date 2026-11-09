/**
 * Per-project settings (v2 A1): the JSON `settings` column of `projects`. Later sessions fill these in (A2 the AI
 * REPOSITORY root, C2 the Characters root and template ids, D1 the chronology resource); A1 only defines the shape,
 * reads it safely and shows it on the dashboard. Unknown keys are kept as they are, so a newer release's settings
 * survive a rollback.
 */
import * as z from 'zod';

const id = z.string().min(1).max(64);

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
  })
  .loose();

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

/** The settings the dashboard and later sessions may rely on, by key, with what each is for. */
export const PROJECT_SETTING_KEYS = [
  { key: 'aiRepositoryRootId', label: 'AI REPOSITORY root', kind: 'resource id' },
  { key: 'charactersRootId', label: 'Characters root', kind: 'resource id' },
  { key: 'chronologyResourceId', label: 'Chronology resource', kind: 'resource id' },
  { key: 'templateIds', label: 'Template ids', kind: 'role → template id' },
] as const;

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
