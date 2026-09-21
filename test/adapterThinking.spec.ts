import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatStream, extractReasoningDelta, type LlmConfig } from '../electron/llm/adapter';

const config: LlmConfig = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', apiKey: 'k' };

function sseResponse(chunks: object[]): Response {
  const body = (chunks as (object | undefined)[]).concat([undefined]);
  const text = body.map((c) => `data: ${c ? JSON.stringify(c) : '[DONE]'}\n\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('extractReasoningDelta', () => {
  it('pulls reasoning_content out of a streamed delta', () => {
    expect(
      extractReasoningDelta(
        JSON.stringify({ choices: [{ delta: { reasoning_content: 'hm', content: 'hi' } }] }),
      ),
    ).toBe('hm');
  });

  it('returns empty string when the payload carries no reasoning', () => {
    expect(extractReasoningDelta(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }))).toBe('');
    expect(extractReasoningDelta('not json')).toBe('');
  });
});

describe('chatStream thinking params', () => {
  it('merges the mapped thinking fields into the request body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([{ choices: [{ delta: { content: 'ok' } }] }]),
      );
    vi.stubGlobal('fetch', fetchMock);
    await chatStream(config, [{ role: 'user', content: 'q' }], { onDelta: () => {} }, undefined, {
      thinking: { style: 'deepseek', level: 'low' },
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('low');
  });

  it('sends no thinking fields when the option is absent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(sseResponse([{ choices: [{ delta: { content: 'ok' } }] }]));
    vi.stubGlobal('fetch', fetchMock);
    await chatStream(config, [{ role: 'user', content: 'q' }], { onDelta: () => {} });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });

  it('forwards reasoning_content deltas through onReasoning without polluting the answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        { choices: [{ delta: { reasoning_content: 'thin' } }] },
        { choices: [{ delta: { reasoning_content: 'king', content: 'an' } }] },
        { choices: [{ delta: { content: 'swer' } }] },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const reasoning: string[] = [];
    const deltas: string[] = [];
    const r = await chatStream(config, [{ role: 'user', content: 'q' }], {
      onDelta: (t) => deltas.push(t),
      onReasoning: (t) => reasoning.push(t),
    });
    expect(reasoning).toEqual(['thin', 'king']);
    expect(deltas).toEqual(['an', 'swer']);
    expect(r.text).toBe('answer');
  });
});
