/**
 * The qualified date forms of Arkona's age tables (v2 E6, "Chronology II", ADR 0048): the owner's examples of 15 and
 * 16 November 2026, each with the reading the engine gives it, and the forms it deliberately leaves unread. Shared by
 * the calendar tests and the chronology tests (test/chronology/qualified.test.ts).
 */
export interface Read {
  readonly cell: string;
  readonly shape: 'day' | 'month' | 'year' | 'range';
  readonly anchor: string;
  readonly approximate?: boolean;
  readonly open?: 'start' | 'end';
  readonly qualifier: string;
  /** The ParsedDate's form: what the timeline event is stored as. */
  readonly detail: 1 | 2 | 3;
}

/** The forms the owner listed, each read by its anchor (25 cells). */
export const READ: readonly Read[] = [
  {
    cell: 'c. 4A 563; exact date unresolved',
    shape: 'year',
    anchor: '4A 563',
    approximate: true,
    qualifier: 'c. …; exact date unresolved',
    detail: 1,
  },
  {
    cell: 'c. 4A 564-565; exact date unresolved',
    shape: 'range',
    anchor: '4A 564 - 4A 565',
    approximate: true,
    qualifier: 'c. …; exact date unresolved',
    detail: 1,
  },
  {
    cell: '4A 565; exact date unresolved',
    shape: 'year',
    anchor: '4A 565',
    qualifier: '…; exact date unresolved',
    detail: 1,
  },
  {
    cell: 'Late 4A 565; exact date unresolved',
    shape: 'year',
    anchor: '4A 565',
    qualifier: 'Late …; exact date unresolved',
    detail: 1,
  },
  {
    cell: 'Third week of Isar, 4A 566; exact day unresolved',
    shape: 'month',
    anchor: 'Isar 4A 566',
    qualifier: 'Third week of …; exact day unresolved',
    detail: 2,
  },
  {
    cell: 'Isar-Selaphos, 4A 566; exact sessions undated',
    shape: 'range',
    anchor: 'Isar - Selaphos, 4A 566',
    qualifier: '…; exact sessions undated',
    detail: 2,
  },
  {
    cell: 'Approximately House Year 8 (c. 4A 578); exact dates unresolved',
    shape: 'year',
    anchor: '4A 578',
    approximate: true,
    qualifier: 'Approximately House Year 8 (c. …); exact dates unresolved',
    detail: 1,
  },
  {
    cell: 'Approximately House Years 19-30 (c. 4A 589-600); exact dates unresolved',
    shape: 'range',
    anchor: '4A 589 - 4A 600',
    approximate: true,
    qualifier: 'Approximately House Years 19-30 (c. …); exact dates unresolved',
    detail: 1,
  },
  {
    cell: 'After Pardis-an placement and before Selyros 40th, 4A 605; exact date unresolved',
    shape: 'day',
    anchor: 'Selyros 40th, 4A 605',
    open: 'start',
    qualifier: 'After Pardis-an placement and before …; exact date unresolved',
    detail: 3,
  },
  {
    cell: 'After Selaphos 35th, 4A 617 and before Surion 10th, 4A 618; exact date unresolved',
    shape: 'range',
    anchor: 'Selaphos 35th, 4A 617 - Surion 10th, 4A 618',
    qualifier: 'After … and before …; exact date unresolved',
    detail: 3,
  },
  {
    cell: 'After Isar 6th and before Zarzakh 29th, 4A 610; exact date unresolved',
    shape: 'range',
    anchor: 'Isar 6th - Zarzakh 29th, 4A 610',
    qualifier: 'After … and before …; exact date unresolved',
    detail: 3,
  },
  {
    cell: 'Between Isar 30th and Azah 27th, 4A 607; exact date unresolved',
    shape: 'range',
    anchor: 'Isar 30th - Azah 27th, 4A 607',
    qualifier: 'Between … and …; exact date unresolved',
    detail: 3,
  },
  {
    cell: 'From Surion 30th, 4A 618 to Isar 3rd, 4A 619; exact handover undated',
    shape: 'range',
    anchor: 'Surion 30th, 4A 618 - Isar 3rd, 4A 619',
    qualifier: 'From … to …; exact handover undated',
    detail: 3,
  },
  {
    cell: 'Isar 3rd, 4A 619 to Selaphos 1st, 4A 620',
    shape: 'range',
    anchor: 'Isar 3rd, 4A 619 - Selaphos 1st, 4A 620',
    qualifier: '… to …',
    detail: 3,
  },
  {
    cell: 'Isar 3rd, 4A 619 through the final personal debrief Camue 8th, 4A 624; exact final legal completion date unresolved',
    shape: 'range',
    anchor: 'Isar 3rd, 4A 619 - Camue 8th, 4A 624',
    qualifier: '… through the final personal debrief …; exact final legal completion date unresolved',
    detail: 3,
  },
  {
    cell: 'Isar 13th, 4A 607; Divan post follows',
    shape: 'day',
    anchor: 'Isar 13th, 4A 607',
    qualifier: '…; Divan post follows',
    detail: 3,
  },
  {
    cell: 'Isar 30th, 4A 607 (start of first MSO investigator period)',
    shape: 'day',
    anchor: 'Isar 30th, 4A 607',
    qualifier: '… (start of first MSO investigator period)',
    detail: 3,
  },
  {
    cell: 'Kumikas 25th, 4A 630; first coronation proceeding, approximately four hours',
    shape: 'day',
    anchor: 'Kumikas 25th, 4A 630',
    qualifier: '…; first coronation proceeding, approximately four hours',
    detail: 3,
  },
  {
    cell: 'Camue 10th, 4A 624 departure; Sarayi Halid arrival some days afterwards, precise day unassigned',
    shape: 'day',
    anchor: 'Camue 10th, 4A 624',
    qualifier: '… departure; Sarayi Halid arrival some days afterwards, precise day unassigned',
    detail: 3,
  },
  {
    cell: 'Less than two days after Isar 6th, 4A 610; exact trial day unresolved',
    shape: 'day',
    anchor: 'Isar 6th, 4A 610',
    open: 'end',
    qualifier: 'Less than two days after …; exact trial day unresolved',
    detail: 3,
  },
  {
    cell: 'From Kumikas 25th, 4A 630 through the subsequent reign; no exact peace-onset date or end assigned',
    shape: 'day',
    anchor: 'Kumikas 25th, 4A 630',
    open: 'end',
    qualifier: 'From … through the subsequent reign; no exact peace-onset date or end assigned',
    detail: 3,
  },
  {
    cell: 'By 4A 623; exact comparison date recorded separately',
    shape: 'year',
    anchor: '4A 623',
    open: 'start',
    qualifier: 'By …; exact comparison date recorded separately',
    detail: 1,
  },
  {
    cell: 'Days following Isar 19th, 4A 613; exact date unresolved',
    shape: 'day',
    anchor: 'Isar 19th, 4A 613',
    open: 'end',
    qualifier: 'Days following …; exact date unresolved',
    detail: 3,
  },
  {
    cell: 'After Zahras 15th, 4A 220, before Camue 33rd, 4A 325; precise date unresolved',
    shape: 'range',
    anchor: 'Zahras 15th, 4A 220 - Camue 33rd, 4A 325',
    qualifier: 'After …, before …; precise date unresolved',
    detail: 3,
  },
  {
    cell: 'In 4A 645; exact month and day unassigned',
    shape: 'year',
    anchor: '4A 645',
    qualifier: 'In …; exact month and day unassigned',
    detail: 1,
  },
];

