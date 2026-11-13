/**
 * Requests from the bridge to the separate off-site runner (v2 E1b, ADR 0043): small JSON files in
 * `<data dir>/offsite/requests/`. The bridge never starts the runner itself (no shared process, no sudo rule):
 * `lk-bridge-offsite.path` watches `*.json` there and starts `lk-bridge-offsite.service`, which consumes (reads and
 * deletes) every request first thing. A request made while a run is going is picked up when that run ends (the path unit
 * starts the service again while a file exists).
 *
 * Kinds: `copy` ("Copy now", or after a nightly full snapshot), `verify` ("Verify now"), `delete_folder` (an old Drive
 * folder the owner chose to delete). No request ever carries a secret.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod';

export const requestSchema = z.object({
  kind: z.enum(['copy', 'verify', 'delete_folder']),
  trigger: z.enum(['request', 'after_full']).default('request'),
  generation: z.number().int().min(1).optional(),
  at: z.number().int(),
});
export type OffsiteRequest = z.output<typeof requestSchema>;

/** `<directory of the database>/offsite/requests`. */
export function requestDir(dbPath: string): string {
  return join(dirname(dbPath), 'offsite', 'requests');
}

export async function writeRequest(
  dir: string,
  req: Omit<OffsiteRequest, 'at'> & { at?: number },
): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dirname(dir), 0o700).catch(() => undefined);
  await chmod(dir, 0o700);
  const at = req.at ?? Date.now();
  const name = `${req.kind}-${at}-${randomBytes(4).toString('hex')}.json`;
  const tmp = join(dir, `.${name}.partial`);
  await writeFile(tmp, `${JSON.stringify({ ...req, at })}\n`, { mode: 0o600 });
  await rename(tmp, join(dir, name));
  return name;
}

/** Reads and deletes every request (the runner, at its start). A file that does not parse is deleted and reported. */
export async function takeRequests(dir: string): Promise<{ requests: OffsiteRequest[]; bad: string[] }> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {
    return { requests: [], bad: [] };
  }
  const requests: OffsiteRequest[] = [];
  const bad: string[] = [];
  for (const n of names.sort()) {
    const p = join(dir, n);
    try {
      const r = requestSchema.safeParse(JSON.parse(await readFile(p, 'utf8')));
      if (r.success) requests.push(r.data);
      else bad.push(n);
    } catch {
      bad.push(n);
    } finally {
      await rm(p, { force: true });
    }
  }
  return { requests, bad };
}

/** Requests waiting (the dashboard shows "Copy requested"). */
export async function pendingRequests(dir: string): Promise<OffsiteRequest[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {
    return [];
  }
  const out: OffsiteRequest[] = [];
  for (const n of names) {
    try {
      const r = requestSchema.safeParse(JSON.parse(await readFile(join(dir, n), 'utf8')));
      if (r.success) out.push(r.data);
    } catch {
      // being consumed
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
