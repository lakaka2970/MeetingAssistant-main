import { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { splitMath } from '../../shared/mathSplit';
import { escapeHtml, renderMarkdownLite } from '../../shared/markdownLite';

/**
 * Renders an answer body with inline math typeset by KaTeX and the common
 * inline Markdown constructs (bold / italic / code / line headings) turned into
 * markup. The LLM answers arrive as plain text, so LaTeX delimiters ($…$,
 * $$…$$, \(…\), \[…\]) and `**markers**` would otherwise show verbatim.
 * {@link splitMath} does the prose/math split and {@link renderMarkdownLite}
 * handles the prose: both keep the app's existing pre-wrap behaviour, and the
 * prose is escaped before any markup is generated.
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
    // Escape first — the tex comes from model output.
    const raw = `${display ? '$$' : '$'}${tex}${display ? '$$' : '$'}`;
    return `<span>${escapeHtml(raw)}</span>`;
  }
}

export function MathText({ text }: { text: string }) {
  const segs = useMemo(() => splitMath(text), [text]);
  return (
    <>
      {segs.map((s, i) =>
        s.type === 'text' ? (
          // escaped by renderMarkdownLite — only <b>/<i>/<code>/<span> survive
          <span key={i} dangerouslySetInnerHTML={{ __html: renderMarkdownLite(s.text) }} />
        ) : (
          // KaTeX output is generated from escaped source — safe to inject.
          <span key={i} dangerouslySetInnerHTML={{ __html: renderMath(s.tex, s.display) }} />
        ),
      )}
    </>
  );
}
