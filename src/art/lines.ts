/**
 * v3 F7 (ADR 0070, G5, G7): the text lines of a page (every block holding text runs, at any depth), and the ones that
 * name an asset or a folder, for the art job (lines naming a moved piece, listed for the owner) and the art layout
 * audit (stale folder paths and ids on a character's pages).
 */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface TextLine {
  readonly blockId: string;
  readonly text: string;
}

/** A block's plain text (its runs' text and mentions' labels). */
export function lineText(b: Obj): string {
  return (Array.isArray(b.content) ? (b.content as unknown[]) : [])
    .map((r) => {
      if (!isObj(r)) return '';
      if (typeof r.text === 'string') return r.text;
      const m = r.mention;
      return isObj(m) && typeof m.text === 'string' ? m.text : '';
    })
    .join('');
}

/** Every block (with an id) holding text runs, at any depth, in document order. */
export function textLines(blocks: readonly unknown[]): TextLine[] {
  const out: TextLine[] = [];
  const walk = (list: readonly unknown[]) => {
    for (const b of list) {
      if (!isObj(b)) continue;
      if (typeof b.id === 'string' && Array.isArray(b.content)) {
        const text = lineText(b);
        if (text.trim() !== '') out.push({ blockId: b.id, text });
      }
      for (const v of Object.values(b)) if (Array.isArray(v)) walk(v);
    }
  };
  walk(blocks);
  return out;
}

/**
 * The lines naming any of these assets, by id or by name (G5): they may state where the piece is, so a job that moves
 * the piece lists them for the owner and never edits them.
 */
export function linesNaming(
  blocks: readonly unknown[],
  assets: readonly { readonly id: string; readonly name: string }[],
): TextLine[] {
  return textLines(blocks).filter((l) =>
    assets.some((a) => l.text.includes(a.id) || l.text.includes(a.name)),
  );
}
