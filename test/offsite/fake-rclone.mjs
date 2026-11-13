#!/usr/bin/env node
/* eslint-disable -- a stand-in executable in plain Node, untyped by design; the tests that use it check it */
// @ts-nocheck
/**
 * A fake rclone for the off-site tests (v2 E1b). It never touches the network: "Google Drive" is a local directory
 * (FAKE_RCLONE_DRIVE), and the crypt remote stores files there in plain form under the folder its config names (the
 * real encryption is rclone's; what is tested here is what the runner asks of it). Every call is recorded as one JSON
 * line in FAKE_RCLONE_LOG: its arguments, and whether the --config file existed and with which mode, and its parsed
 * settings.
 *
 * Remotes come from the --config file: `lkdrive:<path>` is <drive>/<path>; `lkcrypt:<path>` is <drive>/<the crypt
 * remote's folder>/<path>. The crypt keys (obscured) are remembered in `.fake-crypt-keys` at the crypt root on the first
 * write; another pair is refused there afterwards ("wrong keys"), as real rclone could not read the files.
 *
 * Settings (environment):
 *   FAKE_RCLONE_VERSION        what `version` reports (default 1.60.1)
 *   FAKE_RCLONE_FAIL_ON        a substring of the command line: that call fails (exit 1)
 *   FAKE_RCLONE_CRASH_ON       a substring: that call kills itself (SIGKILL), as a crash
 *   FAKE_RCLONE_KILL_PARENT_ON a substring: that call sends SIGTERM to its parent (the runner) and waits
 *   FAKE_RCLONE_NEW_REFRESH    on the first copy or sync, rclone "refreshes" the token: the config's refresh_token
 *                              becomes this value (as rclone writes renewed tokens back to its config)
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

const argv = process.argv.slice(2);
const env = process.env;
const VALUE_FLAGS = new Set([
  '--config',
  '--stats',
  '--stats-log-level',
  '--transfers',
  '--checkers',
  '--retries',
  '--low-level-retries',
  '--bwlimit',
  '--backup-dir',
  '--min-age',
  '--include',
  '--files-from',
  '--max-depth',
]);
const flags = {};
const includes = [];
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) {
    const v = argv[++i];
    if (a === '--include') includes.push(v);
    else flags[a] = v;
  } else if (a.startsWith('-') && a !== '-') flags[a] = true;
  else positional.push(a);
}
const [cmd, ...rest] = positional;
const line = argv.join(' ');

function parseIni(text) {
  const out = {};
  let cur = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    const s = /^\[(.+)\]$/.exec(l);
    if (s) {
      cur = out[s[1]] = {};
      continue;
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(l);
    if (kv && cur) cur[kv[1]] = kv[2];
  }
  return out;
}

const cfgPath = flags['--config'];
let cfg = {};
let cfgMode = null;
if (cfgPath && existsSync(cfgPath)) {
  cfg = parseIni(readFileSync(cfgPath, 'utf8'));
  cfgMode = (statSync(cfgPath).mode & 0o777).toString(8);
}
if (env.FAKE_RCLONE_LOG) {
  appendFileSync(
    env.FAKE_RCLONE_LOG,
    `${JSON.stringify({
      argv,
      cmd,
      config: cfgPath ?? null,
      configExists: cfgPath ? existsSync(cfgPath) : null,
      configMode: cfgMode,
      sections: Object.keys(cfg),
      drive: cfg.lkdrive
        ? { type: cfg.lkdrive.type, scope: cfg.lkdrive.scope, client_id: cfg.lkdrive.client_id }
        : null,
      crypt: cfg.lkcrypt
        ? {
            type: cfg.lkcrypt.type,
            remote: cfg.lkcrypt.remote,
            filename_encryption: cfg.lkcrypt.filename_encryption,
            directory_name_encryption: cfg.lkcrypt.directory_name_encryption,
            password: cfg.lkcrypt.password,
            password2: cfg.lkcrypt.password2,
          }
        : null,
      home: env.HOME,
      envNames: Object.keys(env)
        .filter((k) => !k.startsWith('FAKE_RCLONE_'))
        .sort(),
    })}\n`,
  );
}

const die = (code, msg) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', msg })}\n`);
  process.exit(code);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (env.FAKE_RCLONE_CRASH_ON && line.includes(env.FAKE_RCLONE_CRASH_ON)) process.kill(process.pid, 'SIGKILL');
if (env.FAKE_RCLONE_KILL_PARENT_ON && line.includes(env.FAKE_RCLONE_KILL_PARENT_ON)) {
  process.kill(process.ppid, 'SIGTERM');
  await sleep(5000);
}
if (env.FAKE_RCLONE_FAIL_ON && line.includes(env.FAKE_RCLONE_FAIL_ON))
  die(1, `fake failure on ${env.FAKE_RCLONE_FAIL_ON}`);

if (cmd === 'version') {
  process.stdout.write(`rclone v${env.FAKE_RCLONE_VERSION ?? '1.60.1'}\n- os/version: fake\n`);
  process.exit(0);
}
if (cmd === 'obscure') {
  const input = readFileSync(0, 'utf8').replace(/\n$/, '');
  process.stdout.write(`OBSC_${Buffer.from(input).toString('base64url')}\n`);
  process.exit(0);
}

const drive = env.FAKE_RCLONE_DRIVE;
if (!drive) die(2, 'FAKE_RCLONE_DRIVE is not set');

let wroteCrypt = false;
function resolve(spec, forWrite) {
  const m = /^([a-z]+):(.*)$/.exec(spec);
  if (!m) return spec; // a local path
  const [, remote, path] = m;
  if (remote === 'lkdrive') return join(drive, path);
  if (remote === 'lkcrypt') {
    const c = cfg.lkcrypt;
    if (!c) die(2, 'no crypt remote in the config');
    const base = /^lkdrive:(.*)$/.exec(c.remote)[1];
    const root = join(drive, base);
    const keyFile = join(root, '.fake-crypt-keys');
    const keys = `${c.password}\n${c.password2}`;
    if (existsSync(keyFile)) {
      if (readFileSync(keyFile, 'utf8') !== keys) die(1, 'wrong keys: the files here cannot be decrypted');
    } else if (forWrite) {
      mkdirSync(root, { recursive: true });
      writeFileSync(keyFile, keys);
      wroteCrypt = true;
    }
    return join(root, path);
  }
  die(2, `unknown remote ${remote}`);
}

function walk(dir) {
  const out = [];
  const go = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.fake-crypt-keys') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) go(p);
      else out.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) go(dir);
  return out.sort();
}
const glob = (pat) => new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const included = (rel) => includes.length === 0 || includes.some((p) => glob(p).test(rel.split('/').pop()));
const minAgeMs = flags['--min-age'] ? Number(/^(\d+)s$/.exec(flags['--min-age'])[1]) * 1000 : 0;
const oldEnough = (p) => !minAgeMs || Date.now() - statSync(p).mtimeMs >= minAgeMs;

const stats = { bytes: 0, transfers: 0, errors: 0, checks: 0, deletes: 0 };
function put(from, to) {
  const s = statSync(from);
  if (existsSync(to)) {
    const t = statSync(to);
    if (t.size === s.size && Math.abs(t.mtimeMs - s.mtimeMs) < 1000) {
      stats.checks++;
      return;
    }
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  utimesSync(to, s.atime, s.mtime);
  stats.bytes += s.size;
  stats.transfers++;
}
function refreshOnce() {
  if (!env.FAKE_RCLONE_NEW_REFRESH || !cfgPath) return;
  const text = readFileSync(cfgPath, 'utf8');
  const next = text.replace(/("refresh_token":")[^"]*"/, `$1${env.FAKE_RCLONE_NEW_REFRESH}"`);
  if (next !== text) writeFileSync(cfgPath, next);
}
function done() {
  if (flags['--use-json-log'])
    process.stderr.write(`${JSON.stringify({ level: 'notice', msg: 'Transferred', stats })}\n`);
  process.exit(0);
}

const remoteSide = (s) => /^[a-z]+:/.test(s);
switch (cmd) {
  case 'copy':
  case 'sync': {
    const [srcSpec, dstSpec] = rest;
    const src = resolve(srcSpec, false);
    const dst = resolve(dstSpec, remoteSide(dstSpec));
    if (!existsSync(src)) die(3, `directory not found: ${srcSpec}`);
    refreshOnce();
    let files = walk(src).filter(included);
    if (flags['--files-from']) {
      const want = new Set(readFileSync(flags['--files-from'], 'utf8').split('\n').filter(Boolean));
      files = files.filter((f) => want.has(f));
    }
    const moving = files.filter((f) => oldEnough(join(src, f)));
    for (const f of moving) put(join(src, f), join(dst, f));
    if (cmd === 'sync') {
      const keep = new Set(walk(src).filter(included));
      for (const f of walk(dst).filter(included)) {
        if (keep.has(f)) continue;
        if (flags['--backup-dir']) {
          const b = join(resolve(flags['--backup-dir'], true), f);
          mkdirSync(dirname(b), { recursive: true });
          renameSync(join(dst, f), b);
        } else rmSync(join(dst, f));
        stats.deletes++;
      }
    }
    void wroteCrypt;
    done();
    break;
  }
  case 'copyto': {
    const [srcSpec, dstSpec] = rest;
    const src = resolve(srcSpec, false);
    const dst = resolve(dstSpec, remoteSide(dstSpec));
    if (!existsSync(src)) die(3, `object not found: ${srcSpec}`);
    put(src, dst);
    done();
    break;
  }
  case 'lsjson': {
    const dir = resolve(rest[0], false);
    if (!existsSync(dir)) die(3, `directory not found: ${rest[0]}`);
    let list;
    if (flags['-R'])
      list = walk(dir).map((p) => ({
        Path: p,
        Name: p.split('/').pop(),
        Size: statSync(join(dir, p)).size,
        IsDir: false,
      }));
    else
      list = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.name !== '.fake-crypt-keys')
        .filter((e) => !flags['--files-only'] || e.isFile())
        .map((e) => ({
          Path: e.name,
          Name: e.name,
          Size: e.isFile() ? statSync(join(dir, e.name)).size : -1,
          IsDir: e.isDirectory(),
        }));
    process.stdout.write(JSON.stringify(list));
    process.exit(0);
    break;
  }
  case 'lsf': {
    const dir = resolve(rest[0], false);
    if (!existsSync(dir)) die(3, `directory not found: ${rest[0]}`);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.fake-crypt-keys') continue;
      if (flags['--dirs-only'] && !e.isDirectory()) continue;
      process.stdout.write(`${e.name}${e.isDirectory() ? '/' : ''}\n`);
    }
    process.exit(0);
    break;
  }
  case 'purge': {
    const dir = resolve(rest[0], false);
    if (!existsSync(dir)) die(3, `directory not found: ${rest[0]}`);
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
    break;
  }
  default:
    die(2, `fake rclone: unknown command ${cmd}`);
}
