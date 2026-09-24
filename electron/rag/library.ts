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
import type { KnowledgeFile, KnowledgeImportResult } from '../../shared/protocol';
import { isLibraryExtension } from '../docparse';
import { textHash } from './vector-store';

/** guard against pathological nesting / symlink loops */
export const LIBRARY_WALK_MAX_DEPTH = 12;

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
    for (const filePath of files) {
      try {
        const prev = known.get(filePath);
        const stamp = deps.stat(filePath);
        if (prev && stamp && prev.hash && prev.mtimeMs === stamp.mtimeMs && prev.size === stamp.size) {
          out.unchanged++; // the cheap short-circuit: no parse, no embed, no rewrite
          continue;
        }
        const text = await deps.extract(filePath);
        if (!text.trim()) {
          out.skipped++; // scanned/image-only PDF or empty file
          continue;
        }
        const hash = textHash(text);
        const fresh = {
          mtimeMs: stamp?.mtimeMs ?? 0, // 0 = unknown, so the next import re-checks it
          size: stamp?.size ?? text.length,
        };
        if (prev && prev.hash === hash) {
          // touched but not edited — the chunks are already right, only the stamp moves
          out.unchanged++;
          deps.manifest.upsert({ ...prev, ...fresh, status: 'unchanged' });
          continue;
        }
        const ref = libraryRefFor(filePath, deps.manifest, root);
        const res = await deps.ingest({ text, source: 'doc', ref, replace: true });
        out.imported++;
        out.chars += text.length;
        out.chunks += res?.added ?? 0;
        const entry: KnowledgeFile = {
          ref,
          name: basename(filePath),
          path: filePath,
          chars: text.length,
          addedAt: deps.now().toISOString(),
          hash,
          ...fresh,
          status: prev ? 'reimported' : 'imported',
          chunks: res?.added ?? 0,
          qaCount: res?.qa ?? 0,
        };
        deps.manifest.upsert(entry);
        known.set(filePath, entry);
      } catch (e) {
        log(`[knowledge-files] import failed ${filePath}: ${(e as Error).message}`);
        out.failed++;
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
