// @ts-check
// env-sync core (OPS1, ADR 0024): compares the bridge's env file with deploy/env.template and works out the new file.
//
// Run by deploy/env-sync.sh, as root, with the bridge's private Node and an empty environment, from the root-owned
// installed copy in /opt/lk-bridge/bin (never from the checkout). It imports Node built-ins only, so nothing is loaded
// from anywhere else. It is pure apart from the CLI at the bottom: `planSync` takes two texts and returns a new text and
// a summary.
//
// Secrets: the summary names variables only. Values (old ones, moved ones, generated ones) exist only in the new text,
// which the CLI writes to the one path it is given (a temporary file next to the env file, which env-sync.sh renames
// over it). Nothing here prints, logs or throws a value.
//
// The template carries one marker per variable, on the line directly above it:
//   # @default             safe to add with the template's value (an active NAME=value line)
//   # @generate:<enc>:<n>  a random secret made here: <n> bytes from crypto.randomBytes, as base64, base64url or hex
//   # @secret              only the owner can supply it; added as a commented-out placeholder, never invented.
//                          An active `NAME=` line in the template means required, a commented `# NAME=` optional.
//   # @optional            shown commented out with its default (`# NAME=value`) unless the owner sets it
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** @typedef {{ kind: 'default' } | { kind: 'secret' } | { kind: 'optional' } | { kind: 'generate', encoding: 'base64' | 'base64url' | 'hex', bytes: number }} Marker */
/**
 * @typedef {object} TemplateVar
 * @property {string} name
 * @property {Marker} marker
 * @property {boolean} active      an uncommented `NAME=value` line in the template
 * @property {string} value        the value as written (for a commented line, without a trailing `# comment`)
 * @property {string} line         the template's line, exactly
 * @property {string[]} comment    the explanatory comment lines above it (not the marker, not a section rule)
 */
/**
 * @typedef {object} Need
 * @property {string} name
 * @property {boolean} required    the bridge will not start until it is set
 * @property {boolean} placeholder a commented-out placeholder line is (to be) added for it
 * @property {string} why
 */
/**
 * @typedef {object} Plan
 * @property {string} text          the new file (equal to the old one when nothing changes)
 * @property {string[]} add         default-marked variables (and LK_DEFAULT_PROJECT) to add
 * @property {string[]} generate    generate-marked variables to create or fill in
 * @property {string[]} addOptional optional-marked variables to add, commented out
 * @property {string[]} placeholders secret-marked placeholders to add, commented out
 * @property {string[]} commentOut  variables no longer in the template, to comment out
 * @property {string[]} migrate     the migration's steps, by name
 * @property {string[]} retire      env lines retired because the bridge's encrypted store holds them (OPS2), by name
 * @property {string[]} rotate      the master-key rotation's steps, by name (OPS2)
 * @property {Need[]} needs         what only the owner can do
 * @property {string[]} notes       information; never a change
 * @property {number} changes       how many edits the new text holds
 */

/** Names that change how Node, the dynamic loader or TLS behave. A template may never add one (defence in depth). */
const FORBIDDEN_NAME =
  /^(NODE_(?!ENV$).*|LD_.*|DYLD_.*|PATH|HOME|SHELL|IFS|ENV|BASH_ENV|BASH_FUNC_.*|(HTTPS?|ALL|NO|FTP)_PROXY|SSL_.*|OPENSSL_.*|UV_.*|TZDIR)$/;
const NAME = '[A-Z][A-Z0-9_]*';
const ACTIVE = new RegExp(`^\\s*(${NAME})=(.*)$`);
const COMMENTED = new RegExp(`^\\s*#\\s*(${NAME})=(.*)$`);
const MARKER = /^#\s*@(\S*)\s*$/;
const RULE = /^#\s*-{3,}/;
/** The project variables (v2 A1) follow the project rules below, not the template's markers. */
const PROJECT_FIXED = new Set([
  'LK_PROJECTS',
  'LK_DEFAULT_PROJECT',
  'LK_API_KEY',
  'LK_PROJECT_ID',
  'LK_PROJECT_NAME',
]);
const PROJECT_KEY = /^LK_PROJECT_([A-Z0-9_]+)_API_KEY$/;
const isProjectVar = (/** @type {string} */ n) => PROJECT_FIXED.has(n) || PROJECT_KEY.test(n);
/** The deprecated single-project form (v1): documented in the template, never added by env-sync. */
const SINGLE_FORM = new Set(['LK_API_KEY', 'LK_PROJECT_ID', 'LK_PROJECT_NAME']);
/** A project name (src/config/index.ts PROJECT_NAME_PATTERN). */
const PROJECT_NAME = /^[a-z][a-z0-9_]{0,31}$/;
/** Single-project names the migration comments out (the key itself is moved). */
const MIGRATED_AWAY = ['LK_PROJECT_ID', 'LK_PROJECT_NAME', 'LK_SANDBOX_API_KEY', 'LK_SANDBOX_PROJECT_ID'];
/** OPS2: the only names --retire may comment out: values the bridge keeps in its encrypted store. */
const RETIRABLE = /^(LK_PROJECT_[A-Z0-9_]+_API_KEY|OWNER_PASSWORD_HASH|OWNER_TOTP_SECRET)$/;

