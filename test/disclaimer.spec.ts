/**
 * The disclaimer is legal wording shown on two surfaces (help panel, wizard
 * summary) in two languages. These specs pin the four points, their numbering,
 * and the fact that the short form points at the long one by name — so the two
 * copies cannot drift apart silently.
 */
import { describe, expect, it } from 'vitest';
import { DISCLAIMER } from '../shared/disclaimer';

/** one keyword per point: experimental / no profit / user bears it / licence */
const POINTS_ZH = ['试验', '利益', '使用者', 'Apache'];
const POINTS_EN = ['experiment', 'no profit', 'borne by the person using it', 'apache'];

describe('shared disclaimer copy', () => {
  it('states the four points in zh, numbered last', () => {
    const zh = DISCLAIMER.zh;
    expect(zh.title).toBe('13. 免责声明');
    expect(zh.lines).toHaveLength(POINTS_ZH.length);
    const text = zh.lines.join('\n');
    for (const needle of POINTS_ZH) expect(text).toContain(needle);
  });

  it('states the same four points in en', () => {
    const en = DISCLAIMER.en;
    expect(en.title).toBe('13. Disclaimer');
    expect(en.lines).toHaveLength(POINTS_EN.length);
    const text = en.lines.join('\n').toLowerCase();
    for (const needle of POINTS_EN) expect(text).toContain(needle);
  });

  it('has the wizard short form name the topic it points at', () => {
    expect(DISCLAIMER.zh.short).toContain('免责');
    expect(DISCLAIMER.zh.short).toContain(DISCLAIMER.zh.title);
    expect(DISCLAIMER.en.short.toLowerCase()).toContain('disclaimer');
    expect(DISCLAIMER.en.short).toContain(DISCLAIMER.en.title);
  });
});
