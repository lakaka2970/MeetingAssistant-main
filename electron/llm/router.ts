/**
 * LLM strategy routing (upgrade P1): per-question-kind backend selection plus
 * a failure fallback chain — 「编码题走快档、行为面走质量档、挂了自动兜底」.
 *
 * Pure logic, no electron imports, every side effect injectable so the suite
 * can test routing/cooldown/failover without any network.
 *
 * Credential model: the PRIMARY endpoint is the `llm` settings slot (baseUrl +
 * model + its own key). Any other route target references a catalog PRESET id
 * and resolves its key in this order:
 *   1. the per-preset key stored under `llm.routeKeys[presetId]`;
 *   2. the primary slot's key when the preset belongs to the SAME provider
 *      (e.g. every DeepSeek preset shares one DeepSeek key);
 *   3. no key at all, which is only valid for keyless providers (Ollama).
 * Keys never leave the main process — the renderer only ever sees the routing
 * table and `apiKeySet`/hint metadata.
 */
import { chatStream, type ChatMessage } from './adapter';
import type { ChatUsage } from './adapter';
import { findPresetById } from '../../shared/providerCatalog';
import type { QuestionKind } from '../../shared/textHeuristics';

// ---------- types ----------

export interface RoutingSettings {
  /** gate for per-kind selection only; the fallback chain applies whenever set */
  enabled?: boolean;
  /** QuestionKind -> preset id; '' / absent = primary llm slot */
  byKind?: Partial<Record<QuestionKind, string>>;
  /** ordered preset ids tried after the chosen backend fails */
  fallbackChain?: string[];
}

export interface Endpoint {
  baseUrl: string;
  model: string;
  /** absent when the provider needs no key (Ollama) */
  apiKey?: string;
  /** human-readable identity for logs; never contains the key */
  label: string;
}

/** main-side resolved primary (llm settings slot) handed to the router */
export interface PrimaryContext {
  endpoint: Endpoint;
  /** catalog provider of the primary slot; undefined for hand-configured */
  providerId?: string;
}

/** decrypted per-preset keys (presetId -> plaintext); main-side only */
export type RouteKeyMap = Record<string, string | undefined>;

export type EndpointResolver = (presetId: string) => Endpoint | undefined;

/** providers that work without any API key */
export const KEYLESS_PROVIDERS: ReadonlySet<string> = new Set(['ollama']);

/** stable identity for dedupe/cooldown bookkeeping (never includes the key) */
export function endpointKey(ep: Endpoint): string {
  return `${ep.baseUrl.replace(/\/+$/, '')}|${ep.model}`;
}

// ---------- preset -> endpoint resolution ----------

/** does this preset id name a usable routing target at all? */
export function isRouteTarget(presetId: string): boolean {
  if (!presetId) return false;
  const preset = findPresetById(presetId);
  return !!preset && preset.capability === 'text-llm' && preset.baseUrl !== '';
}

/**
 * Resolve a routing preset id into a concrete endpoint, or undefined when the
 * preset is unknown / not a text LLM / has no usable key.
 */
export function resolveEndpointForPreset(
  presetId: string,
  opts: { primary: PrimaryContext; routeKeys: RouteKeyMap },
): Endpoint | undefined {
  const preset = findPresetById(presetId);
  if (!preset || preset.capability !== 'text-llm' || preset.baseUrl === '') return undefined;

  const routeKey = opts.routeKeys[presetId];
  const sameProvider =
    !!preset.providerId && preset.providerId === opts.primary.providerId;
  const apiKey = routeKey ?? (sameProvider ? opts.primary.endpoint.apiKey : undefined);

  if (!apiKey && !KEYLESS_PROVIDERS.has(preset.providerId)) return undefined;

  return {
    baseUrl: preset.baseUrl,
    model: preset.model,
    apiKey: apiKey || undefined,
    label: presetId,
  };
}

// ---------- planning ----------

/**
 * Ordered backend plan for one request:
 *   1. the per-kind routed endpoint (when routing.enabled and byKind maps the
 *      kind to a resolvable preset) or the primary endpoint;
 *   2. the fallback chain entries (whenever configured, routing.enabled or
 *      not) that resolve to endpoints;
 *   3. the primary endpoint last-resort — unless it already opens the plan.
 * `translate`/`free` stay single-endpoint: clean pass-through semantics.
 *
 * The primary endpoint object is returned BY REFERENCE when selected, so
 * callers can compare identity (used to keep prewarm bookkeeping coherent).
 */
export function planBackends(args: {
  mode: 'segment' | 'continuous' | 'free' | 'translate';
  kind: QuestionKind;
  routing?: RoutingSettings;
  primary: PrimaryContext;
  resolve: EndpointResolver;
}): Endpoint[] {
  const { mode, kind, routing, primary, resolve } = args;

  if (mode === 'translate' || mode === 'free') return [primary.endpoint];

  const plan: Endpoint[] = [];
  const pushUnique = (ep: Endpoint | undefined): void => {
    if (!ep) return;
    if (plan.some((x) => endpointKey(x) === endpointKey(ep))) return;
    plan.push(ep);
  };

  let chosen: Endpoint | undefined;
  if (routing?.enabled) {
    const presetId = routing.byKind?.[kind];
    if (presetId) chosen = resolve(presetId);
  }
  pushUnique(chosen ?? primary.endpoint);
  pushUnique(primary.endpoint);

  for (const presetId of routing?.fallbackChain ?? []) {
    pushUnique(resolve(presetId));
  }
  return plan;
}