/** @param {string} raw */
function parseMarker(raw) {
  if (raw === 'default' || raw === 'secret' || raw === 'optional')
    return /** @type {Marker} */ ({ kind: raw });
  const g = /^generate:(base64|base64url|hex):(\d{1,3})$/.exec(raw);
  if (g) {
    const bytes = Number(g[2]);
    if (bytes >= 16 && bytes <= 256) {
      return /** @type {Marker} */ ({
        kind: 'generate',
        encoding: /** @type {'base64' | 'base64url' | 'hex'} */ (g[1]),
        bytes,
      });
    }
  }
  return undefined;
}

/** A commented line's value, without a trailing `   # explanation`. @param {string} v */
const commentedValue = (v) => v.replace(/\s+#.*$/, '').trim();

/** The value systemd would see: trimmed, one pair of matching quotes removed. @param {string} v */
export function unquote(v) {
  const t = v.trim();
  const m = /^'(.*)'$/.exec(t) ?? /^"(.*)"$/.exec(t);
  return m ? (m[1] ?? '') : t;
}

/**
 * Reads the template and its markers. Every variable line, set or commented out, needs exactly one marker directly
 * above it; a marker belongs to the next line only.
 * @param {string} text
 * @returns {{ vars: TemplateVar[], errors: string[] }}
 */
export function parseTemplate(text) {
  /** @type {TemplateVar[]} */
  const vars = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {Marker | undefined} */
  let pending;
  let pendingLine = 0;
  /** @type {string[]} */
  let comment = [];
  const seen = new Set();
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const n = i + 1;
    const marker = MARKER.exec(line);
    if (marker) {
      if (pending) errors.push(`line ${pendingLine}: a marker must be followed directly by its variable`);
      pending = parseMarker(marker[1] ?? '');
      pendingLine = n;
      if (!pending) {
        errors.push(`line ${n}: unknown marker "@${(marker[1] ?? '').slice(0, 40)}"`);
        pendingLine = 0;
      }
      return;
    }
    const a = ACTIVE.exec(line);
    const c = a ? undefined : COMMENTED.exec(line);
    const m = a ?? c;
    if (m) {
      const name = m[1] ?? '';
      const active = a !== null;
      const value = active ? (m[2] ?? '') : commentedValue(m[2] ?? '');
      if (!pending) {
        if (pendingLine === 0)
          errors.push(`line ${n}: ${name} has no marker (@default, @generate, @secret or @optional)`);
      } else {
        if (seen.has(name)) errors.push(`line ${n}: ${name} appears twice`);
        seen.add(name);
        if (FORBIDDEN_NAME.test(name)) errors.push(`line ${n}: ${name} may not be set from the template`);
        const k = pending.kind;
        if (k === 'default' && !active)
          errors.push(`line ${n}: @default ${name} must be an uncommented NAME=value line`);
        if (k === 'optional' && active)
          errors.push(`line ${n}: @optional ${name} must be commented out (# ${name}=…)`);
        if (k === 'generate' && !(active && value === ''))
          errors.push(`line ${n}: @generate ${name} must be a blank ${name}= line`);
        if (k === 'secret' && value !== '') errors.push(`line ${n}: @secret ${name} must not carry a value`);
        vars.push({ name, marker: pending, active, value, line, comment });
      }
      pending = undefined;
      pendingLine = 0;
      comment = [];
      return;
    }
    if (pending) {
      errors.push(`line ${pendingLine}: a marker must be followed directly by its variable`);
      pending = undefined;
      pendingLine = 0;
    }
    if (line.trim() === '' || RULE.test(line)) {
      comment = [];
    } else if (line.trimStart().startsWith('#')) {
      comment.push(line);
    } else {
      errors.push(`line ${n}: not a comment, a marker or a NAME=value line`);
    }
  });
  if (pending) errors.push(`line ${pendingLine}: a marker must be followed directly by its variable`);
  return { vars, errors };
}

/**
 * @typedef {object} LiveLine
 * @property {string} text
 * @property {'active' | 'commented' | 'other'} kind
 * @property {string} [name]
 */

/** @param {string[]} lines @returns {LiveLine[]} */
function classify(lines) {
  return lines.map((text) => {
    const a = ACTIVE.exec(text);
    if (a) return { text, kind: 'active', name: a[1] ?? '' };
    const c = COMMENTED.exec(text);
    if (c) return { text, kind: 'commented', name: c[1] ?? '' };
    return { text, kind: 'other' };
  });
}

class LiveFile {
  /** @param {string} text */
  constructor(text) {
    this.endsWithNewline = text.endsWith('\n');
    const lines = text.split('\n');
    if (this.endsWithNewline) lines.pop();
    /** @type {LiveLine[]} */
    this.lines = classify(lines);
  }

