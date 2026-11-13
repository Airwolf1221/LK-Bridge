/**
 * The off-site copy, bridge side (v2 E1b, ADR 0043; docs/dashboard.md › Off-site copy). The bridge never copies anything
 * itself: a separate runner (`lk-bridge-offsite.service`, src/offsite/runner.ts) does, with rclone. What the bridge does:
 *
 * - keeps the Google OAuth client (id and secret), the refresh token and rclone crypt's password and salt in the
 *   encrypted secret store (scope `offsite`), never in the env file;
 * - runs Google's sign-in: authorisation code with PKCE (S256) and a `state` bound to the owner's dashboard session (10
 *   minutes, used once), `access_type=offline`, `prompt=consent`, the scope `drive.file` only; the callback
 *   (`/admin/drive/callback`) swaps the code for tokens, stores the refresh token and names the account (`about.get`);
 * - generates the encryption keys (shown once; saved only once the owner types back their last characters) or takes the
 *   owner's own; a change after a copy exists starts a new Drive folder (a fresh full upload), keeping the old one until
 *   the owner deletes it;
 * - writes the runner's requests ("Copy now", "Verify now", deleting an old folder, the copy after a weekly full snapshot);
 * - shows what the runner recorded (runs, findings) and warns on the Overview when the connection is broken, the last good
 *   copy is too old, or the last verify found problems.
 *
 * Secrets: no method returns a stored secret, except the generated keys once (`shownOnce`). Errors are redacted.
 */
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Db } from '../db/open.js';
import { OFFSITE_SCOPE, type SecretStore } from '../secrets/store.js';
import { OffsiteDb, type FolderRow, type RunRow } from './db.js';
import {
  GoogleError,
  GoogleOAuth,
  pkcePair,
  randomState,
  reconnectReason,
  redactSecrets,
  type GoogleOAuthOptions,
} from './google.js';
import { pendingRequests, writeRequest, type OffsiteRequest } from './requests.js';
import { isDue, latestDailySlot, nextDailyRun, nextMonthlySlot, TIMER_TICK_MS } from './schedule.js';
import {
  offsiteSettingsSchema,
  serverNameOf,
  type OffsiteSettings,
  type OffsiteSettingsInput,
} from './settings.js';

export const CALLBACK_PATH = '/admin/drive/callback';
/** How long a "Connect Google Drive" may take between the click and Google's answer. */
export const CONNECT_TTL_MS = 10 * 60_000;
/** How long generated keys wait for the owner's confirmation. */
export const KEYS_TTL_MS = 15 * 60_000;
/** How many trailing characters of each generated key the owner types back. */
export const CONFIRM_CHARS = 6;
export const MIN_OWN_KEY_LENGTH = 16;

export type OffsiteErrorCode =
  | 'OFFSITE_NO_CLIENT'
  | 'OFFSITE_NOT_CONNECTED'
  | 'OFFSITE_NO_KEYS'
  | 'OFFSITE_STATE_MISMATCH'
  | 'OFFSITE_STATE_EXPIRED'
  | 'OFFSITE_NO_SESSION'
  | 'OFFSITE_GOOGLE_REFUSED'
  | 'OFFSITE_GOOGLE_DENIED'
  | 'OFFSITE_SCOPE'
  | 'OFFSITE_CONFIRM_MISMATCH'
  | 'OFFSITE_CONFIRM_EXPIRED'
  | 'OFFSITE_NEW_FOLDER_UNCONFIRMED'
  | 'OFFSITE_BAD_KEYS'
  | 'OFFSITE_FOLDER'
  | 'OFFSITE_STORE_UNAVAILABLE';

export class OffsiteError extends Error {
  override readonly name = 'OffsiteError';
  constructor(
    readonly code: OffsiteErrorCode,
    message: string,
    readonly status = 409,
  ) {
    super(redactSecrets(message));
  }
}

export interface OffsiteServiceOptions {
  readonly db: Db;
  readonly secrets: SecretStore;
  /** BRIDGE_PUBLIC_URL: the redirect URI is `<publicUrl>/admin/drive/callback`; its host names the default folder. */
  readonly publicUrl: string;
  /** Where the runner's request files go (`<data dir>/offsite/requests`). */
  readonly requestDir: string;
  readonly google?: GoogleOAuthOptions;
  readonly now?: () => number;
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
}

