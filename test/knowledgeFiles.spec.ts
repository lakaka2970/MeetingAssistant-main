/**
 * The document-library manifest on disk is user data that outlives the code
 * that wrote it, so loading a pre-v1.0.1 file must produce entries the import
 * pipeline can reason about — not objects whose freshness fields are undefined.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { KnowledgeFile } from '../shared/protocol';
import { KnowledgeFileStore } from '../electron/knowledgeFiles';

const tmp = (name: string): string => join(mkdtempSync(join(tmpdir(), 'mc-kf-')), name);

const legacyEntry = {
  ref: 'old.md',
  name: 'old.md',
  path: '/docs/old.md',
  chars: 42,
  addedAt: '2026-09-01T00:00:00.000Z',
};

describe('KnowledgeFileStore', () => {
  it('starts empty when there is no manifest file yet', () => {
    expect(new KnowledgeFileStore(tmp('files.json')).list()).toEqual([]);
  });

  it('gives a pre-v1.0.1 entry the freshness fields it never had', () => {
    const file = tmp('files.json');
    writeFileSync(file, JSON.stringify({ files: [legacyEntry] }), 'utf8');
    const stored = new KnowledgeFileStore(file).list()[0];
    expect(stored).toMatchObject({
      ref: 'old.md',
      chars: 42,
      hash: '', // empty = never verified, so the next import re-checks it once
      mtimeMs: 0,
      status: 'imported',
    });
  });

  it('survives a corrupt manifest by starting empty', () => {
    const file = tmp('files.json');
    writeFileSync(file, '{ not json', 'utf8');
    expect(new KnowledgeFileStore(file).list()).toEqual([]);
  });

  it('persists and reloads the freshness fields of a v1.0.1 entry', () => {
    const file = tmp('files.json');
    const store = new KnowledgeFileStore(file);
    const entry: KnowledgeFile = {
      ...legacyEntry,
      hash: 'abc123',
      mtimeMs: 1_700,
      size: 42,
      status: 'reimported',
      chunks: 7,
      qaCount: 2,
    };
    store.upsert(entry);
    expect(JSON.parse(readFileSync(file, 'utf8')).files[0].hash).toBe('abc123');
    expect(new KnowledgeFileStore(file).list()).toEqual([entry]);
  });

  it('upserts by ref and clears the total char tally', () => {
    const store = new KnowledgeFileStore(tmp('files.json'));
    store.upsert({ ...legacyEntry, hash: 'a', mtimeMs: 1, size: 10, status: 'imported', chunks: 1, qaCount: 0 });
    store.upsert({ ...legacyEntry, ref: 'old.md', chars: 20, hash: 'b', mtimeMs: 2, size: 20, status: 'unchanged', chunks: 1, qaCount: 0 });
    expect(store.state()).toEqual({ files: [expect.objectContaining({ chars: 20, status: 'unchanged' })], chars: 20 });
    store.clear();
    expect(store.state().chars).toBe(0);
  });
});