  /** Indexes of the active lines for `name`. @param {string} name */
  activeAt(name) {
    /** @type {number[]} */
    const out = [];
    this.lines.forEach((l, i) => {
      if (l.kind === 'active' && l.name === name) out.push(i);
    });
    return out;
  }

  /** The value systemd uses (the last assignment), or undefined. @param {string} name */
  value(name) {
    const at = this.activeAt(name);
    const last = at[at.length - 1];
    if (last === undefined) return undefined;
    const t = this.lines[last]?.text ?? '';
    return unquote(t.slice(t.indexOf('=') + 1));
  }

  /** Set to a non-empty value. @param {string} name */
  isSet(name) {
    const v = this.value(name);
    return v !== undefined && v !== '';
  }

  /** Named on any line, set or commented out. @param {string} name */
  mentions(name) {
    return this.lines.some((l) => l.kind !== 'other' && l.name === name);
  }

  /** @param {number} i @param {string[]} texts */
  replace(i, texts) {
    this.lines.splice(i, 1, ...classify(texts));
  }

  toText() {
    const body = this.lines.map((l) => l.text).join('\n');
    return this.endsWithNewline || this.lines.length === 0 ? `${body}\n` : body;
  }
}

/** @param {Marker & { kind: 'generate' }} m @param {(n: number) => Buffer} random */
function generate(m, random) {
  const buf = random(m.bytes);
  if (!(buf instanceof Uint8Array) || buf.length !== m.bytes) throw new Error('random source failed');
  return m.encoding === 'hex' ? buf.toString('hex') : buf.toString(m.encoding);
}

/**
 * The migration to the multi-project form (v2 A1): LK_API_KEY's line becomes LK_PROJECT_<NAME>_API_KEY with the same
 * value (moved, never read out), LK_PROJECTS and LK_DEFAULT_PROJECT are added above it, and the single-project and
 * sandbox lines are commented out. Refuses anything but a clean single-project form; does nothing on a file already
 * in the multi-project form.
 * @param {LiveFile} live
 * @param {{ release: string, date: string }} o
 * @returns {{ steps: string[], refusal?: string, notes: string[] }}
 */
function migrateProjects(live, o) {
  const listed = live.value('LK_PROJECTS');
  const singleActive = ['LK_API_KEY', 'LK_PROJECT_ID', 'LK_PROJECT_NAME'].filter(
    (n) => live.activeAt(n).length > 0,
  );
  const keyLines = live.lines
    .filter((l) => l.kind === 'active' && PROJECT_KEY.test(l.name ?? ''))
    .map((l) => l.name);
  if (listed !== undefined && listed !== '') {
    if (singleActive.length > 0) {
      return {
        steps: [],
        notes: [],
        refusal: `the file is in a mixed state: it sets LK_PROJECTS and also ${singleActive.join(', ')} (the single-project form). Decide by hand which form is right and remove the other lines, then run this again.`,
      };
    }
    return {
      steps: [],
      notes: ['already in the multi-project form (LK_PROJECTS is set): nothing to migrate'],
    };
  }
  if (listed === '') {
    return {
      steps: [],
      notes: [],
      refusal:
        'LK_PROJECTS is present but empty. Remove that line (or fill it in by hand), then run this again.',
    };
  }
  if (live.activeAt('LK_API_KEY').length === 0) {
    return {
      steps: [],
      notes: [],
      refusal:
        'the file sets neither LK_PROJECTS nor LK_API_KEY, so there is no single-project form to migrate. Add the project lines by hand (runbook, "Adding a project").',
    };
  }
  for (const n of [...singleActive, 'LK_DEFAULT_PROJECT', ...MIGRATED_AWAY]) {
    if (live.activeAt(n).length > 1) {
      return {
        steps: [],
        notes: [],
        refusal: `${n} is set more than once. Keep one line, then run this again.`,
      };
    }
  }
  if (!live.isSet('LK_API_KEY')) {
    return { steps: [], notes: [], refusal: 'LK_API_KEY is empty: there is no key to move.' };
  }
  if (keyLines.length > 0) {
    return {
      steps: [],
      notes: [],
      refusal: `the file is in a mixed state: it sets LK_API_KEY and also ${[...new Set(keyLines)].join(', ')} (the multi-project form) without LK_PROJECTS. Decide by hand which key is right, then run this again.`,
    };
  }
  const name = (live.value('LK_PROJECT_NAME') || 'test').toLowerCase();
  if (!PROJECT_NAME.test(name)) {
    return {
      steps: [],
      notes: [],
      refusal:
        'LK_PROJECT_NAME is not a valid project name (a lowercase letter, then lowercase letters, digits or underscores; at most 32).',
    };
  }
  const wantedDefault = live.value('LK_DEFAULT_PROJECT');
  if (wantedDefault !== undefined && wantedDefault !== '' && wantedDefault.toLowerCase() !== name) {
    return {
      steps: [],
      notes: [],
      refusal: `LK_DEFAULT_PROJECT names another project than the one LK_API_KEY serves ("${name}"). Fix it by hand, then run this again.`,
    };
  }
  const keyVar = `LK_PROJECT_${name.toUpperCase()}_API_KEY`;
  const stamp = `${o.release}, ${o.date}`;
  const steps = [`LK_API_KEY -> ${keyVar} (the value is moved, never shown)`];
  /** @type {string[]} */
  const commented = [];
  // Comment out first (indexes after the key's line do not move the key's line).
  for (const n of MIGRATED_AWAY) {
    const at = live.activeAt(n)[0];
    if (at === undefined) continue;
    const old = live.lines[at]?.text ?? '';
    live.replace(at, [
      `# migrated to the multi-project form by env-sync (${stamp}): ${n} is no longer used.`,
      `# ${old.trimStart()}`,
    ]);
    commented.push(`comment out ${n}`);
  }
  const keyAt = live.activeAt('LK_API_KEY')[0] ?? -1;
  const keyLine = live.lines[keyAt]?.text ?? '';
  const raw = keyLine.slice(keyLine.indexOf('=') + 1);
  const block = [`# migrated to the multi-project form by env-sync (${stamp}): LK_API_KEY became ${keyVar}.`];
  block.push(`LK_PROJECTS=${name}`);
  steps.push(`add LK_PROJECTS (project "${name}")`);
  if (!live.isSet('LK_DEFAULT_PROJECT')) {
    block.push(`LK_DEFAULT_PROJECT=${name}`);
    steps.push('add LK_DEFAULT_PROJECT');
  }
  block.push(`${keyVar}=${raw}`);
  live.replace(keyAt, block);
  return { steps: [...steps, ...commented], notes: [] };
}

