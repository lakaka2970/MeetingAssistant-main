import { describe, expect, it } from 'vitest';
import { supplementMessages, isNoSupplement, NO_SUPPLEMENT } from '../shared/webSupplement';

describe('supplementMessages', () => {
  it('builds a system+user exchange carrying question, answer and web lines', () => {
    const msgs = supplementMessages('Q?', 'A main answer.', ['[t1|u1] s1', '[t2|u2] s2']);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    const all = msgs.map((m) => m.content).join('\n');
    expect(all).toContain('Q?');
    expect(all).toContain('A main answer.');
    expect(all).toContain('[t1|u1] s1');
    expect(all).toContain('[t2|u2] s2');
  });

  it('documents the sentinel contract in the system prompt', () => {
    const msgs = supplementMessages('Q', 'A', ['x']);
    expect(msgs[0].content).toContain(NO_SUPPLEMENT);
  });
});

describe('isNoSupplement', () => {
  it('accepts only the bare sentinel (trimmed)', () => {
    expect(isNoSupplement(NO_SUPPLEMENT)).toBe(true);
    expect(isNoSupplement(` ${NO_SUPPLEMENT} \n`)).toBe(true);
    expect(isNoSupplement('')).toBe(false);
    expect(isNoSupplement(`${NO_SUPPLEMENT}：无补充`)).toBe(false); // prose wins: show it
    expect(isNoSupplement('补充要点：X')).toBe(false);
  });
});
