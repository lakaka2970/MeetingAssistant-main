/**
 * Update checking (plan A: notify, never install).
 *
 * The app has no server and promises no telemetry, so the only honest shape for
 * "is there a newer version" is: ask GitHub's releases API, tell the user what
 * came back, and let them open the page themselves. This module is the pure
 * half — what counts as newer, and when the automatic path may speak — so both
 * are testable and the network stays in electron/updateCheck.ts.
 */

/** One request per day per install, at most. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 3_600_000;

/** the outcome of one check, stamped so the interval can be honoured */
export type UpdateCheck =
  | { at: number; state: 'latest'; version: string }
  | { at: number; state: 'available'; version: string; url: string }
  | { at: number; state: 'failed'; reason: string };

const NUMERIC_VERSION = /^v?\d+(\.\d+)*$/i;

function toParts(value: string): number[] | null {
  const text = value.trim().replace(/^v/i, '');
  if (!NUMERIC_VERSION.test(text)) return null;
  return text.split('.').map(Number);
}

/** `v1.0.2` → `1.0.2`; anything that is not a plain version → null. */
export function parseReleaseTag(tag: string): string | null {
  const parts = toParts(tag);
  return parts ? parts.join('.') : null;
}

/**
 * Is `remote` ahead of `local`? Compares component by component, so 1.0.10 is
 * newer than 1.0.2 (a string compare gets this backwards). A pre-release or a
 * hand-written tag is not a version and never counts as newer — nagging about
 * something we cannot order is worse than staying quiet.
 */
export function isNewerVersion(local: string, remote: string): boolean {
  const a = toParts(remote);
  const b = toParts(local);
  if (!a || !b) return false;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** the two fields of a GitHub release we act on; anything else is ignored */
export interface ReleasePayload {
  tag_name?: unknown;
  html_url?: unknown;
}

/**
 * Turn a release payload into what the tray can say.
 *
 * The url is checked rather than trusted: this string is what a click hands to
 * the operating system, and a release object from an unexpected mirror could
 * carry anything. Only https gets through.
 */
export function interpretRelease(
  payload: ReleasePayload,
  currentVersion: string,
  at: number,
): UpdateCheck {
  const tag = typeof payload.tag_name === 'string' ? parseReleaseTag(payload.tag_name) : null;
  if (!tag) return { at, state: 'failed', reason: '响应里没有可识别的版本号' };
  if (!isNewerVersion(currentVersion, tag)) return { at, state: 'latest', version: tag };
  const url = payload.html_url;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    return { at, state: 'failed', reason: `新版本 v${tag} 没有可打开的 https 地址` };
  }
  return { at, state: 'available', version: tag, url };
}

/**
 * May the launch-time check run? Off unless the user opted in, and then at most
 * once per {@link UPDATE_CHECK_INTERVAL_MS} regardless of the previous outcome —
 * a failure is still an attempt, or a machine with no route to GitHub would
 * retry on every single start.
 */
export function shouldAutoCheck(o: {
  enabled: boolean;
  now: number;
  lastAt?: number | null;
}): boolean {
  if (!o.enabled) return false;
  if (!o.lastAt) return true;
  return o.now - o.lastAt >= UPDATE_CHECK_INTERVAL_MS;
}
