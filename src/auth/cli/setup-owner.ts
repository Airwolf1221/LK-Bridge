import { pathToFileURL } from 'node:url';
import { hashPassword } from '../password.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../totp.js';

/**
 * `npm run setup:owner`: prompts for the owner password (hidden), optionally enrols TOTP, and
 * prints the environment lines to paste into /etc/lk-bridge/lk-bridge.env. It writes nothing to
 * disk and never prints the password.
 *
 * Flags: `--username <name>`, `--totp` / `--no-totp` (skip the question), `--stdin` (read the
 * password from the first line of standard input, for automation; no confirmation, no TOTP check).
 */

export const MIN_PASSWORD_LENGTH = 12;

function readHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      reject(
        new Error('No terminal: run interactively, or pass --stdin to read the password from standard input'),
      );
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function readLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d: string) => {
      process.stdin.pause();
      resolve(d.split(/\r?\n/)[0] ?? '');
    });
  });
}

async function readStdinLine(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    data += chunk as string;
    if (data.includes('\n')) break;
  }
  return data.split(/\r?\n/)[0] ?? '';
}

/** Single-quoted for systemd EnvironmentFile and Node --env-file: `$` in the hash stays literal. */
const envLine = (name: string, value: string) => `${name}='${value}'`;

export async function setupOwner(argv: readonly string[]): Promise<string> {
  const flag = (name: string) => argv.includes(name);
  const userIdx = argv.indexOf('--username');
  const username = userIdx >= 0 ? (argv[userIdx + 1] ?? '') : 'owner';
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username))
    throw new Error('Username must be 1-64 of A-Z a-z 0-9 . _ @ -');

  let password: string;
  if (flag('--stdin')) {
    password = await readStdinLine();
  } else {
    password = await readHidden('Owner password: ');
    const again = await readHidden('Repeat password: ');
    if (again !== password) throw new Error('The passwords do not match');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters (a passphrase is best)`);
  }

  let totp = flag('--totp');
  if (!flag('--totp') && !flag('--no-totp') && !flag('--stdin')) {
    totp = /^y/i.test(await readLine('Enable an authenticator app (TOTP) for sign-in? [y/N] '));
  }

  const hash = await hashPassword(password);
  const lines = [envLine('OWNER_USERNAME', username), envLine('OWNER_PASSWORD_HASH', hash)];

  if (totp) {
    const secret = generateTotpSecret();
    process.stdout.write(
      `\nAdd this account to your authenticator app:\n  ${otpauthUri(secret, username)}\n` +
        `or enter the key manually: ${secret}\n`,
    );
    if (!flag('--stdin')) {
      for (let attempt = 0; ; attempt++) {
        const code = (await readLine('Enter the 6-digit code it shows now, to confirm: ')).replace(
          /\s+/g,
          '',
        );
        if (verifyTotp(secret, code, Math.floor(Date.now() / 1000)) !== undefined) break;
        if (attempt >= 2) throw new Error('The code did not match. Run setup:owner again.');
        process.stdout.write('That code did not match; check the time on this server and your phone.\n');
      }
    }
    lines.push(envLine('OWNER_TOTP_SECRET', secret));
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  try {
    const lines = await setupOwner(process.argv.slice(2));
    process.stdout.write(
      '\nAdd these lines to /etc/lk-bridge/lk-bridge.env (keep the single quotes), then restart LK-Bridge.\n' +
        'Nothing has been saved anywhere else.\n\n' +
        `${lines}\n`,
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(`setup:owner: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