/**
 * OPS2: comments out env lines whose values the bridge now keeps in its encrypted store. The NAMES come from the
 * bridge's own comparison (`dist/secrets/env-tool.js compare`, run by env-sync.sh as the service user): `equal` names
 * hold exactly the stored value, `superseded` ones the value first imported, since replaced on the dashboard. Values
 * are never read here. When no listed project keeps a key line in force, LK_PROJECTS is commented out too.
 * @param {LiveFile} live
 * @param {{ equal: string[], superseded: string[], release: string, date: string }} o
 * @returns {{ steps: string[], refusal?: string, notes: string[] }}
 */
function retireImported(live, o) {
  /** @type {string[]} */
  const steps = [];
  /** @type {string[]} */
  const notes = [];
  if (live.activeAt('LK_API_KEY').length > 0 && !live.isSet('LK_PROJECTS')) {
    return {
      steps,
      notes,
      refusal:
        'the file uses the single-project form (LK_API_KEY). Move it first with --migrate-projects, deploy, then retire.',
    };
  }
  const stamp = `${o.release}, ${o.date}`;
  const all = [...o.equal.map((n) => [n, 'equal']), ...o.superseded.map((n) => [n, 'superseded'])];
  for (const [name, kind] of all) {
    if (!RETIRABLE.test(name ?? ''))
      return { steps, notes, refusal: `${String(name).slice(0, 60)} cannot be retired` };
    const at = live.activeAt(name ?? '');
    if (at.length === 0) {
      notes.push(`${name} is not set in the file: nothing to retire.`);
      continue;
    }
    for (const i of at.reverse()) {
      const old = live.lines[i]?.text ?? '';
      live.replace(i, [
        kind === 'equal'
          ? `# retired by env-sync (${stamp}): the bridge keeps ${name} in its encrypted store (checked equal), so this file no longer needs it.`
          : `# retired by env-sync (${stamp}): ${name} was replaced on the dashboard; the bridge keeps the new value in its encrypted store. Revoke this old value if you have not.`,
        `# ${old.trimStart()}`,
      ]);
    }
    steps.push(`${name}${kind === 'superseded' ? ' (an old value, replaced on the dashboard)' : ''}`);
  }
  // LK_PROJECTS once no listed project keeps a key here: the projects live in the bridge's database now.
  const listed = live.value('LK_PROJECTS');
  if (steps.length > 0 && listed !== undefined && listed !== '') {
    const names = listed
      .split(',')
      .map((n) => n.trim().toLowerCase())
      .filter((n) => n !== '');
    const keysLeft = names.filter((n) => live.isSet(`LK_PROJECT_${n.toUpperCase()}_API_KEY`));
    if (keysLeft.length === 0) {
      for (const i of live.activeAt('LK_PROJECTS').reverse()) {
        const old = live.lines[i]?.text ?? '';
        live.replace(i, [
          `# retired by env-sync (${stamp}): every listed project's key is in the bridge's encrypted store; projects are managed on the dashboard.`,
          `# ${old.trimStart()}`,
        ]);
      }
      steps.push('LK_PROJECTS (no listed project keeps a key in this file)');
    }
  }
  return { steps, notes };
}

