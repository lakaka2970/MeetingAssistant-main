/**
 * RAG service: one object owning the L1/L2/L3 knowledge stack for the main
 * process (upgrade P0) —
 *   L1  reference files (resume / JD / knowledge.md)   → VectorStore chunks
 *   L2  custom notes (CustomNotesManager, notes.md)    → stable-prefix slot
 *   L3  semantic recall (VectorStore + local embedder) → fast-context block
 *
 * Fully lazy: nothing spawns until the first ingest/search while
 * `rag.enabled` is true, so the worker/index cost is zero when unused.
 * Persistence is a single debounced JSON file under userData/rag/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { EmbedClient } from './embedClient';
import { getEmbeddingModel } from './embedding';
import { RagIngestor, type IngestResult } from './ingest';
import {
  VectorStore,
  type RagHit,
  type RagIndexFile,
  type RagRecord,
  type RagSource,
} from './vector-store';
import { CustomNotesManager, MAX_NOTES_CHARS } from '../knowledge/customNotes';

export interface RagSettingsView {
  enabled: boolean;
  model: string;
  topK: number;
  minScore: number;
  remoteHost: string;
}

export interface RagServiceDeps {
  /** userData dir — notes.md and rag/index.json live under it */
  userDataDir: string;
  /** shared model cache dir (same layout as the ASR whisper cache) */
  modelsDir: string;
  /** live settings view */
  getSettings(): RagSettingsView;
  /** forward status changes to the renderer */
  onStatusChange?(): void;
}

export interface RetrieveResult {
  hits: { text: string; source: string; ref?: string; score: number }[];
  /** claimed-fact hits (upgrade P3) — feed the consistency hint */
  facts: { text: string; score: number }[];
  ms: number;
}

const INDEX_DIR = 'rag';
const INDEX_FILE = 'index.json';
const NOTES_FILE = 'notes.md';
/** minimum question length worth a retrieval round-trip */
export const MIN_QUERY_CHARS = 6;

export class RagService {
  private embedder: EmbedClient;
  private store: VectorStore | null = null;
  private ingestor: RagIngestor | null = null;
  private notesManager: CustomNotesManager;
  private storeLoaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDownloadPct: number | null = null;

  constructor(private readonly deps: RagServiceDeps) {
    this.embedder = new EmbedClient({
      onState: () => this.deps.onStatusChange?.(),
      onDownloadProgress: (p) => {
        if (typeof p.pct === 'number') this.lastDownloadPct = Math.round(p.pct);
      },
    });
    const notesPath = join(this.deps.userDataDir, NOTES_FILE);
    let initial = '';
    try {
      if (existsSync(notesPath)) initial = readFileSync(notesPath, 'utf8');
    } catch {
      initial = '';
    }
    this.notesManager = new CustomNotesManager(initial.slice(0, MAX_NOTES_CHARS), (content) => {
      try {
        writeFileSync(notesPath, content, 'utf8');
      } catch (e) {
        console.warn('[rag] notes persist failed:', (e as Error).message);
      }
    });
  }

  // ---- notes (L2) ----

  get notes(): CustomNotesManager {
    return this.notesManager;
  }

  // ---- index plumbing ----

  private get indexPath(): string {
    return join(this.deps.userDataDir, INDEX_DIR, INDEX_FILE);
  }

  private ensureStore(): VectorStore {
    if (this.store) return this.store;
    const modelKey = getEmbeddingModel(this.deps.getSettings().model).key;
    let file: RagIndexFile | null = null;
    try {
      if (existsSync(this.indexPath)) {
        const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as RagIndexFile;
        if (parsed?.version === 1 && parsed.modelKey === modelKey) file = parsed;
        else if (parsed && parsed.modelKey !== modelKey) {
          console.warn(`[rag] index model ${parsed.modelKey} != ${modelKey}; reindex required`);
          // keep the texts, drop the (dimension-mismatched) vectors
          parsed.vectors = {};
          file = parsed;
        }
      }
    } catch (e) {
      console.warn('[rag] index load failed, starting empty:', (e as Error).message);
      file = null;
    }
    this.storeLoaded = true;
    this.store = file
      ? VectorStore.fromFile(file, (f) => this.scheduleSave(f))
      : new VectorStore(modelKey, (f) => this.scheduleSave(f));
    this.ingestor = new RagIngestor(this.store, this.embedder);
    return this.store;
  }

