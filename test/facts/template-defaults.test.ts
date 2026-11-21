/**
 * R4.1 (ADR 0066 amendment 1): a template's default values are not "existing" values. Replacing a field value IDENTICAL
 * to the page's template default is a first fill for the canon guard's `change` rules (Continuity, Continuity Type); a
 * real existing value (anything that differs, by one character included) is still protected, and a `value` rule (Status
 * Authoritative) ignores defaults. The guard's own reads: at entry (a copy in the same request), and inside the lock
 * (the job's own stored copy step, so also after a restart; the template read then).
 */
import { describe, expect, it } from 'vitest';
import { assessFactChange, CanonicalGuard, type FactValue } from '../../src/facts/canonical.js';
import { DEFAULT_CANONICAL_RULES } from '../../src/facts/rules.js';
import {
  isTemplateDefault,
  templateDefaultsOf,
  templateFromCopySteps,
} from '../../src/facts/template-defaults.js';
import { CanonicalApprovalRequiredError, type JobEngine } from '../../src/jobs/index.js';
import type { WriteGuardEntry, WriteGuardInLock } from '../../src/jobs/write-guard.js';

const PLACEHOLDER = "Main CANON, or the AU's name";
const fv = (key: string, text: string): FactValue => ({ key, content: text === '' ? [] : [{ text }] });
const kv = (rows: [string, string][]) => [
  {
    id: 'kv1',
    kind: 'keyValue',
    title: 'PROPERTIES',
    rows: rows.map(([key, text], i) => ({ id: `r${i}`, key, content: text === '' ? [] : [{ text }] })),
  },
];
const TEMPLATE = kv([
  ['Story', "Link to the story's [INDEX]"],
  ['Continuity', PLACEHOLDER],
  ['Continuity Type', ''],
]);
const defaults = templateDefaultsOf(TEMPLATE as unknown as Parameters<typeof templateDefaultsOf>[0]);
const rules = DEFAULT_CANONICAL_RULES;

describe('assessFactChange with template defaults (pure)', () => {
  it('the template’s default replaced is a first fill', () => {
    expect(
      assessFactChange(rules, [fv('Continuity', PLACEHOLDER)], [fv('Continuity', 'Main CANON')], defaults),
    ).toEqual([]);
    // Without the defaults: the old reading (the owner's run, narrative-f4c N3).
    expect(
      assessFactChange(rules, [fv('Continuity', PLACEHOLDER)], [fv('Continuity', 'Main CANON')]).map(
        (c) => c.text,
      ),
    ).toEqual([`Continuity would change from “${PLACEHOLDER}” to “Main CANON”`]);
  });

  it('a real existing value is still protected: another value, one character off the default, or set back to the default', () => {
    for (const before of [
      'Moonfall',
      'Main CANON',
      'Main CANON, or the AU’s name',
      'Main CANON, or the AU',
    ]) {
      const c = assessFactChange(
        rules,
        [fv('Continuity', before)],
        [fv('Continuity', 'Elsewhere')],
        defaults,
      );
      expect(
        c.map((x) => x.ruleId),
        before,
      ).toEqual(['continuity']);
    }
    // A real value replaced BY the template's text is a change too (the default is no value of the page's own).
    expect(
      assessFactChange(rules, [fv('Continuity', 'Moonfall')], [fv('Continuity', PLACEHOLDER)], defaults).map(
        (x) => x.direction,
      ),
    ).toEqual(['change']);
    // A default of another field is no default of this one.
    expect(
      assessFactChange(
        rules,
        [fv('Continuity Type', PLACEHOLDER)],
        [fv('Continuity Type', 'AU')],
        defaults,
      ).map((x) => x.ruleId),
    ).toEqual(['continuity-type']);
  });

  it('a value rule ignores defaults (Status Authoritative is judged as ever)', () => {
    const tpl = templateDefaultsOf(kv([['Status', 'Authoritative']]) as never);
    expect(
      assessFactChange(rules, [fv('Status', 'Authoritative')], [fv('Status', 'Working')], tpl).map(
        (x) => x.ruleId,
      ),
    ).toEqual(['status-authoritative']);
  });

  it('the helpers: empty template values are no default; a job’s own copy step names its template', () => {
    expect(isTemplateDefault(defaults, 'continuity', [{ text: PLACEHOLDER }])).toBe(true);
    expect(isTemplateDefault(defaults, 'Continuity Type', [])).toBe(false);
    expect(defaults.has('continuity type')).toBe(false);
    expect(
      templateFromCopySteps(
        [{ body: { templateId: 'tplA', id: 'other001' } }, { body: { templateId: 'tplB', id: 'page0001' } }],
        'page0001',
      ),
    ).toBe('tplB');
    expect(templateFromCopySteps([{ body: { templateId: 'tplA' } }], 'page0001')).toBeNull();
  });
});

