/**
 * Amendment 1 to ADR 0072: a proposal that changes words never hides them. One change of a page's words, as the owner
 * reads it: the sentence before (the replaced words struck through and highlighted) and after (the new words
 * highlighted). Used by the Proposals page (the proposal's "Words that change" and each item's diff) and the Review
 * page's card.
 */
import type { TextChange, TextSpan } from './types';

/** A sentence with one span marked: `<del>` in the text before, `<ins>` in the text after. */
export function MarkedText({
  text,
  span,
  as,
}: {
  text: string;
  span: TextSpan | undefined;
  as: 'del' | 'ins';
}) {
  if (!span || span.start < 0 || span.end > text.length || span.start > span.end)
    return <span className={as === 'del' ? 'tc-before' : 'tc-after'}>{text}</span>;
  const Mark = as;
  const marked = text.slice(span.start, span.end);
  return (
    <span className={as === 'del' ? 'tc-before' : 'tc-after'}>
      {text.slice(0, span.start)}
      {marked !== '' && (
        <Mark className={`tc-mark ${as === 'del' ? 'diff-del' : 'diff-add'}`} data-testid={`tc-${as}`}>
          {marked}
        </Mark>
      )}
      {text.slice(span.end)}
    </span>
  );
}

/** One change: what and where, then the sentence before and after. */
export function TextChangeView({ c, showPage = true }: { c: TextChange; showPage?: boolean }) {
  return (
    <div className="text-change small-text" data-testid="text-change" data-block={c.blockId ?? ''}>
      {(showPage || c.what) && (
        <div className="muted">
          {showPage && c.page ? <strong>{c.page}</strong> : null}
          {showPage && c.page && c.what ? ' · ' : null}
          {c.what ?? null}
        </div>
      )}
      <div>
        <span className="muted">Before: </span>“<MarkedText text={c.before} span={c.removed} as="del" />”
      </div>
      <div>
        <span className="muted">After: </span>“<MarkedText text={c.after} span={c.added} as="ins" />”
      </div>
    </div>
  );
}

/** Every text change of a proposal's operations (bridge code sets `textChanges`; anything malformed is skipped). */
export function textChangesOf(operations: readonly Record<string, unknown>[] | undefined): TextChange[] {
  const out: TextChange[] = [];
  const span = (v: unknown): v is TextSpan =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as TextSpan).start === 'number' &&
    typeof (v as TextSpan).end === 'number';
  for (const o of operations ?? []) {
    if (!Array.isArray(o.textChanges)) continue;
    for (const c of o.textChanges as unknown[]) {
      if (typeof c !== 'object' || c === null) continue;
      const t = c as TextChange;
      if (typeof t.before === 'string' && typeof t.after === 'string' && span(t.removed) && span(t.added))
        out.push(t);
    }
  }
  return out;
}

/** The changes, listed (none: nothing). */
export function TextChangesList({
  changes,
  label = 'Words that change',
  max = 50,
}: {
  changes: readonly TextChange[];
  label?: string;
  max?: number;
}) {
  if (changes.length === 0) return null;
  return (
    <div className="text-changes" role="group" aria-label={label}>
      {changes.slice(0, max).map((c, i) => (
        <TextChangeView key={`${c.pageId ?? c.page}:${c.blockId ?? ''}:${i}`} c={c} />
      ))}
      {changes.length > max && (
        <p className="muted small-text">and {changes.length - max} more (the job’s changes list them all)</p>
      )}
    </div>
  );
}
