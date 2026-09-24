/**
 * Tests for the document-library import module extracted from electron/main.ts.
 *
 * These functions used to live inside `registerIpc` with zero cover, which made
 * every later change to the import pipeline a blind edit. The behaviour locked
 * here is the behaviour that shipped before the move — extraction must be a
 * no-op on observable results.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { KnowledgeFile, KnowledgeImportResult } from '../shared/protocol';
import { textHash } from '../electron/rag/vector-store';
import {
  LIBRARY_WALK_MAX_DEPTH,
  createLibraryImporter,
  libraryRefFor,
  walkLibraryDir,
} from '../electron/rag/library';

class FakeManifest {
  files: KnowledgeFile[] = [];
  upserted: KnowledgeFile[] = [];

  list(): KnowledgeFile[] {
    return [...this.files];
  }
  hasRef(ref: string): boolean {
    return this.files.some((f) => f.ref === ref);
  }
  upsert(entry: KnowledgeFile): void {
    this.upserted.push(entry);
    const i = this.files.findIndex((f) => f.ref === entry.ref);
    if (i >= 0) this.files[i] = entry;
    else this.files.push(entry);
  }
}

/** what `stat` reports for a file; tests move `mtimeMs` to simulate a touch */
interface FakeStamp {
  mtimeMs: number;
  size: number;
}

/** a manifest entry as a previous import would have written it */
function knownFile(over: { ref: string; path: string; text: string; mtimeMs: number }): KnowledgeFile {
  return {
    ref: over.ref,
    name: over.ref,
    path: over.path,
    chars: over.text.length,
    addedAt: '2026-09-23T09:00:00.000Z',
    hash: textHash(over.text),
    mtimeMs: over.mtimeMs,
    size: over.text.length,
    status: 'imported',
    chunks: 3,
    qaCount: 0,
  };
}


/** an importer whose extract / ingest / clock / file stats are recorded, never real */
function harness(
  opts: {
    texts?: Record<string, string>;
    throws?: Record<string, string>;
    ingestNull?: boolean;
    files?: KnowledgeFile[];
  } = {},
) {
  const manifest = new FakeManifest();
  manifest.files = [...(opts.files ?? [])];
  const texts = { ...(opts.texts ?? {}) };
  const throws = { ...(opts.throws ?? {}) };
  const stamps = new Map<string, FakeStamp>();
  const ingested: { text: string; ref: string }[] = [];
  const extracted: string[] = [];
  const logs: string[] = [];
  const lib = createLibraryImporter({
    manifest,
    now: () => new Date('2026-09-24T10:00:00Z'),
    log: (m) => logs.push(m),
    stat: (path) => stamps.get(path) ?? { mtimeMs: 1_000, size: (texts[path] ?? '').length },
    extract: async (path) => {
      extracted.push(path);
      if (throws[path]) throw new Error(throws[path]);
      return texts[path] ?? '';
    },
    ingest: async (req) => {
      ingested.push({ text: req.text, ref: req.ref });
      return opts.ingestNull ? null : { added: 3, total: 3 };
    },
  });
  /** pretend the file was rewritten with identical bytes: newer mtime, same size */
  const touch = (path: string) => stamps.set(path, { mtimeMs: 2_000, size: (texts[path] ?? '').length });
  /** pretend the file was rewritten with new content (size follows the text) */
  const rewrite = (path: string, body: string) => {
    texts[path] = body;
    stamps.set(path, { mtimeMs: (stamps.get(path)?.mtimeMs ?? 1_000) + 1_000, size: body.length });
  };
  return { lib, manifest, ingested, logs, texts, throws, extracted, touch, rewrite };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-lib-'));
});

/** an import tally with every counter at zero except the ones under test */
const result = (over: Partial<KnowledgeImportResult> = {}): KnowledgeImportResult => ({
  imported: 0,
  skipped: 0,
  failed: 0,
  unchanged: 0,
  chars: 0,
  chunks: 0,
  ...over,
});

/** create `rel` (parent dirs included) under the temp root and return its path */
const write = (rel: string, body = 'x'): string => {
  const full = join(root, ...rel.split('/'));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf8');
  return full;
};
const relOf = (paths: string[]): string[] =>
  paths.map((p) => p.slice(root.length + 1).split('\\').join('/'));