interface PendingConnect {
  readonly sessionHash: string;
  readonly verifier: string;
  readonly expiresAt: number;
}

interface PendingKeys {
  readonly sessionHash: string;
  readonly password: string;
  readonly salt: string;
  readonly expiresAt: number;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export type OverallState = 'not_set_up' | 'ok' | 'warning' | 'bad';

export class OffsiteService {
  readonly store: OffsiteDb;
  readonly google: GoogleOAuth;
  readonly redirectUri: string;
  readonly serverName: string;
  private readonly now: () => number;
  /** Pending authorisations, by SHA-256 of their state. In memory: a restart simply asks the owner to click again. */
  private readonly connects = new Map<string, PendingConnect>();
  private readonly keys = new Map<string, PendingKeys>();

  constructor(readonly o: OffsiteServiceOptions) {
    this.now = o.now ?? Date.now;
    this.store = new OffsiteDb(o.db, this.now);
    this.google = new GoogleOAuth({ ...o.google, now: this.now });
    this.redirectUri = `${o.publicUrl.replace(/\/+$/, '')}${CALLBACK_PATH}`;
    this.serverName = serverNameOf(o.publicUrl, hostname());
  }

  settings(): { settings: OffsiteSettings; problems: string[] } {
    return this.store.settings(this.serverName);
  }

  // ============================================================================================ the client

  hasClient(): boolean {
    return (
      this.o.secrets.has(OFFSITE_SCOPE, 'drive_client_id') &&
      this.o.secrets.has(OFFSITE_SCOPE, 'drive_client_secret')
    );
  }

  clientId(): string | null {
    const r = this.o.secrets.read(OFFSITE_SCOPE, 'drive_client_id');
    return r.ok ? r.value : null;
  }

  /**
   * Stores the Google OAuth client. A different client than the one connected invalidates the connection (a refresh
   * token belongs to its client): the old token is revoked and deleted, and the owner connects again.
   */
  async saveClient(clientId: string, clientSecret: string): Promise<{ disconnected: boolean }> {
    this.requireStore();
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!/^[\w.-]{8,200}\.apps\.googleusercontent\.com$/.test(id)) {
      throw new OffsiteError(
        'OFFSITE_NO_CLIENT',
        'That is not a Google OAuth client ID (it ends in .apps.googleusercontent.com).',
        400,
      );
    }
    if (secret.length < 8 || secret.length > 200 || /\s/.test(secret)) {
      throw new OffsiteError('OFFSITE_NO_CLIENT', 'That is not a Google OAuth client secret.', 400);
    }
    const previous = this.clientId();
    let disconnected = false;
    if (previous !== null && previous !== id && this.o.secrets.has(OFFSITE_SCOPE, 'drive_refresh_token')) {
      await this.disconnect();
      disconnected = true;
    }
    this.o.secrets.write(OFFSITE_SCOPE, 'drive_client_id', id, { source: 'dashboard' });
    this.o.secrets.write(OFFSITE_SCOPE, 'drive_client_secret', secret, {
      source: 'dashboard',
      hint: secret.slice(-4),
    });
    this.store.setClientSaved(this.now());
    return { disconnected };
  }

  private client(): { clientId: string; clientSecret: string } {
    const id = this.o.secrets.read(OFFSITE_SCOPE, 'drive_client_id');
    const secret = this.o.secrets.read(OFFSITE_SCOPE, 'drive_client_secret');
    if (!id.ok || !secret.ok) {
      throw new OffsiteError(
        'OFFSITE_NO_CLIENT',
        id.ok || id.reason === 'not_stored'
          ? 'Paste the Google client ID and secret first (docs/drive-setup.md).'
          : `The saved Google client cannot be read: ${id.message}`,
      );
    }
    return { clientId: id.value, clientSecret: secret.value };
  }

  // ============================================================================================ connecting

