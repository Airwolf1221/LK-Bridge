/**
 * R4.1 (the owner's run of 21 November 2026: consistency-f4b hung for its whole 30-minute timeout with no output, and
 * left its probe pages on the test world because its clean-up never ran). Every sandbox check runs through one of these:
 *
 * - **each step prints a line as it starts and as it finishes** (done, failed or timed out, with how long it took), so
 *   a run that stops shows where;
 * - **each step has its own timeout, which names the step** (`StepTimeoutError`): a step that never resolves fails
 *   with its id and title, and the check goes on to its clean-up, rather than the whole test timing out silently;
 * - **the clean-up is a registry** (`defer`): each action runs once, newest first, each with its own timeout and its own
 *   start and finish lines. The check's own `finally` runs it as before (so its report still says what was cleaned), and
 *   the test file runs it again in an `afterAll` with its own timeout (`SandboxRun.hookTimeoutMs`): an action not yet run
 *   (the test itself timed out, or a hang outside any step) runs there, one already run is not run twice.
 *
 * A step that times out keeps running in the background (a promise cannot be stopped); the clean-up deletes by id what
 * the check recorded as made, so what such a step makes afterwards is named in the report only if it was recorded.
 */

/** A step's default timeout: the longest any one step of the checks needs (a step that needs more says so). */
export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;
/** Each clean-up action's own timeout. */
export const CLEANUP_ACTION_TIMEOUT_MS = 5 * 60_000;
/** The test file's `afterAll` timeout (`SandboxRun.hookTimeoutMs`): beyond the clean-up action's own, room for the rest. */
export const CLEANUP_HOOK_MARGIN_MS = 10 * 60_000;

/** A step that did not finish within its own timeout. */
export class StepTimeoutError extends Error {
  constructor(
    readonly stepId: string,
    readonly stepTitle: string,
    readonly ms: number,
  ) {
    super(
      `step ${stepId} (${stepTitle}) did not finish within its timeout of ${seconds(ms)}: it was stopped there, and the check went on to its clean-up`,
    );
    this.name = 'StepTimeoutError';
  }
}

export interface CleanupResult {
  readonly label: string;
  readonly outcome: 'done' | 'failed' | 'timed out';
  readonly detail?: string;
}

export interface SandboxRunOptions {
  /** The check's name, at the start of every line (`consistency-f4b`). */
  readonly name: string;
  /** Where the lines go (default: standard output, one line each). */
  readonly out?: (line: string) => void;
  readonly stepTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  /**
   * Tests only: steps (by id) that never resolve, to prove the timeouts and the clean-up on the mock
   * (test/sandbox-mock/steps-timeout.test.ts). Never set by a real run.
   */
  readonly stall?: readonly string[];
  readonly now?: () => number;
}

const seconds = (ms: number) =>
  ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${(ms / 1000).toFixed(1)} s`;
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 300);

/** Races `p` against a timer; the timer is cleared either way. */
async function within<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class SandboxRun {
  /** Every line printed, in order (the mock runs read them). */
  readonly lines: string[] = [];
  private readonly actions: {
    label: string;
    fn: () => Promise<void> | void;
    ran?: Promise<CleanupResult>;
  }[] = [];
  private readonly now: () => number;
  private readonly out: (line: string) => void;

  constructor(readonly o: SandboxRunOptions) {
    this.now = o.now ?? Date.now;
    this.out = o.out ?? ((line) => process.stdout.write(`${line}\n`));
  }

  private say(line: string): void {
    const full = `[${this.o.name}] ${line}`;
    this.lines.push(full);
    this.out(full);
  }

  /**
   * Runs one step: a line as it starts, a line as it finishes, and its own timeout (`timeoutMs`, default 10 minutes),
   * after which it rejects with a `StepTimeoutError` naming it. Its result or error is passed on as it came.
   */
  async step<T>(
    id: string,
    title: string,
    fn: () => Promise<T> | T,
    o: { readonly timeoutMs?: number } = {},
  ): Promise<T> {
    const ms = o.timeoutMs ?? this.o.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    const t0 = this.now();
    this.say(`start ${id}: ${title} (timeout ${seconds(ms)})`);
    const stalled = this.o.stall?.includes(id) === true;
    try {
      const r = await within(
        stalled ? new Promise<T>(() => undefined) : Promise.resolve().then(fn),
        ms,
        () => new StepTimeoutError(id, title, ms),
      );
      this.say(`done ${id} in ${seconds(this.now() - t0)}`);
      return r;
    } catch (e) {
      this.say(
        e instanceof StepTimeoutError && e.stepId === id
          ? `timed out ${id} after ${seconds(this.now() - t0)}: ${title}`
          : `failed ${id} after ${seconds(this.now() - t0)}: ${firstLine(e)}`,
      );
      throw e;
    }
  }

  /** Registers a clean-up action (run newest first by `cleanup`, once). */
  defer(label: string, fn: () => Promise<void> | void): void {
    this.actions.push({ label, fn });
  }

  /** Each clean-up action's own timeout. */
  get cleanupTimeoutMs(): number {
    return this.o.cleanupTimeoutMs ?? CLEANUP_ACTION_TIMEOUT_MS;
  }

  /** The test file's `afterAll` timeout: the clean-up action's own, and a margin for the runtime's close. */
  get hookTimeoutMs(): number {
    return this.cleanupTimeoutMs + CLEANUP_HOOK_MARGIN_MS;
  }

  /** Whether an action is registered that has not started yet. */
  get pending(): number {
    return this.actions.filter((a) => !a.ran).length;
  }

  /**
   * Runs every registered action not yet run, newest first, each with its own timeout and lines; an action already
   * running or run is awaited, never started again. Never throws: each outcome is returned (and printed).
   */
  async cleanup(): Promise<CleanupResult[]> {
    const out: CleanupResult[] = [];
    for (const a of [...this.actions].reverse()) {
      a.ran ??= this.runAction(a.label, a.fn);
      out.push(await a.ran);
    }
    return out;
  }

  private async runAction(label: string, fn: () => Promise<void> | void): Promise<CleanupResult> {
    const ms = this.cleanupTimeoutMs;
    const t0 = this.now();
    this.say(`clean-up start: ${label} (timeout ${seconds(ms)})`);
    try {
      await within(
        Promise.resolve().then(fn),
        ms,
        () => new Error(`the clean-up “${label}” did not finish within ${seconds(ms)}`),
      );
      this.say(`clean-up done in ${seconds(this.now() - t0)}: ${label}`);
      return { label, outcome: 'done' };
    } catch (e) {
      const timedOut = /did not finish within/.test(firstLine(e));
      this.say(
        `clean-up ${timedOut ? 'timed out' : 'failed'} after ${seconds(this.now() - t0)}: ${label}: ${firstLine(e)}`,
      );
      return { label, outcome: timedOut ? 'timed out' : 'failed', detail: firstLine(e) };
    }
  }
}

export function sandboxRun(o: SandboxRunOptions): SandboxRun {
  return new SandboxRun(o);
}

/**
 * For a test file's `afterAll`: runs what is left of the clean-up, and fails (naming each action) if an action failed or
 * timed out, so a run that leaves something behind says so.
 */
export async function cleanupAfterAll(run: SandboxRun | undefined): Promise<void> {
  if (!run) return;
  const bad = (await run.cleanup()).filter((r) => r.outcome !== 'done');
  if (bad.length > 0)
    throw new Error(
      `the clean-up did not finish: ${bad.map((b) => `${b.label} (${b.outcome}${b.detail ? `: ${b.detail}` : ''})`).join('; ')}. Delete what it names by hand.`,
    );
}
