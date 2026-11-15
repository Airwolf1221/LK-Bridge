/**
 * Which assistant a connection belongs to (v2 E3, ADR 0045; ADR 0008, ChatGPT as a client).
 *
 * The evaluation records only the calls of the assistant being tested, so each connection (an OAuth grant or a personal
 * access token) is classified as ChatGPT, Claude, or neither. The signals, strongest first; the first one that names
 * exactly one assistant decides:
 *
 * 1. **Redirect host** (OAuth grants). The bridge accepts only a few hosted callbacks (src/auth/redirect-uris.ts): the
 *    registered redirect URIs of a ChatGPT connector are on `chatgpt.com` (or `openai.com`), a Claude connector's on
 *    `claude.ai` or `claude.com` (or `anthropic.com`). This is the signal the client cannot choose freely.
 * 2. **OAuth client name** (self-reported, so weaker): contains "chatgpt" or "openai", or "claude" or "anthropic".
 * 3. **The connection's own name** (a PAT's name; for a grant its client name again) with the same words.
 * 4. **The profile's label**, with the same words ("ChatGPT", "Claude").
 *
 * A signal that matches both assistants is ignored (it decides nothing). When no signal decides, the connection is
 * unclassified (`null`): the owner picks the connection by hand in the panel, which always overrides the classifier. A
 * Claude Code or Claude Desktop connection counts as Claude, as it should for "calls from Claude".
 *
 * Pure: no database, no clock.
 */
import type { Assistant } from './scenarios.js';

export interface ConnectionFacts {
  readonly type: 'grant' | 'pat';
  /** The OAuth client name, or a PAT's name. */
  readonly label: string;
  /** The OAuth client's registered redirect URIs (grants). */
  readonly redirectUris: readonly string[];
  readonly profileLabel: string | null;
}

export interface Classification {
  readonly assistant: Assistant | null;
  /** Which signal decided, in words for the panel ("redirect host chatgpt.com"); "no signal" when none did. */
  readonly reason: string;
}

const CHATGPT_HOST = /(^|\.)(chatgpt\.com|openai\.com)$/i;
const CLAUDE_HOST = /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/i;
const CHATGPT_WORDS = /chatgpt|openai/i;
const CLAUDE_WORDS = /claude|anthropic/i;

function hostOf(uri: string): string | null {
  try {
    return new URL(uri).hostname;
  } catch {
    return null;
  }
}

/** The one assistant a text names, or null (nothing, or both). */
function byWords(text: string | null): Assistant | null {
  if (!text) return null;
  const g = CHATGPT_WORDS.test(text);
  const c = CLAUDE_WORDS.test(text);
  return g === c ? null : g ? 'chatgpt' : 'claude';
}

export function classifyConnection(c: ConnectionFacts): Classification {
  const chatgptHosts = new Set<string>();
  const claudeHosts = new Set<string>();
  for (const u of c.redirectUris) {
    const h = hostOf(u);
    if (!h) continue;
    if (CHATGPT_HOST.test(h)) chatgptHosts.add(h);
    if (CLAUDE_HOST.test(h)) claudeHosts.add(h);
  }
  if (chatgptHosts.size > 0 && claudeHosts.size === 0)
    return { assistant: 'chatgpt', reason: `redirect host ${[...chatgptHosts][0]!}` };
  if (claudeHosts.size > 0 && chatgptHosts.size === 0)
    return { assistant: 'claude', reason: `redirect host ${[...claudeHosts][0]!}` };
  const signals: [string | null, string][] = [
    [c.type === 'grant' ? c.label : null, 'client name'],
    [c.type === 'pat' ? c.label : null, 'token name'],
    [c.profileLabel, 'profile name'],
  ];
  for (const [text, what] of signals) {
    const a = byWords(text);
    if (a) return { assistant: a, reason: `${what} “${(text ?? '').slice(0, 60)}”` };
  }
  return { assistant: null, reason: 'no signal' };
}
