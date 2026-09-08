/**
 * BYOK web search — the knowledge-base-miss fallback.
 *
 * The answer pipeline is knowledge-base first: a prepared answer or a recalled
 * chunk answers locally (tens of ms). Only when NOTHING in the KB is relevant
 * does the question go out to a search API, so the network is never on the
 * critical path of a question the user already prepared for. Every provider is
 * bring-your-own-key (no server of ours in the middle, no silent traffic if the
 * user never configures one) and every call is bounded by a hard timeout — a
 * slow search engine must degrade to a plain LLM answer, never to a hung pane.
 *
 * `fetchFn` is injected so the response mapping is unit-testable without
 * network access.
 */
import {
  DEFAULT_SEARCH_MAX_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  type SearchProviderId,
} from '../shared/searchProviders';

export type { SearchProviderId };
export {
  DEFAULT_SEARCH_MAX_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  SEARCH_PROVIDERS,
  SEARCH_PROVIDER_IDS,
  DEFAULT_SEARCH_PROVIDER,
} from '../shared/searchProviders';
export type { SearchProviderInfo } from '../shared/searchProviders';

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutcome {
  hits: WebSearchHit[];
  ms: number;
  /** set on any failure; the caller answers without web context */
  error?: string;
}

export interface WebSearchRequest {
  provider: SearchProviderId;
  apiKey: string;
  query: string;
  maxResults?: number;
  timeoutMs?: number;
}

export interface WebSearchDeps {
  fetchFn?: typeof globalThis.fetch;
}

type Json = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function arr(v: unknown): Json[] {
  return Array.isArray(v) ? (v as Json[]) : [];
}

/** drop boilerplate the engines return and normalise whitespace */
function clean(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}

function mapTavily(json: Json, limit: number): WebSearchHit[] {
  return arr(json.results)
    .map((r) => ({
      title: clean(str(r.title), 160),
      url: str(r.url),
      snippet: clean(str(r.content), 600),
    }))
    .filter((h) => h.url && (h.title || h.snippet))
    .slice(0, limit);
}

function mapBrave(json: Json, limit: number): WebSearchHit[] {
  const web = json.web as Json | undefined;
  return arr(web?.results)
    .map((r) => ({
      title: clean(str(r.title), 160),
      url: str(r.url),
      snippet: clean(str(r.description), 600),
    }))
    .filter((h) => h.url && (h.title || h.snippet))
    .slice(0, limit);
}

function mapSerpApi(json: Json, limit: number): WebSearchHit[] {
  return arr(json.organic_results)
    .map((r) => ({
      title: clean(str(r.title), 160),
      url: str(r.link),
      snippet: clean(str(r.snippet ?? r.description), 600),
    }))
    .filter((h) => h.url && (h.title || h.snippet))
    .slice(0, limit);
}

/**
 * One search round-trip. Never throws: a missing key, a non-2xx answer or a
 * timeout all come back as `{ hits: [], error }` so the caller can just answer
 * without web context.
 */
export async function webSearch(
  req: WebSearchRequest,
  deps: WebSearchDeps = {},
): Promise<WebSearchOutcome> {
  const t0 = Date.now();
  const query = req.query.trim();
  const apiKey = req.apiKey.trim();
  if (!query) return { hits: [], ms: 0, error: 'empty query' };
  if (!apiKey) return { hits: [], ms: 0, error: 'no api key' };
  const limit = Math.max(1, Math.min(10, req.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS));
  const timeoutMs = Math.max(500, req.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);
  const doFetch = deps.fetchFn ?? globalThis.fetch;

  const url =
    req.provider === 'brave'
      ? `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`
      : req.provider === 'serpapi'
        ? `https://serpapi.com/search.json?engine=google&num=${limit}&q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(apiKey)}`
        : 'https://api.tavily.com/search';

  const init: RequestInit = {
    method: req.provider === 'tavily' ? 'POST' : 'GET',
    headers:
      req.provider === 'brave'
        ? { Accept: 'application/json', 'X-Subscription-Token': apiKey }
        : req.provider === 'serpapi'
          ? { Accept: 'application/json' }
          : {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
    ...(req.provider === 'tavily'
      ? {
          body: JSON.stringify({
            query,
            max_results: limit,
            search_depth: 'basic',
            include_answer: false,
            include_raw_content: false,
          }),
        }
      : {}),
    signal: AbortSignal.timeout(timeoutMs),
  };

  try {
    const res = await doFetch(url, init);
    if (!res.ok) {
      return { hits: [], ms: Date.now() - t0, error: `HTTP ${res.status} ${res.statusText}` };
    }
    const json = (await res.json()) as Json;
    const hits =
      req.provider === 'brave' ? mapBrave(json, limit) : req.provider === 'serpapi' ? mapSerpApi(json, limit) : mapTavily(json, limit);
    return { hits, ms: Date.now() - t0 };
  } catch (e) {
    const msg = (e as Error)?.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : (e as Error).message;
    return { hits: [], ms: Date.now() - t0, error: msg };
  }
}

/**
 * Prompt-ready lines: `[n] title — snippet (url)`. The URL stays in the text on
 * purpose: the answer is expected to cite it, and the user can click-check a
 * claim during the interview. Snippets are already cleaned in the mappers.
 */
export function formatWebLines(hits: WebSearchHit[]): string[] {
  return hits.map((h, i) => {
    const head = h.title ? `${i + 1}] ${h.title}` : `${i + 1}] ${h.url}`;
    return [head, h.snippet && `— ${h.snippet}`, h.title && `(${h.url})`]
      .filter(Boolean)
      .join(' ');
  });
}

/** the compact source list the UI shows under a web-backed answer */
export function webSources(hits: WebSearchHit[]): { title: string; url: string }[] {
  return hits.map((h) => ({ title: h.title || h.url, url: h.url }));
}
