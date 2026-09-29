/**
 * First-byte deadline for outbound HTTP (R: 换台机器也能连得上).
 *
 * Node's fetch has no timeout: when DNS resolves through a virtual adapter or
 * the default route points at a dead VMware NAT, a request neither fails nor
 * answers and hangs until the OS gives up (~21 s), which looks like the app
 * froze. The deadline covers only the wait for the response — once headers are
 * in, the timer is cleared, so a long token stream is never cut short.
 */

/** How long to wait for the first byte from a remote provider. */
export const FIRST_BYTE_TIMEOUT_MS = 15_000;

/** Local engines: Ollama's cold model load legitimately takes minutes. */
const LOOPBACK_HOST =
  /^(?:https?|ws):\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?(?:\/|$)/i;

/** The deadline for this base URL, or null when it must not have one. */
export function firstByteTimeoutFor(baseUrl: string | undefined): number | null {
  if (baseUrl && LOOPBACK_HOST.test(baseUrl.trim())) return null;
  return FIRST_BYTE_TIMEOUT_MS;
}

/**
 * Run a fetch under a first-byte deadline, combined with any signal the caller
 * already has. A caller-initiated abort keeps its own reason; only a deadline
 * expiry is rewritten into something that says what actually happened.
 */
export async function fetchWithFirstByte(
  run: (signal: AbortSignal) => Promise<Response>,
  opts?: { ms?: number | null; signal?: AbortSignal },
): Promise<Response> {
  const ms = opts?.ms === undefined ? FIRST_BYTE_TIMEOUT_MS : opts.ms;
  if (!ms) return await run(opts?.signal ?? new AbortController().signal);

  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new Error(`连接超时：${Math.round(ms / 1000)}s 内没有收到响应（检查网络、代理或 Base URL）`),
      ),
    ms,
  );
  timer.unref?.();
  const signal = opts?.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
  try {
    return await run(signal);
  } catch (e) {
    if (deadline.signal.aborted && !opts?.signal?.aborted) {
      const reason = deadline.signal.reason;
      throw reason instanceof Error ? reason : e;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