describe('the canon guard’s own reads', () => {
  const agent = { principalId: 'pat_agent', profile: 'writer', label: 'agent' };
  const origin = { kind: 'mcp' as const, client: 'claude', tool: 'lk_api_batch', principal: agent };
  const continuityWrite = (rid: string) => ({
    op: 'updatePropertyRow',
    params: {
      path: { resourceId: rid, propertyId: 'kv1', rowId: 'r1' },
      body: { content: [{ text: 'Main CANON' }] },
    },
    options: {},
  });
  const sidebars: Record<string, unknown> = {
    tplch001: TEMPLATE,
    copy0001: TEMPLATE, // a copy holds its template's defaults
    real0001: kv([
      ['Story', "Link to the story's [INDEX]"],
      ['Continuity', 'Moonfall'],
    ]),
  };
  const engine = {
    internalRead: (_p: string, _op: string, params: { path: { resourceId: string } }) =>
      Promise.resolve({ data: sidebars[params.path.resourceId] ?? [] }),
  } as unknown as Pick<JobEngine, 'internalRead'>;

  it('at entry: a template copied in the same request, then its default filled, is allowed', async () => {
    const guard = new CanonicalGuard({ settings: () => ({}), engine });
    const entry: WriteGuardEntry = {
      project: 'proj',
      principal: agent,
      origin,
      jobKind: 'batch_ops',
      gate: 'allow',
      items: [
        {
          op: 'createResourceFromTemplate',
          params: { body: { templateId: 'tplch001', id: 'new00001', name: 'Chapter 1 - First' } },
          options: {},
        },
        continuityWrite('new00001'),
      ],
    } as unknown as WriteGuardEntry;
    expect(await guard.entry(entry)).toEqual({ decision: 'allow' });
    // A page whose Continuity is its own (no copy in the request, no template known): a canonical proposal.
    const real = await guard.entry({ ...entry, items: [continuityWrite('real0001')] });
    expect(real.decision).toBe('propose_canonical');
    // A page holding the placeholder's text whose template the bridge cannot tell: protected as before.
    const unknown = await guard.entry({ ...entry, items: [continuityWrite('copy0001')] });
    expect(unknown.decision).toBe('propose_canonical');
    // Told its template (the tree's record, or a narrative page's): allowed.
    const told = new CanonicalGuard({
      settings: () => ({}),
      engine,
      templateOf: (_p, id) => (id === 'copy0001' || id === 'real0001' ? 'tplch001' : null),
    });
    expect(await told.entry({ ...entry, items: [continuityWrite('copy0001')] })).toEqual({
      decision: 'allow',
    });
    expect((await told.entry({ ...entry, items: [continuityWrite('real0001')] })).decision).toBe(
      'propose_canonical',
    );
  });

  it('inside the lock: the job’s own copy step names the template (read then); a real value, or an unreadable template, refuses', async () => {
    const jobSteps = [
      { opId: 'createResourceFromTemplate', params: { body: { templateId: 'tplch001', id: 'copy0001' } } },
    ];
    const guard = new CanonicalGuard({
      settings: () => ({}),
      engine,
      // As the runtime's reader does inside the lock: the writing job's own stored copy step first.
      templateOf: (_p, id, jobId) =>
        jobId === 'job1'
          ? templateFromCopySteps(
              jobSteps.map((s) => s.params),
              id,
            )
          : null,
    });
    const reads: string[] = [];
    const lock = (rid: string, o: { jobId?: string; template?: 'fails' } = {}): WriteGuardInLock =>
      ({
        job: { id: o.jobId ?? 'job1', projectId: 'proj', origin },
        step: { stepNo: 2, options: {} },
        opId: 'updatePropertyRow',
        params: continuityWrite(rid).params,
        current: undefined,
        read: (op: string, params: { path: { resourceId: string } }) => {
          reads.push(`${op} ${params.path.resourceId}`);
          if (params.path.resourceId === 'tplch001' && o.template === 'fails')
            return Promise.reject(new Error('down'));
          if (op === 'getProperty')
            return Promise.resolve((sidebars[params.path.resourceId] as unknown[])[0]);
          return Promise.resolve({ data: sidebars[params.path.resourceId] });
        },
      }) as unknown as WriteGuardInLock;
    await expect(guard.inLock(lock('copy0001'))).resolves.toBeUndefined();
    expect(reads).toContain('listProperties tplch001');
    // Another job (no copy of its own, no template known): the placeholder's text is protected as before.
    await expect(guard.inLock(lock('copy0001', { jobId: 'job2' }))).rejects.toBeInstanceOf(
      CanonicalApprovalRequiredError,
    );
    // The template cannot be read: no defaults (the safe side).
    await expect(guard.inLock(lock('copy0001', { template: 'fails' }))).rejects.toBeInstanceOf(
      CanonicalApprovalRequiredError,
    );
    // A real value on a page the job copied is still protected.
    jobSteps.push({
      opId: 'createResourceFromTemplate',
      params: { body: { templateId: 'tplch001', id: 'real0001' } },
    });
    await expect(guard.inLock(lock('real0001'))).rejects.toBeInstanceOf(CanonicalApprovalRequiredError);
  });
});