  /** Starts Google's sign-in for this session. Returns the URL to send the browser to. */
  beginConnect(sessionHash: string): { url: string; redirectUri: string } {
    this.requireStore();
    const client = this.client();
    this.sweep();
    const state = randomState();
    const { verifier, challenge } = pkcePair();
    this.connects.set(sha(state), { sessionHash, verifier, expiresAt: this.now() + CONNECT_TTL_MS });
    const st = this.store.state();
    return {
      url: this.google.authorizeUrl({
        clientId: client.clientId,
        redirectUri: this.redirectUri,
        state,
        challenge,
        ...(st.accountEmail ? { loginHint: st.accountEmail } : {}),
      }),
      redirectUri: this.redirectUri,
    };
  }

  /**
   * Google's answer at the callback. Refused unless `state` names a pending sign-in of THIS session that has not
   * expired (each state works once). Swaps the code (with the PKCE verifier) for tokens, checks the scope, stores the
   * refresh token, and asks Drive who the account is.
   */
  async completeConnect(p: {
    sessionHash: string | null;
    state: string | undefined;
    code: string | undefined;
    error: string | undefined;
  }): Promise<{ email: string | null; name: string | null }> {
    if (!p.sessionHash) {
      throw new OffsiteError(
        'OFFSITE_NO_SESSION',
        'You are not signed in to the dashboard in this browser. Sign in, then connect again.',
        401,
      );
    }
    const key = p.state ? sha(p.state) : '';
    const pending = key ? this.connects.get(key) : undefined;
    if (!pending || pending.sessionHash !== p.sessionHash) {
      throw new OffsiteError(
        'OFFSITE_STATE_MISMATCH',
        'This answer from Google does not belong to a sign-in started from this dashboard session. Nothing was changed; connect again.',
        400,
      );
    }
    this.connects.delete(key); // used once, whatever happens next
    if (pending.expiresAt < this.now()) {
      throw new OffsiteError(
        'OFFSITE_STATE_EXPIRED',
        'The sign-in took too long (over 10 minutes). Connect again.',
        400,
      );
    }
    if (p.error) {
      throw new OffsiteError(
        'OFFSITE_GOOGLE_DENIED',
        p.error === 'access_denied'
          ? 'Access was not allowed at Google. Nothing was changed.'
          : `Google answered "${p.error.slice(0, 60)}". Nothing was changed.`,
        400,
      );
    }
    if (!p.code) throw new OffsiteError('OFFSITE_GOOGLE_DENIED', 'Google sent no code. Connect again.', 400);
    const client = this.client();
    let tokens;
    try {
      tokens = await this.google.exchange(client, {
        code: p.code,
        verifier: pending.verifier,
        redirectUri: this.redirectUri,
      });
    } catch (e) {
      throw new OffsiteError(
        'OFFSITE_GOOGLE_REFUSED',
        e instanceof GoogleError ? reconnectReason(e) : 'Google could not be reached.',
        502,
      );
    }
    if (!tokens.scope.split(/\s+/).includes('https://www.googleapis.com/auth/drive.file')) {
      await this.google.revoke(tokens.refreshToken ?? tokens.accessToken);
      throw new OffsiteError(
        'OFFSITE_SCOPE',
        'Google did not grant the drive.file permission (it must be ticked on the consent page). Nothing was kept; connect again.',
        400,
      );
    }
    let account: { email: string | null; name: string | null } = { email: null, name: null };
    try {
      account = await this.google.account(tokens.accessToken);
    } catch (e) {
      this.o.log?.warn({ code: (e as GoogleError).code }, 'the connected Google account could not be named');
    }
    // A previous grant (reconnecting) is replaced; revoke the old token so it cannot linger.
    const old = this.o.secrets.read(OFFSITE_SCOPE, 'drive_refresh_token');
    this.o.secrets.write(OFFSITE_SCOPE, 'drive_refresh_token', tokens.refreshToken!, { source: 'dashboard' });
    if (old.ok && old.value !== tokens.refreshToken) await this.google.revoke(old.value);
    this.store.setConnected(account);
    return account;
  }

