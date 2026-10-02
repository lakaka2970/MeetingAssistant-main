import { describe, expect, it } from 'vitest';
import {
  clearInFlight,
  isContinuation,
  planAsk,
  SPEC_REPLACE_WINDOW_MS,
  type InFlightAsk,
} from '../shared/speculativeAsk';

const flight = (over: Partial<InFlightAsk> = {}): InFlightAsk => ({
  requestId: 'req-1',
  text: '你们这个季度的交付节奏是怎么安排的？',
  firedAt: 10_000,
  ...over,
});

describe('continuation detection', () => {
  it('treats an un-punctuated previous line as one sentence continuing', () => {
    expect(
      isContinuation('我们把首帧时间降了大概', '三成，卡顿率从四个点降到一点五', 300),
    ).toBe(true);
  });

  it('keeps a connector-led full question separate', () => {
    // two asks, not one sentence chopped in two: merging would degrade both
    expect(isContinuation('这个方案上线了吗？', '还有灰度是怎么做的？', 400)).toBe(false);
    // the same connector leading a fragment that cannot stand alone is a tail
    expect(isContinuation('这个方案上线了吗？', '还有', 400)).toBe(true);
  });

  it('treats a bare short fragment as the rest of the previous line', () => {
    expect(isContinuation('你说的那个协议', '具体指哪一层', 200)).toBe(true);
  });

  it('keeps a genuinely separate question separate', () => {
    expect(
      isContinuation('你们团队多少人？', '那你们下个季度的重点是什么？', 400),
    ).toBe(false);
  });

  it('gives up once the replace window has passed', () => {
    expect(
      isContinuation('这个方案的取舍是什么', '还有呢', SPEC_REPLACE_WINDOW_MS + 1),
    ).toBe(false);
  });

  it('ignores an empty follow-up', () => {
    expect(isContinuation('第一句没说完', '   ', 100)).toBe(false);
  });
});

describe('ask planning', () => {
  it('fires immediately on an obvious, silence-closed question when enabled', () => {
    const p = planAsk({
      speculative: true,
      reason: 'silence',
      line: '你们怎么做弱网对抗的？',
      inFlight: null,
      now: 1,
    });
    expect(p).toEqual({ action: 'fire', why: 'speculative' });
  });

  it('speculates on a maxlen line but never during a flush', () => {
    expect(
      planAsk({
        speculative: true,
        reason: 'maxlen',
        line: '你们怎么做弱网对抗的？',
        inFlight: null,
        now: 1,
      }).action,
    ).toBe('fire');
    expect(
      planAsk({
        speculative: true,
        reason: 'flush',
        line: '你们怎么做弱网对抗的？',
        inFlight: null,
        now: 1,
      }).action,
    ).toBe('debounce');
  });

  it('leaves ambiguous lines to the debounce plus model gate', () => {
    const p = planAsk({
      speculative: true,
      reason: 'silence',
      line: '我这边主要是做实时链路的',
      inFlight: null,
      now: 1,
    });
    expect(p).toEqual({ action: 'debounce', gate: undefined });
  });

  it('behaves exactly like today when the switch is off', () => {
    expect(
      planAsk({
        speculative: false,
        reason: 'silence',
        line: '你们怎么做弱网对抗的？',
        inFlight: null,
        now: 1,
      }),
    ).toEqual({ action: 'debounce', gate: 'answer' });
  });

  it('merges a continuation and asks it as one question', () => {
    const p = planAsk({
      speculative: true,
      reason: 'silence',
      line: '还有灰度策略呢',
      inFlight: flight({ text: '这套自适应 FEC 的取舍是什么' }),
      now: 10_400,
    });
    expect(p).toEqual({ action: 'replace', merged: '这套自适应 FEC 的取舍是什么，还有灰度策略呢', why: 'continuation' });
  });

  it('falls back to the ordinary wait for an unrelated line asked mid-flight', () => {
    const p = planAsk({
      speculative: true,
      reason: undefined,
      line: '你们团队现在几个人？',
      inFlight: flight(),
      now: 10_400,
    });
    // never 'hold': dropping a real question to save a call is not acceptable
    expect(p).toEqual({ action: 'debounce', gate: 'answer' });
  });

  it('skips greetings and logistics without asking anything', () => {
    expect(
      planAsk({
        speculative: true,
        reason: 'silence',
        line: '嗯嗯',
        inFlight: null,
        now: 1,
      }).action,
    ).toBe('skip');
  });
});

describe('in-flight bookkeeping', () => {
  it('clears only the ask that just settled', () => {
    const f = flight();
    expect(clearInFlight(f, 'other')).toBe(f);
    expect(clearInFlight(f, 'req-1')).toBeNull();
    expect(clearInFlight(null, 'req-1')).toBeNull();
  });
});
