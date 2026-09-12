/**
 * Loader for a pre-chunked knowledge base index (`991_index.jsonl`).
 *
 * Why consume someone else's chunking at all: this file is the output of a
 * human chunking decision — split on `## ` sections, question/answer tables kept
 * whole, every block carrying job / layer / domain / evidence / section
 * metadata. The app's own chunker (300 chars, 50 overlap, sentence-aligned)
 * destroys exactly that: it cuts a 30秒/90秒/追到底 triple apart, splits a table
 * mid-cell, and separates a "2 分钟版" answer from the "60 秒版" it depends on.
 * Re-chunking would also break the `doc_id` references that the KB's own
 * evaluation set and its routing tables are written against.
 *
 * So: when the index exists, it is the source of truth for chunk boundaries and
 * metadata. When it does not, callers fall back to the ordinary importer.
 *
 * Pure parsing, no fs, no Electron — so the shape can be unit-tested and a
 * malformed line cannot take the RAG down at boot.
 */

/** one indexed block, as written by `_tools/build_index.py` */
export interface KbChunk {
  chunkId: string;
  docId: string;
  title: string;
  path: string;
  section: string;
  docType: string;
  jobPrimary: string;
  jobSecondary: string[];
  layer: string;
  domain: string;
  scenarios: string[];
  evidence: string[];
  priority: string;
  status: string;
  breadcrumb: string[];
  text: string;
  nChars: number;
  hash: string;
}

/** fields the KB's BM25 indexes separately, with the weights it tuned */
export const KB_FIELD_WEIGHTS = {
  title: 2.6,
  section: 1.9,
  meta: 1.5,
  text: 1.0,
} as const;

/** the metadata blob: job / layer / domain / scenarios / evidence as one field */
export function metaFieldOf(c: KbChunk): string {
  return [
    c.jobPrimary,
    ...c.jobSecondary,
    c.layer,
    c.domain,
    c.docType,
    c.priority,
    ...c.scenarios,
    ...c.evidence,
    ...c.breadcrumb,
  ]
    .filter(Boolean)
    .join(' ');
}

type RawRow = Record<string, unknown>;

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string') as string[];
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

/**
 * Parse one JSONL line. Returns null for anything unusable rather than throwing:
 * a single corrupt line in a hand-maintained index must not blank the whole
 * knowledge base, and a truncated final line is normal after an interrupted
 * rebuild.
 */
export function parseKbChunkLine(line: string): KbChunk | null {
  const t = line.trim();
  if (!t) return null;
  let raw: RawRow;
  try {
    raw = JSON.parse(t) as RawRow;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = str(raw.text);
  const chunkId = str(raw.chunk_id);
  // chunk_id + text are the two things retrieval cannot work without
  if (!chunkId || !text.trim()) return null;
  return {
    chunkId,
    docId: str(raw.doc_id),
    title: str(raw.title),
    path: str(raw.path),
    section: str(raw.section),
    docType: str(raw.doc_type),
    jobPrimary: str(raw.job_primary),
    jobSecondary: strList(raw.job_secondary),
    layer: str(raw.layer),
    domain: str(raw.domain),
    scenarios: strList(raw.scenarios),
    evidence: strList(raw.evidence),
    priority: str(raw.priority),
    status: str(raw.status),
    breadcrumb: strList(raw.breadcrumb),
    text,
    nChars: typeof raw.n_chars === 'number' ? raw.n_chars : text.length,
    hash: str(raw.hash),
  };
}

export interface KbParseReport {
  chunks: KbChunk[];
  lines: number;
  skipped: number;
  /** distinct doc_id, so a caller can sanity-check against the KB's own count */
  docs: number;
}

export function parseKbIndex(content: string): KbParseReport {
  const lines = content.split('\n');
  const chunks: KbChunk[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = parseKbChunkLine(line);
    if (c) chunks.push(c);
    else skipped += 1;
  }
  return {
    chunks,
    lines: lines.filter((l) => l.trim()).length,
    skipped,
    docs: new Set(chunks.map((c) => c.docId).filter(Boolean)).size,
  };
}
