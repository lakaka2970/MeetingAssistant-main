/**
 * Speculative answering (draft) — the "turn the wait around" scheme.
 *
 * Today 「持续答」 waits a fixed 1100 ms after a segment closes so that a
 * sentence chopped by the VAD can still be collapsed into one ask. Measured
 * against a local mock provider, the app's own cost from "line in hand" to
 * "first token on its way" is 1–4 ms, so that wait buys certainty at the price
 * of the whole user-visible delay. Speculation buys the same certainty by
 * *retracting* an ask instead of *delaying* it:
 *
 *   fire immediately when the line is obviously a complete ask (heuristic
 *   already says so — and its own doc comment argues this case should not wait
 *   for a model round-trip at all);
 *   when a following line turns out to continue it, cancel that request and ask
 *   the merged question.
 *
 * Anything the rule is not sure about falls back to the existing debounce, so
 * the worst case of a wrong guess equals today's behaviour. The cost of a
 * retracted request is a paid-but-discarded call, which is why this is opt-in.
 *
 * Pure: no React, no electron, no clock — the caller passes `now` so the
 * reducer is deterministic under test.
 */
import { heuristic, type Verdict } from './questionGate';

/**
 * How long a speculative ask stays replaceable. Deliberately the same number the
 * debounce used: it is the window in which the interviewer plausibly keeps
 * talking, not a tuned constant of its own.
 */
export const SPEC_REPLACE_WINDOW_MS = 1100;

/** a segment the ASR cut off by trailing silence may still be unfinished */
export type SegmentReason = 'silence' | 'maxlen' | 'flush';

/**
 * `silence` / `maxlen` both deliver a finished line as far as the user is
 * concerned, and only `flush` (capture being torn down) must not start a paid
 * request. The renderer does not receive the VAD reason yet, so it passes
 * `undefined` and speculation stays allowed — plumbing the real one is a
 * follow-up, not a correctness dependency.
 */

export interface InFlightAsk {
  requestId: string;
  /** the question that was actually sent */
  text: string;
  /** Date.now() at send */
  firedAt: number;
}

export type AskPlan =
  /** send this line now, and remember it as replaceable */
  | { action: 'fire'; why: 'speculative' }
  /** the in-flight ask was cut mid-sentence: cancel it and ask the merged line */
  | { action: 'replace'; merged: string; why: 'continuation' }
  /** today's behaviour: wait out the collapse window, then answer */
  | { action: 'debounce'; gate: Verdict | undefined }
  /** not a question at all */
  | { action: 'skip' };

const SENTENCE_FINAL = /[。！？!?…]\s*$/;

/** 「而且 / 还有 / 那 / 就是」 — a line that grammatically continues the last one */
const CONTINUATION_HEAD =
  /^\s*(而且|还有|以及|另外|或者|和|与|就是|然后|接着|补充|对了|那|那么|所以|因为|如果|不过|但|嗯那)/;

/** cut mid-thought: no sentence-final punctuation, nothing that reads as a unit */
function looksTruncated(text: string): boolean {
  const t = text.trim();
  return !SENTENCE_FINAL.test(t) && !/[?？]\s*$/.test(t);
}

/**
 * Conservative on purpose: a false 'replace' costs a discarded request, a false
 * 'hold' hides a real question. Three signals count as "that was the same
 * sentence" — the previous line ends un-punctuated, or the new line is a
 * fragment that cannot stand (connector-led, or too short to be a question).
 *
 * A connector-led line that IS itself a punctuated question stays separate:
 * 「这个方案上线了吗？」+「还有灰度是怎么做的？」 are two asks, and merging them
 * into one compound question would degrade both answers.
 */
export function isContinuation(
  prevText: string,
  nextText: string,
  gapMs: number,
  windowMs = SPEC_REPLACE_WINDOW_MS,
): boolean {
  if (gapMs > windowMs) return false;
  const next = nextText.trim();
  if (!next) return false;
  if (looksTruncated(prevText)) return true;
  if (SENTENCE_FINAL.test(next)) return false;
  return CONTINUATION_HEAD.test(next) || next.length <= 12;
}

/**
 * What to do with a freshly closed 对方 segment.
 *
 * `reason` gates speculation to the only case that needs it: a segment ended by
 * silence may be unfinished, while 'maxlen'/'flush' deliver a line that is
 * already complete (speculating there would buy nothing).
 */
export function planAsk(o: {
  speculative: boolean;
  /** undefined = the caller cannot tell (the renderer cannot yet) */
  reason?: SegmentReason;
  line: string;
  inFlight: InFlightAsk | null;
  now: number;
}): AskPlan {
  const h = heuristic(o.line);
  if (h.verdict === 'skip') return { action: 'skip' };
  // off means off: every non-speculative path below is already the status quo
  if (!o.speculative) return { action: 'debounce', gate: h.verdict };

  if (o.inFlight) {
    const gapMs = o.now - o.inFlight.firedAt;
    if (isContinuation(o.inFlight.text, o.line, gapMs)) {
      const merged = `${o.inFlight.text.trim()}${looksTruncated(o.inFlight.text) ? '，' : ' '}${o.line.trim()}`;
      return { action: 'replace', merged, why: 'continuation' };
    }
    // Not a continuation: an unrelated question while a request is in flight.
    // Falling back to the ordinary wait keeps today's semantics (two asks are
    // possible either way) and, above all, never drops a real question.
    return { action: 'debounce', gate: h.verdict };
  }

  // heuristic.verdict === 'answer' already means the line reads as a complete
  // ask, so speculation is allowed on any closing reason except a flush.
  if (o.reason !== 'flush' && h.verdict === 'answer') {
    return { action: 'fire', why: 'speculative' };
  }
  return { action: 'debounce', gate: h.verdict };
}

/**
 * Collapse the in-flight bookkeeping once an answer is final or has died, so a
 * stale ask is never "continued" two minutes later.
 */
export function clearInFlight(inFlight: InFlightAsk | null, requestId: string): InFlightAsk | null {
  return inFlight && inFlight.requestId === requestId ? null : inFlight;
}
