/**
 * Answer style ladder (shared): how much to say and in what register. Pure data
 * + pure function — importable from main (stable prefix assembly) and renderer
 * (the quick-switcher). Output feeds the BYTE-STABLE system prompt, so nothing
 * here may vary per question; it varies only when the user moves the ladder.
 */

export type AnswerRichness = 'concise' | 'standard' | 'detailed';
export type AnswerExpertise = 'casual' | 'professional' | 'technical';

/** the v1.0.0 behaviour: teleprompter default, no extra register directive */
export const DEFAULT_RICHNESS: AnswerRichness = 'standard';
export const DEFAULT_EXPERTISE: AnswerExpertise = 'professional';

/** structure line + spoken-length line per richness step */
const RICHNESS: Record<AnswerRichness, [string, string]> = {
  concise: [
    '- 第一句先给结论，最多再补 1-2 个短要点；',
    '- 全文控制在 15-25 秒内可念完（约 60-120 字）；',
  ],
  standard: [
    '- 第一句先给结论或直接回应，再展开 2-3 个短要点；',
    '- 全文控制在 30-60 秒内可念完（约 150-350 字）；',
  ],
  detailed: [
    '- 第一句先给结论，再分层展开 3-5 个要点，每层一句话说清；',
    '- 全文控制在 90-150 秒内可念完（约 400-700 字）；',
  ],
};

/**
 * professional contributes no line of its own — the wording the persona already
 * carries is the professional register, and adding one would move the cached
 * prefix for every existing install.
 */
const EXPERTISE: Record<AnswerExpertise, string[]> = {
  casual: ['- 用大白话说，不得不用的术语就地解释一句；'],
  professional: [],
  technical: ['- 可以直接上术语与指标，并补一句复杂度或方案权衡；'],
};

export function buildStyleDirectives(
  richness: AnswerRichness,
  expertise: AnswerExpertise,
): string[] {
  return [...RICHNESS[richness], ...EXPERTISE[expertise]];
}