/** Forms deliberately NOT read: the owner's relative offset, and what strictness refuses. */
export const UNREAD: readonly { readonly cell: string; readonly code: string; readonly why: RegExp }[] = [
  {
    cell: 'Approximately nine months after Isar 1st, 4A 623; precise day unassigned',
    code: 'DATE_RELATIVE',
    why: /relative offset/,
  },
  { cell: 'Two days before Isar 3rd, 4A 619', code: 'DATE_RELATIVE', why: /relative offset/ },
  { cell: 'Shortly before the coronation; undated', code: 'DATE_NO_ANCHOR', why: /no date/ },
  { cell: 'c. 563; exact date unresolved', code: 'DATE_NO_ANCHOR', why: /no date/ },
  { cell: 'Late Isar 3rd, 4A 619', code: 'DATE_QUALIFIER_ON_DAY', why: /on a day/ },
  { cell: 'From Isar 4A 566 to Selaphos 3rd, 4A 566', code: 'DATE_RANGE_MIXED', why: /precision/ },
  { cell: 'Between Azah 27th and Isar 30th, 4A 607', code: 'DATE_RANGE_REVERSED', why: /ends before/ },
  {
    cell: 'After the Isar road and before Selyros 40th, 4A 605',
    code: 'DATE_BOUND_UNREADABLE',
    why: /Isar road/,
  },
  { cell: 'Isar 3rd or 4th, 4A 619', code: 'DATE_AMBIGUOUS', why: /cannot be read|not certain/ },
  { cell: 'Isar 3rd, 4A 619 (c. 4A 620)', code: 'DATE_AMBIGUOUS', why: /inside and outside/ },
  { cell: 'Kumikas 32nd, 4A 1; a day too many', code: 'DATE_IMPOSSIBLE_DAY', why: /30 days/ },
];

