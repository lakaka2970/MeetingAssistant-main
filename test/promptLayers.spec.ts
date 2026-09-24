import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERSONA_HEAD,
  DEFAULT_PERSONA_TAIL,
  DEFAULT_PERSONA_TEMPLATE,
  DEFAULT_STYLE_DIRECTIVES,
} from '../shared/promptLayers';

// the main-process composer assembles its default block from THESE lines —
// a second copy would drift the moment anyone edits one side
import { buildStablePrefix } from '../electron/llm/prompts';

describe('shared/promptLayers (v1.0.1 editable layer originals)', () => {
  it('keeps the head/tail line counts the style ladder offsets depend on', () => {
    expect(DEFAULT_PERSONA_HEAD).toHaveLength(3);
    expect(DEFAULT_PERSONA_TAIL).toHaveLength(5);
  });

  it('exposes the persona template without the style directives', () => {
    const lines = DEFAULT_PERSONA_TEMPLATE.split('\n');
    expect(lines).toHaveLength(DEFAULT_PERSONA_HEAD.length + DEFAULT_PERSONA_TAIL.length);
    for (const directive of DEFAULT_STYLE_DIRECTIVES) {
      expect(lines).not.toContain(directive);
    }
    expect(lines[0]).toContain('提词器');
  });

  it('defaults the ladder to the two v1.0.0 directive lines', () => {
    expect(DEFAULT_STYLE_DIRECTIVES).toHaveLength(2);
  });

  it('is what the prompt composer assembles its default block from', () => {
    const prefix = buildStablePrefix({ lang: 'chinese' });
    const block = [
      ...DEFAULT_PERSONA_HEAD,
      ...DEFAULT_STYLE_DIRECTIVES,
      ...DEFAULT_PERSONA_TAIL,
    ].join('\n');
    expect(prefix).toContain(block);
  });
});
