/**
 * `[[Name]]` and `[[Name|label]]` as a micromark text construct, with its mdast node (`lkWiki`).
 *
 * It is a real tokenizer rather than a search over text nodes so that escaping works: `\[\[Name\]\]` is consumed by
 * micromark's character escapes before this construct is ever tried, and stays literal text. The construct is tried
 * before CommonMark's link opener for `[`; anything that is not `[[…]]` on one line falls back to normal parsing.
 *
 * Inside the brackets the first `|` separates the name from the label; inside a GFM table cell it must be written `\|`
 * (an unescaped one would end the cell). `\]` and `\\` stand for `]` and `\`.
 */
import type { Literal } from 'mdast';
import type {
  Extension as FromMarkdownExtension,
  CompileContext,
  Token as MdastToken,
} from 'mdast-util-from-markdown';
import type { Code, Construct, Effects, Extension, State, TokenizeContext } from 'micromark-util-types';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    lkWiki: 'lkWiki';
    lkWikiMarker: 'lkWikiMarker';
    lkWikiData: 'lkWikiData';
  }
}

/** The mdast node for `[[…]]`: `name` is what the resolver gets, `label` the optional text after `|`. */
export interface LkWikiNode extends Literal {
  type: 'lkWiki';
  name: string;
  label: string | null;
  /** The source as written, for error messages. */
  value: string;
}

declare module 'mdast' {
  interface PhrasingContentMap {
    lkWiki: LkWikiNode;
  }
  interface RootContentMap {
    lkWiki: LkWikiNode;
  }
}

/** Longest `[[…]]` accepted (a mention label's limit). */
const MAX_INNER = 2048;
const LEFT = 91; // [
const RIGHT = 93; // ]
const BACKSLASH = 92;

function tokenizeWiki(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let size = 0;
  let escaped = false;
  return start;

  function start(code: Code): State | undefined {
    if (code !== LEFT) return nok(code);
    effects.enter('lkWiki');
    effects.enter('lkWikiMarker');
    effects.consume(code);
    return second;
  }
  function second(code: Code): State | undefined {
    if (code !== LEFT) return nok(code);
    effects.consume(code);
    effects.exit('lkWikiMarker');
    effects.enter('lkWikiData');
    return inside;
  }
  function inside(code: Code): State | undefined {
    // A line ending, the end, or an over-long name: not a wiki link after all.
    if (code === null || code < 0 || code === 10 || code === 13 || size > MAX_INNER) return nok(code);
    if (!escaped && code === RIGHT) {
      if (size === 0) return nok(code);
      effects.exit('lkWikiData');
      effects.enter('lkWikiMarker');
      effects.consume(code);
      return close;
    }
    escaped = !escaped && code === BACKSLASH;
    size++;
    effects.consume(code);
    return inside;
  }
  function close(code: Code): State | undefined {
    if (code !== RIGHT) return nok(code);
    effects.consume(code);
    effects.exit('lkWikiMarker');
    effects.exit('lkWiki');
    return ok;
  }
}

const wikiConstruct: Construct = { name: 'lkWiki', tokenize: tokenizeWiki };

/** The micromark extension (tried before the link opener). */
export function lkWikiSyntax(): Extension {
  return { text: { [LEFT]: wikiConstruct } };
}

/**
 * Splits the raw inside of `[[…]]` into name and label. The first `|` separates them, escaped or not (in a GFM table
 * cell the separator must be written `\\|`); `\\]` and `\\\\` stand for `]` and `\\`.
 */
export function splitWiki(inner: string): { name: string; label: string | null } {
  let name = '';
  let label: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    let c = inner[i]!;
    if (c === '\\' && i + 1 < inner.length && '|]\\['.includes(inner[i + 1]!)) c = inner[++i]!;
    else if (c !== '|') {
      if (label === null) name += c;
      else label += c;
      continue;
    }
    if (c === '|' && label === null) {
      label = '';
      continue;
    }
    if (label === null) name += c;
    else label += c;
  }
  return { name: name.trim(), label: label === null ? null : label };
}

/** The mdast-util-from-markdown extension that turns the tokens into `lkWiki` nodes. */
export function lkWikiFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      lkWiki(this: CompileContext, token: MdastToken) {
        this.enter({ type: 'lkWiki', name: '', label: null, value: '' } as never, token);
      },
    },
    exit: {
      lkWiki(this: CompileContext, token: MdastToken) {
        const node = this.stack[this.stack.length - 1] as unknown as LkWikiNode;
        const raw = this.sliceSerialize(token);
        const { name, label } = splitWiki(raw.slice(2, -2));
        node.name = name;
        node.label = label;
        node.value = raw;
        this.exit(token);
      },
    },
  };
}
