/**
 * Pure math-delimiter splitter for answer bodies. Answers arrive as plain text
 * where LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) would otherwise show verbatim;
 * this splits the text into prose / math segments so the renderer can typeset
 * only the math. No DOM, no KaTeX here — unit-testable in isolation.
 *
 * Inline `$…$` carries a small heuristic (non-empty, no surrounding whitespace,
 * capped length) so ordinary text like "costs $5 and $10" is not mistaken for
 * math. `$$…$$` / `\[…\]` are display math and need no such guard — a doubled
 * dollar sign is unambiguous.
 */

export type MathSegment =
  | { type: 'text'; text: string }
  | { type: 'math'; tex: string; display: boolean };

/** cap for a single inline math body — longer is almost certainly not math */
const MAX_INLINE_MATH = 200;

// Display forms come first so `$$` wins over a lone `$`. The inline `$…$`
// branch forbids a newline or a nested `$` inside the body, which keeps a
// currency run like "$5 and $10" from matching across the two dollar signs.
const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^\n$]+?)\$/g;

export function splitMath(text: string): MathSegment[] {
  const segs: MathSegment[] = [];
  let textBuf = '';
  let last = 0;
  let m: RegExpExecArray | null;
  MATH_RE.lastIndex = 0;

  const flushText = () => {
    if (textBuf) {
      segs.push({ type: 'text', text: textBuf });
      textBuf = '';
    }
  };

  while ((m = MATH_RE.exec(text))) {
    textBuf += text.slice(last, m.index);
    const display = m[1] !== undefined || m[2] !== undefined;
    const tex = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    const looksInline = tex.length > 0 && tex.length <= MAX_INLINE_MATH && tex === tex.trim();
    if (display ? tex.trim() !== '' : looksInline) {
      flushText();
      segs.push({ type: 'math', tex, display });
    } else {
      // not convincing math — keep the raw delimited text as prose
      textBuf += m[0];
    }
    last = m.index + m[0].length;
  }
  textBuf += text.slice(last);
  flushText();
  return segs;
}
