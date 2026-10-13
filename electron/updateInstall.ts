/**
 * The electron-updater half of v1.0.4 — deliberately thin.
 *
 * Every rule that decides anything (may this machine install, does a click
 * count as confirmation, is the state allowed to move) lives in
 * shared/updateInstall.ts and is unit-tested there. This file only translates
 * between that reducer and the library's EventEmitter, because the library is
 * the one thing here that cannot be tested from a unit test: it needs a
 * packaged app, a real release and a Windows box to install onto.
 *
 * Three defaults have to be overridden, each verified against the installed
 * node_modules/electron-updater@6.8.10 rather than from memory:
 *
 *   autoDownload          default TRUE (AppUpdater.js) — a check would start a
 *                         118 MiB download by itself. Decision: download only
 *                         after the user asks, so this is the load-bearing one.
 *   autoInstallOnAppQuit   default TRUE  (AppUpdater.js:114) — a downloaded
 *                         update would be installed silently on the next quit,
 *                         which is exactly the automatic restart we promised
 *                         never to do.
 *   disableWebInstaller   default FALSE (AppUpdater.js:147) — we ship a full
 *                         installer, so refusing a web-installer update is both
 *                         safer and what v27 will default to anyway.
 *
 * Code signing: there is none, so `app-update.yml` carries no `publisherName`,
 * and NsisUpdater.verifySignature returns early on that (NsisUpdater.js:84-97).
 * The chain this feature trusts is https to GitHub plus the sha512 inside
 * latest.yml — no more, and the README has to say so.
 */
import { app } from 'electron';
import {
  canDownload,
  canInstall,
  detectCapability,
  updaterReducer,
  type Capability,
  type UpdaterEvent,
  type UpdaterState,
} from '../shared/updateInstall';

/**
 * Typed slice of the library, so the require below stays honest about what we
 * use. `CancellationToken` is passed in rather than imported because the seam in
 * `createUpdater` lets a test hand in a fake library, and a fake should not have
 * to reproduce a class from the real one.
 */
export interface LibUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  disableWebInstaller: boolean;
  logger: unknown;
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>;
  downloadUpdate(token?: unknown): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): boolean | void;
  on(event: string, cb: (payload?: unknown) => void): void;
}

export interface Updater {
  readonly capability: Capability;
  get state(): UpdaterState;
  /** called after every state change; main broadcasts it to tray and renderer */
  onChange: (listener: (state: UpdaterState) => void) => void;
  check(): Promise<void>;
  download(): Promise<void>;
  /**
   * Abandon an in-flight download. Called when the user turns the setting off:
   * hiding the strip while 118 MB keeps arriving would be the worst kind of
   * quiet, and electron-updater supports cancellation.
   */
  cancel(): void;
  /** the user's confirmation is the ONLY way in; returns false when refused */
  confirmInstall(): boolean;
}

/**
 * Console-shim logger. electron-updater would otherwise pull electron-log in
 * and write into the userData folder; the app's own log is where a reader
 * looks, and every line here is prefixed so it sorts with the rest.
 */
const log = {
  info: (m: unknown) => console.log(`[updater] ${String(m)}`),
  warn: (m: unknown) => console.warn(`[updater] ${String(m)}`),
  error: (m: unknown) => console.error(`[updater] ${String(m)}`),
};

/**
 * Build the updater. Returns null when this machine cannot self-update: a dev
 * run, a portable exe, Linux, or macOS. The caller shows the reason instead of
 * a dead button, which is why this returns null rather than throwing — the tray
 * and the settings panel both need to keep working.
 *
 * `lib`, `capability` and `currentVersion` are injectable for one reason: the
 * three library defaults this module overrides are the load-bearing part of the
 * "never installs or restarts by itself" promise, and a test can only check
 * them against a stand-in updater. Without the seam, flipping
 * `autoDownload = false` back to the library default would be invisible until a
 * user's meter ran out mid-download.
 */
