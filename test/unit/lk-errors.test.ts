import {
  ConnectionError,
  ERROR_CODES,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '@legendkeeper/sdk';
import { describe, expect, it } from 'vitest';
import {
  BridgeLkError,
  BudgetWaitError,
  classify,
  fromLkResponse,
  LK_ERROR_CODES,
  toBridgeLkError,
} from '../../src/lk/errors.js';

describe('error mapping', () => {
  it('classifies every code in the SDK catalogue', () => {
    expect(Object.keys(LK_ERROR_CODES).sort()).toEqual([...ERROR_CODES].sort());
  });

  it.each([
    ['VALIDATION_ERROR', 400, 'user_fixable', false],
    ['KIND_MISMATCH', 400, 'user_fixable', false],
    ['UNAUTHENTICATED', 401, 'auth', false],
    ['PAID_PLAN_REQUIRED', 402, 'auth', false],
    ['WRONG_PROJECT', 403, 'auth', false],
    ['INSUFFICIENT_SCOPE', 403, 'auth', false],
    ['FEATURE_UNAVAILABLE', 403, 'auth', false],
    ['NOT_FOUND', 404, 'user_fixable', false],
    ['HAS_CHILDREN', 409, 'conflict', false],
    ['IN_PROGRESS', 409, 'conflict', true],
    ['VERSION_MISMATCH', 412, 'conflict', false],
    ['PAYLOAD_TOO_LARGE', 413, 'user_fixable', false],
    ['STORAGE_QUOTA_EXCEEDED', 413, 'user_fixable', false],
    ['DOCUMENT_TOO_LARGE', 422, 'user_fixable', false],
    ['RATE_LIMITED', 429, 'budget', true],
    ['UPLOAD_RATE_EXCEEDED', 429, 'budget', true],
    ['INTERNAL', 500, 'upstream', false],
  ])('%s (%i) -> %s, retryable %s', (code, status, classification, retryable) => {
    const e = fromLkResponse({ status, body: { code, message: 'm', requestId: 'r-1' } });
    expect(e).toMatchObject({ code, status, classification, retryable, requestId: 'r-1' });
  });

  it('branches on code, not message', () => {
    const a = fromLkResponse({ status: 409, body: { code: 'IN_PROGRESS', message: 'Version mismatch' } });
    const b = fromLkResponse({ status: 409, body: { code: 'HAS_CHILDREN', message: 'in progress, retry' } });
    expect(a.retryable).toBe(true);
    expect(b.retryable).toBe(false);
  });

  it('falls back to the status for unknown codes and plain-text bodies', () => {
    expect(classify('SOMETHING_NEW', 403)).toBe('auth');
    expect(classify(undefined, 413)).toBe('user_fixable');
    expect(classify(undefined, 409)).toBe('conflict');
    expect(classify(undefined, 503)).toBe('upstream');
    const e = fromLkResponse({ status: 503, body: undefined });
    expect(e).toMatchObject({ retryable: true, classification: 'upstream', code: undefined });
  });

  it('keeps errors[] paths from 400s', () => {
    const e = fromLkResponse({
      status: 400,
      body: { code: 'VALIDATION_ERROR', errors: [{ path: 'block.children[0].level', message: 'too deep' }] },
    });
    expect(e.errors).toEqual([{ path: 'block.children[0].level', message: 'too deep' }]);
  });

  it('maps SDK errors, preferring the raw wire body (so unknown codes survive)', () => {
    const resp = new Response(null, { status: 429, headers: { 'retry-after': '3', 'x-request-id': 'r-9' } });
    const sdk = new RateLimitError(429, { code: 'RATE_LIMITED', message: 'slow down' }, resp);
    expect(toBridgeLkError(sdk, 'listResources')).toMatchObject({
      classification: 'budget',
      code: 'RATE_LIMITED',
      requestId: 'r-9',
      retryAfterMs: 3000,
      opId: 'listResources',
    });
    const unknown = new ValidationError(400, { code: 'NEW_THING', message: 'x' });
    expect(unknown.code).toBeUndefined(); // the SDK drops unknown codes...
    expect(toBridgeLkError(unknown, 'op', { body: { code: 'NEW_THING' } }).code).toBe('NEW_THING'); // ...we don't
    expect(toBridgeLkError(new NotFoundError(404, { code: 'NOT_FOUND' })).classification).toBe(
      'user_fixable',
    );
  });

  it('maps connection errors, timeouts, aborts and bugs', () => {
    expect(toBridgeLkError(new ConnectionError('ECONNRESET'))).toMatchObject({
      code: 'CONNECTION_ERROR',
      classification: 'upstream',
      retryable: true,
    });
    expect(toBridgeLkError(new Error('x'), 'op', { timedOut: true }).code).toBe('TIMEOUT');
    expect(toBridgeLkError(new Error('x'), 'op', { aborted: true }).code).toBe('ABORTED');
    expect(toBridgeLkError(new TypeError('oops'))).toMatchObject({
      code: 'UNEXPECTED',
      classification: 'bridge',
    });
  });

  it('unwraps governor guards the SDK wrapped in ConnectionError', () => {
    const guard = new BridgeLkError({
      message: 'no',
      code: 'GOVERNOR_BYPASS',
      retryable: false,
      classification: 'bridge',
    });
    expect(toBridgeLkError(new ConnectionError('no', guard)).code).toBe('GOVERNOR_BYPASS');
  });

  it('BudgetWaitError is a budget BridgeLkError with tier and retry time', () => {
    const e = new BudgetWaitError({ tier: 'key-day', retryAtMs: Date.UTC(2026, 10, 8) });
    expect(e).toBeInstanceOf(BridgeLkError);
    expect(e).toMatchObject({
      name: 'BudgetWaitError',
      tier: 'key-day',
      classification: 'budget',
      retryable: true,
    });
    expect(e.message).toContain('2026-11-08T00:00:00.000Z');
    expect(JSON.parse(JSON.stringify(e))).toMatchObject({ classification: 'budget' });
  });
});