  private scheduleSave(file: RagIndexFile): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(join(this.deps.userDataDir, INDEX_DIR), { recursive: true });
        writeFileSync(this.indexPath, JSON.stringify(file), 'utf8');
      } catch (e) {
        console.warn('[rag] index persist failed:', (e as Error).message);
      }
    }, 400);
  }

  /** spawn the embed worker (no-op when ready); false = RAG unusable right now */
  async ensureReady(): Promise<boolean> {
    if (!this.deps.getSettings().enabled) return false;
    const s = this.deps.getSettings();
    try {
      await this.embedder.ensure({
        modelKey: s.model,
        modelsDir: this.deps.modelsDir,
        remoteHost: s.remoteHost,
      });
      this.ensureStore();
      return true;
    } catch (e) {
      console.warn('[rag] embed worker unavailable:', (e as Error).message);
      return false;
    }
  }

  // ---- ingest (L1/L2 → L3) ----

  async ingest(opts: {
    text: string;
    source: RagSource;
    sessionId?: string;
    ref?: string;
    replace?: boolean;
  }): Promise<IngestResult | null> {
    if (!(await this.ensureReady())) return null;
    try {
      return await this.ingestor!.ingest(opts);
    } catch (e) {
      console.warn('[rag] ingest failed:', (e as Error).message);
      return null;
    }
  }

  ingestSessionMaterial(
    kind: 'resume' | 'jd',
    sessionId: string | undefined,
    ref: string | undefined,
    text: string,
  ): Promise<IngestResult | null> {
    // without a session id the material would leak into every session — skip
    if (!sessionId) return Promise.resolve(null);
    return this.ingest({ text, source: kind, sessionId, ref, replace: true });
  }

  /** drop every chunk of one global source (e.g. knowledge.md cleared) */
  clearSource(source: RagSource, sessionId?: string): number {
    if (!this.storeLoaded) return 0;
    return this.ensureStore().removeWhere(
      (r) => r.source === source && (r.sessionId ?? undefined) === (sessionId ?? undefined),
    );
  }

  /** drop one imported document's chunks (source 'doc', exact ref) */
  removeDocument(ref: string): number {
    if (!this.storeLoaded) return 0;
    return this.ensureStore().removeWhere(
      (r) => r.source === 'doc' && (r.ref ?? undefined) === ref,
    );
  }

  /** drop a session's material (session deleted) */
  dropSession(sessionId: string): number {
    if (!this.storeLoaded) return 0;
    return this.ensureStore().removeWhere((r) => r.sessionId === sessionId);
  }

  // ---- retrieval (L3) ----

  /**
   * Serve a live question. NEVER spawns the worker or waits for a download —
   * a question must not block on a 600 MB model fetch. Warm the service
   * explicitly ({@link ensureReady}, called on capture start / ingest / UI).
   * One query embedding feeds BOTH searches: material hits (for the RAG
   * block) and claimed-fact hits (for the consistency hint, upgrade P3).
   */
  async retrieve(query: string, sessionId?: string, topK?: number): Promise<RetrieveResult> {
    const t0 = Date.now();
    const q = query.trim();
    const s = this.deps.getSettings();
    if (!s.enabled || q.length < MIN_QUERY_CHARS) return { hits: [], facts: [], ms: 0 };
    if (this.embedder.state !== 'ready') return { hits: [], facts: [], ms: Date.now() - t0 };
    try {
      const qvec = await this.embedder.embedOne(q, 15_000);
      const store = this.ensureStore();
      const toView = (h: RagHit) => ({
        text: h.record.text,
        source: h.record.source,
        ref: h.record.ref,
        score: Number(h.score.toFixed(4)),
      });
      const hits = store
        .search(qvec, {
          topK: topK ?? s.topK,
          minScore: s.minScore,
          sessionId,
          excludeSources: ['fact'],
        })
        .map(toView);
      const facts = store
        .search(qvec, { topK: 4, minScore: Math.max(0.35, s.minScore), sessionId, sources: ['fact'] })
        .map(toView);
      return { hits, facts, ms: Date.now() - t0 };
    } catch (e) {
      console.warn('[rag] retrieve failed:', (e as Error).message);
      return { hits: [], facts: [], ms: Date.now() - t0 };
    }
  }

  /** renderer search playground: bypasses the min-question-length gate */
  async searchForUi(query: string, sessionId?: string): Promise<RetrieveResult> {
    const t0 = Date.now();
    if (!(await this.ensureReady())) return { hits: [], facts: [], ms: Date.now() - t0 };
    const qvec = await this.embedder.embedOne(query, 15_000);
    const s = this.deps.getSettings();
    const store = this.ensureStore();
    const hits = store
      .search(qvec, { topK: Math.max(5, s.topK * 2), minScore: 0, sessionId })
      .map((h) => ({
        text: h.record.text,
        source: h.record.source,
        ref: h.record.ref,
        score: Number(h.score.toFixed(4)),
      }));
    return { hits, facts: [], ms: Date.now() - t0 };
  }

  /** replace this session's claimed-fact records (upgrade P3) */
  async ingestFacts(sessionId: string, facts: string[]): Promise<IngestResult | null> {
    if (!(await this.ensureReady())) return null;
    try {
      return await this.ingestor!.ingestFacts(sessionId, facts);
    } catch (e) {
      console.warn('[rag] fact ingest failed:', (e as Error).message);
      return null;
    }
  }

  // ---- reindex (model switch / dimension change) ----

  /** Re-embed every stored chunk with the CURRENT model. Texts survive a
   * dimension change because the index file keeps them; only vectors drop. */
  async reindex(): Promise<{ records: number; failed: boolean }> {
    const store = this.ensureStore();
    const records = store.allRecords();
    if (!records.length) return { records: 0, failed: false };

    const modelKey = getEmbeddingModel(this.deps.getSettings().model).key;
    const fresh = new VectorStore(modelKey, (f) => this.scheduleSave(f));
    const oldStore = this.store;
    this.store = fresh;
    this.ingestor = new RagIngestor(fresh, this.embedder);

    try {
      await this.embedder.ensure({
        modelKey,
        modelsDir: this.deps.modelsDir,
        remoteHost: this.deps.getSettings().remoteHost,
      });
      const batch = 8;
      let done = 0;
      for (let i = 0; i < records.length; i += batch) {
        const slice = records.slice(i, i + batch);
        const vectors = await this.embedder.embed(slice.map((r) => r.text));
        for (let j = 0; j < slice.length; j++) {
          const r: RagRecord = slice[j];
          fresh.add({
            source: r.source,
            sessionId: r.sessionId,
            ref: r.ref,
            text: r.text,
            metadata: r.metadata,
            embedding: vectors[j],
          });
        }
        done += slice.length;
        console.log(`[rag] reindex ${done}/${records.length}`);
      }
      fresh.persistNow();
      return { records: records.length, failed: false };
    } catch (e) {
      console.error('[rag] reindex failed, restoring previous vectors:', (e as Error).message);
      this.store = oldStore;
      this.ingestor = new RagIngestor(oldStore!, this.embedder);
      return { records: records.length, failed: true };
    }
  }

  // ---- status ----

  status(): {
    enabled: boolean;
    state: 'idle' | 'loading' | 'ready' | 'error';
    modelKey: string;
    modelHfId: string;
    dim: number;
    modelLocal: boolean;
    source: 'local' | 'download' | null;
    loadMs: number | null;
    chunks: number;
    bySource: Record<string, number>;
    lastError: string;
    downloadPct: number | null;
  } {
    const desc = getEmbeddingModel(this.deps.getSettings().model);
    const store = this.storeLoaded && this.store ? this.store : null;
    const chunks = store ? store.size : 0;
    return {
      enabled: this.deps.getSettings().enabled,
      state: this.embedder.state,
      modelKey: desc.key,
      modelHfId: desc.hfId,
      dim: this.embedder.ready?.dim ?? desc.dim,
      modelLocal: existsSync(join(this.deps.modelsDir, desc.hfId, 'config.json')),
      source: this.embedder.ready?.source ?? null,
      loadMs: this.embedder.ready?.loadMs ?? null,
      chunks,
      bySource: store ? store.countsBySource() : {},
      lastError: this.embedder.lastError,
      downloadPct: this.embedder.state === 'loading' ? this.lastDownloadPct : null,
    };
  }

  async dispose(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      try {
        this.store?.persistNow();
      } catch {
        /* best effort */
      }
    }
    await this.embedder.dispose();
  }
}
