import { describe, expect, it } from 'vitest';
import { parseCheckOutput } from '../shared/answerCheck';

describe('parseCheckOutput', () => {
  it('accepts a clean OK verdict with no revision', () => {
    expect(parseCheckOutput('VERDICT: OK')).toEqual({ verdict: 'ok', note: '', revision: '' });
  });

  it('tolerates the fences and prose a model wraps around the verdict line', () => {
    const r = parseCheckOutput('好的，我看完了。\nVERDICT: ok\n');
    expect(r.verdict).toBe('ok');
  });

  it('extracts the one-line cause and the revision from a FIX', () => {
    const r = parseCheckOutput('VERDICT: FIX\n空数组时 nums[1] 越界\n【修订】\n```cpp\nint x;\n```');
    expect(r.verdict).toBe('fix');
    expect(r.note).toBe('空数组时 nums[1] 越界');
    expect(r.revision).toBe('```cpp\nint x;\n```');
  });

  it('accepts the revision marker on the same line as the text', () => {
    const r = parseCheckOutput('VERDICT: FIX\n越界\n【修订】 复杂度写错了\nreturn 1;');
    expect(r.note).toBe('越界');
    expect(r.revision).toBe('复杂度写错了\nreturn 1;');
  });

  it('downgrades a FIX with no revision to unknown, keeping the cause', () => {
    const r = parseCheckOutput('VERDICT: FIX\n少了取模');
    expect(r).toEqual({ verdict: 'unknown', note: '少了取模', revision: '' });
  });

  it('never guesses a verdict when the first line is not one', () => {
    const r = parseCheckOutput('这段代码看起来是对的，边界也处理了。');
    expect(r.verdict).toBe('unknown');
    expect(r.note).toContain('这段代码看起来是对的');
  });

  it('treats empty output as unknown with no note', () => {
    expect(parseCheckOutput('   ')).toEqual({ verdict: 'unknown', note: '', revision: '' });
  });

  it('clips a runaway note instead of pasting the whole reply into a badge', () => {
    const r = parseCheckOutput(`VERDICT: FIX\n${'错'.repeat(2000)}\n【修订】\nx`);
    expect(r.note.length).toBeLessThanOrEqual(300);
    expect(r.revision).toBe('x');
  });

  it('keeps indentation and blank lines inside the revised code intact', () => {
    const body = '```cpp\nint main() {\n    int x = 0;\n\n    if (!x) return 1;\n    return 0;\n}\n```';
    const r = parseCheckOutput(`VERDICT: FIX\n空数组越界\n【修订】\n${body}`);
    expect(r.revision).toBe(body);
  });

  it('takes only the next non-empty line as the cause', () => {
    const r = parseCheckOutput('VERDICT: FIX\n第一行\n第二行\n【修订】\nx');
    expect(r.note).toBe('第一行');
    expect(r.revision).toBe('x');
  });

  it('collapses an unparseable multi-line reply into a single-line note', () => {
    const r = parseCheckOutput('这段代码\n看了几行\n应该没问题');
    expect(r.verdict).toBe('unknown');
    expect(r.note).toBe('这段代码 看了几行 应该没问题');
  });

  it('does not eat the revision when the marker sits on the cause line', () => {
    const r = parseCheckOutput('VERDICT: FIX\n【修订】\ndef f():\n    return 1');
    expect(r.verdict).toBe('fix');
    expect(r.note).toBe('');
    expect(r.revision).toBe('def f():\n    return 1');
  });
});
