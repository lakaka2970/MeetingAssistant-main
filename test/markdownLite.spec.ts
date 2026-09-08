import { describe, it, expect } from 'vitest';
import { escapeHtml, renderMarkdownLite } from '../shared/markdownLite';

describe('renderMarkdownLite (answer-body inline markdown)', () => {
  it('escapes html before anything else', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href="x"&gt;&amp;&lt;/a&gt;');
    expect(renderMarkdownLite('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
  });

  it('renders **bold** and *italic*', () => {
    expect(renderMarkdownLite('**Sigmoid 函数：**解释')).toBe('<b>Sigmoid 函数：</b>解释');
    expect(renderMarkdownLite('这是 *重点* 内容')).toBe('这是 <i>重点</i> 内容');
  });

  it('leaves a lone ** (math hugging) and product asterisks alone', () => {
    expect(renderMarkdownLite('2*3*4')).toBe('2*3*4');
    expect(renderMarkdownLite('a ** b')).toBe('a ** b');
  });

  it('turns a line heading into a md-h span without adding block markup', () => {
    expect(renderMarkdownLite('### 核心公式\n下一行')).toBe(
      '<span class="md-h">核心公式</span>\n下一行',
    );
  });

  it('renders `code` spans and keeps their content out of the emphasis passes', () => {
    expect(renderMarkdownLite('用 `sigmoid(x)` 实现')).toBe('用 <code class="md-c">sigmoid(x)</code> 实现');
    expect(renderMarkdownLite('`a * b` 不变')).toBe('<code class="md-c">a * b</code> 不变');
  });

  it('keeps newlines raw so the pane pre-wrap layout is unchanged', () => {
    expect(renderMarkdownLite('一行\n两行\n三行')).toBe('一行\n两行\n三行');
  });

  it('handles a realistic sigmoid answer body', () => {
    const html = renderMarkdownLite(
      '**Sigmoid（S 形函数）**\n\n公式：σ(z) = 1 / (1 + e^(-z))，`range` 在 0~1。\n\n- 单调递增\n- 导数 σ\' = σ(1-σ)',
    );
    expect(html).toContain('<b>Sigmoid（S 形函数）</b>');
    expect(html).toContain('<code class="md-c">range</code>');
    expect(html).toContain('- 单调递增');
    expect(html).not.toContain('**');
  });
});
