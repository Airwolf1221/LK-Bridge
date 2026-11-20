/**
 * The blocks the sandbox check assumptions-r4 (Y2) writes, kept apart so a mock contract test
 * (test/contract/sandbox-table-shape.test.ts) checks their shape against the registry without a sandbox run.
 *
 * The owner's run of assumptions-r4 (20 November 2026): Y2 failed before testing anything ("Invalid params for
 * replaceDocumentBlocks: body.blocks.2: Invalid input"), because its table was built with `rows` and `cells` arrays. A
 * table's rows are its `children` of kind `tableRow`, and a row's cells its `children` of kind `tableCell`, each holding
 * paragraphs: the shape of assumptions-r3's X2 case, which LegendKeeper accepted.
 */
type Obj = Record<string, unknown>;

/** Y2's blocks: a labelled mention in a paragraph, a mention with no label, and a labelled mention in a table cell. */
export function y2Blocks(pageId: string, mint: () => string): Obj[] {
  const labelled = (text: string) => ({ mention: { resourceId: pageId, text } });
  const cell = (content: Obj[]): Obj => ({
    id: mint(),
    kind: 'tableCell',
    children: [{ id: mint(), kind: 'paragraph', content }],
  });
  return [
    { id: mint(), kind: 'paragraph', content: [{ text: 'See ' }, labelled('a custom label')] },
    { id: mint(), kind: 'paragraph', content: [{ text: 'Plain ' }, { mention: { resourceId: pageId } }] },
    {
      id: mint(),
      kind: 'table',
      children: [
        {
          id: mint(),
          kind: 'tableRow',
          children: [cell([{ text: 'Holder' }]), cell([labelled('in a cell')])],
        },
      ],
    },
  ];
}
