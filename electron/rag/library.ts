/**
 * Document-library import (v1.0.1 ③): the walk / ref-naming / ingest rules for
 * multi-file knowledge import, extracted from `registerIpc` so it can be tested
 * without an Electron process. Behaviour is unchanged from the inline version.
 *
 * Everything external is injected: the parser, the RAG ingest call, the on-disk
 * manifest and the clock. `extract` is the only async dependency by design —
 * parsing is what makes a single file fail while the rest of a directory import
 * still succeeds.
 */
import { readdirSync, type Dirent } from 'fs';
import { basename, join, relative, sep } from 'path';
import type {
  KnowledgeFile,
  KnowledgeImportItem,
  KnowledgeImportProgress,
  KnowledgeImportResult,
} from '../../shared/protocol';
import { isLibraryExtension } from '../docparse';
import { textHash } from './vector-store';

/** guard against pathological nesting / symlink loops */
export const LIBRARY_WALK_MAX_DEPTH = 12;
/**
 * Nothing real a meeting needs is bigger than this, and the parsers read the
 * whole file into memory (pdf/pptx unzip it too), so a bigger one is refused by
 * its stat — the cost of letting it through is the main process, not a slow import.
 */
export const LIBRARY_MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface LibraryManifest {
  list(): KnowledgeFile[];
  hasRef(ref: string): boolean;
  upsert(entry: KnowledgeFile): void;
}

/** the cheap half of the freshness check — stat costs nothing next to parsing */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export interface LibraryDeps {
  manifest: LibraryManifest;
  /** document → text; throws on a corrupt or unreadable file */
  extract: (path: string) => Promise<string>;
  /** returns null when the index silently declined the text */
  ingest: (req: {
    text: string;
    source: 'doc';
    ref: string;
    replace: true;
  }) => Promise<{ added: number; qa?: number } | null>;
  /** source-file freshness; null when the file cannot be stat'd (gone, locked) */
  stat: (path: string) => FileStamp | null;
  /**
   * Local section analysis of a document that just went in; returns how many
   * summary records it stored. Best-effort: rejecting must not fail the import.
   */
  summarize?: (req: { ref: string; text: string; name: string }) => Promise<number>;
  /** one call per settled file, so a large import can show a live progress bar */
  onProgress?: (p: KnowledgeImportProgress) => void;
  now: () => Date;
  log?: (message: string) => void;
}

export const emptyImportResult = (): KnowledgeImportResult => ({
  imported: 0,
  skipped: 0,
  failed: 0,
  unchanged: 0,
  chars: 0,
  chunks: 0,
  items: [],
});

/** recursive walk; skips hidden entries and unsupported extensions */
export function walkLibraryDir(dir: string, out: string[], depth = 0): void {
  if (depth > LIBRARY_WALK_MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.warn(`[knowledge-files] cannot read ${dir}:`, (e as Error).message);
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walkLibraryDir(full, out, depth + 1);
    else if (ent.isFile() && isLibraryExtension(ent.name)) out.push(full);
  }
}

/** unique RAG ref for one file; re-importing the same path keeps its ref */
export function libraryRefFor(filePath: string, manifest: LibraryManifest, root?: string): string {
  const existing = manifest.list().find((f) => f.path === filePath);
  if (existing) return existing.ref;
  const base = root ? relative(root, filePath).split(sep).join('/') : basename(filePath);
  if (!manifest.hasRef(base)) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let n = 2;
  while (manifest.hasRef(`${stem} (${n})${ext}`)) n++;
  return `${stem} (${n})${ext}`;
}

