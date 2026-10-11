import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyCheckCard, type Check, type CheckEvent } from '../src/exam/checkCard';

/**
 * These tests exist because the check round never streamed at all in the first
 * cut: the main process emits every `checkDelta` BEFORE the `check` header (the
 * verdict is parsed from the finished text), and the reducer required a header
 * first — so each token was dropped and the revision appeared in one block at
 * `checkDone`. The order under test is therefore delta-first, always.
 */
const header = (over: Partial<Extract<CheckEvent, { kind: 'check' }>> = {}): CheckEvent => ({
  kind: 'check',
  turn: 1,
  verdict: 'fix',
  note: '',
  ms: 1200,
  ...over,
});
const delta = (text: string, turn = 1): CheckEvent => ({ kind: 'checkDelta', turn, text });
const done = (text: string, turn = 1): CheckEvent => ({ kind: 'checkDone', turn, text });

const run = (events: CheckEvent[]): Check | null => events.reduce<Check | null>((c, ev) => applyCheckCard(c, ev), null);

describe('applyCheckCard — delta-first (what main actually sends)', () => {
  it('a token with no card opens a provisional one instead of being dropped', () => {
    const c = run([delta('思路：')]);
    expect(c).toEqual({ turn: 1, verdict: 'unknown', note: '', revision: '思路：', streaming: true, ms: 0 });
  });

  it('the provisional card grows token by token', () => {
    const c = run([delta('a'), delta('b'), delta('c')]);
    expect(c?.revision).toBe('abc');
    expect(c?.streaming).toBe(true);
  });

  it('the verdict header MERGES — the streamed revision survives it', () => {
    const c = run([delta('rev '), delta('part'), header({ note: '边界漏了空数组', ms: 900 })]);
    expect(c).toEqual({
      turn: 1,
      verdict: 'fix',
      note: '边界漏了空数组',
      revision: 'rev part',
      streaming: true,
      ms: 900,
    });
  });

  it('checkDone retells the round in full and closes the spinner', () => {
    const c = run([delta('rev '), header(), done('revision 全文')]);
    expect(c).toMatchObject({ revision: 'revision 全文', streaming: false, verdict: 'fix' });
  });

  it('an empty checkDone does not erase what already streamed', () => {
    const c = run([delta('streamed'), header(), done('')]);
    expect(c?.revision).toBe('streamed');
    expect(c?.streaming).toBe(false);
  });
});

describe('applyCheckCard — header-first (kept working for robustness)', () => {
  it('a fix header opens a streaming card and later tokens append to it', () => {
    const c = run([header(), delta('x'), done('x')]);
    expect(c).toMatchObject({ verdict: 'fix', revision: 'x', streaming: false });
  });

  it('an ok verdict is the round’s last word: no spinner, no revision', () => {
    const c = run([header({ verdict: 'ok', ms: 0 })]);
    expect(c).toEqual({ turn: 1, verdict: 'ok', note: '', revision: '', streaming: false, ms: 0 });
  });

  it('an unknown verdict says so, with the reason as note', () => {
    const c = run([delta('半截'), header({ verdict: 'unknown', note: '模型输出无法解析' })]);
    expect(c).toMatchObject({ verdict: 'unknown', note: '模型输出无法解析', streaming: false });
    // the partial text stays visible: the user must be able to see what was lost
    expect(c?.revision).toBe('半截');
  });
});

describe('applyCheckCard — orphans and turn boundaries', () => {
  it('a token after a settled round is dropped, not appended', () => {
    const settled = run([delta('a'), header(), done('a')]);
    expect(settled?.streaming).toBe(false);
    expect(applyCheckCard(settled, delta('a'))).toBe(settled); // same reference: nothing changed
  });

  it('the first token of round 2 supersedes round 1’s card', () => {
    const c = run([delta('r1', 1), header({ turn: 1 }), done('r1', 1), delta('r2 ', 2)]);
    expect(c).toMatchObject({ turn: 2, verdict: 'unknown', revision: 'r2 ', streaming: true });
  });

  it('a header whose turn differs from the card replaces it — no cross-round merge', () => {
    const c = run([delta('round 2 的 token', 2), header({ turn: 1, verdict: 'ok', note: '迟到的第 1 轮判词' })]);
    expect(c).toEqual({ turn: 1, verdict: 'ok', note: '迟到的第 1 轮判词', revision: '', streaming: false, ms: 1200 });
  });

  it('a checkDone with no card invents nothing', () => {
    expect(applyCheckCard(null, done('全文'))).toBe(null);
    const c = run([delta('x'), header()]);
    expect(applyCheckCard(c, done('别的轮次', 7))).toBe(c);
  });

  it('null in, null out for an unknown-free idle window', () => {
    expect(run([])).toBe(null);
  });
});

/**
 * The wiring the reducer cannot express: ExamApp must route all three phases
 * through it (the first cut hand-wrote three separate cases, which is how the
 * merge got lost) and must clear the card on every path that ends a round.
 */
describe('ExamApp check wiring', () => {
  const src = readFileSync(new URL('../src/exam/ExamApp.tsx', import.meta.url), 'utf8');

  it('routes all three check phases through the single reducer', () => {
    const at = src.indexOf("case 'check':");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('break;', at));
    expect(block).toContain("case 'checkDelta':");
    expect(block).toContain("case 'checkDone':");
    expect(block).toMatch(/setCheck\(\(c\) => applyCheckCard\(c, ev\)\)/);
  });

  it('cancel clears the card: an aborted round sends neither a header nor a done', () => {
    const at = src.indexOf('const stop = useCallback');
    const body = src.slice(at, src.indexOf('const copy = useCallback'));
    expect(body).toMatch(/window\.mcExam\.cancel/);
    expect(body).toMatch(/setCheck\(null\)/);
  });

  it('a new ask clears the card, on both the call and the begin event', () => {
    const ask = src.slice(src.indexOf('const ask = useCallback'), src.indexOf('const capture = useCallback'));
    expect(ask).toMatch(/setCheck\(null\)/);
    const begin = src.slice(src.indexOf("if (ev.kind === 'begin')"), src.indexOf("if (ev.kind === 'subMode')"));
    expect(begin).toMatch(/setCheck\(null\)/);
  });

  it('gives the user a way out of a streaming check card', () => {
    expect(src).toMatch(/answer\?\.streaming \|\| check\?\.streaming \? \(\s*\n\s*<button className="btn" onClick=\{stop\}/);
  });

  it('keeps note plain text and the revision in MathText — never mixed', () => {
    expect(src).toMatch(/<div className="exam-check-note">\{check\.note\}<\/div>/);
    expect(src).toMatch(/<MathText text=\{check\.revision\} codeLabels=\{t\.codeLabels\} \/>/);
  });
});
