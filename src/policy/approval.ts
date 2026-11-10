/**
 * The internal approval token (docs/policy.md, "Approval cannot loop").
 *
 * The engine puts EVERY entry to the policy gate, so a proposer at scope `propose` would get `propose` again when the
 * owner's approved work is submitted on its behalf. The proposal service therefore attaches an `ApprovalToken` to the
 * origin of that one submission. The gate allows an operation only when the token:
 * - was minted by this module (identity is checked against a private set, so JSON look-alikes are worthless),
 * - has not been consumed or expired,
 * - is bound to the proposal whose ops are being submitted (same proposal id, same principal, same op ids and
 *   params hashes, in the same order), and to the proposal's project (v2 A1): it covers nothing in another project.
 *
 * `issueApprovalToken` is deliberately NOT exported from `src/policy/index.ts`: only the proposal service's
 * `approve`, which only the owner command layer calls, mints one. Nothing an agent can reach can create or read one,
 * and a token serialises to `{ proposalId }` only (it is stored with the job's origin).
 */
import { createHash } from 'node:crypto';

/** Canonical JSON (sorted keys), so a params hash does not depend on key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function hashJson(v: unknown): string {
  return createHash('sha256').update(canonicalJson(v)).digest('hex');
}

export interface ExpectedOp {
  readonly op: string;
  readonly paramsHash: string;
}

const live = new WeakSet<ApprovalToken>();
const TOKEN_TTL_MS = 120_000;

export class ApprovalToken {
  readonly #expected: readonly ExpectedOp[];
  readonly #principalId: string;
  readonly #projectId: string;
  readonly #expiresAt: number;
  readonly #canonical: boolean;

  private constructor(
    readonly proposalId: string,
    principalId: string,
    projectId: string,
    expected: readonly ExpectedOp[],
    expiresAt: number,
    canonical: boolean,
  ) {
    this.#expected = expected;
    this.#principalId = principalId;
    this.#projectId = projectId;
    this.#expiresAt = expiresAt;
    this.#canonical = canonical;
  }

  /** @internal Use `issueApprovalToken`. */
  static mint(
    proposalId: string,
    principalId: string,
    projectId: string,
    expected: readonly ExpectedOp[],
    now: number,
    canonical = false,
  ) {
    const t = new ApprovalToken(
      proposalId,
      principalId,
      projectId,
      Object.freeze([...expected]),
      now + TOKEN_TTL_MS,
      canonical,
    );
    live.add(t);
    return t;
  }

  /**
   * Is this a live token for `principalId` in `projectId`, and is `op` with `params` step `index` of the approved
   * proposal?
   */
  covers(
    principalId: string,
    projectId: string,
    index: number,
    op: string,
    params: unknown,
    now: number,
  ): boolean {
    if (!live.has(this) || now > this.#expiresAt || principalId !== this.#principalId) return false;
    if (projectId !== this.#projectId) return false;
    const want = this.#expected[index];
    return want !== undefined && want.op === op && want.paramsHash === hashJson(params);
  }

  get stepCount(): number {
    return this.#expected.length;
  }

  /**
   * v2 C2a (ADR 0032): the owner approved this proposal with "Approve and accept as canon". Only such a token lets the
   * work make a protected canonical change (src/facts/canonical.ts).
   */
  get canonical(): boolean {
    return this.#canonical;
  }

  /** Spent: the approved submission has been made (or abandoned). */
  consume(): void {
    live.delete(this);
  }

  /** Only the proposal id reaches the jobs table. */
  toJSON(): { proposalId: string } {
    return { proposalId: this.proposalId };
  }
}

/**
 * Mints a token for one proposal. Called only by `ProposalService.approve` and `approveAsCanon` (owner command layer);
 * `canonical` only by the latter.
 */
export function issueApprovalToken(
  proposalId: string,
  principalId: string,
  projectId: string,
  expected: readonly ExpectedOp[],
  now: number,
  canonical = false,
): ApprovalToken {
  return ApprovalToken.mint(proposalId, principalId, projectId, expected, now, canonical);
}

/** v2 C2a: true only for a live token minted by "Approve and accept as canon". */
export function isCanonicalApproval(v: unknown): boolean {
  return isLiveApprovalToken(v) && v.canonical;
}

/** True only for a token this module minted and that has not been consumed. */
export function isLiveApprovalToken(v: unknown): v is ApprovalToken {
  return v instanceof ApprovalToken && live.has(v);
}
