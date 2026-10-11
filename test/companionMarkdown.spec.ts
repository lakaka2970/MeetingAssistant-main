import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * The phone page loads markdown.js as a plain script that hangs
 * renderMarkdown off `window`, so the only honest way to test it is to run it
 * the way the browser does.
 */
function loadRenderer(): (src: string) => string {
  const source = readFileSync(new URL('../resources/companion/markdown.js', import.meta.url), 'utf8');
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  runInContext(source, createContext(sandbox) as never);
  return (sandbox.window as { renderMarkdown: (s: string) => string }).renderMarkdown;
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
});
