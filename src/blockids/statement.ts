/**
 * The approved-automation statement of the block-id sweep (ADR 0056). Arkona's Repository Automation: "a separately
 * approved narrow automation action must identify exact scope, prerequisites, transformations, verification,
 * concurrency rules and stop conditions." These six points are shown, word for word, on the job's Maintenance card and
 * in the ADR, so that enabling the job is the owner's informed approval. Change them only with the ADR.
 */

/** The job's id in the maintenance registry. */
export const SWEEP_JOB_ID = 'assign-block-ids-sweep';

export interface StatementPoint {
  readonly key: 'scope' | 'prerequisites' | 'transformation' | 'verification' | 'concurrency' | 'stop';
  readonly title: string;
  readonly text: string;
}

export const AUTOMATION_STATEMENT: readonly StatementPoint[] = [
  {
    key: 'scope',
    title: 'Scope',
    text:
      'Page documents only (never maps, timelines or boards) of pages inside AI REPOSITORY, in each project the ' +
      'bridge serves. A document is a candidate when the latest snapshot shows a block without an id, or an id used ' +
      'more than once (the rule block-by-block writes refuse on). Finding the candidates costs no request.',
  },
  {
    key: 'prerequisites',
    title: 'Prerequisites',
    text:
      'The project is not read-only, writes are not paused and the bridge is not draining. The sandbox check ' +
      '(assign-block-ids) has a recorded PASS for this bridge version, or the owner has set the override, which needs ' +
      're-authentication and is audited. The job cannot be enabled without one or the other.',
  },
  {
    key: 'transformation',
    title: 'Transformation',
    text:
      'One assignBlockIds call per document. Nothing else: no text, structure, sidebar or tag change, and Last Major ' +
      'Revision is never set.',
  },
  {
    key: 'verification',
    title: 'Verification',
    text:
      'Before the call, the whole document is read and journalled as its pre-image. After it, the document is read ' +
      'again and compared with the pre-image, block ids aside: block kinds, order, nesting, text runs and marks, every ' +
      'field and the number of unsupported blocks must be identical, every block must have an id, and no id may appear ' +
      'twice. Anything else is a verification failure.',
  },
  {
    key: 'concurrency',
    title: 'Concurrency',
    text:
      'Each document is its own engine job at P3, run by the system principal (origin maintenance), holding the ' +
      'page lock. Inside the lock the document must still be exactly the version the pre-image was read at ' +
      '(LegendKeeper takes no If-Match on this call, so the bridge compares the version itself); if it has moved, the ' +
      'document is skipped and retried next run, never forced, and one that has meanwhile gained ids is skipped. At ' +
      'most N documents a run (default 20, set below); a run stops early when the P3 budget says wait.',
  },
  {
    key: 'stop',
    title: 'Stop conditions',
    text:
      'A verification failure stops the whole sweep: the job disables itself and records the document, the ' +
      'differences and the journal entry, shown here in red with the entry to restore from. A run also stops on a ' +
      'governor refusal, read-only mode, a writes pause or the bridge draining, and when a write’s outcome is not ' +
      'known (that document is checked first next run).',
  },
];
