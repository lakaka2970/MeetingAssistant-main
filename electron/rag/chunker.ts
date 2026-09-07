/**
 * Sentence-boundary sliding-window chunker for the RAG ingest pipeline
 * (upgrade P0). Pure logic — no imports — so the retrieval quality and the
 * window invariants are unit-testable in isolation.
 *
 * Design: split on CJK/latin sentence enders and newlines, then accumulate
 * sentences into chunks of <= chunkSize chars with an overlap tail. A single
 * sentence longer than the budget is hard-sliced (a transcript of "啊啊啊..."
 * must not produce an oversized or infinitely-retrying chunk).
 */

export const DEFAULT_CHUNK_SIZE = 300;
export const DEFAULT_CHUNK_OVERLAP = 50;

/** sentence enders: CJK punctuation, latin .!? followed by space/EOL, newlines */
const SENTENCE_SPLIT = /(?<=[。！？!?；;\n])|(?<=\.)\s+/;

export function chunkText(
  text: string,
  opts: { chunkSize?: number; overlap?: number } = {},
): string[] {
  const chunkSize = Math.max(40, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.min(Math.max(0, opts.overlap ?? DEFAULT_CHUNK_OVERLAP), Math.floor(chunkSize / 2));

  const sentences = splitSentences(text);
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = (): void => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
  };

  for (const sentence of sentences) {
    if (sentence.length > chunkSize) {
      // flush what we have, then hard-slice the giant sentence
      pushCurrent();
      current = '';
      for (let i = 0; i < sentence.length; i += chunkSize - overlap) {
        const slice = sentence.slice(i, i + chunkSize).trim();
        if (slice) chunks.push(slice);
        if (i + chunkSize >= sentence.length) break;
      }
      continue;
    }
    if (current && current.length + sentence.length > chunkSize) {
      pushCurrent();
      // keep the tail of the previous chunk as overlap for semantic continuity
      current = overlap > 0 ? current.slice(-overlap) : '';
    }
    current += sentence;
  }
  pushCurrent();
  return chunks;
}

function splitSentences(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  return normalized.split(SENTENCE_SPLIT).map((s) => s.trim()).filter((s) => s.length > 0);
}
