import { describe, it, expect } from 'vitest';
import { splitMath } from '../shared/mathSplit';

describe('splitMath (answer-body math delimiters)', () => {
  it('leaves prose without delimiters as a single text segment', () => {
    expect(splitMath('just some words')).toEqual([{ type: 'text', text: 'just some words' }]);
  });

  it('splits inline $…$ into a math segment', () => {
    const segs = splitMath('Solve $x^2 = 4$.');
    expect(segs).toEqual([
      { type: 'text', text: 'Solve ' },
      { type: 'math', tex: 'x^2 = 4', display: false },
      { type: 'text', text: '.' },
    ]);
  });

  it('splits display $$…$$ into a display-math segment', () => {
    const segs = splitMath('before\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nafter');
    expect(segs).toEqual([
      { type: 'text', text: 'before\n\n' },
      { type: 'math', tex: '\n\\int_0^1 x\\,dx\n', display: true },
      { type: 'text', text: '\n\nafter' },
    ]);
  });

  it('supports \\(…\\) inline and \\[…\\] display', () => {
    expect(splitMath('\\(a+b\\)')).toEqual([{ type: 'math', tex: 'a+b', display: false }]);
    expect(splitMath('\\[x_1 + y_2\\]')).toEqual([{ type: 'math', tex: 'x_1 + y_2', display: true }]);
  });

  it('does not mistake a currency run like "$5 and $10" for math', () => {
    const segs = splitMath('costs $5 and $10 today');
    expect(segs).toEqual([{ type: 'text', text: 'costs $5 and $10 today' }]);
  });

  it('keeps an unclosed inline $ as literal text', () => {
    expect(splitMath('total is $42')).toEqual([{ type: 'text', text: 'total is $42' }]);
  });

  it('rejects inline math with surrounding whitespace', () => {
    // the body has a trailing space, so it is not convincing inline math
    expect(splitMath('$5 and $')).toEqual([{ type: 'text', text: '$5 and $' }]);
  });

  it('renders mixed prose and several formulas in order', () => {
    const segs = splitMath('F=ma: $F=ma$. Energy: $$E=mc^2$$ done');
    expect(segs).toEqual([
      { type: 'text', text: 'F=ma: ' },
      { type: 'math', tex: 'F=ma', display: false },
      { type: 'text', text: '. Energy: ' },
      { type: 'math', tex: 'E=mc^2', display: true },
      { type: 'text', text: ' done' },
    ]);
  });
});
