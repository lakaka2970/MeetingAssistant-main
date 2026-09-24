import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPERTISE,
  DEFAULT_RICHNESS,
  buildStyleDirectives,
} from '../shared/answerStyle';

/**
 * The two lines the teleprompter persona hardcoded before the style ladder
 * existed (electron/llm/prompts.ts PERSONA). The default ladder must reproduce
 * them byte-for-byte: the stable prefix is shared with the provider prefix
 * cache, so a fresh v1.0.1 install has to send the same bytes v1.0.0 sent.
 */
const LEGACY_STRUCTURE_LINE = '- 第一句先给结论或直接回应，再展开 2-3 个短要点；';
const LEGACY_LENGTH_LINE = '- 全文控制在 30-60 秒内可念完（约 150-350 字）；';

/** read the 「约 150-350 字」 budget back out of a generated length line */
function charBudget(line: string): [number, number] {
  const m = line.match(/约 (\d+)-(\d+) 字/);
  expect(m, `no char budget in: ${line}`).not.toBeNull();
  return [Number(m![1]), Number(m![2])];
}

describe('buildStyleDirectives defaults', () => {
  it('reproduces the legacy persona lines verbatim on the default ladder', () => {
    expect(buildStyleDirectives(DEFAULT_RICHNESS, DEFAULT_EXPERTISE)).toEqual([
      LEGACY_STRUCTURE_LINE,
      LEGACY_LENGTH_LINE,
    ]);
  });

  it('defaults to standard richness at professional expertise', () => {
    expect(DEFAULT_RICHNESS).toBe('standard');
    expect(DEFAULT_EXPERTISE).toBe('professional');
  });

  it('is deterministic across calls', () => {
    expect(buildStyleDirectives('detailed', 'technical')).toEqual(
      buildStyleDirectives('detailed', 'technical'),
    );
  });
});

describe('buildStyleDirectives richness', () => {
  const lengthLine = (r: 'concise' | 'standard' | 'detailed') =>
    buildStyleDirectives(r, 'professional')[1];

  it('widens the spoken-length budget as richness rises', () => {
    const [cLo] = charBudget(lengthLine('concise'));
    const [sLo] = charBudget(lengthLine('standard'));
    const [dLo] = charBudget(lengthLine('detailed'));
    expect(cLo).toBeLessThan(sLo);
    expect(sLo).toBeLessThan(dLo);
  });

  it('raises the bullet count as richness rises', () => {
    const bullets = (r: 'concise' | 'standard' | 'detailed') => {
      const m = buildStyleDirectives(r, 'professional')[0].match(/(\d+)-(\d+) 个/);
      expect(m, `no bullet range for ${r}`).not.toBeNull();
      return Number(m![2]);
    };
    expect(bullets('concise')).toBeLessThan(bullets('standard'));
    expect(bullets('standard')).toBeLessThan(bullets('detailed'));
  });

  it('only the two structure/length lines change with expertise', () => {
    for (const x of ['casual', 'technical'] as const) {
      const lines = buildStyleDirectives('standard', x);
      expect(lines.slice(0, 2)).toEqual([LEGACY_STRUCTURE_LINE, LEGACY_LENGTH_LINE]);
    }
  });
});

describe('buildStyleDirectives expertise', () => {
  it('adds no diction line for professional so the default prefix stays put', () => {
    expect(buildStyleDirectives('standard', 'professional')).toHaveLength(2);
  });

  it('adds exactly one distinct diction line for casual and technical', () => {
    const casual = buildStyleDirectives('standard', 'casual');
    const technical = buildStyleDirectives('standard', 'technical');
    expect(casual).toHaveLength(3);
    expect(technical).toHaveLength(3);
    expect(casual[2]).not.toBe(technical[2]);
  });
});

describe('buildStyleDirectives line shape', () => {
  it('emits persona-style bullets only', () => {
    const all = [
      ...buildStyleDirectives(DEFAULT_RICHNESS, DEFAULT_EXPERTISE),
      ...buildStyleDirectives('concise', 'casual'),
      ...buildStyleDirectives('detailed', 'technical'),
    ];
    for (const line of all) {
      expect(line.startsWith('- '), line).toBe(true);
      expect(line.endsWith('；'), line).toBe(true);
      expect(line.includes('\n'), line).toBe(false);
    }
  });
});
