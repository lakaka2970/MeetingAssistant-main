import { describe, expect, it } from 'vitest';
import { buildExamAskMessages, buildExamCheckMessages, CHECK_ANSWER_MAX_CHARS } from '../electron/llm/examPrompts';

const system = (mode: 'technical' | 'aptitude' | 'open' | 'personality'): string =>
  buildExamAskMessages({ subMode: mode, question: 'q' })[0].content as string;

describe('algorithm answer contract', () => {
  it('tells the model to fence its code and name the language', () => {
    const s = system('technical');
    expect(s).toContain('带语言标签的围栏块');
    expect(s).toContain('cpp / java / python / javascript / typescript / go');
  });

  it('demands the given signature be kept, so the snippet pastes into the judge', () => {
    expect(system('technical')).toContain('保留题目给定的函数签名');
  });

  it('caps what may sit outside the fence', () => {
    const s = system('technical');
    expect(s).toContain('块外只允许两行');
  });

  it('keeps the existing style rules untouched', () => {
    const s = system('technical');
    expect(s).toContain('第一行用一句话讲思路');
    expect(s).toContain('复杂度写在代码后面一行说明');
  });

  it('does not leak the contract into the other sub-modes', () => {
    for (const mode of ['aptitude', 'open', 'personality'] as const) {
      expect(system(mode)).not.toContain('围栏块');
    }
  });
});

describe('buildExamCheckMessages', () => {
  it('asks for a verdict line and nothing else when the answer is fine', () => {
    const [sys] = buildExamCheckMessages({ question: 'q', answer: 'a' });
    const content = sys.content as string;
    expect(content).toContain('VERDICT: OK');
    expect(content).toContain('VERDICT: FIX');
    expect(content).toContain('不要把能跑的代码改写成');
  });

  it('lists the five checks in order', () => {
    const content = buildExamCheckMessages({ question: 'q', answer: 'a' })[0].content as string;
    for (const probe of ['n=0/n=1', '能否编译', '复杂度与实现', '题目给定的签名', '第三方库']) {
      expect(content).toContain(probe);
    }
  });

  it('carries the question, the answer and the user hint into the user turn', () => {
    const [, user] = buildExamCheckMessages({ question: '两数之和', answer: 'int main(){}', hint: '越界了' });
    expect(user.content).toContain('【题目】\n两数之和');
    expect(user.content).toContain('【我的答案】\nint main(){}');
    expect(user.content).toContain('【用户指出的问题】\n越界了');
  });

  it('feeds earlier verdicts back so round 3 does not repeat round 2', () => {
    const [, user] = buildExamCheckMessages({ question: 'q', answer: 'a', priorNotes: ['第 1 轮：少了空数组判断'] });
    expect(user.content).toContain('【此前几轮复核的结论】');
    expect(user.content).toContain('第 1 轮：少了空数组判断');
  });

  it('truncates a long answer instead of sending the world', () => {
    const [, user] = buildExamCheckMessages({ question: 'q', answer: 'x'.repeat(CHECK_ANSWER_MAX_CHARS + 500) });
    expect(user.content).not.toContain('x'.repeat(CHECK_ANSWER_MAX_CHARS + 1));
  });

  it('omits the hint and history blocks when there are none', () => {
    const [, user] = buildExamCheckMessages({ question: 'q', answer: 'a' });
    expect(user.content).not.toContain('【用户指出的问题】');
    expect(user.content).not.toContain('【此前几轮复核的结论】');
  });
});
