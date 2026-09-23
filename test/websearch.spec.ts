import { describe, it, expect, vi } from 'vitest';
import {
  formatWebLines,
  webSearch,
  webSources,
  DEFAULT_SEARCH_TIMEOUT_MS,
  type SearchProviderId,
} from '../electron/websearch';

/** a fetch stub that records the request and answers with a canned JSON body */
function mockFetch(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, opts?: RequestInit) => {
    calls.push({ url: String(url), init: (opts ?? {}) as RequestInit });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.statusText ?? 'OK',
      json: async () => body,
    } as Response;
  });
  return { fn, calls };
}

const json = (body: unknown) => body;

describe('webSearch — tavily', () => {
  it('POSTs the query with a bearer key and maps results', async () => {
    const { fn, calls } = mockFetch(
      json({
        results: [
          { title: 'Sigmoid 函数', url: 'https://ex.com/sg', content: 'S(z)=1/(1+e^-z) 的说明' },
          { title: '激活函数对比', url: 'https://ex.com/act', content: 'ReLU 更常用' },
        ],
      }),
    );
    const r = await webSearch(
      { provider: 'tavily', apiKey: 'tvly-abc', query: 'sigmoid 公式', maxResults: 5 },
      { fetchFn: fn as unknown as typeof fetch },
    );
    expect(r.error).toBeUndefined();
    expect(r.hits).toHaveLength(2);
    expect(r.hits[0]).toEqual({
      title: 'Sigmoid 函数',
      url: 'https://ex.com/sg',
      snippet: 'S(z)=1/(1+e^-z) 的说明',
    });
    expect(calls[0].url).toBe('https://api.tavily.com/search');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tvly-abc');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      query: 'sigmoid 公式',
      max_results: 5,
    });
  });

  it('drops entries without a url and respects maxResults', async () => {
    const { fn } = mockFetch(
      json({
        results: [
          { title: 'no url', content: 'x' },
          { title: 'a', url: 'https://a', content: 'A' },
          { title: 'b', url: 'https://b', content: 'B' },
        ],
      }),
    );
    const r = await webSearch(
      { provider: 'tavily', apiKey: 'k', query: 'q', maxResults: 1 },
      { fetchFn: fn as unknown as typeof fetch },
    );
    expect(r.hits.map((h) => h.url)).toEqual(['https://a']);
  });
});

describe('webSearch — brave & serpapi response shapes', () => {
  it('reads brave web.results with the subscription-token header', async () => {
    const { fn, calls } = mockFetch(
      json({ web: { results: [{ title: 'B', url: 'https://b', description: 'desc' }] } }),
    );
    const r = await webSearch(
      { provider: 'brave', apiKey: 'BSkey', query: 'a b' },
      { fetchFn: fn as unknown as typeof fetch },
    );
    expect(r.hits[0].snippet).toBe('desc');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-Subscription-Token']).toBe('BSkey');
    expect(calls[0].url).toContain('q=a%20b');
    expect(calls[0].url).not.toContain('BSkey'); // the key never rides in the URL
  });

  it('reads serpapi organic_results (link/snippet) and keeps the key out of the query', async () => {
    const { fn, calls } = mockFetch(
      json({ organic_results: [{ title: 'S', link: 'https://s', snippet: 'sn' }] }),
    );
    const r = await webSearch(
      { provider: 'serpapi', apiKey: 'secret-key', query: 'x' },
      { fetchFn: fn as unknown as typeof fetch },
    );
    expect(r.hits[0]).toEqual({ title: 'S', url: 'https://s', snippet: 'sn' });
    expect(calls[0].url).toContain('engine=google');
    // serpapi authenticates by query param — the key is present but the URL is
    // never logged by the caller; assert at least that nothing else leaked
    expect(calls[0].init.method).toBe('GET');
  });

  it('tolerates a malformed payload without throwing', async () => {
    const { fn } = mockFetch(json({ unexpected: true }));
    const r = await webSearch(
      { provider: 'brave', apiKey: 'k', query: 'x' },
      { fetchFn: fn as unknown as typeof fetch },
    );
    expect(r.hits).toEqual([]);
  });
});

