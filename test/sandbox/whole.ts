/**
 * CR-2026-11-R4 (the owner's request S): a failing step of a sandbox check reports what was answered WHOLE, never a
 * slice of it. These two helpers say it in full: an error with its JSON (LegendKeeper's status, code, issues and
 * request id, or the engine's job and step), and an engine run that did not succeed with everything it returned (a
 * proposal's summary and reasons, a parked job's id and reason). Nothing secret is in either: the governor's errors
 * carry no request headers.
 */

/** The error's message and, when it has them, its JSON form or its own fields (a code, the details it carries). */
export function wholeError(e: unknown): string {
  if (!(e instanceof Error)) return JSON.stringify(e) ?? String(e);
  const toJSON = (e as { toJSON?: () => unknown }).toJSON;
  if (typeof toJSON === 'function') return `${e.message} ${JSON.stringify(toJSON.call(e))}`;
  const own = Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'stack' && k !== 'message'));
  return Object.keys(own).length > 0 ? `${e.message} ${JSON.stringify({ name: e.name, ...own })}` : e.message;
}

/** An engine run of `op` that did not succeed, with everything it returned. */
export function notSucceeded(op: string, r: { readonly status: string }): Error {
  return new Error(`${op}: ${r.status} ${JSON.stringify(r)}`);
}
