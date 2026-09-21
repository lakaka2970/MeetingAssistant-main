import { describe, expect, it } from 'vitest';
import { SpeculativeCache, after } from '../electron/rag/speculative';

const settled = (v: number) => Promise.resolve(v);

describe('SpeculativeCache', () => {
  it('returns the stored promise for an exactly equal text', async () => {
    const c = new SpeculativeCache<number>();
    c.set('q', settled(1));
    await expect(c.get('q')).resolves.toBe(1);
  });

  it('misses on a different text', () => {
    const c = new SpeculativeCache<number>();
    c.set('q', settled(1));
    expect(c.get('q2')).toBeUndefined();
  });

  it('expires entries past the TTL', async () => {
    const c = new SpeculativeCache<number>(50);
    c.set('q', settled(1));
    await after(80);
    expect(c.get('q')).toBeUndefined();
  });

  it('evicts the oldest entry beyond the capacity', async () => {
    const c = new SpeculativeCache<number>(10_000, 2);
    c.set('a', settled(1));
    c.set('b', settled(2));
    c.set('c', settled(3));
    expect(c.get('a')).toBeUndefined();
    await expect(c.get('b')).resolves.toBe(2);
    await expect(c.get('c')).resolves.toBe(3);
  });

  it('replacing the same text refreshes the entry', async () => {
    const c = new SpeculativeCache<number>();
    c.set('q', settled(1));
    c.set('q', settled(2));
    await expect(c.get('q')).resolves.toBe(2);
  });

  it('drops blank keys without touching the cache', () => {
    const c = new SpeculativeCache<number>();
    c.set('  ', settled(1));
    expect(c.get('')).toBeUndefined();
  });
});