export function createUpdater(o: {
  lib?: () => { autoUpdater: LibUpdater };
  capability?: Capability;
  currentVersion?: string;
  /** makes a cancellation token for one download (real one comes from the lib) */
  token?: () => { cancel(): void };
  onReason?: (reason: string) => void;
} = {}): Updater | null {
  const capability =
    o.capability ??
    detectCapability({
      platform: process.platform,
      packaged: app.isPackaged,
      env: process.env,
    });
  if (capability !== 'nsis') {
    o.onReason?.(capability);
    return null;
  }
  // required lazily: electron-updater touches Electron internals at import
  const { autoUpdater } = (o.lib ?? (() => require('electron-updater')))();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = log;

  let state: UpdaterState = { kind: 'idle' };
  let activeToken: { cancel(): void } | null = null;
  /** the library's own token type, created lazily so the fake lib need not have one */
  const downloadToken = (): { cancel(): void } => {
    if (o.token) return o.token();
    const { CancellationToken } = require('electron-updater') as {
      CancellationToken: new () => { cancel(): void };
    };
    return new CancellationToken();
  };
  let listener: (s: UpdaterState) => void = () => {};
  /** the version the library last reported; every event but check-result carries no version */
  let current: string | undefined;

  const apply = (event: UpdaterEvent): void => {
    const next = updaterReducer(state, event);
    if (next === state) return;
    state = next;
    if ('version' in next) current = next.version;
    listener(next);
  };

  autoUpdater.on('error', (e: unknown) => {
    const err = e as { message?: string } | null;
    apply({ type: 'failed', reason: err?.message ?? String(e), version: current });
  });
  autoUpdater.on('checking-for-update', () => apply({ type: 'check-start' }));
  autoUpdater.on('update-available', (info: unknown) => {
    const version = (info as { version?: string })?.version ?? current ?? '';
    apply({ type: 'check-result', version, newer: true });
  });
  autoUpdater.on('update-not-available', (info: unknown) => {
    // `update-not-available` carries the LATEST remote info, so its version is
    // not "what we are up to date as" — using it would label the state with a
    // version that is neither installed here nor fetchable by us
    const version = o.currentVersion ?? app.getVersion();
    void info;
    apply({ type: 'check-result', version, newer: false });
  });
  autoUpdater.on('download-progress', (p: unknown) => {
    apply({ type: 'download-progress', percent: (p as { percent?: number })?.percent ?? 0 });
  });
  autoUpdater.on('update-downloaded', (info: unknown) => {
    // the version rides along on this event, and `downloaded` is the only thing
    // fed to the reducer here: re-announcing `check-result` to set the version
    // walked the state back to `available`, which made the banner flicker from
    // 下载中 back to a download button
    apply({
      type: 'downloaded',
      version: (info as { version?: string })?.version ?? current,
    });
  });

  return {
    capability,
    get state() {
      return state;
    },
    onChange(fn) {
      listener = fn;
    },
    async check() {
      apply({ type: 'check-start' });
      try {
        await autoUpdater.checkForUpdates();
      } catch (e) {
        apply({ type: 'failed', reason: (e as Error)?.message ?? String(e) });
      }
    },
    async download() {
      // the state machine decides, not the menu that produced the click
      const gate = canDownload(state, capability);
      if (!gate.allowed) {
        // a code, not prose: the renderer translates it, because this string
        // would otherwise land in an English UI as Chinese (and vice versa)
        apply({ type: 'failed', reason: 'no-version', version: current });
        return;
      }
      apply({ type: 'download-start' });
      const token = o.token?.() ?? downloadToken();
      activeToken = token;
      try {
        await autoUpdater.downloadUpdate(token);
      } catch (e) {
        apply({ type: 'failed', reason: (e as Error)?.message ?? String(e), version: current });
      } finally {
        activeToken = null;
      }
    },
    cancel() {
      if (!activeToken) return;
      log.warn('download cancelled by the user');
      activeToken.cancel();
      activeToken = null;
      apply({ type: 'failed', reason: 'cancelled', version: current });
    },
    confirmInstall() {
      if (!canInstall(state, { confirmed: true, capability })) {
        log.warn(`refused install from state ${state.kind}`);
        return false;
      }
      apply({ type: 'install-confirmed' });
      // silent + relaunch: NSIS per-user with oneClick installs without a
      // wizard, and the user just agreed to a restart, so the app must come
      // back up on its own
      const handedOver = autoUpdater.quitAndInstall(true, true);
      // BaseUpdater.install() returns false (and dispatches its own error) when
      // the cached installer is gone. Swallowing that left the strip reading
      // 正在交给安装程序… forever over an app that was still running.
      if (handedOver === false) {
        apply({ type: 'failed', reason: 'handover-failed', version: current });
        return false;
      }
      return true;
    },
  };
}