/**
 * OPS2: starts a rotation of the secret store's master key. The current SECRETS_MASTER_KEY line becomes
 * SECRETS_MASTER_KEY_PREVIOUS with its value text moved, never read out; SECRETS_MASTER_KEY gets a new random value. An
 * older SECRETS_MASTER_KEY_PREVIOUS line is commented out (kept, with a note). The bridge's
 * `npm run secrets -- rotate-master-key` then re-encrypts everything (backup first).
 * @param {LiveFile} live
 * @param {{ release: string, date: string, random: (n: number) => Buffer, marker: Marker | undefined }} o
 * @returns {{ steps: string[], refusal?: string }}
 */
function rotateMasterKey(live, o) {
  const at = live.activeAt('SECRETS_MASTER_KEY');
  if (at.length !== 1 || !live.isSet('SECRETS_MASTER_KEY')) {
    return {
      steps: [],
      refusal:
        at.length > 1
          ? 'SECRETS_MASTER_KEY is set more than once. Keep one line, then run this again.'
          : 'SECRETS_MASTER_KEY is not set, so there is nothing to rotate.',
    };
  }
  if (!o.marker || o.marker.kind !== 'generate') {
    return { steps: [], refusal: 'the template does not say how to generate SECRETS_MASTER_KEY.' };
  }
  const stamp = `${o.release}, ${o.date}`;
  const steps = [];
  for (const i of live.activeAt('SECRETS_MASTER_KEY_PREVIOUS').reverse()) {
    const old = live.lines[i]?.text ?? '';
    live.replace(i, [
      `# replaced by env-sync (${stamp}): an older SECRETS_MASTER_KEY_PREVIOUS, kept for database backups sealed with it.`,
      `# ${old.trimStart()}`,
    ]);
    steps.push('comment out the older SECRETS_MASTER_KEY_PREVIOUS (kept in the file)');
  }
  const keyAt = live.activeAt('SECRETS_MASTER_KEY')[0] ?? -1;
  const keyLine = live.lines[keyAt]?.text ?? '';
  const raw = keyLine.slice(keyLine.indexOf('=') + 1);
  live.replace(keyAt, [
    `# master key rotated by env-sync (${stamp}): run \`npm run secrets -- rotate-master-key\` before restarting the bridge.`,
    `SECRETS_MASTER_KEY=${generate(o.marker, o.random)}`,
    `SECRETS_MASTER_KEY_PREVIOUS=${raw}`,
  ]);
  steps.push('SECRETS_MASTER_KEY -> SECRETS_MASTER_KEY_PREVIOUS (the value is moved, never shown)');
  steps.push('generate a new SECRETS_MASTER_KEY (random; never shown)');
  return { steps };
}

/**
 * v3 F2 (ADR 0049 decision 3): comments out LK_DEFAULT_PROJECT once the default the dashboard stored ("Make default")
 * agrees with it, so the dashboard's choice applies from then on. `stored` is the name the bridge's own database holds
 * (`npm run projects -- stored-default`, run by env-sync.sh as the service user), or '' when none is stored. A line that
 * disagrees is refused: press Make default on the Projects page first (it would otherwise change the default).
 * @param {LiveFile} live
 * @param {{ stored: string, release: string, date: string }} o
 * @returns {{ steps: string[], refusal?: string, notes: string[] }}
 */
function retireDefaultProject(live, o) {
  /** @type {string[]} */
  const steps = [];
  /** @type {string[]} */
  const notes = [];
  const at = live.activeAt('LK_DEFAULT_PROJECT');
  if (at.length === 0) {
    notes.push('LK_DEFAULT_PROJECT is not set in the file: nothing to retire.');
    return { steps, notes };
  }
  const wanted = (live.value('LK_DEFAULT_PROJECT') ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(o.stored)) {
    return {
      steps,
      notes,
      refusal:
        'the bridge has no stored default project yet. Press Make default on the Projects page first, then run this again.',
    };
  }
  if (wanted !== o.stored) {
    return {
      steps,
      notes,
      refusal: `LK_DEFAULT_PROJECT=${wanted.slice(0, 32)} differs from the dashboard's stored default (${o.stored}). Press Make default on ${wanted.slice(0, 32)} on the Projects page first (or keep the line), then run this again.`,
    };
  }
  const stamp = `${o.release}, ${o.date}`;
  for (const i of at.reverse()) {
    const old = live.lines[i]?.text ?? '';
    live.replace(i, [
      `# retired by env-sync (${stamp}): the dashboard stores the default project (${o.stored}); Make default on the Projects page changes it.`,
      `# ${old.trimStart()}`,
    ]);
  }
  steps.push(`LK_DEFAULT_PROJECT (the dashboard's stored default, ${o.stored}, agrees)`);
  return { steps, notes };
}