  /** Revokes the token at Google and deletes it here. The client and keys stay (the owner may connect again). */
  async disconnect(): Promise<{ revoked: boolean; message: string | null }> {
    const t = this.o.secrets.read(OFFSITE_SCOPE, 'drive_refresh_token');
    let revoked = false;
    let message: string | null = null;
    if (t.ok) {
      const r = await this.google.revoke(t.value);
      revoked = r.ok;
      message = r.ok
        ? null
        : `${r.message ?? 'Google did not confirm.'} The token was deleted here; to be sure, remove the app in your Google account (Security → your connections to third-party apps).`;
    }
    this.o.secrets.remove(OFFSITE_SCOPE, 'drive_refresh_token');
    this.store.setDisconnected();
    return { revoked, message };
  }

  /** "Check the connection": one refresh now. A refusal turns the card red. */
  async checkConnection(): Promise<{ ok: boolean; message: string | null }> {
    const client = this.client();
    const t = this.o.secrets.read(OFFSITE_SCOPE, 'drive_refresh_token');
    if (!t.ok) throw new OffsiteError('OFFSITE_NOT_CONNECTED', 'Google Drive is not connected.');
    try {
      const tokens = await this.google.refresh(client, t.value);
      if (tokens.refreshToken && tokens.refreshToken !== t.value)
        this.o.secrets.write(OFFSITE_SCOPE, 'drive_refresh_token', tokens.refreshToken, {
          source: 'dashboard',
        });
      this.store.setTokenOk();
      return { ok: true, message: null };
    } catch (e) {
      if (e instanceof GoogleError && e.needsReconnect) {
        this.store.setBroken(reconnectReason(e));
        return { ok: false, message: reconnectReason(e) };
      }
      return { ok: false, message: e instanceof Error ? redactSecrets(e.message) : 'unknown error' };
    }
  }

  // ============================================================================================ keys

  /** Whether setting keys (or the folder) now starts a new Drive folder: the current one already holds a copy. */
  wouldStartNewFolder(): boolean {
    const cur = this.store.currentFolder(this.settings().settings.folder);
    return cur.firstCopyAt !== null || cur.adoptedAt !== null;
  }

  /** Generates a strong password and salt, held (not saved) until the owner confirms them. Shown once. */
  generateKeys(sessionHash: string): {
    confirmId: string;
    password: string;
    salt: string;
    confirmChars: number;
    newFolder: boolean;
    shownOnce: true;
  } {
    this.requireStore();
    this.sweep();
    const password = randomBytes(32).toString('base64url');
    const salt = randomBytes(32).toString('base64url');
    const confirmId = randomBytes(16).toString('hex');
    this.keys.set(confirmId, { sessionHash, password, salt, expiresAt: this.now() + KEYS_TTL_MS });
    return {
      confirmId,
      password,
      salt,
      confirmChars: CONFIRM_CHARS,
      newFolder: this.wouldStartNewFolder(),
      shownOnce: true,
    };
  }

  /** Saves generated keys once the owner typed back the last characters of both. */
  confirmGeneratedKeys(
    sessionHash: string,
    p: {
      confirmId: string;
      passwordEnd: string;
      saltEnd: string;
      acknowledgeNewFolder?: boolean | undefined;
    },
  ): { newFolder: FolderRow | null } {
    const k = this.keys.get(p.confirmId);
    if (!k || k.sessionHash !== sessionHash || k.expiresAt < this.now()) {
      if (k) this.keys.delete(p.confirmId);
      throw new OffsiteError(
        'OFFSITE_CONFIRM_EXPIRED',
        'These keys are no longer waiting: generate new ones.',
        400,
      );
    }
    const okPw = p.passwordEnd.trim() === k.password.slice(-CONFIRM_CHARS);
    const okSalt = p.saltEnd.trim() === k.salt.slice(-CONFIRM_CHARS);
    if (!okPw || !okSalt) {
      throw new OffsiteError(
        'OFFSITE_CONFIRM_MISMATCH',
        `The last ${CONFIRM_CHARS} characters of the ${!okPw ? 'password' : 'salt'} do not match. Check what you saved, then try again; nothing was saved.`,
        400,
      );
    }
    const r = this.saveKeys(k.password, k.salt, 'generated', p.acknowledgeNewFolder === true);
    this.keys.delete(p.confirmId);
    return r;
  }

