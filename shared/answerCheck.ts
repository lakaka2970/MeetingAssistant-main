/**
 * The one deterministic read of the checker's reply.
 *
 * Everything downstream of this is UI, so the failure mode it has to prevent is
 * a malformed reply being *inferred* into a verdict: an unparseable round shows
 * as 复核未完成 with the raw text, never as OK. That is the same rule the bank
 * lookup follows (shared/bankStore.ts decideBankAnswer) — certainty is earned,
 * not assumed.
 */
import { classifyQuestion } from './textHeuristics';

export type CheckVerdict = 'ok' | 'fix' | 'unknown';

export interface CheckResult {
  verdict: CheckVerdict;
  /** one line shown on the card: the cause, or the unparseable reply */
  note: string;
  /** full corrected answer, empty unless verdict is fix */
  revision: string;
}

const NOTE_MAX = 300;
/** models like to clear their throat first; three lines is the grace period */
const VERDICT_SCAN_LINES = 3;
const MARKER = '【修订】';

/** the note is a badge, not a paragraph — collapse and clip */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);

export function parseCheckOutput(raw: string): CheckResult {
  const text = (raw ?? '').trim();
  if (!text) return { verdict: 'unknown', note: '', revision: '' };

  // Detection reads trimmed, non-empty lines. Extraction slices the RAW text:
  // the revision is code destined for the code-block renderer, and rebuilding it
  // from trimmed lines would strip every indent and delete every blank line
  // inside a fence (breaking Python outright).
  const lines = text.split('\n');
  const probes = lines.map((line, idx) => ({ idx, t: line.trim() })).filter((p) => p.t);

  let hit = -1;
  let verdict: CheckVerdict | undefined;
  for (let i = 0; i < Math.min(probes.length, VERDICT_SCAN_LINES); i++) {
    const m = /^VERDICT:\s*(OK|FIX)\b/i.exec(probes[i].t.replace(/^[>*#]+/, ''));
    if (m) {
      hit = i;
      verdict = m[1].toUpperCase() === 'OK' ? 'ok' : 'fix';
      break;
    }
  }
  if (!verdict) return { verdict: 'unknown', note: oneLine(text), revision: '' };
  if (verdict === 'ok') return { verdict: 'ok', note: '', revision: '' };

  const cause = probes[hit + 1];
  const causeIsMarker = !!cause && cause.t.startsWith(MARKER);
  const note = cause && !causeIsMarker ? oneLine(cause.t.replace(/^[-•*]+/, '')) : '';
  const start = cause ? (causeIsMarker ? cause.idx : cause.idx + 1) : probes[hit].idx + 1;
  const body = lines.slice(start).join('\n');
  const at = body.indexOf(MARKER);
  const revision = at === -1 ? '' : body.slice(at + MARKER.length).replace(/^[ \t]*\r?\n?/, '').trimEnd();
  // a FIX that produced no corrected answer is not a fix — say what is wrong and
  // leave the original answer standing alone
  if (!revision) return { verdict: 'unknown', note: note || oneLine(body), revision: '' };
  return { verdict: 'fix', note, revision };
}

/**
 * Whether an answered question deserves the extra call. Deliberately narrow:
 * the checker costs one round trip per question, and on an 行测 item or a
 * personality answer that buys nothing while slowing the thing the user is
 * racing against.
 */
export function shouldRunCheck(input: {
  subMode: 'aptitude' | 'technical' | 'personality' | 'open';
  question: string;
  answer: string;
  fromBank: boolean;
}): boolean {
  if (input.fromBank || !input.answer.trim()) return false;
  if (input.subMode === 'technical') return true;
  if (input.subMode !== 'open') return false;
  return classifyQuestion(input.question) === 'coding';
}
