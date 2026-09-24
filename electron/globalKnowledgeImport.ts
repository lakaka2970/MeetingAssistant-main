/**
 * The global knowledge channel: pick one document → knowledge.md → the
 * 'knowledge' vector source. Parsing MUST go through the same deterministic
 * document parser every other import uses: reading a PDF as UTF-8 text used to
 * store its binary bytes as the user's "knowledge base" and index that noise.
 *
 * knowledge.md is what the answer prompt injects, so a vector-index failure is
 * logged, not fatal — the text still works without embeddings.
 */
import { normalizeDocText } from './docparse';

/** what the vector index reports back; only these two counts are ever logged */
export interface IngestCounts {
  added: number;
  total: number;
}

export interface GlobalImportDeps {
  /** overwrite knowledge.md */
  set: (text: string) => void;
  /** re-index the whole global source with the new text */
  ingest: (text: string) => Promise<IngestCounts | null | undefined>;
  parse: (filePath: string) => Promise<string>;
  log?: (msg: string) => void;
}

export interface GlobalImportResult {
  imported: boolean;
  reason?: 'empty' | 'failed';
  detail?: string;
}

export async function importGlobalKnowledge(
  filePath: string,
  deps: GlobalImportDeps,
): Promise<GlobalImportResult> {
  const log = (msg: string): void => deps.log?.(msg);
  let text: string;
  try {
    text = normalizeDocText(await deps.parse(filePath));
  } catch (e) {
    log(`[knowledge] global import failed for ${filePath}: ${(e as Error).message}`);
    return { imported: false, reason: 'failed', detail: (e as Error).message };
  }
  // a scanned PDF parses to '' — replacing then would silently wipe a KB the
  // user built from another document
  if (!text) {
    log(`[knowledge] global import skipped, no readable text in ${filePath}`);
    return { imported: false, reason: 'empty' };
  }
  deps.set(text);
  log(`[knowledge] global import: ${text.length} chars from ${filePath}`);
  try {
    const res = await deps.ingest(text);
    if (res) log(`[rag] knowledge ingest: ${res.added}/${res.total} chunks`);
  } catch (e) {
    log(`[rag] knowledge ingest failed: ${(e as Error).message}`);
  }
  return { imported: true };
}
