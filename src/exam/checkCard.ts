import type { CheckVerdict } from '../../shared/protocol';

/**
 * The self-check round on the answer already shown. It lives in its own state
 * slot — never merged into the answer — because the whole point of the card is
 * that the original answer stays visible and the revision sits beside it, so OK,
 * FIX and "didn't run" are distinguishable at a glance.
 */
export interface Check {
  turn: number;
  verdict: CheckVerdict;
  note: string;
  revision: string;
  streaming: boolean;
  ms: number;
}

/** The three check events, stripped of the requestId the window already filtered. */
export type CheckEvent =
  | { kind: 'check'; turn: number; verdict: CheckVerdict; note: string; ms: number }
  | { kind: 'checkDelta'; turn: number; text: string }
  | { kind: 'checkDone'; turn: number; text: string };

/**
 * Only a `fix` verdict has a revision to keep writing; `ok` and `unknown` are the
 * round's last word, so a card that carries one is already closed.
 */
const openAfterHeader = (verdict: CheckVerdict): boolean => verdict === 'fix';

/**
 * The check card's state machine, one pure function for all three phases.
 *
 * The order it has to survive is the one the main process actually produces:
 * `chatStream` emits every `checkDelta` first and only then the `check` header,
 * because the verdict is parsed from the finished text. A reducer that demanded a
 * header before accepting tokens would therefore drop the entire stream and show
 * the revision as one block at `checkDone` — which is exactly what the first cut
 * did, and what this function fixes: the first token opens a provisional card
 * (verdict `unknown`, nothing is claimed yet), and the later header for the same
 * turn MERGES into it, keeping the text the user watched appear.
 *
 * `null` means "no card shown"; returning the incoming `c` unchanged means "drop
 * this event", which is what a stale token after a settled round deserves.
 *
 * The phone page mirrors this machine (resources/companion/app.js, marker
 * CHECK_MARKED) because it renders the same three phases onto a different model —
 * a card attached to the hero answer rather than a window-wide state slot.
 */
export function applyCheckCard(c: Check | null, ev: CheckEvent): Check | null {
  switch (ev.kind) {
    case 'checkDelta': {
      if (c && c.turn === ev.turn) {
        // A round that already closed was retold in full by its `checkDone`;
        // appending to it would reopen a finished card and duplicate its text.
        return c.streaming ? { ...c, revision: c.revision + ev.text } : c;
      }
      // No card for this turn: the round is streaming ahead of its verdict.
      return { turn: ev.turn, verdict: 'unknown', note: '', revision: ev.text, streaming: true, ms: 0 };
    }
    case 'check': {
      if (c && c.turn === ev.turn) {
        // Merge, never replace: wholesale replacement would erase the revision
        // that already streamed and make the card blink back to empty.
        return { ...c, verdict: ev.verdict, note: ev.note, ms: ev.ms, streaming: openAfterHeader(ev.verdict) };
      }
      // A header for a different turn is a new round: round 2 supersedes round 1.
      return {
        turn: ev.turn,
        verdict: ev.verdict,
        note: ev.note,
        revision: '',
        streaming: openAfterHeader(ev.verdict),
        ms: ev.ms,
      };
    }
    case 'checkDone': {
      if (!c || c.turn !== ev.turn) return c; // a done for a turn with no card invents nothing
      // `checkDone` carries the parsed revision and is the lossy stream's
      // retake: it wins over the tokens, but an empty one must not erase them.
      return { ...c, revision: ev.text || c.revision, streaming: false };
    }
  }
}