export function createLibraryImporter(deps: LibraryDeps) {
  const log = deps.log ?? ((m: string) => console.log(m));

  /** `root` is the picked directory, so a folder import keeps relative refs */
  async function ingestFiles(files: string[], root?: string): Promise<KnowledgeImportResult> {
    const out = emptyImportResult();
    const known = new Map(deps.manifest.list().map((f) => [f.path, f] as const));
    const settle = (item: KnowledgeImportItem): KnowledgeImportItem => {
      out.items.push(item);
      deps.onProgress?.({ done: out.items.length, total: files.length, item });
      return item;
    };
    /** local section analysis — a failure costs the summaries, never the import */
    const analyze = async (filePath: string, ref: string, name: string, text: string) => {
      if (!deps.summarize) return { summaries: 0, failed: false };
      try {
        return { summaries: (await deps.summarize({ ref, text, name })) ?? 0, failed: false };
      } catch (e) {
        log(`[knowledge-files] section analysis failed ${filePath}: ${(e as Error).message}`);
        return { summaries: 0, failed: true };
      }
    };
    for (const filePath of files) {
      const name = basename(filePath);
      if (!isLibraryExtension(filePath)) {
        // decided from the name alone: the parser is never handed a .zip
        out.skipped++;
        settle({ name, status: 'skipped', reason: 'unsupported-extension', chunks: 0 });
        continue;
      }
      try {
        const prev = known.get(filePath);
        const stamp = deps.stat(filePath);
        if (
          prev &&
          !prev.analysisFailed &&
          stamp &&
          prev.hash &&
          prev.mtimeMs === stamp.mtimeMs &&
          prev.size === stamp.size
        ) {
          out.unchanged++; // the cheap short-circuit: no parse, no embed, no rewrite
          settle({ name, ref: prev.ref, status: 'unchanged', chunks: prev.chunks });
          continue;
        }
        if (stamp && stamp.size > LIBRARY_MAX_FILE_BYTES) {
          // decided from the stat alone, before a byte is read
          out.skipped++;
          settle({ name, ref: prev?.ref, status: 'skipped', reason: 'too-large', chunks: 0 });
          continue;
        }
        const text = await deps.extract(filePath);
        if (!text.trim()) {
          out.skipped++; // scanned/image-only PDF or empty file
          settle({ name, ref: prev?.ref, status: 'skipped', reason: 'no-extractable-text', chunks: 0 });
          continue;
        }
        const hash = textHash(text);
        const fresh = {
          mtimeMs: stamp?.mtimeMs ?? 0, // 0 = unknown, so the next import re-checks it
          size: stamp?.size ?? text.length,
        };
        if (prev && prev.hash === hash) {
          // touched but not edited — the chunks are already right, only the stamp
          // moves. A section analysis that failed on an earlier run is still owed,
          // so this branch re-runs that step rather than the whole ingest.
          const a = prev.analysisFailed ? await analyze(filePath, prev.ref, name, text) : null;
          out.unchanged++;
          deps.manifest.upsert({
            ...prev,
            ...fresh,
            status: 'unchanged',
            ...(a?.failed ? { analysisFailed: true as const } : { analysisFailed: undefined }),
          });
          settle({
            name,
            ref: prev.ref,
            status: 'unchanged',
            chunks: prev.chunks,
            ...(a ? { summaries: a.summaries } : {}),
          });
          continue;
        }
        const ref = libraryRefFor(filePath, deps.manifest, root);
        const res = await deps.ingest({ text, source: 'doc', ref, replace: true });
        if (!res) {
          // The index took nothing — the embedding model is still downloading,
          // RAG is off, or the ingestor threw. Storing a hash for that would
          // make every later attempt report 未变化 and the library would stay
          // empty for good, so the manifest is left untouched and the next
          // import retries this file.
          out.skipped++;
          settle({ name, ref, status: 'skipped', reason: 'index-declined', chunks: 0 });
          continue;
        }
        const chunks = res.added;
        out.imported++;
        out.chars += text.length;
        out.chunks += chunks;
        const a = await analyze(filePath, ref, name, text);
        const entry: KnowledgeFile = {
          ref,
          name,
          path: filePath,
          chars: text.length,
          addedAt: deps.now().toISOString(),
          hash,
          ...fresh,
          status: prev ? 'reimported' : 'imported',
          chunks,
          qaCount: res.qa ?? 0,
          ...(a.failed ? { analysisFailed: true as const } : {}),
        };
        deps.manifest.upsert(entry);
        known.set(filePath, entry);
        settle({ name, ref, status: 'imported', chunks, summaries: a.summaries });
      } catch (e) {
        const detail = (e as Error).message;
        log(`[knowledge-files] import failed ${filePath}: ${detail}`);
        out.failed++;
        settle({ name, status: 'failed', reason: 'parse-failed', detail, chunks: 0 });
      }
    }
    log(
      `[knowledge-files] import: ${out.imported} imported, ${out.skipped} skipped, ${out.failed} failed, ${out.unchanged} unchanged, ${out.chunks} chunks`,
    );
    return out;
  }

  return { ingestFiles, walk: walkLibraryDir, refFor: (p: string, root?: string) => libraryRefFor(p, deps.manifest, root) };
}

export type LibraryImporter = ReturnType<typeof createLibraryImporter>;
