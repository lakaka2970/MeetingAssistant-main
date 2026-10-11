/**
 * Type-level only: these assertions read object literals this file builds, and
 * vitest strips the annotations, so the gate here is `npm run typecheck` (an
 * unknown `kind` stops compiling). What the events actually do on the wire —
 * the buffering, the round separation, `subMode` staying silent — is pinned by
 * test/companionExamStream.spec.ts, which drives publishExam for real.
 */
import { describe, expect, it } from 'vitest';
import type { ExamEvent } from '../shared/protocol';

describe('exam check events', () => {
  it('carries the round number so two re-checks cannot overwrite each other', () => {
    const ev: ExamEvent = { requestId: 'r1', kind: 'check', turn: 2, verdict: 'fix', note: '越界', ms: 812 };
    expect(ev.kind === 'check' && ev.turn).toBe(2);
  });

  it('keeps a revision stream separate from the answer stream', () => {
    const d: ExamEvent = { requestId: 'r1', kind: 'checkDelta', turn: 1, text: 'x' };
    const e: ExamEvent = { requestId: 'r1', kind: 'checkDone', turn: 1, text: 'y' };
    expect([d.kind, e.kind]).toEqual(['checkDelta', 'checkDone']);
  });

  it('names the sub-mode without a request of its own', () => {
    const ev: ExamEvent = { requestId: '', kind: 'subMode', subMode: 'technical' };
    expect(ev.kind === 'subMode' && ev.requestId).toBe('');
  });
});
