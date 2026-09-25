/**
 * Answer style ladder (shared): how much to say and in what register. Pure data
 * + pure function — importable from main (stable prefix assembly) and renderer
 * (the quick-switcher). Output feeds the BYTE-STABLE system prompt, so nothing
 * here may vary per question; it varies only when the user moves the ladder.
 */

/** the rungs, in the order the UI shows them */
export const RICHNESS_STEPS = ['concise', 'standard', 'detailed'] as const;
export const EXPERTISE_STEPS = ['casual', 'professional', 'technical'] as const;

export type AnswerRichness = (typeof RICHNESS_STEPS)[number];
export type AnswerExpertise = (typeof EXPERTISE_STEPS)[number];

/**
 * Is this a rung at all? settings.json is hand-editable, and the only reader of
 * these two is {@link buildStyleDirectives}, which throws on a name it does not
 * have — so the check belongs on the way in, not in the prompt builder.
 */
export function isRichness(value: unknown): value is AnswerRichness {
  return (RICHNESS_STEPS as readonly string[]).includes(value as string);
}

export function isExpertise(value: unknown): value is AnswerExpertise {
  return (EXPERTISE_STEPS as readonly string[]).includes(value as string);
}

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
