/**
 * The ETag as a version (v2 D1.1, ADR 0039): LegendKeeper sends it quoted; the bridge uses it bare.
 */
import { describe, expect, it } from 'vitest';
import { parseEtag } from '../../src/lk/governor/headers.js';

const h = (etag?: string) => new Headers(etag === undefined ? {} : { etag });

describe('parseEtag', () => {
  it('unquotes a strong ETag', () => {
    expect(parseEtag(h('"6f78abcf9e74a430"'))).toBe('6f78abcf9e74a430');
  });
  it('takes a bare value as it is, and drops a weak marker', () => {
    expect(parseEtag(h('f187b4e39467a0e4'))).toBe('f187b4e39467a0e4');
    expect(parseEtag(h('W/"abc123"'))).toBe('abc123');
  });
  it('is undefined when there is none or it is empty', () => {
    expect(parseEtag(h())).toBeUndefined();
    expect(parseEtag(h('""'))).toBeUndefined();
  });
});
