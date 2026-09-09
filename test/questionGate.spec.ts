import { describe, it, expect } from 'vitest';
import {
  GATE_TIMEOUT_MS,
  GateMemory,
  gateMessages,
  heuristic,
  parseVerdict,
} from '../shared/questionGate';

describe('heuristic — the free first tier', () => {
  it('skips greetings, fragments and logistics without any model call', () => {
    for (const line of ['你好', '嗯嗯', '对对对', '好的收到', '稍等', '辛苦啦']) {
      expect(heuristic(line).verdict).toBe('skip');
    }
    expect(heuristic('把这个链接发我一下').verdict).toBe('skip');
    expect(heuristic('我共享一下屏幕').verdict).toBe('skip');
  });

  it('answers a marked question or an explicit ask immediately', () => {
    expect(heuristic('你为什么会选择离开上一家公司？').verdict).toBe('answer');
    expect(heuristic('介绍一下你的项目难点').verdict).toBe('answer');
    expect(heuristic('How does you handle conflict?').verdict).toBe('answer');
    expect(heuristic('讲讲 Redis 的持久化原理').verdict).toBe('answer');
  });

  it('leaves only genuinely ambiguous lines for the classifier', () => {
    const h = heuristic('我们团队大概十个人左右,平时用 kanban 管理任务');
    expect(h.verdict).toBeUndefined();
    expect(h.why).toBe('ambiguous');
  });

  it('reports the question kind alongside the decision (routing reuses it)', () => {
    expect(heuristic('手写一个防抖函数').kind).toBe('coding');
    expect(heuristic('你的缺点是什么？').kind).toBe('behavioral');
  });
});

describe('parseVerdict — the classifier answers with one word', () => {
  it('accepts the shapes a chat model actually returns', () => {
    expect(parseVerdict('ANSWER')).toBe('answer');
    expect(parseVerdict('answer')).toBe('answer');
    expect(parseVerdict('ANSWER.')).toBe('answer');
    expect(parseVerdict('SKIP')).toBe('skip');
    expect(parseVerdict('不需要')).toBe('skip');
    expect(parseVerdict('需要')).toBe('answer');
  });

  it('returns undefined rather than guessing from prose', () => {
    expect(parseVerdict('这道题应该回答')).toBeUndefined();
    expect(parseVerdict('')).toBeUndefined();
    expect(parseVerdict('   ')).toBeUndefined();
  });
});

describe('gateMessages', () => {
  it('demands a one-word answer and gives it the recent lines as context', () => {
    const msgs = gateMessages('你怎么看加班', ['我们先聊聊项目', '好的']);
    expect(msgs[0].content).toContain('ANSWER');
    expect(msgs[0].content).toContain('SKIP');
    expect(msgs[1].content).toContain('我们先聊聊项目');
    expect(msgs[1].content).toContain('你怎么看加班');
  });

  it('omits the context block when there is none', () => {
    expect(gateMessages('q', [])[1].content).not.toContain('【最近对话】');
  });
});

describe('GateMemory', () => {
  it('remembers a decision and expires it', () => {
    const m = new GateMemory(50, 10);
    m.set('a', 'skip');
    expect(m.get('a')).toBe('skip');
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(m.get('a')).toBeUndefined();
        resolve();
      }, 80),
    );
  });

  it('treats a pending entry as "already in flight" (no double calls)', () => {
    const m = new GateMemory();
    m.set('b', 'pending');
    expect(m.get('b')).toBe('pending');
  });

  it('evicts the oldest when it grows past the cap', () => {
    const m = new GateMemory(10 * 60_000, 3);
    for (const k of ['k1', 'k2', 'k3', 'k4']) m.set(k, 'answer');
    expect(m.size).toBeLessThanOrEqual(3);
    expect(m.get('k4')).toBe('answer');
  });
});

describe('the budget', () => {
  it('is shorter than the answer itself, so a slow classifier cannot delay a reply', () => {
    expect(GATE_TIMEOUT_MS).toBeLessThanOrEqual(2000);
    expect(GATE_TIMEOUT_MS).toBeGreaterThanOrEqual(500);
  });
});
