import { Fragment, useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { splitMath } from '../../shared/mathSplit';

/**
 * Renders an answer body with inline math typeset by KaTeX. The LLM answers
 * arrive as plain text, so LaTeX delimiters ($…$, $$…$$, \(…\), \[…\]) would
 * otherwise show verbatim. {@link splitMath} does the prose/math split; this
 * component typesets the math segments and keeps the prose as text nodes so the
 * app's existing pre-wrap behaviour is unchanged.
 */

function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      throwOnError: false,
      displayMode: display,
      strict: false,
    });
  } catch {
    // belt-and-suspenders: renderToString should not throw with throwOnError
    // false, but never let one bad formula take down the whole answer pane.
    return `<span>${display ? '$$' : '$'}${tex}${display ? '$$' : '$'}</span>`;
  }
}

export function MathText({ text }: { text: string }) {
  const segs = useMemo(() => splitMath(text), [text]);
  return (
    <>
      {segs.map((s, i) =>
        s.type === 'text' ? (
          <Fragment key={i}>{s.text}</Fragment>
        ) : (
          // KaTeX output is generated from escaped source — safe to inject.
          <span key={i} dangerouslySetInnerHTML={{ __html: renderMath(s.tex, s.display) }} />
        ),
      )}
    </>
  );
}