  /** The owner's own password and salt. */
  setOwnKeys(p: { password: string; salt: string; acknowledgeNewFolder?: boolean | undefined }): {
    newFolder: FolderRow | null;
  } {
    this.requireStore();
    if (p.password.length < MIN_OWN_KEY_LENGTH || p.salt.length < MIN_OWN_KEY_LENGTH) {
      throw new OffsiteError(
        'OFFSITE_BAD_KEYS',
        `The password and the salt must each be at least ${MIN_OWN_KEY_LENGTH} characters (use a password manager’s generator).`,
        400,
      );
    }
    if (p.password === p.salt)
      throw new OffsiteError('OFFSITE_BAD_KEYS', 'The password and the salt must differ.', 400);
    if (p.password.length > 1024 || p.salt.length > 1024 || /[\r\n]/.test(p.password + p.salt)) {
      throw new OffsiteError(
        'OFFSITE_BAD_KEYS',
        'The keys must be on one line and at most 1,024 characters.',
        400,
      );
    }
    return this.saveKeys(p.password, p.salt, 'entered', p.acknowledgeNewFolder === true);
  }

  private saveKeys(
    password: string,
    salt: string,
    source: 'generated' | 'entered',
    acknowledged: boolean,
  ): { newFolder: FolderRow | null } {
    const hadKeys = this.o.secrets.has(OFFSITE_SCOPE, 'drive_crypt_password');
    const fresh = this.wouldStartNewFolder();
    if (hadKeys && fresh && !acknowledged) {
      throw new OffsiteError(
        'OFFSITE_NEW_FOLDER_UNCONFIRMED',
        'A copy already exists with the current keys. New keys mean a fresh full upload into a new Drive folder; the old folder is kept until you delete it. Confirm that to go on.',
      );
    }
    let newFolder: FolderRow | null = null;
    this.o.db.transaction(() => {
      if (hadKeys && fresh) {
        const r = this.store.newGenerationIfCopied(
          this.settings().settings.folder,
          'the encryption keys changed',
        );
        if (r.started) newFolder = r.folder;
      }
      this.o.secrets.write(OFFSITE_SCOPE, 'drive_crypt_password', password, { source: 'dashboard' });
      this.o.secrets.write(OFFSITE_SCOPE, 'drive_crypt_salt', salt, { source: 'dashboard' });
      this.store.setKeys(source);
    })();
    return { newFolder };
  }

  // ============================================================================================ settings

  updateSettings(
    input: Partial<OffsiteSettingsInput>,
    acknowledgeNewFolder = false,
  ): {
    settings: OffsiteSettings;
    newFolder: FolderRow | null;
  } {
    const current = this.settings().settings;
    const merged = offsiteSettingsSchema.safeParse({ ...current, ...input });
    if (!merged.success) {
      throw new OffsiteError(
        'OFFSITE_FOLDER',
        merged.error.issues.map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; '),
        400,
      );
    }
    const next = { ...merged.data, folder: merged.data.folder ?? current.folder };
    const folderChanged = next.folder !== current.folder;
    if (folderChanged && this.wouldStartNewFolder() && !acknowledgeNewFolder) {
      throw new OffsiteError(
        'OFFSITE_NEW_FOLDER_UNCONFIRMED',
        'A copy already exists in the current folder. A new folder means a fresh full upload; the old folder is kept until you delete it. Confirm that to go on.',
      );
    }
    let newFolder: FolderRow | null = null;
    this.o.db.transaction(() => {
      this.store.saveSettingsJson(JSON.stringify(next));
      if (folderChanged) {
        const r = this.store.newGenerationIfCopied(next.folder, 'the folder setting changed');
        if (r.started) newFolder = r.folder;
      }
    })();
    return { settings: this.settings().settings, newFolder };
  }

  // ============================================================================================ requests

