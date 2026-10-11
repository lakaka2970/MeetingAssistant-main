import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatOnce, chatStream, type LlmConfig } from '../electron/llm/adapter';
import { defaultProviderTestDeps, runProviderTest } from '../electron/providerTest';
import { omitsTemperature } from '../shared/providerCatalog';

const kimi: LlmConfig = { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3', apiKey: 'k' };
const deepseek: LlmConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
  apiKey: 'k',
};

function sseResponse(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

const DELTA = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
const JSON_ONCE = { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };

afterEach(() => vi.unstubAllGlobals());

// platform.kimi.com/docs/api/models-overview: for kimi-k3 and the k2.7-code family
// `temperature` is 固定 1.0 and 传入其他值报错 — a value we would have to guess right.
// Omitting the field is what Moonshot's own examples do, so the server applies its
// pinned value instead of rejecting ours.
describe('omitsTemperature', () => {
  it('is true for the Moonshot hosts and false for the others', () => {
    // both hosts answer POST /v1/chat/completions with 401 (measured 2026-10-11), so
    // both really are the Kimi API; api.kimi.com 404s on that path and is a console,
    // not an endpoint, so it stays out.
    expect(omitsTemperature('https://api.moonshot.cn/v1')).toBe(true);
    expect(omitsTemperature('https://api.moonshot.ai/v1')).toBe(true);
    expect(omitsTemperature('https://api.deepseek.com/v1')).toBe(false);
    expect(omitsTemperature('https://api.siliconflow.cn/v1')).toBe(false);
    expect(omitsTemperature('https://ark.cn-beijing.volces.com/api/v3')).toBe(false);
    expect(omitsTemperature('http://127.0.0.1:11434/v1')).toBe(false);
  });

  it('keys off the host, not the whole url', () => {
    expect(omitsTemperature('http://localhost:8787/moonshot')).toBe(false);
    expect(omitsTemperature('https://api.moonshot.cn')).toBe(true);
    expect(omitsTemperature('https://notapi.moonshot.cn.evil.test/v1')).toBe(false);
  });
});

describe('chatStream request body', () => {
  it('sends no temperature to Moonshot, even when the caller asked for one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(DELTA));
    vi.stubGlobal('fetch', fetchMock);

    await chatStream(kimi, [{ role: 'user', content: 'q' }], { onDelta: () => {} }, undefined, {
      temperature: 0.2,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).not.toHaveProperty('temperature');
  });

  it('keeps sending temperature everywhere else', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(DELTA));
    vi.stubGlobal('fetch', fetchMock);

    await chatStream(deepseek, [{ role: 'user', content: 'q' }], { onDelta: () => {} }, undefined, {
      temperature: 0.2,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).temperature).toBe(0.2);
  });
});

describe('chatOnce request body', () => {
  it('sends no temperature to Moonshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue(JSON_ONCE as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await chatOnce(kimi, [{ role: 'user', content: 'q' }], { maxTokens: 1, temperature: 0 });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).not.toHaveProperty('temperature');
    expect(body.max_tokens).toBe(1);
  });
});

describe('the connection probe', () => {
  // testTextLlm asks for temperature 0 to keep the probe cheap; on Moonshot that
  // value is illegal, so the probe has to go out without it or 测试连接 fails on a
  // perfectly good key.
  it('sends no temperature to Moonshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue(JSON_ONCE as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await runProviderTest(
      {
        capability: 'text-llm',
        providerId: 'kimi',
        baseUrl: 'https://api.moonshot.cn/v1',
        model: 'kimi-k3',
        slot: 'llm',
        presetId: 'kimi.text.k3',
      },
      'sk-live-1234',
      defaultProviderTestDeps,
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).not.toHaveProperty('temperature');
  });
});
