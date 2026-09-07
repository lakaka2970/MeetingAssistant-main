/**
 * L2 knowledge layer: free-form personal background notes (upgrade P0 step 4).
 * Injected into the byte-stable prompt prefix so they ride the provider's
 * prefix cache, unlike RAG recall which is per-question and lives in the fast
 * context. Plain-text file persistence fits the repo's no-DB invariant.
 */
import type { NotesSaveResult } from '../../shared/protocol';
export type { NotesSaveResult };

export const MAX_NOTES_CHARS = 8000;

export class CustomNotesManager {
  constructor(
    private notes: string = '',
    private readonly persist: (content: string) => void = () => {},
  ) {}

  get text(): string {
    return this.notes;
  }

  get chars(): number {
    return this.notes.length;
  }

  /** strict cap, matching the doc: 8000 chars, rejected — never truncated. */
  setNotes(content: string): NotesSaveResult {
    const next = content.replace(/\r\n/g, '\n').trim();
    if (next.length > MAX_NOTES_CHARS) {
      return { ok: false, chars: this.notes.length, error: 'too-long' };
    }
    this.notes = next;
    this.persist(next);
    return { ok: true, chars: next.length };
  }

  clear(): void {
    this.notes = '';
    this.persist('');
  }
}
