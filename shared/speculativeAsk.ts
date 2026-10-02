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
import type { SegmentCloseReason } from './protocol';

/**
 * How long a speculative ask stays replaceable. Deliberately the same number the
 * debounce used: it is the window in which the interviewer plausibly keeps
 * talking, not a tuned constant of its own.
 */
export const SPEC_REPLACE_WINDOW_MS = 1100;

/**
 * Two ceilings, both about money rather than latency. A chained question can be
 * chopped repeatedly (「你们…」+「那个…」+「上线…」) and every cut we act on is one
 * discarded request, so merging stops paying for the user after this many
 * retractions; and an ask whose first token has already been rendered is never
 * retracted at all — blanking an answer someone is reading is worse than the
 * 1100 ms we saved, and that call is spent either way.
 */
export const SPEC_MAX_RETRACTS = 2;

/** a segment the ASR closed; see shared/protocol SegmentCloseReason */
export type SegmentReason = SegmentCloseReason;

export interface InFlightAsk {
  requestId: string;
  /** the question that was actually sent */
  text: string;
  /** Date.now() at send */
  firedAt: number;
  /** true once any token has reached the screen (see above) */
  streamed: boolean;
  /** retractions already spent on this chained question */
  retracts: number;
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
 * `reason` is the VAD's own verdict on whether the line can still grow: a
 * silence-closed one may be mid-sentence, `maxlen` is a complete line forced
 * open, and `flush` means capture is being torn down — an answer started there
 * is a paid request nobody will read.
 */
export function planAsk(o: {
  speculative: boolean;
  /** undefined = the engine never ran our VAD (a service's own final) */
  reason?: SegmentReason;
  line: string;
  inFlight: InFlightAsk | null;
  now: number;
}): AskPlan {
  const h = heuristic(o.line);
  if (h.verdict === 'skip') return { action: 'skip' };
  // off means off: every non-speculative path below is already the status quo
  if (!o.speculative) return { action: 'debounce', gate: h.verdict };
  if (o.reason === 'flush') return { action: 'debounce', gate: h.verdict };

  if (o.inFlight) {
    const gapMs = o.now - o.inFlight.firedAt;
    const mergeable =
      !o.inFlight.streamed &&
      o.inFlight.retracts < SPEC_MAX_RETRACTS &&
      isContinuation(o.inFlight.text, o.line, gapMs);
    if (mergeable) {
      const merged = `${o.inFlight.text.trim()}${looksTruncated(o.inFlight.text) ? '，' : ' '}${o.line.trim()}`;
      return { action: 'replace', merged, why: 'continuation' };
    }
    // Not mergeable (unrelated line, already on screen, or out of budget):
    // fall back to the ordinary wait. Never 'hold' — dropping a real question to
    // save one call is not a trade the user asked for.
    return { action: 'debounce', gate: h.verdict };
  }

  // heuristic.verdict === 'answer' already means the line reads as a complete
  // ask, which is exactly when firing early carries no extra risk.
  if (h.verdict === 'answer') return { action: 'fire', why: 'speculative' };
  return { action: 'debounce', gate: h.verdict };
}

/**
 * Collapse the in-flight bookkeeping once an answer is final or has died, so a
 * stale ask is never "continued" two minutes later.
 */
export function clearInFlight(inFlight: InFlightAsk | null, requestId: string): InFlightAsk | null {
  return inFlight && inFlight.requestId === requestId ? null : inFlight;
}

/**
 * Note the first token of an in-flight ask. Returns the same object for any
 * other requestId so the caller can assign unconditionally.
 */
export function markStreamed(inFlight: InFlightAsk | null, requestId: string): InFlightAsk | null {
  return inFlight && inFlight.requestId === requestId ? { ...inFlight, streamed: true } : inFlight;
}

/** a fresh speculative ask, with its retraction budget intact */
export function startInFlight(requestId: string, text: string, now: number, retracts = 0): InFlightAsk {
  return { requestId, text, firedAt: now, streamed: false, retracts };
}
