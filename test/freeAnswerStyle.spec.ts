import { describe, expect, it } from 'vitest';
import { buildAnswerMessages, buildStablePrefix, retrievalQuery } from '../electron/llm/prompts';

const base = {
  mode: 'free' as const,
  recentTranscript: [],
  freeQuestion: 'shared_ptr 是线程安全的吗？',
  richness: 'standard' as const,
  expertise: 'professional' as const,
};

describe('free-ask answer style and voice', () => {
  it('applies the standard length ladder (was skipped before, producing essays)', () => {
    const msgs = buildAnswerMessages({ ...base });
    const sys = msgs[0];
    expect(sys.role).toBe('system');
    expect(sys.content).toContain('150-350');
    expect(sys.content).toContain('不得超过 400 字');
  });

  it('forbids source-revealing and code-pasting phrases', () => {
    const msgs = buildAnswerMessages({ ...base });
    const sys = msgs[0].content as string;
    expect(sys).toContain('禁止');
    expect(sys).toContain('贴代码');
    expect(sys).toContain('知识库');
  });

  it('requires faithfulness to recalled material and forbids fabrication', () => {
    const sys = buildAnswerMessages({ ...base })[0].content as string;
    expect(sys).toContain('核心结论与关键术语');
    expect(sys).toContain('不得改写或省略');
    expect(sys).toContain('不得编造材料之外');
  });

  it('keeps the system prefix byte-stable across questions (prefix-cache safety)', () => {
    const a = buildAnswerMessages({ ...base, ragContext: ['【知识库召回】块A'] });
    const b = buildAnswerMessages({ ...base, freeQuestion: '另一个问题', ragContext: ['【知识库召回】块B'] });
    expect(a[0]).toEqual(b[0]);
    // the variable recall must ride the user message, not the system head
    expect(JSON.stringify(a.slice(1))).toContain('块A');
    expect(JSON.stringify(b.slice(1))).toContain('块B');
  });

  it('keeps recent turns intact under a total budget (follow-up antecedent survives)', () => {
    const history = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `${i}:` + 'x'.repeat(350),
    }));
    const msgs = buildAnswerMessages({ ...base, history });
    const hist = msgs.filter((m) => typeof m.content === 'string' && /^\d:xxx/.test(m.content));
    // 2400 budget / 352 chars = 6 newest kept verbatim, oldest two dropped
    expect(hist.length).toBe(6);
    expect(hist.every((m) => !(m.content as string).includes('（略）'))).toBe(true);
    expect(hist[0].content).toContain('2:');
    expect(hist[hist.length - 1].content).toContain('7:');
  });

  it('caps a single essay message so it cannot eat the whole budget', () => {
    const history = [
      { role: 'user' as const, content: 'old question' },
      { role: 'assistant' as const, content: 'y'.repeat(3000) },
    ];
    const msgs = buildAnswerMessages({ ...base, history });
    const hist = msgs.filter((m) => typeof m.content === 'string' && m.content.startsWith('yyy'));
    expect(hist.length).toBe(1);
    expect((hist[0].content as string).length).toBeLessThanOrEqual(1510);
    expect(hist[0].content).toContain('（略）');
  });
});

describe('retrievalQuery follow-up expansion', () => {
  const hist = [
    { role: 'user' as const, content: 'shared_ptr 是线程安全的吗？' },
    { role: 'assistant' as const, content: '计数安全，对象不安全。' },
  ];

  it('expands an anaphoric follow-up with the previous question', () => {
    expect(retrievalQuery('那弱计数呢？', hist)).toBe('那弱计数呢？ shared_ptr 是线程安全的吗？');
    expect(retrievalQuery('它安全吗', hist)).toContain('shared_ptr');
  });

  it('leaves standalone questions untouched', () => {
    expect(retrievalQuery('什么是多态？', hist)).toBe('什么是多态？');
    expect(retrievalQuery('TCP 为什么三次握手', hist)).toBe('TCP 为什么三次握手');
  });

  it('strips the free-mode reference wrapper from the prior turn', () => {
    const wrapped = [{ role: 'user' as const, content: '【知识库召回】块A\n\n问题：vector 扩容机制' }];
    expect(retrievalQuery('那迭代器呢？', wrapped)).toBe('那迭代器呢？ vector 扩容机制');
  });

  it('returns the question unchanged when there is no history', () => {
    expect(retrievalQuery('那弱计数呢？', [])).toBe('那弱计数呢？');
  });
});

describe('interview stable prefix voice', () => {
  it('carries the same voice prohibitions as free ask', () => {
    const prefix = buildStablePrefix({ lang: 'chinese' });
    expect(prefix).toContain('贴代码');
    expect(prefix).toContain('知识库');
  });
});