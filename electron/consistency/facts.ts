/**
 * Session consistency (upgrade P3): structured "claimed facts" extracted from
 * the rolling memo and injected into the fast context as recall. Pure logic —
 * the extraction runs on the memo the LLM already maintains (P1-5), so no
 * extra model call is needed; the semantic side reuses the RAG embedder.
 *
 * The memo format is fixed by buildMemoUpdateMessages (prompts.ts):
 *   【已问问题】 …
 *   【我已声称的事实】 one fact per line
 *   【面试官关注点】 …
 *   【注意事项】 …
 */

import type { StoredSession } from '../../shared/protocol';

/** lines from the 我已声称的事实 memo section (bounded per line) */
export function extractMemoFacts(memo: string): string[] {
  const lines = memo.replace(/\r\n/g, '\n').split('\n');
  const facts: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^【[^】]*】/.test(line)) {
      inSection = line.includes('已声称的事实');
      // the header itself may carry inline content after 】 — keep it
      const inline = line.replace(/^【[^】]*】/, '').trim();
      if (inSection && inline) facts.push(inline);
      continue;
    }
    if (inSection) facts.push(line);
  }
  return facts.map((f) => f.slice(0, 120)).filter((f) => f.length >= 4).slice(0, 30);
}

/** fast-context block telling the model what must stay consistent; '' = none */
export function formatFactsHint(facts: string[]): string {
  if (!facts.length) return '';
  const body = facts.map((f) => `- ${f}`).join('\n');
  return `以下是我此前回答中已声称的事实，本次回答绝不能与之矛盾：\n${body}`;
}

/** session-scoped facts text for RAG ingest (one fact per line, replaceable) */
export function factsIngestText(session: StoredSession | undefined): string {
  return extractMemoFacts(session?.memo ?? '').join('\n');
}
