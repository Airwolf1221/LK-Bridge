/**
 * F6d follow-up (the owner's ruling; ADR 0057 decision 5 and ADR 0081 amended): the owner's automation at Apply runs
 * directly, canon and lifecycle changes included. Pure: which requests and jobs are direct.
 */
import { describe, expect, it } from 'vitest';
import { canonAccepted, directJob, directWrite } from '../../src/jobs/write-guard.js';

const AUTOMATION = { principalId: 'automation' };
const apply = { kind: 'maintenance' as const, automationApply: true as const };

describe('the automation at Apply is direct', () => {
  it('at entry: the Automation principal, a maintenance origin, the marker, the gate allowing it', () => {
    expect(directWrite({ principal: AUTOMATION, origin: apply, gate: 'allow' })).toBe(true);
  });

  it('not at Propose (the gate proposes: a forced proposal), not without the marker, not on another origin', () => {
    expect(directWrite({ principal: AUTOMATION, origin: apply, gate: 'propose' })).toBe(false);
    expect(directWrite({ principal: AUTOMATION, origin: { kind: 'maintenance' }, gate: 'allow' })).toBe(
      false,
    );
    expect(
      directWrite({ principal: AUTOMATION, origin: { kind: 'ui', automationApply: true }, gate: 'allow' }),
    ).toBe(false);
    expect(directWrite({ principal: { principalId: 'system' }, origin: apply, gate: 'allow' })).toBe(false);
  });

  it('in the lock: its job is direct and may make the canon changes judged at entry; an approved one is not "direct"', () => {
    const job = { principalId: 'automation', approvedBy: null, origin: { ...apply } } as never;
    expect(directJob(job)).toBe(true);
    expect(canonAccepted(job)).toBe(true);
    const approved = { principalId: 'automation', approvedBy: 'owner', origin: { ...apply } } as never;
    expect(directJob(approved)).toBe(false);
    const propose = { principalId: 'automation', approvedBy: null, origin: { kind: 'maintenance' } } as never;
    expect(directJob(propose)).toBe(false);
  });
});