// ---------- cooldown bookkeeping ----------

/**
 * Remembers which endpoints recently failed so failover does not hammer a
 * provider that just errored (or rate-limited) for the whole cooldown window.
 * Pure bookkeeping — the clock is injectable for tests.
 */
export class FailureBook {
  private readonly failedUntil = new Map<string, number>();

  constructor(
    private readonly cooldownMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  markFailure(ep: Endpoint): void {
    this.failedUntil.set(endpointKey(ep), this.now() + this.cooldownMs);
  }

  markSuccess(ep: Endpoint): void {
    this.failedUntil.delete(endpointKey(ep));
  }

  isCooling(ep: Endpoint): boolean {
    const until = this.failedUntil.get(endpointKey(ep));
    return until !== undefined && until > this.now();
  }

  /** stable partition: non-cooling endpoints keep their order, cooling ones
   * move to the back (still in the plan as a last resort). */
  reorder(plan: Endpoint[]): Endpoint[] {
    const ok: Endpoint[] = [];
    const cooling: Endpoint[] = [];
    for (const ep of plan) (this.isCooling(ep) ? cooling : ok).push(ep);
    return [...ok, ...cooling];
  }
}

// ---------- failover streaming ----------

/** structural re-export so callers stay decoupled from the adapter import */
export type FailoverUsage = ChatUsage;

export interface FailoverResult {
  text: string;
  usage?: ChatUsage;
  /** the endpoint that actually served the answer */
  endpoint: Endpoint;
  /** how many endpoints were tried before success (1 = first try) */
  attempts: number;
}

export interface FailoverAttempt {
  /**
   * Emit deltas through the third argument — the router uses it both to
   * forward live output and to detect "mid-stream" (deltas already shown).
   */
  (
    endpoint: Endpoint,
    signal: AbortSignal,
    onDelta: (text: string) => void,
  ): Promise<{ text: string; usage?: ChatUsage }>;
}

/**
 * Try each endpoint in order. A request is handed to the NEXT endpoint when it
 * fails (or times out) BEFORE producing any delta. The first streamed delta
 * pins the attempt: an error after that is rethrown as-is, because the user
 * is already reading partial output and silent replay would duplicate it.
 * `firstTokenTimeoutMs` (default off) aborts an attempt that never streamed a
 * first token — how a black-holed provider gets skipped without hanging.
 */
export async function streamWithFallback(args: {
  endpoints: Endpoint[];
  messages: ChatMessage[];
  onDelta(text: string): void;
  signal?: AbortSignal;
  /** 0 / undefined = no first-token timeout */
  firstTokenTimeoutMs?: number;
  attempt?: FailoverAttempt;
  onAttemptError?(ep: Endpoint, err: Error, hadDelta: boolean): void;
}): Promise<FailoverResult> {
  let lastErr: Error | undefined;

  for (let i = 0; i < args.endpoints.length; i++) {
    const ep = args.endpoints[i];
    let hadDelta = false;
    const link = new AbortController();
    const onOuterAbort = () => link.abort();
    if (args.signal) {
      if (args.signal.aborted) throw abortError();
      args.signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (args.firstTokenTimeoutMs && args.firstTokenTimeoutMs > 0) {
      timer = setTimeout(() => {
        if (!hadDelta) link.abort();
      }, args.firstTokenTimeoutMs);
    }

    try {
      const trackDelta = (text: string): void => {
        hadDelta = true;
        args.onDelta(text);
      };
      const attempt: FailoverAttempt =
        args.attempt ??
        ((_ep, signal, onDelta) =>
          chatStream(
            { baseUrl: ep.baseUrl, model: ep.model, apiKey: ep.apiKey ?? '' },
            args.messages,
            { onDelta },
            signal,
          ));
      const r = await attempt(ep, link.signal, trackDelta);
      if (args.signal?.aborted) throw abortError();
      return { text: r.text, usage: r.usage, endpoint: ep, attempts: i + 1 };
    } catch (err) {
      const e = err as Error;
      if (args.signal?.aborted) throw abortError();
      if (e.name === 'AbortError' && !hadDelta && args.firstTokenTimeoutMs) {
        // first-token timeout: bookkeeping below treats it like any failure
        lastErr = new Error(
          `first token timeout after ${args.firstTokenTimeoutMs}ms (${ep.label})`,
        );
        args.onAttemptError?.(ep, lastErr, false);
        continue;
      }
      lastErr = e;
      args.onAttemptError?.(ep, e, hadDelta);
      if (hadDelta) throw e; // mid-stream: partial output already shown
      continue;
    } finally {
      if (timer) clearTimeout(timer);
      if (args.signal) args.signal.removeEventListener('abort', onOuterAbort);
    }
  }

  throw new Error(lastErr?.message ?? 'all endpoints failed');
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}
