/**
 * LLM strategy routing (upgrade P1): plan composition, preset→endpoint
 * credential resolution, failure cooldowns and failover streaming.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FailureBook,
  endpointKey,
  isRouteTarget,
  planBackends,
  resolveEndpointForPreset,
  streamWithFallback,
  type Endpoint,
  type FailoverAttempt,
  type PrimaryContext,
  type RouteKeyMap,
} from '../electron/llm/router';
import type { ChatMessage } from '../electron/llm/adapter';

const primary: PrimaryContext = {
  endpoint: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-primary', label: 'primary' },
  providerId: 'deepseek',
};

const noRouteKeys: RouteKeyMap = {};

const resolve = (presetId: string) =>
  resolveEndpointForPreset(presetId, { primary, routeKeys: noRouteKeys });

describe('resolveEndpointForPreset', () => {
  it('reuses the primary key for same-provider presets', () => {
    const ep = resolve('deepseek.text.thinking');
    expect(ep).toMatchObject({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-primary',
    });
  });

  it('prefers the per-preset route key over the primary key', () => {
    const ep = resolveEndpointForPreset('zhipu.text.flash', {
      primary,
      routeKeys: { 'zhipu.text.flash': 'glm-key' },
    });
    expect(ep).toMatchObject({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'glm-key' });
  });

  it('rejects cross-provider presets without a route key', () => {
    expect(resolve('zhipu.text.flash')).toBeUndefined();
    expect(resolve('groq.text.llama33')).toBeUndefined();
  });

  it('allows keyless providers (Ollama) without any key', () => {
    const ep = resolve('ollama.text.local');
    expect(ep).toMatchObject({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' });
    expect(ep?.apiKey).toBeUndefined();
  });

  it('rejects unknown ids and non-text capabilities', () => {
    expect(resolve('does.not.exist')).toBeUndefined();
    // ASR preset: right platform, wrong capability for LLM routing
    expect(resolve('aliyun.cn.asr.fun-realtime')).toBeUndefined();
    expect(isRouteTarget('deepseek.text.fast')).toBe(true);
    expect(isRouteTarget('')).toBe(false);
  });
});

describe('planBackends', () => {
  it('returns only the primary when routing is off', () => {
    const plan = planBackends({
      mode: 'segment',
      kind: 'coding',
      routing: { enabled: false, fallbackChain: ['zhipu.text.flash'] },
      primary,
      resolve,
    });
    expect(plan).toEqual([primary.endpoint]);
  });

  it('routes a mapped kind to its preset and appends the primary', () => {
    const plan = planBackends({
      mode: 'segment',
      kind: 'coding',
      routing: { enabled: true, byKind: { coding: 'deepseek.text.thinking' } },
      primary,
      resolve,
    });
    expect(plan[0].model).toBe('deepseek-v4-flash');
    expect(plan).toContain(primary.endpoint);
    expect(plan[0]).not.toBe(primary.endpoint);
  });

  it('falls back to the primary when the mapped preset cannot resolve', () => {
    const plan = planBackends({
      mode: 'segment',
      kind: 'behavioral',
      routing: { enabled: true, byKind: { behavioral: 'zhipu.text.flash' } },
      primary,
      resolve,
    });
    expect(plan).toEqual([primary.endpoint]);
  });

  it('keeps translate/free as clean single-endpoint pass-throughs', () => {
    for (const mode of ['translate', 'free'] as const) {
      const plan = planBackends({
        mode,
        kind: 'coding',
        routing: { enabled: true, byKind: { coding: 'deepseek.text.thinking' }, fallbackChain: ['deepseek.text.deep'] },
        primary,
        resolve,
      });
      expect(plan).toEqual([primary.endpoint]);
    }
  });

  it('appends resolvable fallback-chain entries and dedupes', () => {
    const plan = planBackends({
      mode: 'segment',
      kind: 'other',
      routing: {
        fallbackChain: ['deepseek.text.thinking', 'zhipu.text.flash', 'deepseek.text.thinking'],
      },
      primary,
      resolve,
    });
    // zhipu has no route key -> unresolvable -> dropped; deepseek dedupes
    expect(plan.map((p) => p.model)).toEqual(['deepseek-chat', 'deepseek-v4-flash']);
  });

  it('returns the primary by reference when it opens the plan', () => {
    const plan = planBackends({ mode: 'segment', kind: 'other', primary, resolve });
    expect(plan[0]).toBe(primary.endpoint);
  });
});

describe('FailureBook', () => {
  it('moves cooling endpoints to the back and forgets after cooldown', () => {
    let now = 1_000;
    const book = new FailureBook(60_000, () => now);
    const a: Endpoint = { baseUrl: 'https://a/v1', model: 'a', label: 'a' };
    const b: Endpoint = { baseUrl: 'https://b/v1', model: 'b', label: 'b' };

    book.markFailure(a);
    expect(book.isCooling(a)).toBe(true);
    expect(book.reorder([a, b]).map((x) => x.label)).toEqual(['b', 'a']);

    now += 60_001;
    expect(book.isCooling(a)).toBe(false);
    expect(book.reorder([a, b]).map((x) => x.label)).toEqual(['a', 'b']);

    book.markFailure(b);
    book.markSuccess(b);
    expect(book.isCooling(b)).toBe(false);
  });

  it('keys failures per endpoint, not per object', () => {
    const book = new FailureBook(60_000, () => 0);
    book.markFailure({ baseUrl: 'https://a/v1/', model: 'm', label: 'x' });
    // trailing slash and different object, same identity
    expect(book.isCooling({ baseUrl: 'https://a/v1', model: 'm', label: 'y' })).toBe(true);
    expect(endpointKey({ baseUrl: 'https://a/v1/', model: 'm', label: 'z' })).toBe(
      endpointKey({ baseUrl: 'https://a/v1', model: 'm', label: 'z' }),
    );
  });
});

describe('streamWithFallback', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'q' }];

  it('serves from the first endpoint on success', async () => {
    const deltas: string[] = [];
    const r = await streamWithFallback({
      endpoints: [{ baseUrl: 'https://a/v1', model: 'a', label: 'a' }],
      messages,
      onDelta: (t) => deltas.push(t),
      attempt: async (ep, signal) => {
        expect(signal.aborted).toBe(false);
        return { text: `ok@${ep.label}` };
      },
    });
    expect(r).toMatchObject({ text: 'ok@a', attempts: 1, endpoint: { label: 'a' } });
  });

  it('fails over to the next endpoint when one errors before any delta', async () => {
    const errors: string[] = [];
    const calls: string[] = [];
    const attempt: FailoverAttempt = async (ep) => {
      calls.push(ep.label);
      if (ep.label === 'a') throw new Error('HTTP 503');
      return { text: `ok@${ep.label}` };
    };
    const r = await streamWithFallback({
      endpoints: [
        { baseUrl: 'https://a/v1', model: 'a', label: 'a' },
        { baseUrl: 'https://b/v1', model: 'b', label: 'b' },
      ],
      messages,
      onDelta: () => {},
      attempt,
      onAttemptError: (ep, err) => errors.push(`${ep.label}:${err.message}`),
    });
    expect(r.attempts).toBe(2);
    expect(r.endpoint.label).toBe('b');
    expect(calls).toEqual(['a', 'b']);
    expect(errors).toEqual(['a:HTTP 503']);
  });

  it('rethrows mid-stream errors (partial output already shown)', async () => {
    const attempt: FailoverAttempt = async (_ep, _signal, onDelta) => {
      onDelta('partial ');
      throw new Error('connection reset');
    };
    const deltas: string[] = [];
    await expect(
      streamWithFallback({
        endpoints: [
          { baseUrl: 'https://a/v1', model: 'a', label: 'a' },
          { baseUrl: 'https://b/v1', model: 'b', label: 'b' },
        ],
        messages,
        onDelta: (t) => deltas.push(t),
        attempt,
      }),
    ).rejects.toThrow('connection reset');
    expect(deltas).toEqual(['partial ']);
  });

  it('skips a black-holed endpoint via the first-token timeout', async () => {
    vi.useFakeTimers();
    try {
      const attempt: FailoverAttempt = (ep, signal) => {
        if (ep.label === 'slow') {
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
        }
        return Promise.resolve({ text: `ok@${ep.label}` });
      };
      const work = streamWithFallback({
        endpoints: [
          { baseUrl: 'https://slow/v1', model: 's', label: 'slow' },
          { baseUrl: 'https://fast/v1', model: 'f', label: 'fast' },
        ],
        messages,
        onDelta: () => {},
        firstTokenTimeoutMs: 1_000,
        attempt,
      });
        await vi.advanceTimersByTimeAsync(1_001);
      const r = await work;
      expect(r.endpoint.label).toBe('fast');
      expect(r.attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces the last error when every endpoint fails', async () => {
    const attempt: FailoverAttempt = async (ep) => {
      throw new Error(`down@${ep.label}`);
    };
    await expect(
      streamWithFallback({
        endpoints: [
          { baseUrl: 'https://a/v1', model: 'a', label: 'a' },
          { baseUrl: 'https://b/v1', model: 'b', label: 'b' },
        ],
        messages,
        onDelta: () => {},
        attempt,
      }),
    ).rejects.toThrow('down@b');
  });

  it('propagates outer cancellation instead of failing over', async () => {
    const ac = new AbortController();
    const attempt: FailoverAttempt = async (_ep, signal) => {
      ac.abort();
      expect(signal.aborted).toBe(true);
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
    await expect(
      streamWithFallback({
        endpoints: [
          { baseUrl: 'https://a/v1', model: 'a', label: 'a' },
          { baseUrl: 'https://b/v1', model: 'b', label: 'b' },
        ],
        messages,
        onDelta: () => {},
        signal: ac.signal,
        attempt,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('forwards deltas only for the serving attempt', async () => {
    const deltas: string[] = [];
    const attempt: FailoverAttempt = async (ep) => {
      // attempt 'a' emits nothing, then dies; attempt 'b' streams
      if (ep.label === 'a') throw new Error('503');
      return { text: 'streamed' };
    };
    const r = await streamWithFallback({
      endpoints: [
        { baseUrl: 'https://a/v1', model: 'a', label: 'a' },
        { baseUrl: 'https://b/v1', model: 'b', label: 'b' },
      ],
      messages,
      onDelta: (t) => deltas.push(t),
      attempt,
    });
    expect(r.text).toBe('streamed');
    expect(deltas).toEqual([]);
  });

  it('reuses the real transport (chatStream) when no attempt is injected', async () => {
    // no local server: the fetch must fail fast with a connect error, which
    // proves the default attempt path is wired (label included is optional)
    await expect(
      streamWithFallback({
        endpoints: [{ baseUrl: 'http://127.0.0.1:9/v1', model: 'x', label: 'unreachable' }],
        messages,
        onDelta: () => {},
        firstTokenTimeoutMs: 500,
      }),
    ).rejects.toThrow();
  });
});
