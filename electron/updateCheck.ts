/**
 * The network half of the update check (plan A: notify, never install).
 *
 * One GET, one response, no identifiers beyond what any HTTPS request carries
 * (the host sees this machine's IP and the version string we ask about). That is
 * why `update.autoCheck` ships off: the README promises no telemetry, and an
 * unsolicited request — however harmless — would contradict it. The tray item is
 * always available because there the user asked.
 */
import { interpretRelease, type ReleasePayload, type UpdateCheck } from '../shared/updateCheck';
import { fetchWithFirstByte } from './fetchDeadline';

const REPO = 'lakaka2970/MeetingAssistant-main';
const DEFAULT_API_BASE = 'https://api.github.com';
/** GitHub answers in well under a second; longer than this is a dead route. */
const CHECK_TIMEOUT_MS = 10_000;

/**
 * The endpoint to ask. A mirror is supported because api.github.com is not
 * reachable from some of the networks this app is used on — but only over
 * https, since the answer decides what the next click opens.
 */
export function updateApiUrl(apiBase: string): string {
  const base = apiBase.trim().replace(/\/+$/, '');
  if (!base) return `${DEFAULT_API_BASE}/repos/${REPO}/releases/latest`;
  if (!/^https:\/\//i.test(base)) return '';
  return `${base}/repos/${REPO}/releases/latest`;
}

export async function checkForUpdate(
  currentVersion: string,
  apiBase: string,
  now: number = Date.now(),
): Promise<UpdateCheck> {
  const url = updateApiUrl(apiBase);
  if (!url) return { at: now, state: 'failed', reason: '镜像地址必须以 https:// 开头' };
  try {
    const res = await fetchWithFirstByte(
      (signal) =>
        fetch(url, {
          signal,
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MeetingAssistant' },
        }),
      { ms: CHECK_TIMEOUT_MS },
    );
    if (!res.ok) {
      // 403/429 is the anonymous 60-requests-per-hour ceiling, not an outage
      const reason =
        res.status === 403 || res.status === 429
          ? `GitHub 接口限流（HTTP ${res.status}），稍后再试`
          : `HTTP ${res.status}`;
      return { at: now, state: 'failed', reason };
    }
    const json: unknown = await res.json();
    return interpretRelease(
      (json && typeof json === 'object' ? json : {}) as ReleasePayload,
      currentVersion,
      now,
    );
  } catch (e) {
    return { at: now, state: 'failed', reason: (e as Error)?.message || '网络错误' };
  }
}
