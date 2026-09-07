/**
 * RAG ingest orchestration (upgrade P0 step 3): chunk → embed → upsert, with
 * replace-semantics per (source, sessionId, ref) so re-importing a file never
 * duplicates and stale chunks never linger. Runs in the main process; the
 * heavy part (embedding) happens in the utility worker via EmbedClient.
 */
import { chunkText } from './chunker';
import type { RagSource, VectorStore } from './vector-store';
import type { EmbedClient } from './embedClient';

const EMBED_BATCH = 8;

export interface IngestOptions {
  text: string;
  source: RagSource;
  sessionId?: string;
  ref?: string;
  metadata?: Record<string, unknown>;
  /** drop previous chunks with the same (source, sessionId, ref) first */
  replace?: boolean;
  chunkSize?: number;
  overlap?: number;
}

export interface IngestResult {
  total: number;
  added: number;
  skipped: number;
}

export class RagIngestor {
  constructor(
    private readonly store: VectorStore,
    private readonly embedder: EmbedClient,
  ) {}

  async ingest(opts: IngestOptions): Promise<IngestResult> {
    const chunks = chunkText(opts.text, { chunkSize: opts.chunkSize, overlap: opts.overlap });
    if (!chunks.length) return { total: 0, added: 0, skipped: 0 };

    if (opts.replace) {
      this.store.removeWhere(
        (r) =>
          r.source === opts.source &&
          (r.sessionId ?? undefined) === (opts.sessionId ?? undefined) &&
          (r.ref ?? undefined) === (opts.ref ?? undefined),
      );
    }

    let added = 0;
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const vectors = await this.embedder.embed(batch);
      for (let j = 0; j < batch.length; j++) {
        const record = this.store.add({
          source: opts.source,
          sessionId: opts.sessionId,
          ref: opts.ref,
          text: batch[j],
          metadata: { ...(opts.metadata ?? {}), chunk_index: i + j },
          embedding: vectors[j],
        });
        if (record) added++;
      }
    }
    return { total: chunks.length, added, skipped: chunks.length - added };
  }

  /** per-session dual-slot material (resume / JD), replace-semantics */
  ingestSessionMaterial(
    kind: 'resume' | 'jd',
    sessionId: string,
    ref: string | undefined,
    text: string,
  ): Promise<IngestResult> {
    return this.ingest({ text, source: kind, sessionId, ref, replace: true });
  }

  /** global knowledge file (L1 fallback), replace-semantics */
  ingestKnowledge(text: string, ref?: string): Promise<IngestResult> {
    return this.ingest({ text, source: 'knowledge', ref, replace: true });
  }

  /** custom notes (L2) → a few chunks of 'custom_note' source, global scope */
  ingestNotes(text: string): Promise<IngestResult> {
    return this.ingest({ text, source: 'custom_note', ref: 'notes', replace: true });
  }

  /**
   * Claimed facts (upgrade P3): each fact is ONE record (never chunked) so a
   * recall hit quotes the fact verbatim. Replace-per-session.
   */
  async ingestFacts(sessionId: string, facts: string[]): Promise<IngestResult> {
    this.store.removeWhere((r) => r.source === 'fact' && r.sessionId === sessionId);
    if (!facts.length) return { total: 0, added: 0, skipped: 0 };
    let added = 0;
    for (let i = 0; i < facts.length; i += EMBED_BATCH) {
      const batch = facts.slice(i, i + EMBED_BATCH);
      const vectors = await this.embedder.embed(batch);
      for (let j = 0; j < batch.length; j++) {
        const record = this.store.add({
          source: 'fact',
          sessionId,
          ref: 'memo',
          text: batch[j],
          metadata: { fact_index: i + j },
          embedding: vectors[j],
        });
        if (record) added++;
      }
    }
    return { total: facts.length, added, skipped: facts.length - added };
  }

  /** drop a session's material (session deleted) */
  dropSession(sessionId: string): number {
    return this.store.removeWhere((r) => r.sessionId === sessionId);
  }
}
