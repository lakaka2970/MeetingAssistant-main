import { describe, expect, it } from 'vitest';
import { hasImageContent, type ChatMessage } from '../electron/llm/adapter';

// The answer path may only take the non-streaming vision transport when the
// prompt actually carries an image. A text-only interview answer routed
// through visionChat made the user wait for the whole completion with no
// first token — the regression these cases pin down.
describe('hasImageContent', () => {
  it('is false for plain-text messages (the interview answer shape)', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是面试助手' },
      { role: 'user', content: '请解释 shared_ptr 的线程安全性' },
    ];
    expect(hasImageContent(messages)).toBe(false);
  });

  it('is false for multimodal parts that are text-only', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '题干文字' }] },
    ];
    expect(hasImageContent(messages)).toBe(false);
  });

  it('is true when any message carries an image_url part (exam screenshot)', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是面试助手' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看截图回答' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
    ];
    expect(hasImageContent(messages)).toBe(true);
  });

  it('is false for an empty message list', () => {
    expect(hasImageContent([])).toBe(false);
  });
});