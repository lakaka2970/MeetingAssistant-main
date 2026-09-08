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

// ---------- inline-body classification ----------
// A `$…$` whose body is flush against the delimiters is math (the historical
// rule). A PADDED one (`$ \sigma(x) = \frac{1}{1+e^{-x}} $`) needs a real LaTeX
// signal before it is typeset: chat models pad their formulas this way, and
// rejecting them left the raw `$…$` visible in the answer pane. Currency-ish
// bodies ("$5 and $") carry none of these signals and stay prose.

/** any LaTeX command: \frac \sigma \int … */
const LATEX_COMMAND = /\\[a-zA-Z]+/;
/** sub/superscript or a group brace: x_1 e^{-x} \text{…} */
const LATEX_STRUCT = /[_^{}]/;
/** operators and Greek letters that never appear in prose */
const MATH_SYMBOL =
  /[×÷≤≥≠≈±∓∞∑∏∫∮∂∇√∛∠⊂⊃⊆⊇∈∉∪∩∧∨∀∃∴∵≡≅∼∽∝≪≫⌈⌉⌊⌋⟨⟩αβγδεζηθικλμνξοπρςστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ]/;
/** a relation between symbols: `a=b` `x ≥ 0` `y = 2x` `a+b` `e^-x` */
const MATH_RELATION =
  /[A-Za-zα-ω](?:\s*[=<>≤≥≠≈]\s*|[+\-*/]\s*)[\dA-Za-zα-ω(\\-]/;
/** a known function applied to something: sin(x) log_2 n exp(-x) */
const MATH_FUNCTION =
  /(?:^|[^A-Za-z])(?:sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|sinh|cosh|tanh|log|ln|lg|exp|lim|max|min|sup|inf|arg|gcd|lcm|det|tr|dim|deg|mod|floor|ceil)(?:\s*[( _^\\{]|$)/;

/** does this `$…$` body look like math? (caller has NOT trimmed it) */
export function looksLikeMathBody(body: string): boolean {
  const t = body.trim();
  if (!t || t.length > MAX_INLINE_MATH) return false;
  return (
    LATEX_COMMAND.test(t) ||
    LATEX_STRUCT.test(t) ||
    MATH_SYMBOL.test(t) ||
    MATH_RELATION.test(t) ||
    MATH_FUNCTION.test(t)
  );
}

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
    const strictInline = tex.length > 0 && tex.length <= MAX_INLINE_MATH && tex === tex.trim();
    if (display ? tex.trim() !== '' : strictInline || looksLikeMathBody(tex)) {
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
