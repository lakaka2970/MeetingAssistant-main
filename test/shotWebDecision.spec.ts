import { describe, expect, it } from 'vitest';
import { decideShotWeb, shouldRaiseLocalExamWindow } from '../shared/shotWeb';

describe('decideShotWeb — screenshot ask: local-first, web only when both local sources are silent', () => {
  it('a bank hit means the local knowledge answered: no web, no hint', () => {
    expect(
      decideShotWeb({ bankHit: true, ragHit: false, webFallback: true, webConfigured: true }),
    ).toEqual({ run: false, hint: false });
  });

  it('a RAG material hit is also "local has content": no web', () => {
    expect(
      decideShotWeb({ bankHit: false, ragHit: true, webFallback: true, webConfigured: true }),
    ).toEqual({ run: false, hint: false });
  });

  it('both local sources silent + fallback on + search configured → run the web search', () => {
    expect(
      decideShotWeb({ bankHit: false, ragHit: false, webFallback: true, webConfigured: true }),
    ).toEqual({ run: true, hint: false });
  });

  it('fallback wanted but search not configured → no web, one hint so the silence is explained', () => {
    expect(
      decideShotWeb({ bankHit: false, ragHit: false, webFallback: true, webConfigured: false }),
    ).toEqual({ run: false, hint: true });
  });

  it('fallback switched off → no web and no nagging hint', () => {
    expect(
      decideShotWeb({ bankHit: false, ragHit: false, webFallback: false, webConfigured: true }),
    ).toEqual({ run: false, hint: false });
  });
});

describe('shouldRaiseLocalExamWindow — dual-screen owns the display, so this machine stays silent', () => {
  it('dual-screen enabled → never pop the local exam window (hotkeyToPhone is irrelevant here)', () => {
    expect(shouldRaiseLocalExamWindow({ enabled: true, hotkeyToPhone: true })).toBe(false);
    expect(shouldRaiseLocalExamWindow({ enabled: true, hotkeyToPhone: false })).toBe(false);
  });

  it('dual-screen off → the local window is the only display, so raise it', () => {
    expect(shouldRaiseLocalExamWindow({ enabled: false, hotkeyToPhone: true })).toBe(true);
    expect(shouldRaiseLocalExamWindow({ enabled: false, hotkeyToPhone: false })).toBe(true);
  });

  it('companion never configured → same as off', () => {
    expect(shouldRaiseLocalExamWindow(undefined)).toBe(true);
  });
});
