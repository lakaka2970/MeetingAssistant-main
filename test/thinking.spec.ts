import { describe, expect, it } from 'vitest';
import {
  buildThinkingParams,
  type ThinkingLevel,
  type ThinkingStyle,
} from '../shared/thinking';

describe('buildThinkingParams', () => {
  it('deepseek: off disables thinking without an effort field', () => {
    expect(buildThinkingParams('deepseek', 'off')).toEqual({
      thinking: { type: 'disabled' },
    });
  });

  it('deepseek: low/medium/high map onto its low/high/max ladder', () => {
    expect(buildThinkingParams('deepseek', 'low')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    });
    expect(buildThinkingParams('deepseek', 'medium')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(buildThinkingParams('deepseek', 'high')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
  });

  it('thinking_type (binary switch providers): any level above off enables it', () => {
    expect(buildThinkingParams('thinking_type', 'off')).toEqual({
      thinking: { type: 'disabled' },
    });
    for (const level of ['low', 'medium', 'high'] as ThinkingLevel[]) {
      expect(buildThinkingParams('thinking_type', level)).toEqual({
        thinking: { type: 'enabled' },
      });
    }
  });

  it('enable_thinking (DashScope): off is false, levels set a budget', () => {
    expect(buildThinkingParams('enable_thinking', 'off')).toEqual({
      enable_thinking: false,
    });
    const budgets: Record<string, number> = { low: 1024, medium: 4096, high: 8192 };
    for (const [level, budget] of Object.entries(budgets)) {
      expect(buildThinkingParams('enable_thinking', level as ThinkingLevel)).toEqual({
        enable_thinking: true,
        thinking_budget: budget,
      });
    }
  });

  it('reasoning_effort (OpenAI-compatible): off sends none', () => {
    const expectLevel = (style: ThinkingStyle, level: ThinkingLevel, effort: string) => {
      expect(buildThinkingParams(style, level)).toEqual({ reasoning_effort: effort });
    };
    expectLevel('reasoning_effort', 'off', 'none');
    expectLevel('reasoning_effort', 'low', 'low');
    expectLevel('reasoning_effort', 'medium', 'medium');
    expectLevel('reasoning_effort', 'high', 'high');
  });
});
