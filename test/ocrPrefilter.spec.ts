import { describe, expect, it } from 'vitest';
import { decideRoute, MIN_TEXT_CHARS } from '../electron/vision/ocrPrefilter';

describe('decideRoute (OCR prefilter, upgrade P2)', () => {
  it('routes text-rich extractions to the text LLM', () => {
    expect(decideRoute('Given an array of integers, return indices of the two numbers')).toBe('text');
    expect(decideRoute('讲讲 Redis 缓存穿透、击穿、雪崩的区别与解决方案')).toBe('text');
  });

  it('routes sparse/noisy extractions (charts, diagrams) to the vision model', () => {
    expect(decideRoute('')).toBe('vision');
    expect(decideRoute('Fig 3.2')).toBe('vision');
    expect(decideRoute('   \n\t  ')).toBe('vision');
  });

  it('honours the default threshold constant', () => {
    const exactly = 'a'.repeat(MIN_TEXT_CHARS);
    expect(decideRoute(exactly)).toBe('text');
    expect(decideRoute('a'.repeat(MIN_TEXT_CHARS - 1))).toBe('vision');
  });

  it('collapses whitespace before counting', () => {
    expect(decideRoute('a '.repeat(MIN_TEXT_CHARS))).toBe('text');
    expect(decideRoute('x\n\ny\t\tz   ')).toBe('vision'); // 5 real chars
  });
});
