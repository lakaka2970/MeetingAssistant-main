import { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { splitCodeFences } from '../../shared/codeFences';
import { splitMath } from '../../shared/mathSplit';
import { escapeHtml, renderMarkdownLite } from '../../shared/markdownLite';
import { CodeBlock, type CodeBlockLabels } from './CodeBlock';

/**
 * Renders an answer body: fenced code goes to {@link CodeBlock} (monospace,
 * scrolling, highlight), everything else to {@link ProseText} with inline math
 * typeset by KaTeX and the common inline Markdown constructs (bold / italic /
 * code / line headings) turned into markup. The LLM answers arrive as plain
 * text, so a ``` fence would otherwise show its own backticks in a proportional
 * font and LaTeX delimiters would show verbatim. {@link splitCodeFences} peels
 * the fences off first — which also keeps a shell `$((a+b))` out of the math
 * splitter — and then {@link splitMath} + {@link renderMarkdownLite} handle the
 * prose exactly the way they did before; prose is escaped before any markup is
 * generated.
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

/** The pre-fence-split renderer, moved here verbatim: an answer without a
 *  fence must reach the DOM exactly as it did before this component existed. */
function ProseText({ text }: { text: string }) {
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

export function MathText({ text, codeLabels }: { text: string; codeLabels?: CodeBlockLabels }) {
  // a trailing bare fence mid-stream yields body: '' — drop it rather than
  // paint an empty framed block with three buttons around nothing
  const segs = useMemo(() => splitCodeFences(text).filter((s) => s.kind !== 'code' || s.body !== ''), [text]);
  return (
    <>
      {segs.map((seg, i) =>
        seg.kind === 'code' ? (
          <CodeBlock key={i} lang={seg.lang} code={seg.body} labels={codeLabels} />
        ) : (
          <ProseText key={i} text={seg.text} />
        ),
      )}
    </>
  );
}
