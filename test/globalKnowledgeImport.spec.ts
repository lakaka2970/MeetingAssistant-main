import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { extractDocText } from '../electron/docparse';
import { importGlobalKnowledge, type IngestCounts } from '../electron/globalKnowledgeImport';

const FIX = join(__dirname, 'fixtures');

/** records every call so the tests can assert what was *not* touched either */
function harness(opts: {
  parse?: (filePath: string) => Promise<string>;
  ingest?: (text: string) => Promise<IngestCounts | null>;
}) {
  const stored: string[] = [];
  const ingested: string[] = [];
  const logs: string[] = [];
  const deps = {
    set: (text: string) => stored.push(text),
    ingest:
      opts.ingest ??
      (async (text: string) => {
        ingested.push(text);
        return { added: 1, total: 1 };
      }),
    parse:
      opts.parse ??
      ((filePath: string) => Promise.reject(new Error(`unexpected read of ${filePath}`))),
    log: (msg: string) => logs.push(msg),
  };
  return { deps, stored, ingested, logs };
}

describe('importGlobalKnowledge (the .md/txt/docx/pdf → knowledge.md channel)', () => {
  it('runs a picked PDF through the document parser instead of storing its bytes', { timeout: 120_000 }, async () => {
    const { deps, stored, ingested } = harness({ parse: extractDocText });
    const r = await importGlobalKnowledge(join(FIX, 'sample.pdf'), deps);
    expect(r).toEqual({ imported: true });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('Resume PDF fixture: Python and SQL');
    expect(stored[0]).not.toContain('%PDF');
    // the vector index gets exactly the text the store kept, not a re-read
    expect(ingested).toEqual([stored[0]]);
  });

  it('leaves the current knowledge base untouched when the document has no text layer', async () => {
    const { deps, stored, ingested } = harness({ parse: async () => '   \n\n  ' });
    const r = await importGlobalKnowledge('scanned.pdf', deps);
    expect(r.imported).toBe(false);
    expect(r.reason).toBe('empty');
    expect(stored).toEqual([]);
    expect(ingested).toEqual([]);
  });

  it('reports a failed parse and keeps the old text', async () => {
    const { deps, stored, ingested } = harness({
      parse: async () => {
        throw new Error('unsupported document type: .doc');
      },
    });
    const r = await importGlobalKnowledge('legacy.doc', deps);
    expect(r.imported).toBe(false);
    expect(r.reason).toBe('failed');
    expect(r.detail).toContain('unsupported document type');
    expect(stored).toEqual([]);
    expect(ingested).toEqual([]);
  });

  it('keeps the stored text when vector indexing fails: the prompt injection works without it', async () => {
    const { deps, stored, logs } = harness({
      parse: async () => '# 简历\n\n项目：MeetingAssistant',
      ingest: async () => {
        throw new Error('embedding model missing');
      },
    });
    const r = await importGlobalKnowledge('resume.md', deps);
    expect(r.imported).toBe(true);
    expect(stored).toEqual(['# 简历\n\n项目：MeetingAssistant']);
    expect(logs.join('\n')).toContain('embedding model missing');
  });
});
