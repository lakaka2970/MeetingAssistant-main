/**
 * Web-search provider catalog: the BYOK search services the knowledge-base-miss
 * fallback can use. Pure data (same rule as providerCatalog.ts) so the settings
 * UI and the main-process client share one source of truth.
 *
 * Search is OFF until the user stores a key: no question ever reaches these
 * endpoints by default, and when enabled it is reached only for questions the
 * local knowledge base could not answer.
 */

export type SearchProviderId = 'tavily' | 'brave' | 'serpapi';

export interface SearchProviderInfo {
  id: SearchProviderId;
  name: string;
  /** where the user creates the key */
  keyUrl: string;
  /** settings-row label, per UI language */
  labelZh: string;
  labelEn: string;
  /** free-tier note shown next to the key field */
  billingZh: string;
  billingEn: string;
}

export const SEARCH_PROVIDERS: Record<SearchProviderId, SearchProviderInfo> = {
  tavily: {
    id: 'tavily',
    name: 'Tavily',
    keyUrl: 'https://app.tavily.com/home',
    labelZh: 'Tavily（为 LLM 检索设计，有免费额度）',
    labelEn: 'Tavily (built for LLM retrieval, free tier)',
    billingZh: '每月 1000 次免费查询',
    billingEn: '1000 free queries / month',
  },
  brave: {
    id: 'brave',
    name: 'Brave Search',
    keyUrl: 'https://api-dashboard.search.brave.com/app/keys',
    labelZh: 'Brave Search API（独立索引，不依赖 Google）',
    labelEn: 'Brave Search API (independent index)',
    billingZh: '每月 2000 次免费查询',
    billingEn: '2000 free queries / month',
  },
  serpapi: {
    id: 'serpapi',
    name: 'SerpAPI',
    keyUrl: 'https://serpapi.com/manage-api-key',
    labelZh: 'SerpAPI（转发 Google 结果，质量最高）',
    labelEn: 'SerpAPI (Google results, best coverage)',
    billingZh: '免费 100 次/月，之后按量付费',
    billingEn: '100 free / month, then paid',
  },
};

export const SEARCH_PROVIDER_IDS = Object.keys(SEARCH_PROVIDERS) as SearchProviderId[];

export const DEFAULT_SEARCH_PROVIDER: SearchProviderId = 'tavily';
export const DEFAULT_SEARCH_MAX_RESULTS = 5;
/** one search must never hold up an answer for longer than this */
export const DEFAULT_SEARCH_TIMEOUT_MS = 2500;
