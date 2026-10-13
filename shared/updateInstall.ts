/**
 * The install half of the update feature (v1.0.4).
 *
 * `shared/updateCheck.ts` answers "is there a newer release"; this module
 * answers "may this machine install one, and where is that process right now".
 * Both stay pure for the same reason the tray model does: the rules are the
 * product, and a rule that only exists inside an Electron callback cannot be
 * tested.
 *
 * Four rules live here rather than in the UI:
 *  1. only a Windows NSIS installation can self-update — electron-builder's own
 *     docs describe the portable exe as "auto-updates require manual
 *     implementation", and Linux keeps 打开下载页面 for now;
 *  2. nothing is offered until the user turns the setting on;
 *  3. an install requires an explicit confirmation;
 *  4. the reducer has no path into `installing` except `install-confirmed`, so
 *     "永不自动重启" is enforced by the type, not by a comment.
 */

/** what shape this running app actually is */
export type Capability =
  /** Windows: installed by the NSIS installer — the one shape that can self-update */
  | 'nsis'
  /** Windows: the single-file portable exe */
  | 'portable'
  /** Linux: mounted AppImage */
  | 'appimage'
  /** Linux: .deb on disk */
  | 'deb'
  /** not packaged at all (npm run dev, the smoke harnesses) */
  | 'dev'
  /** anything else, macOS included */
  | 'unsupported';

/**
 * `packaged` and two environment variables the electron-builder launchers set
 * for themselves. Portable cannot be detected from the path (a copy of
 * win-unpacked would look identical), and AppImage detection by `APPIMAGE` is
 * already how electron/autostartLinux.ts picks its Exec target.
 */
export function detectCapability(o: {
  platform: string;
  packaged: boolean;
  env: Record<string, string | undefined>;
}): Capability {
  if (!o.packaged) return 'dev';
  if (o.platform === 'win32') return o.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'nsis';
  if (o.platform === 'linux') return o.env.APPIMAGE ? 'appimage' : 'deb';
  return 'unsupported';
}

/** why the feature is unavailable, in the words the UI has to render */
export type GateReason = 'off' | 'portable' | 'appimage' | 'deb' | 'dev' | 'unsupported';

export type UpdaterState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate'; version: string }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'installing'; version: string }
  | { kind: 'failed'; version?: string; reason: string };

export type UpdaterEvent =
  | { type: 'check-start' }
  | { type: 'check-result'; version: string; newer: boolean }
  | { type: 'download-start' }
  | { type: 'download-progress'; percent: number }
  | { type: 'downloaded'; version?: string }
  | { type: 'install-confirmed' }
  | { type: 'failed'; reason: string; version?: string };

/**
 * The one transition table. Anything not listed is deliberately ignored — the
 * events come off electron-updater's emitter and arrive in orders we do not
 * control (a `download-progress` frame after `update-downloaded`, an `error`
 * while the installer is already handing off), and a banner that flickers
 * backwards under those is worse than one that ignores them.
 */
export function updaterReducer(state: UpdaterState, event: UpdaterEvent): UpdaterState {
  // handing the process over to the installer is terminal for everything except
  // the handover failing: quitAndInstall() returns false and dispatches an
  // error when the cached installer is gone, and a strip stuck on
  // 正在交给安装程序… is then indistinguishable from a hang
  if (state.kind === 'installing') {
    return event.type === 'failed'
      ? { kind: 'failed', version: event.version ?? state.version, reason: event.reason }
      : state;
  }

  // every step after the check knows which version it is about; a state without
  // one cannot start downloading, or the banner would promise "v 已就绪"
  const known = 'version' in state ? state.version : undefined;

  switch (event.type) {
    case 'check-start':
      // a redundant 检查更新 must not discard a finished download
      return state.kind === 'ready' ? state : { kind: 'checking' };
    case 'check-result':
      if (!event.newer) return { kind: 'upToDate', version: event.version };
      // same version we already have on disk: stay ready
      return state.kind === 'ready' && state.version === event.version
        ? state
        : { kind: 'available', version: event.version };
    case 'download-start':
      // the machine-level half of this rule is canDownload(); here only the
      // question "does this state have something to fetch"
      return known !== undefined && (state.kind === 'available' || state.kind === 'failed')
        ? { kind: 'downloading', version: known, percent: 0 }
        : state;
    case 'download-progress':
      if (state.kind === 'downloading') {
        return { ...state, percent: clampPercent(event.percent) };
      }
      // `available` only: a frame that lands after `ready` must not roll the
      // banner back to 97%, and `ready` is where the user is asked to confirm
      return state.kind === 'available'
        ? { kind: 'downloading', version: state.version, percent: clampPercent(event.percent) }
        : state;
    case 'downloaded':
      // electron-updater also names the version on this event, and taking it
      // must not walk the state back through `available` — that made the banner
      // flicker from 下载中 back to a download button
      if (state.kind === 'downloading' || state.kind === 'available') {
        return { kind: 'ready', version: event.version ?? state.version };
      }
      return state;
    case 'install-confirmed':
      return state.kind === 'ready' ? { kind: 'installing', version: state.version } : state;
    case 'failed':
      return { kind: 'failed', version: event.version ?? known, reason: event.reason };
  }
}

/** percent comes from a third-party downloader and feeds a width style */
function clampPercent(percent: number): number {
  const p = Number.isFinite(percent) ? percent : 0;
  return Math.min(100, Math.max(0, Math.round(p)));
}

/**
 * Whether a 下载并安装 click may start a download. Two things must both be true:
 * the machine is allowed to install, and the state actually names a version to
 * fetch. Without the second half a click in any state (a stale menu, a renderer
 * that kept an old view after a re-check) could walk the machine into
 * `downloading → ready` from `upToDate`, and `canInstall` would then hand over.
 */
export function canDownload(
  state: UpdaterState,
  capability: Capability,
): { allowed: true } | { allowed: false; reason: GateReason | 'no-version' } {
  if (capability !== 'nsis') return { allowed: false, reason: capability };
  const hasVersion = 'version' in state && state.version !== '';
  if (!hasVersion) return { allowed: false, reason: 'no-version' };
  if (state.kind !== 'available' && state.kind !== 'failed') {
    return { allowed: false, reason: 'no-version' };
  }
  return { allowed: true };
}

/**
 * The action-side check. The menu is built from `updaterGate`, but a stale menu
 * click must still be refused, so the capability is verified again here.
 */
export function canInstall(
  state: UpdaterState,
  o: { confirmed: boolean; capability: Capability },
): boolean {
  return state.kind === 'ready' && o.confirmed && o.capability === 'nsis';
}

/**
 * Whether to offer any of this at all. Default off: the app promises no
 * unsolicited network use, and downloading 118 MB is a bigger step than asking
 * GitHub for a version string.
 */
export function updaterGate(o: { enabled: boolean; capability: Capability }): {
  allowed: boolean;
  reason?: GateReason;
} {
  if (!o.enabled) return { allowed: false, reason: 'off' };
  if (o.capability === 'nsis') return { allowed: true };
  return { allowed: false, reason: o.capability };
}

/**
 * Generic-provider feed for a mirror. Same https rule as updateApiUrl: this
 * string decides where a 118 MB download and its checksum manifest come from,
 * so plaintext is refused. Empty means "use the GitHub provider" — the only
 * shape v1.0.4 exposes.
 */
export function updaterFeedUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  if (!trimmed || !/^https:\/\//i.test(trimmed)) return '';
  return trimmed;
}
