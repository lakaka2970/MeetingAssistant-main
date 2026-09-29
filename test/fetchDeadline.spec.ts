/**
 * Outbound deadline policy.
 *
 * Node's fetch has no timeout at all: when DNS resolves through the wrong
 * adapter or the default route points at a dead VMware NAT, a request neither
 * fails nor answers — it hangs until the OS gives up ~21 s later, and the user
 * sees a spinner with nothing happening. A first-byte deadline turns that into a
 * real error without touching the stream: once headers are in, the timer is
 * gone, so a long answer is never cut short.
 *
 * Local engines are exempt. Ollama's first request after a reboot loads the
 * model into RAM, which legitimately takes minutes; killing that would be a
 * worse bug than the hang this fixes.
 */
import { describe, expect, it } from 'vitest';
import { FIRST_BYTE_TIMEOUT_MS, fetchWithFirstByte, firstByteTimeoutFor } from '../electron/fetchDeadline';

/** Resolves never; rejects with the abort reason, the way fetch behaves. */
function hangs(signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        const reason = signal.reason;
        reject(reason instanceof Error ? reason : new Error('AbortError'));
      },
      { once: true },
    );
  });
}

describe('firstByteTimeoutFor', () => {
  it('gives remote providers a deadline', () => {
    expect(firstByteTimeoutFor('https://api.deepseek.com/v1')).toBe(FIRST_BYTE_TIMEOUT_MS);
  });

  it('gives local engines none, because cold model load is minutes', () => {
    expect(firstByteTimeoutFor('http://127.0.0.1:11434/v1')).toBeNull();
    expect(firstByteTimeoutFor('http://localhost:11434')).toBeNull();
    expect(firstByteTimeoutFor('ws://[::1]:10097')).toBeNull();
  });

  it('treats an unset base URL as remote', () => {
    expect(firstByteTimeoutFor(undefined)).toBe(FIRST_BYTE_TIMEOUT_MS);
  });
});

describe('fetchWithFirstByte', () => {
  it('disarms the deadline once the response is in', async () => {
    let seen: AbortSignal | undefined;
    const res = await fetchWithFirstByte(
      async (signal) => {
        seen = signal;
        await new Promise((r) => setTimeout(r, 15));
        return new Response('ok');
      },
      { ms: 60 },
    );
    expect(await res.text()).toBe('ok');
    // the assertion has to come after the deadline would have fired, or a
    // missing clearTimeout still passes — and cutting a long stream is the
    // exact damage this helper must not do
    await new Promise((r) => setTimeout(r, 140));
    expect(seen?.aborted).toBe(false);
  });

  it('rejects with the deadline reason when nothing answers', async () => {
    const seen: { signal?: AbortSignal } = {};
    await expect(
      fetchWithFirstByte(
        (signal) => {
          seen.signal = signal;
          return hangs(signal);
        },
        { ms: 10 },
      ),
    ).rejects.toThrow(/超时/);
    expect(seen.signal?.aborted).toBe(true);
  });

  it('leaves a caller-initiated abort as the caller’s error', async () => {
    const caller = new AbortController();
    setTimeout(() => caller.abort(new Error('user cancelled')), 5);
    await expect(
      fetchWithFirstByte((signal) => hangs(signal), { ms: 5_000, signal: caller.signal }),
    ).rejects.toThrow(/user cancelled/);
  });

  it('waits forever when the policy says no deadline', async () => {
    const res = await fetchWithFirstByte(
      async () => {
        await new Promise((r) => setTimeout(r, 60));
        return new Response('slow but fine');
      },
      { ms: firstByteTimeoutFor('http://127.0.0.1:11434/v1') },
    );
    expect(await res.text()).toBe('slow but fine');
  });
});
