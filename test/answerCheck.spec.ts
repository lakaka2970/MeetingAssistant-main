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
    expect(r.note.length).toBeLessThanOrEqual(301);
    expect(r.revision).toBe('x');
  });
});
