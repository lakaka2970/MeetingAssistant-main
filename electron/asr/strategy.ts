/**
 * ASR strategy routing (upgrade P1): which engine serves a segment.
 *
 * Two local engines coexist in the worker:
 *   primary   whisper-large-v3-turbo  — bilingual, most accurate, ~1 s
 *   fast lane moonshine-tiny          — English-only, sub-300 ms
 *
 * The rules are pure and unit-tested; the worker only executes them:
 *   accuracy  never fast-lane (whisper serves every segment)
 *   balanced  fast lane for short English utterances (LID + length gated)
 *   latency   fast lane for every English segment
 */

export type AsrStrategyMode = 'accuracy' | 'balanced' | 'latency';

export interface AsrStrategyOptions {
  mode: AsrStrategyMode;
  /** balanced mode: English segments up to this length take the fast lane */
  maxBalancedAudioMs: number;
}

export const DEFAULT_STRATEGY_OPTIONS: AsrStrategyOptions = {
  mode: 'balanced',
  maxBalancedAudioMs: 8000,
};

export function normalizeStrategyMode(mode: string | undefined): AsrStrategyMode {
  return mode === 'accuracy' || mode === 'latency' ? mode : 'balanced';
}

/**
 * Should THIS segment go to the fast (moonshine) engine? Chinese always stays
 * on the primary; unknown language ('auto' unresolved) stays primary too —
 * the caller decides with the sticky router language, never a raw guess.
 */
export function shouldUseFastEngine(
  opts: AsrStrategyOptions,
  lang: 'chinese' | 'english' | string,
  audioMs: number,
): boolean {
  if (opts.mode === 'accuracy') return false;
  if (lang !== 'english') return false;
  if (opts.mode === 'latency') return true;
  return audioMs <= opts.maxBalancedAudioMs;
}

/** human-readable summary for logs / diagnostics */
export function strategyLabel(opts: AsrStrategyOptions): string {
  switch (opts.mode) {
    case 'accuracy':
      return 'accuracy (whisper-only)';
    case 'latency':
      return 'latency (en → moonshine)';
    default:
      return `balanced (en ≤${Math.round(opts.maxBalancedAudioMs / 1000)}s → moonshine)`;
  }
}
