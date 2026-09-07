/**
 * Document-library manifest (upgrade): the list of files the user imported
 * into the global knowledge base for semantic recall (L3). One JSON file under
 * userData/knowledge-files.json; the actual chunk text + vectors live in the
 * RAG index (rag/index.json) keyed by the same `ref`, so the two must stay in
 * lock-step: remove/clear here also drops the matching RAG chunks in main.ts.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { KnowledgeFile, KnowledgeFilesState } from '../shared/protocol';

export class KnowledgeFileStore {
  private entries: KnowledgeFile[] = [];

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as {
        files?: KnowledgeFile[];
      };
      this.entries = Array.isArray(parsed?.files) ? parsed.files : [];
    } catch (e) {
      console.warn('[knowledge-files] manifest load failed, starting empty:', (e as Error).message);
      this.entries = [];
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ files: this.entries }, null, 2), 'utf8');
    } catch (e) {
      console.warn('[knowledge-files] manifest persist failed:', (e as Error).message);
    }
  }

  list(): KnowledgeFile[] {
    return [...this.entries];
  }

  state(): KnowledgeFilesState {
    const files = [...this.entries];
    const chars = files.reduce((s, f) => s + f.chars, 0);
    return { files, chars };
  }

  hasRef(ref: string): boolean {
    return this.entries.some((f) => f.ref === ref);
  }

  /** upsert by ref; re-importing the same file replaces its entry */
  upsert(entry: KnowledgeFile): void {
    const i = this.entries.findIndex((f) => f.ref === entry.ref);
    if (i >= 0) this.entries[i] = entry;
    else this.entries.push(entry);
    this.persist();
  }

  remove(ref: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((f) => f.ref !== ref);
    if (this.entries.length !== before) this.persist();
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.persist();
  }
}