/**
 * An Arkona-shaped set of 63 qualified Date cells (the number the owner's Fourth Age check reported unreadable on 15
 * November 2026): the owner's 26 examples, and 37 more written in the same forms with other dates, of which 8 are the
 * kinds the reader must leave unread (relative offsets, a disputed day, a qualifier on a day, a bound that names a
 * place, a season, no date at all). Not one of them is read by the plain forms; `read` says whether the qualified
 * reader is certain of it.
 */
export const ARKONA_QUALIFIED: readonly { readonly cell: string; readonly read: boolean }[] = [
  ...READ.map((r) => ({ cell: r.cell, read: true })),
  { cell: UNREAD[0]!.cell, read: false },
  { cell: 'c. 4A 571; exact date unresolved', read: true },
  { cell: 'c. 4A 572-574; exact dates unresolved', read: true },
  { cell: '4A 575; exact date unresolved', read: true },
  { cell: 'Early 4A 576; exact date unresolved', read: true },
  { cell: 'Mid-4A 577; exact month unresolved', read: true },
  { cell: 'Second week of Selaphos, 4A 579; exact day unresolved', read: true },
  { cell: 'Azah-Selyros, 4A 580; exact sessions undated', read: true },
  { cell: 'Approximately House Year 12 (c. 4A 582); exact dates unresolved', read: true },
  { cell: 'Approximately House Years 13-15 (c. 4A 583-585); exact dates unresolved', read: true },
  { cell: 'After the Menkhet census and before Surion 12th, 4A 586; exact date unresolved', read: true },
  { cell: 'After Malakh 3rd, 4A 587 and before Zahras 20th, 4A 587; exact date unresolved', read: true },
  { cell: 'After Kumikas 4th and before Isar 9th, 4A 590; exact date unresolved', read: true },
  { cell: 'Between Selaphos 2nd and Azah 14th, 4A 592; exact date unresolved', read: true },
  { cell: 'From Camue 1st, 4A 594 to Pahan 30th, 4A 595; exact handover undated', read: true },
  { cell: 'Selyros 3rd, 4A 597 to Sarias 20th, 4A 597', read: true },
  {
    cell: 'Surion 4th, 4A 601 through the closing audit Kusha 9th, 4A 603; exact completion date unresolved',
    read: true,
  },
  { cell: 'Jehet 21st, 4A 604; Divan notice follows', read: true },
  { cell: 'Attina 2nd, 4A 606 (end of the first inquiry)', read: true },
  { cell: 'Umbaeos 8th, 4A 608; second hearing, approximately three hours', read: true },
  {
    cell: 'Zarzakh 14th, 4A 609 departure; arrival some days afterwards, precise day unassigned',
    read: true,
  },
  { cell: 'Less than three days after Isar 20th, 4A 611; exact day unresolved', read: true },
  { cell: 'From Selaphos 5th, 4A 612 through the regency; no end assigned', read: true },
  { cell: 'By 4A 614; exact date recorded separately', read: true },
  { cell: 'Weeks following Azah 2nd, 4A 615; exact date unresolved', read: true },
  { cell: 'After Malakh 15th, 4A 616, before Camue 3rd, 4A 616; precise date unresolved', read: true },
  { cell: 'In 4A 621; exact month and day unassigned', read: true },
  { cell: 'Before Kusha 1st, 4A 622; exact date unresolved', read: true },
  { cell: 'Shortly after Jehet 5th, 4A 625; exact day unresolved', read: true },
  { cell: 'Late Selyros 4A 626; exact day unresolved', read: true },
  { cell: 'About two weeks after Attina 3rd, 4A 627; precise day unassigned', read: false },
  { cell: 'Some months after the coronation; undated', read: false },
  { cell: 'Several years before 4A 628; exact date unresolved', read: false },
  { cell: 'Isar 3rd or 4th, 4A 629; exact day disputed', read: false },
  { cell: 'Late Kumikas 2nd, 4A 631; exact hour unresolved', read: false },
  { cell: 'After the Isar accords and before Selaphos 9th, 4A 632; undated', read: false },
  { cell: 'Spring of 4A 633; exact date unresolved', read: false },
  { cell: 'Shortly before the second coronation; undated', read: false },
];
