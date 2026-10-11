import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * The phone page loads markdown.js as a plain script that hangs renderMarkdown
 * (and the codeTextFromLines joiner the copy/download read path uses) off
 * `window`, so the only honest way to test it is to run it the way the browser
 * does.
 */
function loadWindow(): Record<string, unknown> {
  const source = readFileSync(new URL('../resources/companion/markdown.js', import.meta.url), 'utf8');
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  runInContext(source, createContext(sandbox) as never);
  return sandbox.window;
}

function loadRenderer(): (src: string) => string {
  return (loadWindow() as { renderMarkdown: (s: string) => string }).renderMarkdown;
}

describe('companion renderMarkdown', () => {
  const md = loadRenderer();

  it('renders a fenced block as a code-block with a language tag and controls', () => {
    const html = md('```cpp\nint main(){}\n```');
    expect(html).toContain('class="code-block"');
    expect(html).toContain('data-lang="cpp"');
    expect(html).toContain('class="code-pre"');
    expect(html).toContain('code-wrap');
    expect(html).toContain('int main(){}');
  });

  it('trims blank lines at the block edges but keeps indentation', () => {
    const html = md('```python\n\n\ndef f(x):\n    return x\n\n```');
    // One span.code-line per source line, joined without a separator: the
    // wrap mode's hanging indent only works because text-indent acts on each
    // block's first line — a merged text node would break it.
    expect(html).toContain('<span class="code-line">def f(x):</span><span class="code-line">    return x</span>');
    // Both leading blank lines and the trailing one are trimmed away.
    expect((html.match(/class="code-line"/g) || []).length).toBe(2);
  });

  it('closes an unterminated fence at end of input', () => {
    expect(md('```java\nclass A {')).toContain('class A {');
  });

  it('escapes HTML inside code instead of emitting it', () => {
    const html = md('```\n<script>alert(1)</script>\n```');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('still renders prose, lists and inline code', () => {
    const html = md('# 标题\n\n- 一\n- 二\n\n`x` 与 **粗**');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<code>x</code>');
    expect(html).toContain('<strong>粗</strong>');
  });

  it('does not turn markdown inside a code block into markup', () => {
    const html = md('```\n# not a heading\n1. not a list\n```');
    expect(html).toContain('# not a heading');
    expect(html).not.toContain('<h1>');
    expect(html).not.toContain('<ol>');
  });

  it('falls back to txt for an exotic fence tag instead of walking the prototype chain', () => {
    // CODE_EXT is a plain object literal; CODE_EXT['constructor'] would hit
    // Object.prototype and stringify a native function into data-ext.
    const html = md('```constructor\nx\n```');
    expect(html).toContain('data-ext="txt"');
    expect(html).not.toMatch(/native code|function Object/);
  });
});

describe('companion code-block read path', () => {
  const md = loadRenderer();
  const { codeTextFromLines } = loadWindow() as unknown as {
    codeTextFromLines: (lines: string[]) => string;
  };
  const lineSpans = (html: string) =>
    [...html.matchAll(/<span class="code-line">([^<]*)<\/span>/g)].map((m) => m[1]);

  it('round-trips a two-line block: spans carry the exact lines, the joiner restores newlines', () => {
    const html = md('```c\nline1\n  line2\n```');
    expect(lineSpans(html)).toEqual(['line1', '  line2']);
    expect(codeTextFromLines(lineSpans(html))).toBe('line1\n  line2');
  });

  it('keeps an interior blank line through the round trip', () => {
    const html = md('```c\na\n\nb\n```');
    expect(lineSpans(html)).toEqual(['a', '', 'b']);
    expect(codeTextFromLines(lineSpans(html))).toBe('a\n\nb');
  });

  it('joins the spans with the empty string in markup — newlines live only in the read path', () => {
    // white-space:pre would render a literal \n between spans as a phantom
    // blank line, so the DOM contract is join(''); copy/download must read
    // per-line and rejoin, never glue textContent (which has no separator).
    const html = md('```c\nline1\nline2\n```');
    expect(html).toContain('<span class="code-line">line1</span><span class="code-line">line2</span>');
    expect(html).not.toContain('<code>\n');
  });

  it('app.js reconstructs copy/download text from .code-line via the shared joiner, not raw textContent', () => {
    const src = readFileSync(new URL('../resources/companion/app.js', import.meta.url), 'utf8');
    expect(src).toMatch(/querySelectorAll\('\.code-line'\)/);
    expect(src).toMatch(/codeTextFromLines/);
    expect(src).not.toMatch(/writeText\([^)]*textContent/);
    expect(src).not.toMatch(/new Blob\(\[[^\]]*textContent/);
  });
});
