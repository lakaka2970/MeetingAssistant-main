/**
 * The one deterministic read of the checker's reply.
 *
 * Everything downstream of this is UI, so the failure mode it has to prevent is
 * a malformed reply being *inferred* into a verdict: an unparseable round shows
 * as 复核未完成 with the raw text, never as OK. That is the same rule the bank
 * lookup follows (shared/bankStore.ts decideBankAnswer) — certainty is earned,
 * not assumed.
 */

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

const nonEmptyLines = (text: string): string[] =>
  text.split('\n').map((l) => l.trim()).filter(Boolean);

export function parseCheckOutput(raw: string): CheckResult {
  const text = (raw ?? '').trim();
  if (!text) return { verdict: 'unknown', note: '', revision: '' };

  const lines = nonEmptyLines(text);
  let at = -1;
  let verdict: 'ok' | 'fix' | undefined;
  for (let i = 0; i < Math.min(lines.length, VERDICT_SCAN_LINES); i++) {
    const m = /^VERDICT:\s*(OK|FIX)\b/i.exec(lines[i].replace(/^[>*#\s]+/, ''));
    if (m) {
      at = i;
      verdict = m[1].toUpperCase() === 'OK' ? 'ok' : 'fix';
      break;
    }
  }
  if (!verdict) return { verdict: 'unknown', note: text.slice(0, NOTE_MAX), revision: '' };
  if (verdict === 'ok') return { verdict: 'ok', note: '', revision: '' };

  const note = (lines[at + 1] ?? '').replace(/^[-•*]\s*/, '').slice(0, NOTE_MAX);
  const rest = lines.slice(at + 2).join('\n');
  const marker = /【修订】[ \t]*/.exec(rest);
  const revision = marker ? rest.slice(marker.index + marker[0].length).trim() : '';
  // a FIX that produced no corrected answer is not a fix — say what is wrong and
  // leave the original answer standing alone
  if (!revision) return { verdict: 'unknown', note: note || rest.slice(0, NOTE_MAX), revision: '' };
  return { verdict: 'fix', note, revision };
}