/**
 * Works out the new env file.
 * @param {object} o
 * @param {string} o.template           deploy/env.template's text
 * @param {string} o.live               the env file's text
 * @param {boolean} [o.migrateProjects] also migrate the single-project form (refuses a mixed state)
 * @param {boolean} [o.placeholdersOnly] only add the commented-out secret-marked placeholders (inert in any release)
 * @param {string[]} [o.retireEqual]    OPS2: names the bridge found equal to its encrypted store, to comment out
 * @param {string[]} [o.retireSuperseded] OPS2: names holding a value the dashboard has since replaced, to comment out
 * @param {string} [o.retireDefaultProject] v3 F2: the stored default project ('' for none): retire LK_DEFAULT_PROJECT
 * @param {boolean} [o.rotateMasterKey] OPS2: move SECRETS_MASTER_KEY to SECRETS_MASTER_KEY_PREVIOUS and make a new one
 * @param {string} [o.release]          the release the template belongs to, for the notes in the file
 * @param {string} [o.date]             YYYY-MM-DD, for the notes in the file
 * @param {(n: number) => Buffer} [o.random] the random source (crypto.randomBytes)
 * @returns {Plan | { error: string }}
 */
export function planSync(o) {
  const t = parseTemplate(o.template);
  if (t.errors.length > 0) return { error: `the template is not valid: ${t.errors.join('; ')}` };
  const release = o.release || 'this release';
  const date = o.date ?? new Date().toISOString().slice(0, 10);
  const random = o.random ?? randomBytes;
  const live = new LiveFile(o.live);
  /** @type {Plan} */
  const plan = {
    text: '',
    add: [],
    generate: [],
    addOptional: [],
    placeholders: [],
    commentOut: [],
    migrate: [],
    retire: [],
    rotate: [],
    needs: [],
    notes: [],
    changes: 0,
  };
  const all = !o.placeholdersOnly;

  if (all && (o.retireEqual?.length || o.retireSuperseded?.length)) {
    const r = retireImported(live, {
      equal: o.retireEqual ?? [],
      superseded: o.retireSuperseded ?? [],
      release,
      date,
    });
    if (r.refusal) return { error: `refusing to retire: ${r.refusal}` };
    plan.retire = r.steps;
    plan.notes.push(...r.notes);
  }
  if (all && o.retireDefaultProject !== undefined) {
    const r = retireDefaultProject(live, { stored: o.retireDefaultProject, release, date });
    if (r.refusal) return { error: `refusing to retire: ${r.refusal}` };
    plan.retire.push(...r.steps);
    plan.notes.push(...r.notes);
  }
  if (all && o.rotateMasterKey) {
    const r = rotateMasterKey(live, {
      release,
      date,
      random,
      marker: t.vars.find((v) => v.name === 'SECRETS_MASTER_KEY')?.marker,
    });
    if (r.refusal) return { error: `refusing to rotate: ${r.refusal}` };
    plan.rotate = r.steps;
  }

  if (o.migrateProjects && all) {
    const m = migrateProjects(live, { release, date });
    if (m.refusal) return { error: `refusing to migrate: ${m.refusal}` };
    plan.migrate = m.steps;
    plan.notes.push(...m.notes);
  }

  /** @type {string[][]} blocks to append, each the comment lines and then the variable line */
  const additions = [];
  const templateNames = new Set(t.vars.map((v) => v.name));

  // The project form decides who looks after the project variables.
  const listed = live.value('LK_PROJECTS');
  const multi = listed !== undefined && listed !== '';
  const single =
    !multi && (live.activeAt('LK_API_KEY').length > 0 || live.activeAt('LK_PROJECT_ID').length > 0);
  // OPS2: a file that mentions LK_PROJECTS only commented out (retired, or never used) leaves the projects to the
  // dashboard: no project line is added for it.
  const projectRules = multi || single || live.mentions('LK_PROJECTS');

  for (const v of t.vars) {
    // The single-project form's names are never added; the project variables follow the project rules below once
    // the file uses either form (a file with neither gets the template's project lines like any other).
    if (SINGLE_FORM.has(v.name) || (projectRules && isProjectVar(v.name))) continue;
    const m = v.marker;
    if (m.kind === 'default' || m.kind === 'optional') {
      if (!all || live.mentions(v.name)) continue;
      additions.push([...v.comment, v.line]);
      (m.kind === 'default' ? plan.add : plan.addOptional).push(v.name);
    } else if (m.kind === 'generate') {
      if (!all || live.isSet(v.name)) continue;
      const at = live.activeAt(v.name);
      const last = at[at.length - 1];
      const line = `${v.name}=${generate(m, random)}`;
      if (last !== undefined) live.replace(last, [line]);
      else additions.push([...v.comment, line]);
      plan.generate.push(v.name);
    } else {
      // @secret
      if (live.isSet(v.name)) continue;
      const placeholder = !live.mentions(v.name);
      if (placeholder) {
        additions.push([...v.comment, v.active ? `# ${v.line}` : v.line]);
        plan.placeholders.push(v.name);
      }
      if (v.active || placeholder) {
        plan.needs.push({
          name: v.name,
          required: v.active,
          placeholder,
          why: v.active
            ? 'required: the bridge will not start without it'
            : 'new and optional: fill it in, or leave the placeholder commented out',
        });
      }
    }
  }

  // The project rules (v2 A1), by name only.
  if (multi) {
    const names = (listed ?? '')
      .split(',')
      .map((n) => n.trim().toLowerCase())
      .filter((n) => n !== '');
    const valid = names.filter((n) => PROJECT_NAME.test(n));
    if (valid.length !== names.length) {
      plan.needs.push({
        name: 'LK_PROJECTS',
        required: true,
        placeholder: false,
        why: 'lists a name that is not a valid project name',
      });
    }
    for (const n of valid) {
      const keyVar = `LK_PROJECT_${n.toUpperCase()}_API_KEY`;
      if (live.isSet(keyVar)) continue;
      const placeholder = !live.mentions(keyVar);
      // OPS2: a key line that is present but not set (retired, or left blank) is fine: the bridge serves the project
      // with its key from the encrypted store, if one is stored there.
      if (!placeholder) {
        plan.notes.push(
          `${keyVar} is not set: project ${n} is served with its key from the bridge's encrypted store, if one is stored.`,
        );
        continue;
      }
      if (placeholder) {
        additions.push([
          `# The API key of project ${n} (listed in LK_PROJECTS; ADMIN role). Secret: never paste it anywhere else.`,
          `# ${keyVar}=`,
        ]);
        plan.placeholders.push(keyVar);
      }
      plan.needs.push({
        name: keyVar,
        required: true,
        placeholder,
        why: `required: LK_PROJECTS lists project ${n}`,
      });
    }
    const def = live.value('LK_DEFAULT_PROJECT');
    if (def === undefined || def === '') {
      if (valid.length === 1 && !live.mentions('LK_DEFAULT_PROJECT') && all) {
        const tv = t.vars.find((v) => v.name === 'LK_DEFAULT_PROJECT');
        additions.push([...(tv?.comment ?? []), `LK_DEFAULT_PROJECT=${valid[0]}`]);
        plan.add.push('LK_DEFAULT_PROJECT');
      } else if (valid.length > 1) {
        plan.needs.push({
          name: 'LK_DEFAULT_PROJECT',
          required: true,
          placeholder: false,
          why: 'required: LK_PROJECTS lists more than one project; choose where reads go',
        });
      }
    } else if (!valid.includes(def.toLowerCase())) {
      plan.needs.push({
        name: 'LK_DEFAULT_PROJECT',
        required: true,
        placeholder: false,
        why: 'names a project LK_PROJECTS does not list',
      });
    }
    for (const n of ['LK_API_KEY', 'LK_PROJECT_ID', 'LK_PROJECT_NAME']) {
      if (live.activeAt(n).length > 0)
        plan.notes.push(`${n} is set but ignored (LK_PROJECTS is set). Remove the line by hand.`);
    }
    for (const l of live.lines) {
      const k = l.kind === 'active' ? PROJECT_KEY.exec(l.name ?? '') : null;
      if (k && !valid.includes((k[1] ?? '').toLowerCase())) {
        plan.notes.push(
          `${l.name} is set but LK_PROJECTS does not list its project, so the bridge ignores it.`,
        );
      }
    }
  } else if (single) {
    plan.notes.push(
      'the file uses the single-project form (LK_API_KEY, LK_PROJECT_ID), which still works but is deprecated. Once this release is deployed, move with: env-sync.sh --migrate-projects',
    );
  }

  // Variables the template no longer lists: commented out in place, never deleted.
  if (all) {
    plan.commentOut = [
      ...new Set(
        live.lines
          .filter(
            (l) => l.kind === 'active' && !templateNames.has(l.name ?? '') && !PROJECT_KEY.test(l.name ?? ''),
          )
          .map((l) => l.name ?? ''),
      ),
    ];
    for (const name of plan.commentOut) {
      for (const at of live.activeAt(name).reverse()) {
        const old = live.lines[at]?.text ?? '';
        live.replace(at, [
          `# removed in ${release} (${date}): ${name} is no longer in deploy/env.template, so the bridge ignores it. Kept here, commented out.`,
          `# ${old.trimStart()}`,
        ]);
      }
    }
  }

  if (additions.length > 0) {
    const last = live.lines[live.lines.length - 1];
    const block = [];
    if (last && last.text.trim() !== '') block.push('');
    block.push(
      `# ---------------------------------------------------------------- Added by env-sync (${release}, ${date})`,
    );
    block.push('# See deploy/env.template for each setting. Lines that start with # are not in force.');
    for (const a of additions) {
      // A blank line before each added setting that has its own explanation, so the two stay together.
      if (a.length > 1) block.push('');
      block.push(...a);
    }
    live.lines.push(...classify(block));
    live.endsWithNewline = true;
  }

  plan.changes =
    plan.retire.length +
    plan.rotate.length +
    plan.add.length +
    plan.generate.length +
    plan.addOptional.length +
    plan.placeholders.length +
    plan.commentOut.length +
    plan.migrate.length;
  plan.text = plan.changes > 0 ? live.toText() : o.live;
  return plan;
}

