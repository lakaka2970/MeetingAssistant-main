/**
 * In-memory vector index with JSON persistence for the RAG knowledge layers
 * (upgrade P0). Pure logic — persistence and the clock are injected — so the
 * retrieval behaviour is unit-testable without Electron or a native sqlite.
 *
 * Why not sqlite-vec (as the upgrade sketch proposed): the realistic corpus
 * here is hundreds to a few thousand chunks (resume + JD + notes + global
 * knowledge + facts). Brute-force cosine over Float32Array is <5 ms at that
 * scale, needs no native rebuild, no ABI juggling and no asarUnpack. The
 * `VectorIndex` interface below is the seam where a sqlite-vec backend can be
 * dropped in later without touching callers.
 *
 * Persistence: one JSON file with base64-encoded float32 vectors (compact and
 * fast to parse; no dependency on any database file format).
 */

export const RAG_INDEX_VERSION = 1;

/** where a chunk came from — mirrors the knowledge-layer design */
export type RagSource =
  | 'resume'
  | 'jd'
  | 'knowledge'
  | 'doc'
  | 'custom_note'
  | 'fact'
  | 'transcript';

export interface RagRecord {
  id: number;
  source: RagSource;
  /** owning session; absent = global knowledge (searchable everywhere) */
  sessionId?: string;
  /** human-facing origin, e.g. file name or fact id */
  ref?: string;
  text: string;
  metadata?: Record<string, unknown>;
  /** 64-bit FNV-1a of `text` — dedupe + fast change detection */
  hash: string;
  createdAt: number;
}

export interface RagHit {
  record: RagRecord;
  /** cosine similarity in [-1, 1]; higher = closer */
  score: number;
}

export interface RagSearchOptions {
  topK?: number;
  /** restrict to these sources; undefined = all */
  sources?: RagSource[];
  /** drop these sources (e.g. 'fact' when the caller wants material only) */
  excludeSources?: RagSource[];
  /**
   * scope: undefined => only global records; a session id => that session's
   * records PLUS global ones (resume/JD material never leaks across sessions).
   */
  sessionId?: string;
  /** drop hits below this cosine similarity (default 0.2) */
  minScore?: number;
}

export interface RagUpsert {
  source: RagSource;
  sessionId?: string;
  ref?: string;
  text: string;
  metadata?: Record<string, unknown>;
  embedding: Float32Array;
}

// ---------- hashing ----------

/** 64-bit FNV-1a as hex — deterministic across processes, collision-safe
 * enough for change detection on text chunks. */
export function textHash(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

// ---------- math ----------

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// ---------- persistence format ----------

export interface RagIndexFile {
  version: number;
  nextId: number;
  modelKey: string;
  records: (Omit<RagRecord, 'embedding'>)[];
  /** base64(float32 buffer) keyed by record id */
  vectors: Record<string, string>;
}

export function serializeIndex(
  records: RagRecord[],
  vectors: Map<number, Float32Array>,
  modelKey: string,
): RagIndexFile {
  const out: RagIndexFile = { version: RAG_INDEX_VERSION, nextId: 0, modelKey, records: [], vectors: {} };
  let maxId = 0;
  for (const r of records) {
    const { embedding: _ignored, ...rest } = r as RagRecord & { embedding?: unknown };
    void _ignored;
    out.records.push(rest);
    maxId = Math.max(maxId, r.id);
  }
  for (const [id, v] of vectors) {
    out.vectors[String(id)] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
  }
  out.nextId = maxId + 1;
  return out;
}

export function parseIndex(file: RagIndexFile): {
  records: RagRecord[];
  vectors: Map<number, Float32Array>;
} {
  const records: RagRecord[] = file.records.map((r) => ({ ...r }));
  const vectors = new Map<number, Float32Array>();
  for (const [id, b64] of Object.entries(file.vectors ?? {})) {
    const buf = Buffer.from(b64, 'base64');
    vectors.set(Number(id), new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
  }
  return { records, vectors };
}

// ---------- the store ----------

export class VectorStore {
  private records: RagRecord[] = [];
  private vectors = new Map<number, Float32Array>();
  private nextId = 1;

  constructor(
    public modelKey = '',
    private readonly persist: (file: RagIndexFile) => void = () => {},
  ) {}

  /** number of live records */
  get size(): number {
    return this.records.length;
  }

  /** distinct (source) counts, for the UI status line */
  countsBySource(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.records) out[r.source] = (out[r.source] ?? 0) + 1;
    return out;
  }

  /**
   * Insert one chunk. Returns the created record, or null when an identical
   * text (same hash) already exists for the same source+ref+session — ingest
   * is idempotent by construction.
   */
  add(chunk: RagUpsert): RagRecord | null {
    const hash = textHash(chunk.text);
    const dup = this.records.find(
      (r) =>
        r.hash === hash &&
        r.source === chunk.source &&
        (r.sessionId ?? undefined) === (chunk.sessionId ?? undefined) &&
        (r.ref ?? undefined) === (chunk.ref ?? undefined),
    );
    if (dup) return null;

    const record: RagRecord = {
      id: this.nextId++,
      source: chunk.source,
      sessionId: chunk.sessionId,
      ref: chunk.ref,
      text: chunk.text,
      metadata: chunk.metadata,
      hash,
      createdAt: Date.now(),
    };
    this.records.push(record);
    this.vectors.set(record.id, chunk.embedding);
    this.persistNow();
    return record;
  }

  /**
   * Replace-semantics ingest point: drop all records matching the filter, then
   * (by the caller) add fresh ones. Used when a resume/JD/notes file changes.
   */
  removeWhere(pred: (r: RagRecord) => boolean): number {
    let removed = 0;
    this.records = this.records.filter((r) => {
      if (pred(r)) {
        this.vectors.delete(r.id);
        removed++;
        return false;
      }
      return true;
    });
    if (removed > 0) this.persistNow();
    return removed;
  }

  search(query: Float32Array, opts: RagSearchOptions = {}): RagHit[] {
    const topK = Math.max(1, opts.topK ?? 5);
    const minScore = opts.minScore ?? 0.2;
    const sources = opts.sources ? new Set(opts.sources) : undefined;
    const exclude = opts.excludeSources ? new Set(opts.excludeSources) : undefined;
    const hits: RagHit[] = [];
    for (const r of this.records) {
      if (sources && !sources.has(r.source)) continue;
      if (exclude && exclude.has(r.source)) continue;
      if (opts.sessionId === undefined) {
        if (r.sessionId !== undefined) continue; // global-only query
      } else if (r.sessionId !== undefined && r.sessionId !== opts.sessionId) {
        continue; // another session's material
      }
      const v = this.vectors.get(r.id);
      if (!v) continue;
      const score = cosine(query, v);
      if (score >= minScore) hits.push({ record: r, score });
    }
    hits.sort((a, b) => b.score - a.score || a.record.id - b.record.id);
    return hits.slice(0, topK);
  }

  /** exact lookup by id (UI inspection / tests) */
  get(id: number): RagRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** snapshot of every record (reindex / diagnostics) — not live */
  allRecords(): RagRecord[] {
    return [...this.records];
  }

  persistNow(): void {
    this.persist(serializeIndex(this.records, this.vectors, this.modelKey));
  }

  static fromFile(
    file: RagIndexFile,
    persist: (file: RagIndexFile) => void = () => {},
  ): VectorStore {
    const store = new VectorStore(file.modelKey, persist);
    const { records, vectors } = parseIndex(file);
    store.records = records;
    store.vectors = vectors;
    store.nextId = Math.max(1, file.nextId ?? records.length + 1);
    return store;
  }
}
