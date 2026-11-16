/**
 * `npm run images -- <command>` (v3 F2, ADR 0049 decision 10): the owner's image commands, run on the server as the
 * service user:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run images -- migrate-staging --project test
 *
 * `migrate-staging` moves the images of the old LegendKeeper staging folder (D3's hidden `LK-Bridge staging`) to the
 * bridge's server staging. The command holds no LegendKeeper key and sends nothing itself: it writes a request into the
 * bridge's database; the RUNNING bridge (which holds the project's key and governor) carries it out within a minute and
 * writes what it did, which the command prints. The bridge copies each staged record's bytes to the server and makes
 * ONE proposal deleting the hidden assets and then the empty folder; it never deletes without the owner's approval, and
 * running the command again is safe.
 */
import { pathToFileURL } from 'node:url';
import { defaultMigrationsDir, migrationContextFromEnv, runMigrations } from '../db/migrate.js';
import { openDatabase } from '../db/open.js';
import { PolicyStore } from '../policy/store.js';
import { ProjectStore } from '../projects/store.js';
import { ImageStore } from './store.js';

const usage = `Usage:
  npm run images -- migrate-staging --project <name>   move the old LegendKeeper staging folder to server staging`;

export async function runImagesCommand(
  argv: readonly string[],
  dbPath: string,
  out: (s: string) => void,
  o: { readonly waitMs?: number; readonly pollMs?: number } = {},
): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== 'migrate-staging') {
    out(usage);
    return 2;
  }
  const at = rest.indexOf('--project');
  const name = at >= 0 ? rest[at + 1]?.trim().toLowerCase() : undefined;
  if (!name) {
    out(usage);
    return 2;
  }
  const db = openDatabase(dbPath);
  try {
    runMigrations(db, defaultMigrationsDir(), { context: migrationContextFromEnv() });
    const project = new ProjectStore(db).byName(name);
    if (!project) {
      out(`No project named "${name}" is registered. \`npm run projects -- list\` shows them.`);
      return 1;
    }
    const images = new ImageStore(db, Date.now);
    const id = images.requestMigration(project.id, 'owner (images CLI)');
    new PolicyStore(db).audit('owner', 'images.migrate_staging', project.name, undefined, {
      request: id,
      via: 'images-cli',
    });
    out(
      `Asked the running bridge to migrate ${project.name}'s staging folder (request ${id}); waiting for it…`,
    );
    const deadline = Date.now() + (o.waitMs ?? 300_000);
    for (;;) {
      const m = images.migration(id);
      if (m && (m.state === 'done' || m.state === 'failed')) {
        const r = (m.result ?? {}) as Record<string, unknown>;
        if (m.state === 'failed') {
          out(`It failed: ${typeof r.error === 'string' ? r.error : 'unknown'}. Nothing was deleted.`);
          return 1;
        }
        out(typeof r.message === 'string' ? r.message : 'Done.');
        const list = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]) : []);
        out(
          `Copied to the server: ${list('copied').length}; already there: ${list('alreadyOnServer').length}.`,
        );
        for (const x of list('leftAlone') as { id: string; name: string; why: string }[])
          out(`Left alone: ${x.name} (${x.id}): ${x.why}`);
        if (m.proposalId) out(`Proposal: ${m.proposalId} (approve it on the dashboard's Proposals page).`);
        return 0;
      }
      if (Date.now() > deadline) {
        out(
          'The bridge has not picked the request up yet (is it running?). It will run it when it does; run this command again later to see the result.',
        );
        return 1;
      }
      await new Promise((r) => setTimeout(r, o.pollMs ?? 2000));
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runImagesCommand(process.argv.slice(2), process.env.DB_PATH ?? './data/bridge.db', (s) =>
    process.stdout.write(`${s}\n`),
  ).then((code) => {
    process.exitCode = code;
  });
}
