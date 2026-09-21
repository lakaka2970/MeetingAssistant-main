/**
 * Speculative-retrieval cache (pipeline-latency ②): the ASR partial stream
 * prefetches `retrieve` results keyed by the partial's EXACT text, so the
 * final question — which usually settles on a string already spoken as a
 * partial — hits a Map lookup instead of paying embed + search before the
 * first token. Deliberately tiny and boring: short TTL (a partial's useful
 * life is seconds), one-digit capacity, exact match only — a fuzzy prefix
 * match could serve a half-sentence's retrieval result as if it were whole.
 *
 * Values are held as promises: a prefetch still in flight is awaited (bounded
 * by `after`) by the real question; if it has not landed in time, a live
 * retrieve wins and the guess is simply dropped.
 *
 * Pure — no electron, no fs.
 */
export class SpeculativeCache<T> {
  private entries = new Map<string, { p: Promise<T>; at: number }>();

  constructor(
    private readonly ttlMs = 15_000,
    private readonly max = 8,
  ) {}

  set(text: string, p: Promise<T>): void {
    const key = text.trim();
    if (!key) {
      void p.catch(() => undefined); // still a dropped promise if nobody owns it
      return;
    }
    this.entries.set(key, { p, at: Date.now() });
    // Map iterates in insertion order → the first key is the oldest write
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  get(text: string): Promise<T> | undefined {
    const key = text.trim();
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.p;
  }
}

/** resolve with null after ms — the bounded wait a speculative hit is allowed */
export const after = (ms: number): Promise<null> =>
  new Promise((res) => setTimeout(() => res(null), ms));
