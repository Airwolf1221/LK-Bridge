/**
 * The off-site copy's settings (v2 E1b, ADR 0043), kept in the database (`offsite_state.settings_json`) and edited on the
 * dashboard's Off-site copy page. The separate runner reads them from the database at every start, so a change applies
 * from its next run without touching a systemd unit.
 *
 * Stored values are validated field by field: a value that no longer validates falls back to its default (and the
 * dashboard says so), so a bad row never stops the runner.
 */
import * as z from 'zod';

/** Whether a string holds a control character (U+0000 to U+001F, U+007F). */
function hasControl(s: string): boolean {
  for (const c of s) {
    const n = c.charCodeAt(0);
    if (n < 32 || n === 127) return true;
  }
  return false;
}

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 04:45');

/**
 * rclone's `--bwlimit` in its simplest form: a rate in KiB/s with an optional suffix (`512`, `512K`, `2M`, `1.5M`), or
 * empty/`off` for no limit. Timetables are deliberately not accepted (a bad one would stop every copy).
 */
const bandwidth = z
  .string()
  .trim()
  .regex(
    /^(|off|\d{1,6}(\.\d{1,3})?[KMG]?)$/i,
    'A rate such as 512K or 2M (bytes a second), or empty for none',
  );

/** A Drive folder path: plain names separated by `/`, no `..`, no leading or trailing slash. */
const folder = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (s) =>
      !s.startsWith('/') &&
      !s.endsWith('/') &&
      s
        .split('/')
        .every((p) => p.trim() !== '' && p !== '.' && p !== '..' && !/[\\:*?"<>|]/.test(p) && !hasControl(p)),
    'Folder names separated by "/", without "..", ":" or a leading or trailing "/"',
  );

export const offsiteSettingsSchema = z.object({
  /** The Drive folder the copies go into; each key generation gets `copy-<n>` inside it. */
  folder: folder.optional(),
  /** The daily copy's time (London). Default 04:45: after the nightly database copy at 04:15. */
  copyTime: time.default('04:45'),
  /** Days the pieces E1a's clean-up removed stay on Drive (in `deleted/<date>`) before the runner purges them. */
  deletedRetentionDays: z.number().int().min(1).max(3650).default(30),
  bandwidthLimit: bandwidth.default(''),
  /** rclone `--transfers`. */
  transfers: z.number().int().min(1).max(16).default(4),
  verifyEnabled: z.boolean().default(true),
  /** The monthly verify's day of the month (1 to 28) and time (London). */
  verifyDay: z.number().int().min(1).max(28).default(1),
  verifyTime: time.default('05:30'),
  /** The verify downloads every manifest, plus this percentage of the objects (at least `verifySampleMin`). */
  verifySamplePercent: z.number().min(0).max(100).default(1),
  verifySampleMin: z.number().int().min(0).max(1_000_000).default(50),
  /** The Overview warns when the last good copy is older than this. */
  staleAfterDays: z.number().min(0.5).max(365).default(2),
});

export type OffsiteSettingsInput = z.input<typeof offsiteSettingsSchema>;
export interface OffsiteSettings extends Omit<z.output<typeof offsiteSettingsSchema>, 'folder'> {
  readonly folder: string;
}

export const DEFAULT_FOLDER_ROOT = 'LK-Bridge backups';

/** The default Drive folder: `LK-Bridge backups/<server name>` (the bridge's public host name). */
export function defaultFolder(serverName: string): string {
  const name =
    [...serverName]
      .map((c) => (/[\\/:*?"<>|]/.test(c) || c.charCodeAt(0) < 32 ? '-' : c))
      .join('')
      .trim() || 'server';
  return `${DEFAULT_FOLDER_ROOT}/${name}`;
}

/** The server name for the default folder: the host of BRIDGE_PUBLIC_URL, else the machine's host name. */
export function serverNameOf(publicUrl: string | undefined, hostname: string): string {
  try {
    if (publicUrl) return new URL(publicUrl).hostname;
  } catch {
    // fall through
  }
  return hostname;
}

/** Parses stored JSON; each invalid field falls back to its default and is named in `problems`. Never throws. */
export function parseOffsiteSettings(
  json: string,
  serverName: string,
): { settings: OffsiteSettings; problems: string[] } {
  let raw: Record<string, unknown> = {};
  const problems: string[] = [];
  try {
    const v = JSON.parse(json) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) raw = v as Record<string, unknown>;
  } catch {
    problems.push('the stored settings could not be read; the defaults apply');
  }
  const shape = offsiteSettingsSchema.shape;
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(shape)) {
    const r = (s as z.ZodType).safeParse(raw[k]);
    if (r.success) out[k] = r.data;
    else {
      problems.push(`${k}: the stored value is not valid; the default applies`);
      out[k] = (s as z.ZodType).parse(undefined);
    }
  }
  const settings = { ...out, folder: (out.folder as string | undefined) ?? defaultFolder(serverName) };
  return { settings: settings as OffsiteSettings, problems };
}

/** The folder of a key generation: `<folder>/copy-<n>`. */
export function generationPath(folderPath: string, generation: number): string {
  return `${folderPath}/copy-${generation}`;
}