/**
 * The summary: names only, never a value.
 * @param {Plan} p
 * @param {{ applied?: boolean }} [o]
 */
export function summarise(p, o = {}) {
  const will = o.applied ? '' : 'will ';
  const out = [];
  const list = (/** @type {string} */ label, /** @type {string[]} */ names) => {
    if (names.length > 0) out.push(`  ${label}: ${names.join(', ')}`);
  };
  list(`${will}migrate to the multi-project form`, p.migrate);
  list(`${will}retire (in the encrypted store now; values are never shown)`, p.retire);
  list(`${will}rotate the master key`, p.rotate);
  list(`${will}add`, p.add);
  list(`${will}generate (random; the value is never shown)`, p.generate);
  list(`${will}add, commented out (optional)`, p.addOptional);
  list(`${will}add a commented-out placeholder`, p.placeholders);
  list(`${will}comment out (no longer in the template)`, p.commentOut);
  list('needs you', [...new Set(p.needs.map((n) => n.name))]);
  for (const n of p.notes) out.push(`  note: ${n}`);
  if (p.changes === 0 && p.needs.length === 0) out.push('  in step: nothing to change.');
  return out;
}

/** @param {Need[]} needs @param {string} file */
export function actionNeeded(needs, file) {
  return needs.map(
    (n) =>
      `ACTION NEEDED: fill in ${n.name} in ${file} (${n.why}).` +
      (n.placeholder
        ? ` Its commented-out placeholder line is at the end of the file: remove the "# " and add the value.`
        : ''),
  );
}

