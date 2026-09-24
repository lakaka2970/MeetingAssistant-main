/**
 * RAG ingest orchestration (upgrade P0 step 3): chunk → embed → upsert, with
 * replace-semantics per (source, sessionId, ref) so re-importing a file never
 * duplicates and stale chunks never linger. Runs in the main process; the
 * heavy part (embedding) happens in the utility worker via EmbedClient.
 *
 * Every ingested document is ALSO scanned for prepared Q&A pairs (interview
 * prep notes). Those become dedicated 'qa' records: the vector is the
 * QUESTION alone (so a spoken question matches the question, not the answer's
 * prose) while the record keeps the full pair in `metadata`, which is what the
 * answer pane shows verbatim on a direct hit.
 */
import { chunkText } from './chunker';
import { buildDocSummaries, belongsToDoc, isSectionRefOf, sectionRefOf } from './summaries';
import { extractQaPairs, formatQaRecord, type QaPair } from '../../shared/qaPairs';
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
  /** false = skip the prepared-Q&A scan (used for the transcript stream) */
  qa?: boolean;
}

export interface IngestResult {
  total: number;
  added: number;
  skipped: number;
  /** prepared Q&A pairs stored alongside the chunks (same replace scope) */
  qa: number;
}

export class RagIngestor {
  constructor(
    private readonly store: VectorStore,
    private readonly embedder: EmbedClient,
  ) {}

  async ingest(opts: IngestOptions): Promise<IngestResult> {
    const chunks = chunkText(opts.text, { chunkSize: opts.chunkSize, overlap: opts.overlap });
    const pairs = opts.qa === false ? [] : extractQaPairs(opts.text);
    if (!chunks.length && !pairs.length) return { total: 0, added: 0, skipped: 0, qa: 0 };

    if (opts.replace) {
      // `#s` refs belong to the same document: re-importing the body invalidates
      // its section summaries, and re-importing one section must not touch the
      // body or its siblings.
      const inScope = (ref: string | undefined): boolean =>
        opts.ref ? belongsToDoc(ref, opts.ref) : !ref;
      this.store.removeWhere(
        (r) =>
          r.source === opts.source &&
          (r.sessionId ?? undefined) === (opts.sessionId ?? undefined) &&
          inScope(r.ref),
      );
      // the pairs live under source 'qa' in the same scope — replace them too
      this.store.removeWhere(
        (r) =>
          r.source === 'qa' &&
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
    const qa = await this.ingestQaPairs(pairs, opts);
    return { total: chunks.length, added, skipped: chunks.length - added, qa };
  }

  /**
   * Section summaries of one imported document (v1.0.1 ③): extractive, local,
   * one record per section under `docRef#sN`. The purge covers the whole
   * `docRef` family, so a document that lost a section cannot leave a stale
   * summary behind. No Q&A scan — a summary is a locator, not a prepared answer.
   */
  async ingestDocSummaries(req: {
    docRef: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<number> {
    this.store.removeWhere((r) => r.source === 'doc' && isSectionRefOf(r.ref, req.docRef));
    const summaries = buildDocSummaries(req.text);
    let added = 0;
    for (let i = 0; i < summaries.length; i += EMBED_BATCH) {
      const batch = summaries.slice(i, i + EMBED_BATCH);
      const vectors = await this.embedder.embed(batch.map((s) => s.text));
      for (let j = 0; j < batch.length; j++) {
        const s = batch[j];
        const record = this.store.add({
          source: 'doc',
          ref: sectionRefOf(req.docRef, s.index),
          text: s.text,
          metadata: {
            ...req.metadata,
            kind: 'summary',
            doc_ref: req.docRef,
            section: s.index,
            section_title: s.title,
          },
          embedding: vectors[j],
        });
        if (record) added++;
      }
    }
    return added;
  }

  /** one record per pair: text = the whole pair, embedding = the question */
  async ingestQaPairs(
    pairs: QaPair[],
    scope: { source?: RagSource; sessionId?: string; ref?: string } = {},
  ): Promise<number> {
    if (!pairs.length) return 0;
    let added = 0;
    for (let i = 0; i < pairs.length; i += EMBED_BATCH) {
      const batch = pairs.slice(i, i + EMBED_BATCH);
      const vectors = await this.embedder.embed(batch.map((p) => p.question));
      for (let j = 0; j < batch.length; j++) {
        const p = batch[j];
        const record = this.store.add({
          source: 'qa',
          sessionId: scope.sessionId,
          ref: scope.ref,
          text: formatQaRecord(p.question, p.answer),
          metadata: {
            qa: true,
            question: p.question,
            answer: p.answer,
            via: p.via,
            qa_from: scope.source ?? 'knowledge',
          },
          embedding: vectors[j],
        });
        if (record) added++;
      }
    }
    return added;
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
    if (!facts.length) return { total: 0, added: 0, skipped: 0, qa: 0 };
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
    return { total: facts.length, added, skipped: facts.length - added, qa: 0 };
  }

  /** drop a session's material (session deleted) */
  dropSession(sessionId: string): number {
    return this.store.removeWhere((r) => r.sessionId === sessionId);
  }
}
