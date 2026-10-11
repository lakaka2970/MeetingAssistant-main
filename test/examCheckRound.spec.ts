import { describe, expect, it } from 'vitest';
import { shouldRunCheck } from '../shared/answerCheck';

describe('shouldRunCheck', () => {
  const code = '思路\n```cpp\nint main(){}\n```\n复杂度 O(1)';

  it('runs for the technical sub-mode', () => {
    expect(shouldRunCheck({ subMode: 'technical', question: '实现一个 LRU', answer: code, fromBank: false })).toBe(true);
  });

  it('runs when an open-mode question is clearly a coding question', () => {
    expect(shouldRunCheck({ subMode: 'open', question: '用 LeetCode 风格写一道算法题的解：两数之和', answer: code, fromBank: false })).toBe(true);
  });

  it('never runs on a bank-direct answer — the bank is already the certainty here', () => {
    expect(shouldRunCheck({ subMode: 'technical', question: 'q', answer: code, fromBank: true })).toBe(false);
  });

  it('stays out of aptitude and personality items', () => {
    expect(shouldRunCheck({ subMode: 'aptitude', question: '下列说法正确的是 A.甲 B.乙', answer: '选 A', fromBank: false })).toBe(false);
    expect(shouldRunCheck({ subMode: 'personality', question: '我常感到精力充沛', answer: '选「非常符合」', fromBank: false })).toBe(false);
  });

  it('has nothing to check in an empty answer', () => {
    expect(shouldRunCheck({ subMode: 'technical', question: 'q', answer: '  ', fromBank: false })).toBe(false);
  });
});