/** A comma-separated list of variable names (from env-sync.sh), or none. @param {unknown} v @returns {string[]} */
function names(v) {
  return typeof v === 'string'
    ? v
        .split(',')
        .map((n) => n.trim())
        .filter((n) => /^[A-Z][A-Z0-9_]*$/.test(n))
    : [];
}

/** @param {string[]} argv */
function main(argv) {
  /** @type {Record<string, string | boolean>} */
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i] ?? '';
    if (['--migrate-projects', '--placeholders-only', '--rotate-master-key'].includes(k)) a[k] = true;
    else if (
      [
        '--template',
        '--live',
        '--out',
        '--release',
        '--date',
        '--label',
        '--retire',
        '--retire-superseded',
        '--retire-default-project',
      ].includes(k)
    )
      a[k] = argv[++i] ?? '';
    else {
      process.stderr.write(`ERROR: unknown argument ${k.slice(0, 40)}\n`);
      return 2;
    }
  }
  const template = String(a['--template'] ?? '');
  const livePath = String(a['--live'] ?? '');
  if (!template || !livePath) {
    process.stderr.write('ERROR: --template and --live are required\n');
    return 2;
  }
  let templateText;
  let liveText;
  try {
    templateText = readFileSync(template, 'utf8');
    liveText = readFileSync(livePath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `ERROR: cannot read the template or the env file (${/** @type {NodeJS.ErrnoException} */ (err).code ?? 'error'})\n`,
    );
    return 2;
  }
  let plan;
  try {
    plan = planSync({
      template: templateText,
      live: liveText,
      migrateProjects: a['--migrate-projects'] === true,
      placeholdersOnly: a['--placeholders-only'] === true,
      rotateMasterKey: a['--rotate-master-key'] === true,
      retireEqual: names(a['--retire']),
      retireSuperseded: names(a['--retire-superseded']),
      ...(typeof a['--retire-default-project'] === 'string'
        ? {
            retireDefaultProject:
              a['--retire-default-project'] === '-' ? '' : a['--retire-default-project'].trim().toLowerCase(),
          }
        : {}),
      ...(typeof a['--release'] === 'string' ? { release: a['--release'] } : {}),
      ...(typeof a['--date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a['--date'])
        ? { date: a['--date'] }
        : {}),
    });
  } catch {
    process.stderr.write('ERROR: env-sync failed while planning (no value is shown)\n');
    return 2;
  }
  if ('error' in plan) {
    process.stderr.write(`ERROR: ${plan.error}\n`);
    return 2;
  }
  const label = String(a['--label'] ?? livePath);
  process.stdout.write(`${summarise(plan).join('\n')}\n`);
  const out = a['--out'];
  if (typeof out === 'string' && out !== '' && plan.changes > 0) {
    // 'wx': the temporary file must be new (never follow or reuse a file someone else made); 0600 until it is renamed.
    writeFileSync(out, plan.text, { flag: 'wx', mode: 0o600 });
  }
  for (const line of actionNeeded(plan.needs, label)) process.stdout.write(`${line}\n`);
  process.stdout.write(`status: changes=${plan.changes} action_needed=${plan.needs.length}\n`);
  return plan.changes > 0 || plan.needs.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
