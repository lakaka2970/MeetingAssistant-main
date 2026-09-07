import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRATEGY_OPTIONS,
  normalizeStrategyMode,
  shouldUseFastEngine,
  strategyLabel,
} from '../electron/asr/strategy';

describe('shouldUseFastEngine (moonshine English fast lane)', () => {
  it('accuracy mode never takes the fast lane', () => {
    const opts = { ...DEFAULT_STRATEGY_OPTIONS, mode: 'accuracy' as const };
    expect(shouldUseFastEngine(opts, 'english', 3000)).toBe(false);
    expect(shouldUseFastEngine(opts, 'chinese', 3000)).toBe(false);
  });

  it('latency mode sends every English segment to the fast lane', () => {
    const opts = { ...DEFAULT_STRATEGY_OPTIONS, mode: 'latency' as const };
    expect(shouldUseFastEngine(opts, 'english', 500)).toBe(true);
    expect(shouldUseFastEngine(opts, 'english', 20000)).toBe(true);
  });

  it('balanced mode gates on segment length', () => {
    const opts = { ...DEFAULT_STRATEGY_OPTIONS, mode: 'balanced' as const, maxBalancedAudioMs: 8000 };
    expect(shouldUseFastEngine(opts, 'english', 8000)).toBe(true);
    expect(shouldUseFastEngine(opts, 'english', 8001)).toBe(false);
  });

  it('chinese and unknown languages always stay on the primary engine', () => {
    for (const mode of ['accuracy', 'balanced', 'latency'] as const) {
      const opts = { ...DEFAULT_STRATEGY_OPTIONS, mode };
      expect(shouldUseFastEngine(opts, 'chinese', 1000)).toBe(false);
      expect(shouldUseFastEngine(opts, 'auto', 1000)).toBe(false);
    }
  });
});

describe('normalizeStrategyMode + strategyLabel', () => {
  it('normalizes unknown/absent modes to balanced', () => {
    expect(normalizeStrategyMode(undefined)).toBe('balanced');
    expect(normalizeStrategyMode('weird')).toBe('balanced');
    expect(normalizeStrategyMode('latency')).toBe('latency');
    expect(normalizeStrategyMode('accuracy')).toBe('accuracy');
  });

  it('labels each mode for logs/diagnostics', () => {
    expect(strategyLabel({ mode: 'accuracy', maxBalancedAudioMs: 8000 })).toContain('accuracy');
    expect(strategyLabel({ mode: 'latency', maxBalancedAudioMs: 8000 })).toContain('moonshine');
    expect(strategyLabel({ mode: 'balanced', maxBalancedAudioMs: 8000 })).toContain('8s');
  });
});