describe('walkLibraryDir', () => {
  it('collects supported files recursively, sorted per level by name', () => {
    write('b.md');
    write('a.txt');
    write('notes/aaa.md');
    write('notes/deep/keep.docx');
    write('skip.xyz'); // extension outside the library whitelist
    const out: string[] = [];
    walkLibraryDir(root, out);
    expect(relOf(out)).toEqual(['a.txt', 'b.md', 'notes/aaa.md', 'notes/deep/keep.docx']);
  });

  it('skips hidden files and never descends into hidden directories', () => {
    write('.hidden.md');
    write('.git/config.md');
    write('visible.md');
    const out: string[] = [];
    walkLibraryDir(root, out);
    expect(relOf(out)).toEqual(['visible.md']);
  });

  it('stops descending once it is past the depth cap', () => {
    // one directory deeper than the cap allows, so the file inside is unseen
    const deep = Array.from({ length: LIBRARY_WALK_MAX_DEPTH + 1 }, (_, i) => `d${i}`);
    write([...deep, 'too-deep.md'].join('/'));
    write([...deep.slice(0, LIBRARY_WALK_MAX_DEPTH - 1), 'in-range.md'].join('/'));
    const out: string[] = [];
    walkLibraryDir(root, out);
    expect(relOf(out).some((p) => p.endsWith('too-deep.md'))).toBe(false);
    expect(relOf(out).some((p) => p.endsWith('in-range.md'))).toBe(true);
  });

  it('survives an unreadable directory instead of throwing', () => {
    const out: string[] = [];
    expect(() => walkLibraryDir(join(root, 'no-such-dir'), out)).not.toThrow();
    expect(out).toEqual([]);
  });
});

describe('libraryRefFor', () => {
  const entry = (ref: string, path: string): KnowledgeFile =>
    knownFile({ ref, path, text: 'x', mtimeMs: 1 });

  it('keeps the ref of a path that is already in the manifest', () => {
    const manifest = new FakeManifest();
    manifest.files.push(entry('kept.md', join(root, 'kept.md')));
    expect(libraryRefFor(join(root, 'kept.md'), manifest, root)).toBe('kept.md');
  });

  it('uses the path relative to the import root, with forward slashes', () => {
    expect(libraryRefFor(join(root, 'notes', 'a.md'), new FakeManifest(), root)).toBe('notes/a.md');
  });

  it('falls back to the basename when there is no root', () => {
    expect(libraryRefFor('/tmp/x/report.pdf', new FakeManifest())).toBe('report.pdf');
  });

  it('de-duplicates a colliding ref with a numbered suffix', () => {
    const manifest = new FakeManifest();
    manifest.files.push(entry('a.md', '/elsewhere/a.md'));
    expect(libraryRefFor('/here/a.md', manifest)).toBe('a (2).md');
    manifest.files.push(entry('a (2).md', '/y/a.md'));
    expect(libraryRefFor('/here2/a.md', manifest)).toBe('a (3).md');
  });

  it('handles an extension-less name when de-duplicating', () => {
    const manifest = new FakeManifest();
    manifest.files.push(entry('LICENSE', '/a/LICENSE'));
    expect(libraryRefFor('/b/LICENSE', manifest)).toBe('LICENSE (2)');
  });
});

describe('ingestLibraryFiles', () => {
  it('counts an empty-text file as skipped and never ingests it', async () => {
    const { lib, ingested } = harness({ texts: { '/a.md': '   \n  ' } });
    const out: KnowledgeImportResult = await lib.ingestFiles(['/a.md']);
    expect(out).toEqual(result({ skipped: 1 }));
    expect(ingested).toEqual([]);
  });

  it('keeps going after a per-file failure and counts it as failed', async () => {
    const { lib, ingested } = harness({
      texts: { '/good.md': 'hello' },
      throws: { '/bad.md': 'boom' },
    });
    const out = await lib.ingestFiles(['/bad.md', '/good.md']);
    expect(out).toEqual(result({ imported: 1, failed: 1, chars: 5, chunks: 3 }));
    expect(ingested.map((i) => i.ref)).toEqual(['good.md']);
  });

  it('counts a silent partial ingest (null result) as imported with 0 chunks', async () => {
    const { lib } = harness({ texts: { '/a.md': 'abc' }, ingestNull: true });
    expect(await lib.ingestFiles(['/a.md'])).toEqual(result({ imported: 1, chars: 3 }));
  });

  it('writes the manifest entry with ref, basename and the injected clock', async () => {
    const { lib, manifest } = harness({ texts: { '/notes/a.md': 'abcdef' } });
    await lib.ingestFiles(['/notes/a.md'], '/notes');
    expect(manifest.upserted).toEqual([
      {
        ref: 'a.md',
        name: 'a.md',
        path: '/notes/a.md',
        chars: 6,
        addedAt: '2026-09-24T10:00:00.000Z',
        hash: textHash('abcdef'),
        mtimeMs: 1_000,
        size: 6,
        status: 'imported',
        chunks: 3,
        qaCount: 0,
      },
    ]);
  });

  it('re-imports a changed path under the same ref so the index replaces it', async () => {
    const { lib, ingested, rewrite } = harness({ texts: { '/a.md': 'v1' } });
    await lib.ingestFiles(['/a.md']);
    rewrite('/a.md', 'v2');
    await lib.ingestFiles(['/a.md']);
    expect(ingested).toEqual([
      { text: 'v1', ref: 'a.md' },
      { text: 'v2', ref: 'a.md' },
    ]);
  });

  it('sums chars and chunks across files', async () => {
    const { lib, logs } = harness({ texts: { '/a.md': 'aa', '/b.md': 'bbbb' } });
    expect(await lib.ingestFiles(['/a.md', '/b.md'])).toEqual(
      result({ imported: 2, chars: 6, chunks: 6 }),
    );
    expect(logs.join('\n')).toContain('2 imported, 0 skipped, 0 failed, 0 unchanged, 6 chunks');
  });
});

