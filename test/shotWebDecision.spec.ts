import { describe, expect, it } from 'vitest';
import { decideShotWeb } from '../shared/shotWeb';

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