  configured(): { ready: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!this.hasClient()) missing.push('the Google client');
    if (!this.o.secrets.has(OFFSITE_SCOPE, 'drive_refresh_token'))
      missing.push('the Google Drive connection');
    if (
      !this.o.secrets.has(OFFSITE_SCOPE, 'drive_crypt_password') ||
      !this.o.secrets.has(OFFSITE_SCOPE, 'drive_crypt_salt')
    )
      missing.push('the encryption keys');
    return { ready: missing.length === 0, missing };
  }

  async request(
    kind: OffsiteRequest['kind'],
    o: { trigger?: OffsiteRequest['trigger']; generation?: number } = {},
  ): Promise<string> {
    if (kind !== 'delete_folder') {
      const c = this.configured();
      if (!c.ready) {
        throw new OffsiteError(
          c.missing.includes('the Google Drive connection') ? 'OFFSITE_NOT_CONNECTED' : 'OFFSITE_NO_KEYS',
          `Set up ${c.missing.join(' and ')} first.`,
        );
      }
    }
    return writeRequest(this.o.requestDir, {
      kind,
      trigger: o.trigger ?? 'request',
      ...(o.generation !== undefined ? { generation: o.generation } : {}),
      at: this.now(),
    });
  }

  /** After a weekly full snapshot: a copy, if the off-site copy is set up (quietly nothing otherwise). */
  async afterFullSnapshot(): Promise<void> {
    if (!this.configured().ready) return;
    await this.request('copy', { trigger: 'after_full' });
  }

  async deleteFolder(generation: number): Promise<void> {
    const f = this.store.folder(generation);
    if (!f) throw new OffsiteError('OFFSITE_FOLDER', `There is no folder generation ${generation}.`, 404);
    if (f.generation === this.store.state().generation) {
      throw new OffsiteError(
        'OFFSITE_FOLDER',
        'The current folder cannot be deleted; only an old, retired one can.',
      );
    }
    if (f.deletedAt !== null) throw new OffsiteError('OFFSITE_FOLDER', 'That folder was already deleted.');
    this.store.requestDelete(generation);
    await this.request('delete_folder', { generation });
  }

  /** Lets copies go into a current folder that already holds a copy this database did not make (after a recovery). */
  adoptFolder(): FolderRow {
    const f = this.store.currentFolder(this.settings().settings.folder);
    this.store.markAdopted(f.generation);
    return this.store.folder(f.generation)!;
  }

  // ============================================================================================ status

  /** The Overview's view: one state and the messages behind it. */
  health(): { state: OverallState; messages: string[] } {
    const st = this.store.state();
    const { settings } = this.settings();
    const c = this.configured();
    const messages: string[] = [];
    let state: OverallState = 'ok';
    const worse = (s: OverallState) => {
      const rank = { not_set_up: 0, ok: 1, warning: 2, bad: 3 } as const;
      if (rank[s] > rank[state]) state = s;
    };
    if (st.connection === 'broken') {
      worse('bad');
      messages.push(`Off-site copy: Google Drive needs reconnecting. ${st.brokenReason ?? ''}`.trim());
    }
    if (!c.ready && st.connection !== 'broken') {
      if (st.clientSavedAt === null && st.keysSetAt === null && st.connection === 'none') {
        return {
          state: 'not_set_up',
          messages: ['The off-site copy to Google Drive is not set up yet (docs/drive-setup.md).'],
        };
      }
      worse('warning');
      messages.push(`Off-site copy: not complete; set up ${c.missing.join(' and ')}.`);
    }
    const folder = this.store.folder(st.generation);
    const lastGood = folder?.lastGoodCopyAt ?? null;
    const staleMs = settings.staleAfterDays * 86_400_000;
    if (c.ready) {
      const since = lastGood ?? st.keysSetAt ?? st.connectedAt ?? this.now();
      if (this.now() - since > staleMs) {
        worse('bad');
        messages.push(
          lastGood === null
            ? `Off-site copy: no good copy on Drive yet, ${Math.floor((this.now() - since) / 86_400_000)} days after it was set up.`
            : `Off-site copy: the last good copy is ${Math.floor((this.now() - lastGood) / 3_600_000)} hours old (more than ${settings.staleAfterDays} days).`,
        );
      }
    }
    const lastCopy = this.store.lastRun('copy', {
      states: ['succeeded', 'failed', 'interrupted', 'refused'],
    });
    if (lastCopy && lastCopy.state !== 'succeeded') {
      worse('warning');
      messages.push(
        `Off-site copy: the last copy ${lastCopy.state === 'refused' ? 'was refused' : lastCopy.state}: ${lastCopy.message ?? ''}`.trim(),
      );
    }
    const lastVerify = this.store.lastRun('verify', { states: ['succeeded', 'failed'] });
    if (lastVerify && lastVerify.state === 'failed') {
      worse('bad');
      messages.push(`Off-site copy: the last verify found problems: ${lastVerify.message ?? ''}`.trim());
    }
    return { state, messages };
  }

  async status(): Promise<Record<string, unknown>> {
    const st = this.store.state();
    const { settings, problems } = this.settings();
    const folder = this.store.currentFolder(settings.folder);
    const runs = this.store.runs({ limit: 30 });
    const lastCopy = this.store.lastRun('copy', {
      states: ['succeeded', 'failed', 'interrupted', 'refused'],
    });
    const lastGoodCopy = this.store.lastRun('copy', { states: ['succeeded'] });
    const verifies = this.store.runs({ kind: 'verify', limit: 12 });
    const lastVerify = verifies.find((r) => r.state !== 'running') ?? null;
    // The runner's own rule (runner.ts, tick): any copy started since the latest daily time counts.
    const lastScheduled = this.store.lastRun('copy');
    const nextCopyAt = isDue(latestDailySlot(this.now(), settings.copyTime), lastScheduled?.startedAt)
      ? this.now()
      : nextDailyRun(this.now(), settings.copyTime);
    const pwMeta = this.o.secrets.meta(OFFSITE_SCOPE, 'drive_crypt_password');
    const clientId = this.clientId();
    const view = (r: RunRow | null | undefined) =>
      r ? { ...r, findings: r.kind === 'verify' ? this.store.findingCount(r.id) : undefined } : null;
    return {
      redirectUri: this.redirectUri,
      setupDoc: 'docs/drive-setup.md',
      client: {
        saved: this.hasClient(),
        clientId,
        secretHint: this.o.secrets.meta(OFFSITE_SCOPE, 'drive_client_secret')?.hint ?? null,
        savedAt: st.clientSavedAt,
      },
      connection: {
        state: st.connection,
        account: st.accountEmail || st.accountName ? { email: st.accountEmail, name: st.accountName } : null,
        connectedAt: st.connectedAt,
        brokenAt: st.brokenAt,
        brokenReason: st.brokenReason,
        tokenCheckedAt: st.tokenCheckedAt,
      },
      keys: {
        set: pwMeta !== undefined && this.o.secrets.has(OFFSITE_SCOPE, 'drive_crypt_salt'),
        setAt: st.keysSetAt,
        source: st.keysSource,
        newFolderOnChange: this.wouldStartNewFolder(),
      },
      settings,
      settingsProblems: problems,
      folder,
      folders: this.store.folders(),
      configured: this.configured(),
      health: this.health(),
      running: view(this.store.running()),
      lastCopy: view(lastCopy),
      lastGoodCopy: view(lastGoodCopy),
      nextCopyAt,
      nextCopyWithinMs: TIMER_TICK_MS,
      verify: {
        last: view(lastVerify),
        lastFindings: lastVerify ? this.store.findings(lastVerify.id, 100) : [],
        history: verifies.map(view),
        nextAt: settings.verifyEnabled
          ? nextMonthlySlot(this.now(), settings.verifyDay, settings.verifyTime)
          : null,
      },
      runs: runs.map(view),
      pending: await pendingRequests(this.o.requestDir),
      now: this.now(),
    };
  }

  // ============================================================================================ internals

  private requireStore(): void {
    if (!this.o.secrets.available) {
      throw new OffsiteError(
        'OFFSITE_STORE_UNAVAILABLE',
        'The encrypted secret store is not available (SECRETS_MASTER_KEY): nothing can be saved.',
        503,
      );
    }
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.connects) if (v.expiresAt < t - CONNECT_TTL_MS) this.connects.delete(k);
    for (const [k, v] of this.keys) if (v.expiresAt < t) this.keys.delete(k);
  }
}
