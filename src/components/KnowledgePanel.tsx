/**
 * Knowledge panel (upgrade P0/M3): one place for the three-layer knowledge
 * stack — embed-worker/index status, a retrieval playground, the L2 personal
 * notes editor and the embedding-model switch with re-index.
 *
 * Read-only over IPC by design: chunking, embedding and persistence all live
 * in the main process; this panel only previews retrieval and edits notes.
 */
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { EMBEDDING_MODELS } from '../../shared/embeddingModels';
import type {
  KnowledgeFilesState,
  PreparedQaView,
  RagHitView,
  RagStatus,
  SkillView,
} from '../../shared/protocol';

const SOURCE_KEYS = {
  resume: 'sourceResume',
  jd: 'sourceJd',
  knowledge: 'sourceKnowledge',
  doc: 'sourceDoc',
  custom_note: 'sourceNote',
  fact: 'sourceFact',
  transcript: 'sourceTranscript',
  qa: 'sourceQa',
} as const;

export function KnowledgePanel({
  onClose,
  sessionId,
}: {
  onClose: () => void;
  /** the interview currently open — its own resume/JD pairs are listed too */
  sessionId?: string;
}) {
  const t = useT();
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<RagHitView[] | null>(null);
  const [searchMs, setSearchMs] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [notes, setNotes] = useState<string>('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [notesNotice, setNotesNotice] = useState<string | null>(null);
  const [notesMax, setNotesMax] = useState(8000);
  const [reindexing, setReindexing] = useState(false);
  const [reindexNotice, setReindexNotice] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [library, setLibrary] = useState<KnowledgeFilesState>({ files: [], chars: 0 });
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  /** the prepared Q&A pairs the index detected (what a direct hit can serve) */
  const [qaList, setQaList] = useState<PreparedQaView[]>([]);
  const [qaOpen, setQaOpen] = useState(false);

  const refreshQa = useCallback(() => {
    void window.mc
      .ragQaList(sessionId)
      .then(setQaList)
      .catch(() => setQaList([]));
  }, [sessionId]);

  const refreshStatus = useCallback(() => {
    void window.mc
      .ragStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshStatus();
    refreshQa();
    const off = window.mc.onRagStatus((s) => setStatus(s));
    void window.mc
      .notesGet()
      .then((n) => {
        setNotes(n.text);
        setNotesMax(n.maxChars);
      })
      .catch(() => {});
    void window.mc
      .skillsList()
      .then(setSkills)
      .catch(() => {});
    void window.mc
      .listKnowledgeFiles()
      .then(setLibrary)
      .catch(() => {});
    return off;
  }, [refreshStatus, refreshQa]);

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      // scoped like a real question: this interview's own material plus global
      const r = await window.mc.ragSearch({ query: q, sessionId });
      setHits(r.hits);
      setSearchMs(r.ms);
    } catch {
      setHits([]);
    } finally {
      setSearching(false);
    }
  }, [query, sessionId]);

  const saveNotes = useCallback(async () => {
    setNotesNotice(null);
    try {
      const r = await window.mc.notesSet(notes);
      if (r.ok) {
        setNotesNotice(t.knowledge.notesSaved);
        setNotesDirty(false);
        refreshStatus();
        // main re-indexes the notes' Q&A in the background — give it a beat
        setTimeout(refreshQa, 800);
      } else {
        setNotesNotice(t.knowledge.notesTooLong(notesMax));
      }
    } catch (e) {
      setNotesNotice((e as Error).message);
    }
  }, [notes, notesMax, t, refreshStatus, refreshQa]);

  const reindex = useCallback(
    async (model?: string) => {
      setReindexing(true);
      setReindexNotice(null);
      try {
        const s = await window.mc.ragReindex(model);
        setStatus(s);
        setReindexNotice(t.knowledge.reindexDone(s.chunks));
      } catch {
        setReindexNotice(t.knowledge.reindexFailed);
      } finally {
        setReindexing(false);
      }
    },
    [t],
  );

  const importFiles = useCallback(async () => {
    setImporting(true);
    setImportNotice(null);
    try {
      const r = await window.mc.importKnowledgeFiles();
      setImportNotice(t.knowledge.importResult(r));
      setLibrary(await window.mc.listKnowledgeFiles());
      refreshStatus();
      refreshQa();
    } catch (e) {
      setImportNotice((e as Error).message);
    } finally {
      setImporting(false);
    }
  }, [t, refreshStatus, refreshQa]);

  const importDir = useCallback(async () => {
    setImporting(true);
    setImportNotice(null);
    try {
      const r = await window.mc.importKnowledgeDir();
      setImportNotice(t.knowledge.importResult(r));
      setLibrary(await window.mc.listKnowledgeFiles());
      refreshStatus();
      refreshQa();
    } catch (e) {
      setImportNotice((e as Error).message);
    } finally {
      setImporting(false);
    }
  }, [t, refreshStatus, refreshQa]);

  const removeFile = useCallback(
    async (ref: string) => {
      setLibrary(await window.mc.removeKnowledgeFile(ref));
      refreshStatus();
    },
    [refreshStatus],
  );

  const clearLibrary = useCallback(async () => {
    if (!window.confirm(t.knowledge.clearLibraryConfirm)) return;
    setLibrary(await window.mc.clearKnowledgeFiles());
    refreshStatus();
  }, [t, refreshStatus]);

  const stateLabel = !status
    ? ''
    : status.state === 'ready'
      ? t.knowledge.stateReady
      : status.state === 'loading'
        ? t.knowledge.stateLoading
        : status.state === 'error'
          ? t.knowledge.stateError
          : t.knowledge.stateIdle;

  return (
    <div className="settings knowledge-panel">
      <div className="settings-section">{t.knowledge.title}</div>
      <div className="settings-hint">{t.knowledge.intro}</div>

      {/* ---- status ---- */}
      <div className="settings-row">
        <span className="settings-label">{t.knowledge.modelLabel}</span>
        <select
          value={status?.modelKey ?? 'bge-m3'}
          disabled={reindexing}
          onChange={(e) => void reindex(e.target.value)}
        >
          {Object.values(EMBEDDING_MODELS).map((m) => (
            <option key={m.key} value={m.key}>
              {m.labelZh}（{m.dim}d · ~{m.sizeHintMb}MB）
            </option>
          ))}
        </select>
        <span className="settings-inline-hint">
          {status?.modelLocal ? t.knowledge.modelLocal : t.knowledge.modelDownload}
        </span>
      </div>
      <div className="settings-inline-hint">
        {stateLabel}
        {status?.state === 'loading' && status.downloadPct !== null
          ? ` · ${t.knowledge.downloadPct(status.downloadPct)}`
          : ''}
        {status ? ` · ${t.knowledge.chunksLabel(status.chunks)}` : ''}
        {status?.lastError ? ` · ${status.lastError}` : ''}
      </div>
      {status && status.chunks > 0 && (
        <div className="settings-inline-hint">
          {t.knowledge.bySourceLabel}:{' '}
          {Object.entries(status.bySource)
            .map(([src, n]) => `${t.knowledge[SOURCE_KEYS[src as keyof typeof SOURCE_KEYS] ?? 'sourceKnowledge']} ${n}`)
            .join(' · ')}
        </div>
      )}

      {/* ---- document library (multi-file import) ---- */}
      <div className="settings-section">{t.knowledge.libraryTitle}</div>
      <div className="settings-hint">{t.knowledge.libraryHint}</div>
      <div className="settings-actions">
        <button className="btn btn-primary" disabled={importing} onClick={() => void importFiles()}>
          {t.knowledge.importFilesBtn}
        </button>
        <button className="btn" disabled={importing} onClick={() => void importDir()}>
          {t.knowledge.importDirBtn}
        </button>
      </div>
      {library.files.length > 0 ? (
        <>
          <div className="knowledge-hits">
            {library.files.map((f) => (
              <div key={f.ref} className="knowledge-hit">
                <div
                  className="knowledge-hit-meta"
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
                >
                  <span>
                    {f.name} · {t.knowledge.libraryChars(f.chars)}
                  </span>
                  <button className="btn btn-sm" onClick={() => void removeFile(f.ref)}>
                    {t.knowledge.removeFile}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="settings-actions">
            <button className="btn" onClick={() => void clearLibrary()}>
              {t.knowledge.clearLibrary}
            </button>
          </div>
        </>
      ) : (
        <div className="settings-inline-hint">{t.knowledge.libraryEmpty}</div>
      )}
      {importNotice && <div className="settings-inline-hint">{importNotice}</div>}

      {/* ---- prepared answers (auto-detected Q&A → direct hits) ---- */}
      <div className="settings-section">{t.knowledge.qaTitle}</div>
      <div className="settings-hint">{t.knowledge.qaHint}</div>
      <div className="settings-actions">
        <span className="settings-inline-hint">{t.knowledge.qaCount(qaList.length)}</span>
        {qaList.length > 0 && (
          <button className="btn" onClick={() => setQaOpen((v) => !v)}>
            {t.knowledge.qaBtn}
          </button>
        )}
      </div>
      {qaList.length === 0 ? (
        <div className="settings-inline-hint">{t.knowledge.qaEmpty}</div>
      ) : (
        qaOpen && (
          <div className="knowledge-hits">
            {qaList.map((p, i) => (
              <div key={`${p.ref ?? ''}|${p.question}`} className="knowledge-hit">
                <div
                  className="knowledge-hit-meta"
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}
                >
                  <span style={{ fontWeight: 600 }}>{p.question}</span>
                  <span style={{ flexShrink: 0 }}>
                    {[p.ref, p.sessionId ? t.knowledge.qaThisSession : t.knowledge.qaGlobal]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <div className="knowledge-hit-text">{p.answer}</div>
              </div>
            ))}
          </div>
        )
      )}

      {/* ---- search playground ---- */}
      <div className="settings-section">{t.knowledge.searchTitle}</div>
      <div className="settings-hint">{t.knowledge.searchHint}</div>
      <div className="settings-row">
        <input
          style={{ flex: 1 }}
          value={query}
          placeholder={t.knowledge.searchPlaceholder}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
          }}
        />
        <button className="btn btn-primary" disabled={searching || !query.trim()} onClick={() => void search()}>
          {searching ? t.knowledge.searching : t.knowledge.searchBtn}
        </button>
      </div>
      {hits !== null && (
        <div className="knowledge-hits">
          {hits.length === 0 && <div className="settings-inline-hint">{t.knowledge.searchNoHits}</div>}
          {hits.map((h, i) => (
            <div key={i} className="knowledge-hit">
              <div className="knowledge-hit-meta">
                [{h.source}
                {h.ref ? `|${h.ref}` : ''}] · {h.score.toFixed(3)}
                {searchMs !== null && i === 0 ? ` · ${t.knowledge.searchMs(searchMs)}` : ''}
              </div>
              <div className="knowledge-hit-text">{h.text}</div>
            </div>
          ))}
        </div>
      )}

      {/* ---- L2 notes ---- */}
      <div className="settings-section">{t.knowledge.notesTitle}</div>
      <div className="settings-hint">{t.knowledge.notesHint}</div>
      <textarea
        className="knowledge-notes"
        value={notes}
        placeholder={t.knowledge.notesPlaceholder}
        spellCheck={false}
        onChange={(e) => {
          setNotes(e.target.value);
          setNotesDirty(true);
        }}
      />
      <div className="settings-actions">
        <span className="settings-inline-hint">
          {t.knowledge.notesChars(notes.length, notesMax)}
        </span>
        <button className="btn btn-primary" disabled={!notesDirty} onClick={() => void saveNotes()}>
          {t.knowledge.notesSave}
        </button>
        {notesNotice && <span className="settings-inline-hint">{notesNotice}</span>}
      </div>

      {/* ---- reindex ---- */}
      <div className="settings-hint">{t.knowledge.reindexHint}</div>
      <div className="settings-actions">
        <button className="btn" disabled={reindexing} onClick={() => void reindex()}>
          {reindexing ? t.knowledge.reindexing : t.knowledge.reindexBtn}
        </button>
        {reindexNotice && <span className="settings-inline-hint">{reindexNotice}</span>}
      </div>

      {/* ---- skills (upgrade P3) ---- */}
      <div className="settings-section">{t.knowledge.skillsTitle}</div>
      <div className="settings-hint">{t.knowledge.skillsHint}</div>
      {skills.length === 0 ? (
        <div className="settings-inline-hint">{t.knowledge.skillsEmpty}</div>
      ) : (
        <div className="knowledge-hits">
          {skills.map((s) => (
            <div key={s.trigger} className="knowledge-hit">
              <div className="knowledge-hit-meta">
                <code>{s.trigger}</code> · {s.name}
              </div>
              <div className="knowledge-hit-text">{s.description}</div>
            </div>
          ))}
        </div>
      )}

      <div className="settings-actions">
        <button className="btn" onClick={onClose}>
          {t.knowledge.close}
        </button>
      </div>
    </div>
  );
}