describe('incremental import (unchanged files are skipped)', () => {
  it('skips a file whose mtime and size already match the manifest, without parsing it', async () => {
    const { lib, ingested, extracted } = harness({
      texts: { '/a.md': 'v1 content' },
      files: [knownFile({ ref: 'a.md', path: '/a.md', text: 'v1 content', mtimeMs: 1_000 })],
    });
    const out = await lib.ingestFiles(['/a.md']);
    expect(out).toEqual(result({ unchanged: 1 }));
    expect(extracted).toEqual([]); // the whole point: no PDF/docx decode
    expect(ingested).toEqual([]); // and no re-embedding
  });

  it('re-imports when mtime moved and the text really changed', async () => {
    const { lib, ingested, touch, texts } = harness({
      texts: { '/a.md': 'v1 content' },
      files: [knownFile({ ref: 'a.md', path: '/a.md', text: 'v1 content', mtimeMs: 1_000 })],
    });
    touch('/a.md'); // same size, so the fast path cannot decide
    texts['/a.md'] = 'v2 content';
    expect(await lib.ingestFiles(['/a.md'])).toEqual(
      result({ imported: 1, chars: 10, chunks: 3 }),
    );
    expect(ingested.map((i) => i.text)).toEqual(['v2 content']);
  });

  it('counts a touched-but-identical file as unchanged and leaves the index alone', async () => {
    const { lib, ingested, manifest, touch } = harness({
      texts: { '/a.md': 'v1 content' },
      files: [knownFile({ ref: 'a.md', path: '/a.md', text: 'v1 content', mtimeMs: 1_000 })],
    });
    touch('/a.md');
    expect(await lib.ingestFiles(['/a.md'])).toEqual(result({ unchanged: 1 }));
    expect(ingested).toEqual([]);
    // the stored stamp advances, so the next import takes the fast path again
    expect(manifest.files[0]).toMatchObject({ mtimeMs: 2_000, status: 'unchanged' });
  });

  it('records reimported status when content changed, and imported only the first time', async () => {
    const { lib, manifest, rewrite } = harness({ texts: { '/a.md': 'v1' } });
    await lib.ingestFiles(['/a.md']);
    expect(manifest.files[0].status).toBe('imported');
    rewrite('/a.md', 'a much longer v2');
    await lib.ingestFiles(['/a.md']);
    expect(manifest.files[0].status).toBe('reimported');
    expect(manifest.files[0].hash).toBe(textHash('a much longer v2'));
  });

  it('re-imports a legacy manifest entry that has no hash yet', async () => {
    const legacy: KnowledgeFile = {
      ref: 'old.md',
      name: 'old.md',
      path: '/old.md',
      chars: 2,
      addedAt: '2026-01-01T00:00:00.000Z',
    } as KnowledgeFile;
    const { lib, ingested, manifest } = harness({ texts: { '/old.md': 'v1' }, files: [legacy] });
    await lib.ingestFiles(['/old.md']);
    expect(ingested).toEqual([{ text: 'v1', ref: 'old.md' }]);
    expect(manifest.files[0].hash).toBe(textHash('v1'));
  });

  it('mixes unchanged and imported files in one directory import', async () => {
    const { lib, rewrite } = harness({
      texts: { '/a.md': 'aaa', '/b.md': 'bbb' },
      files: [knownFile({ ref: 'a.md', path: '/a.md', text: 'aaa', mtimeMs: 1_000 })],
    });
    rewrite('/b.md', 'a newer body');
    expect(await lib.ingestFiles(['/a.md', '/b.md'])).toEqual(
      result({ imported: 1, unchanged: 1, chars: 12, chunks: 3 }),
    );
  });
});
