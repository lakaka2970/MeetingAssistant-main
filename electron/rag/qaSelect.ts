/**
 * Prepared-answer direct-hit selection — the gate that decides when a knowledge
 * base Q&A pair is confident enough to be printed to the user verbatim.
 *
 * Split out of RagService.retrieve so the thresholds are unit-testable without
 * an embedding model: the cost of a false positive here is high (the user reads
 * the hit aloud in an interview), and it depends on two signals — the embedding
 * cosine and a lexical bigram score over the question text — that must be
 * combined and ranked deterministically.
 */
import { parseQaRecord, questionSimilarity } from '../../shared/qaPairs';

/**
 * bge-m3 settles around ≥0.55 for "the same question asked differently" and
 * stays under 0.5 for unrelated pairs; the lexical score catches a literally
 * repeated question even when the embedding drifts. Either signal alone is
 * enough — false positives are the thing to avoid, not recall.
 */
export const QA_DIRECT_MIN_COSINE = 0.55;
export const QA_DIRECT_MIN_LEXICAL = 0.62;

export interface QaCandidate {
  /** the stored record text (`问：…\n\n答：…`) */
  text: string;
  source: string;
  ref?: string;
  metadata?: Record<string, unknown>;
}

export interface QaSearchHit {
  record: QaCandidate;
  score: number;
}

export interface QaHitView {
  question: string;
  answer: string;
  ref?: string;
  source?: string;
  score: number;
  exact: boolean;
}

/**
 * One 'qa' record -> the renderer's direct-hit view, or null when the record
 * carries no usable pair. The stored metadata wins over re-parsing the text, so
 * a record written by an older chunker still renders its real question.
 */
export function qaViewOf(hit: QaSearchHit, query: string): QaHitView | null {
  const md = hit.record.metadata;
  const storedQ = typeof md?.question === 'string' ? md.question.trim() : '';
  const storedA = typeof md?.answer === 'string' ? md.answer.trim() : '';
  const parsed = storedQ && storedA ? null : parseQaRecord(hit.record.text);
  const question = storedQ || (parsed?.question ?? '');
  const answer = storedA || (parsed?.answer ?? '');
  if (!question || !answer || question === answer) return null;
  const lexical = questionSimilarity(query, question);
  return {
    question,
    answer,
    ref: hit.record.ref,
    source: hit.record.source,
    score: Number(hit.score.toFixed(4)),
    exact: lexical >= QA_DIRECT_MIN_LEXICAL,
  };
}

/**
 * Rank the candidate hits and keep the ones that clear either gate: best
 * confidence first (a literal question match outranks a merely close embedding),
 * at most `limit` of them.
 */
export function selectQaHits(
  query: string,
  hits: QaSearchHit[],
  limit = 2,
): QaHitView[] {
  const scored: { view: QaHitView; lexical: number }[] = [];
  for (const h of hits) {
    const view = qaViewOf(h, query);
    if (!view) continue;
    const lexical = questionSimilarity(query, view.question);
    if (!view.exact && h.score < QA_DIRECT_MIN_COSINE) continue;
    scored.push({ view, lexical });
  }
  scored.sort((a, b) => {
    const av = Math.max(a.view.score, a.lexical);
    const bv = Math.max(b.view.score, b.lexical);
    return bv - av || (b.view.exact ? 1 : 0) - (a.view.exact ? 1 : 0);
  });
  return scored.slice(0, limit).map((s) => s.view);
}