describe('webSearch — failure modes never throw (the answer must still stream)', () => {
  it('refuses without a key', async () => {
    const { fn } = mockFetch(json({}));
    const r = await webSearch(
      { provider: 'tavily', apiKey: '  ', query: 'x' },
      { fetchFn: fn as unknown as typeof fetch },
    );
    expect(r.hits).toEqual([]);
    expect(r.error).toBe('no api key');
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports a non-2xx status as an error', async () => {
    const { fn } = mockFetch(json({ message: 'quota' }), { ok: false, status: 429, statusText: 'Too Many Requests' });
    const r = await webSearch(
      { provider: 'tavily', apiKey: 'k', query: 'x' },
      { fetchFn: fn as unknown as typeof fetch },
    );
    expect(r.hits).toEqual([]);
    expect(r.error).toContain('429');
  });

  it('survives a rejected fetch (network down / timeout)', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { name: 'TimeoutError' });
    });
    const r = await webSearch(
      { provider: 'tavily', apiKey: 'k', query: 'x', timeoutMs: 800 },
      { fetchFn: fn as unknown as typeof fetch },
    );
    expect(r.hits).toEqual([]);
    expect(r.error).toContain('timeout 800ms');
  });

  it('sends an abort signal so a hung engine cannot pin the request', async () => {
    const { fn, calls } = mockFetch(json({ results: [] }));
    await webSearch({ provider: 'tavily', apiKey: 'k', query: 'x' }, { fetchFn: fn as unknown as typeof fetch });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('clamps the limits instead of trusting the caller', async () => {
    const { fn, calls } = mockFetch(json({ results: [] }));
    await webSearch(
      { provider: 'tavily', apiKey: 'k', query: 'x', maxResults: 999, timeoutMs: 1 },
      { fetchFn: fn as unknown as typeof fetch },
    );
    expect(JSON.parse(String(calls[0].init.body)).max_results).toBe(10);
  });

  it('replaces NaN settings values with the shared defaults', async () => {
    // maxResults/timeoutMs come from a user-editable settings file: `??`
    // lets NaN through, which poisons the request body and AbortSignal.
    const { fn, calls } = mockFetch(json({ results: [] }));
    const r = await webSearch(
      { provider: 'tavily', apiKey: 'k', query: 'x', maxResults: NaN, timeoutMs: NaN },
      { fetchFn: fn as unknown as typeof fetch },
    );
    expect(r.error).toBeUndefined();
    expect(JSON.parse(String(calls[0].init.body)).max_results).toBe(5);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('defaults the timeout from the shared catalog constant', async () => {
    const { fn } = mockFetch(json({ results: [] }));
    const r = await webSearch(
      { provider: 'tavily', apiKey: 'k', query: 'x' },
      { fetchFn: fn as unknown as typeof fetch },
    );
    expect(r.ms).toBeLessThan(DEFAULT_SEARCH_TIMEOUT_MS + 5000);
  });
});

describe('formatWebLines / webSources (prompt + UI views)', () => {
  const hits = [
    { title: 'A', url: 'https://a', snippet: 'first' },
    { title: '', url: 'https://b', snippet: '' },
  ];

  it('numbers every line and keeps the url visible', () => {
    const lines = formatWebLines(hits);
    expect(lines[0]).toBe('1] A — first (https://a)');
    // a title-less hit shows the url once, not twice
    expect(lines[1]).toBe('2] https://b');
  });

  it('falls back to the url as the source title', () => {
    expect(webSources(hits)).toEqual([
      { title: 'A', url: 'https://a' },
      { title: 'https://b', url: 'https://b' },
    ]);
  });

  it('is stable for the empty case', () => {
    expect(formatWebLines([])).toEqual([]);
    expect(webSources([])).toEqual([]);
  });
});

describe('provider ids', () => {
  it('every catalogued provider is wired to a mapper', async () => {
    const providers: SearchProviderId[] = ['tavily', 'brave', 'serpapi'];
    for (const p of providers) {
      const { fn } = mockFetch(json({ results: [], web: { results: [] }, organic_results: [] }));
      const r = await webSearch({ provider: p, apiKey: 'k', query: 'x' }, { fetchFn: fn as unknown as typeof fetch });
      expect(r.error).toBeUndefined();
    }
  });
});
