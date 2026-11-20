import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPERTISE,
  DEFAULT_RICHNESS,
  buildStyleDirectives,
} from '../shared/answerStyle';

/**
 * The teleprompter persona's original structure/length lines, plus the
 * 2026-11-20 tightening: standard was producing detailed-level essays, so the
 * ladder now carries hard caps and a format line. The default ladder must stay
 * byte-stable across calls (provider prefix cache), hence these pins.
 */
const LEGACY_STRUCTURE_LINE = '- 第一句先给结论或直接回应，再展开 1-3 个短要点，写完即停；';
const LEGACY_LENGTH_LINE = '- 全文控制在 30-60 秒内可念完（约 150-350 字），不得超过 400 字；';
const LEGACY_FORMAT_LINE = '- 不用多级标题、表格；不复述问题、不写结尾总结段；代码确有必要时最多 3 行；';

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
      LEGACY_FORMAT_LINE,
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

  it('the three structure/length/format lines stay put across expertise', () => {
    for (const x of ['casual', 'technical'] as const) {
      const lines = buildStyleDirectives('standard', x);
      expect(lines.slice(0, 3)).toEqual([LEGACY_STRUCTURE_LINE, LEGACY_LENGTH_LINE, LEGACY_FORMAT_LINE]);
    }
  });
});

describe('buildStyleDirectives expertise', () => {
  it('adds no diction line for professional so the default prefix stays put', () => {
    expect(buildStyleDirectives('standard', 'professional')).toHaveLength(3);
  });

  it('adds exactly one distinct diction line for casual and technical', () => {
    const casual = buildStyleDirectives('standard', 'casual');
    const technical = buildStyleDirectives('standard', 'technical');
    expect(casual).toHaveLength(4);
    expect(technical).toHaveLength(4);
    expect(casual[3]).not.toBe(technical[3]);
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
