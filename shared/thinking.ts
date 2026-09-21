/**
 * Model thinking-effort mapping (shared): one UI ladder (off/low/medium/high)
 * translated per provider style into the request fields each vendor actually
 * accepts. Pure data + pure function — importable from renderer and main.
 */

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/**
 * How a provider spells its thinking control:
 *  - 'deepseek':        thinking {type} + reasoning_effort (low|high|max)
 *  - 'thinking_type':   thinking {type} only (GLM-style binary switch)
 *  - 'enable_thinking': enable_thinking bool + thinking_budget int (DashScope)
 *  - 'reasoning_effort': reasoning_effort string (OpenAI-compatible ladder)
 */
export type ThinkingStyle = 'deepseek' | 'thinking_type' | 'enable_thinking' | 'reasoning_effort';

export interface ThinkingCapability {
  style: ThinkingStyle;
  /** non-off levels this model actually exposes in the UI */
  levels: Exclude<ThinkingLevel, 'off'>[];
}

/** Extra request-body fields for one (style, level) pair. {} = send nothing extra. */
export function buildThinkingParams(style: ThinkingStyle, level: ThinkingLevel): Record<string, unknown> {
  switch (style) {
    case 'deepseek':
      return level === 'off'
        ? { thinking: { type: 'disabled' } }
        : {
            thinking: { type: 'enabled' },
            reasoning_effort: { low: 'low', medium: 'high', high: 'max' }[level],
          };
    case 'thinking_type':
      return { thinking: { type: level === 'off' ? 'disabled' : 'enabled' } };
    case 'enable_thinking':
      return level === 'off'
        ? { enable_thinking: false }
        : { enable_thinking: true, thinking_budget: { low: 1024, medium: 4096, high: 8192 }[level] };
    case 'reasoning_effort':
      return { reasoning_effort: level === 'off' ? 'none' : level };
  }
}
