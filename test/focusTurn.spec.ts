import { describe, expect, it } from 'vitest';
import { focusTurn, type AnswerTurn } from '../src/components/prompt/focusTurn';

function turn(id: string, status: AnswerTurn['status'] = 'done'): AnswerTurn {
  return { id, kind: 'continuous', label: `q-${id}`, text: `a-${id}`, status };
}

describe('focusTurn — which turn the prompt card shows', () => {
  it('shows nothing for an empty session', () => {
    expect(focusTurn([], null)).toEqual({ focus: null, follow: true });
  });

  it('follows the newest turn when nothing is pinned', () => {
    const r = focusTurn([turn('a'), turn('b')], null);
    expect(r.focus?.id).toBe('b');
    expect(r.follow).toBe(true);
  });

  it('keeps a pinned older turn while the newest one is finished', () => {
    const r = focusTurn([turn('a'), turn('b')], 'a');
    expect(r.focus?.id).toBe('a');
    expect(r.follow).toBe(false);
  });

  it('pinning the newest turn counts as following it', () => {
    const r = focusTurn([turn('a'), turn('b')], 'b');
    expect(r.focus?.id).toBe('b');
    expect(r.follow).toBe(true);
  });

  it('a new streaming turn releases the pin and is followed', () => {
    const r = focusTurn([turn('a'), turn('b', 'streaming')], 'a');
    expect(r.focus?.id).toBe('b');
    expect(r.follow).toBe(true);
  });

  it('a streaming turn alone is the focus even with a stale pin', () => {
    const r = focusTurn([turn('b', 'streaming')], 'gone');
    expect(r.focus?.id).toBe('b');
    expect(r.follow).toBe(true);
  });

  it('falls back to the newest turn when the pinned one was cleared', () => {
    const r = focusTurn([turn('b')], 'gone');
    expect(r.focus?.id).toBe('b');
    expect(r.follow).toBe(true);
  });

  it('surfaces a failed newest turn so its error text is visible', () => {
    const r = focusTurn([turn('a'), turn('b', 'error')], null);
    expect(r.focus?.id).toBe('b');
    expect(r.follow).toBe(true);
  });
});
