/**
 * The install half of the update feature, kept pure so the four rules that
 * matter can be read as a table:
 *
 *  1. only a Windows NSIS install can be updated this way — portable and the
 *     Linux packages keep 打开下载页面, and they say why instead of showing a
 *     dead button;
 *  2. the whole feature is off until the user turns it on (settings default);
 *  3. an install needs a confirmation and nothing else can start one;
 *  4. the state machine cannot walk itself into `installing` on its own, so
 *     "永不自动重启" is an assertion, not a comment.
 *
 * The electron-updater calls these rules are fed to live in
 * electron/updateInstall.ts; nothing here imports electron.
 */
import { describe, expect, it } from 'vitest';
import {
  canDownload,
  canInstall,
  detectCapability,
  updaterFeedUrl,
  updaterGate,
  updaterReducer,
  type UpdaterState,
} from '../shared/updateInstall';

describe('detectCapability', () => {
  it('refuses to speak of installing in a dev build', () => {
    expect(detectCapability({ platform: 'win32', packaged: false, env: {} })).toBe('dev');
  });

  it('tells the portable exe and the NSIS install apart by the launcher env', () => {
    // electron-builder's portable launcher sets PORTABLE_EXECUTABLE_FILE; an
    // installed app has no such thing. Guessing from the path instead would
    // call a copy of win-unpacked\MeetingAssistant.exe "portable".
    expect(
      detectCapability({
        platform: 'win32',
        packaged: true,
        env: { PORTABLE_EXECUTABLE_FILE: 'D:\\MeetingAssistant-1.0.4-win-x64-portable.exe' },
      }),
    ).toBe('portable');
    expect(detectCapability({ platform: 'win32', packaged: true, env: {} })).toBe('nsis');
  });

  it('separates AppImage from deb the way autostartLinux.ts already does', () => {
    expect(
      detectCapability({
        platform: 'linux',
        packaged: true,
        env: { APPIMAGE: '/home/u/MeetingAssistant-1.0.4-linux-x86_64.AppImage' },
      }),
    ).toBe('appimage');
    expect(detectCapability({ platform: 'linux', packaged: true, env: {} })).toBe('deb');
  });

  it('has no plan at all for a platform with no installer', () => {
    expect(detectCapability({ platform: 'darwin', packaged: true, env: {} })).toBe('unsupported');
  });
});

describe('updaterGate', () => {
  it('is closed by default and says so', () => {
    expect(updaterGate({ enabled: false, capability: 'nsis' })).toEqual({
      allowed: false,
      reason: 'off',
    });
  });

  it('opens only for a Windows NSIS install that opted in', () => {
    expect(updaterGate({ enabled: true, capability: 'nsis' })).toEqual({ allowed: true });
  });

  /**
   * Each unavailable shape gets its own reason because the UI has to name the
   * cause: "免安装版" and "开发环境" are different things to do something about,
   * and one shared 不可用 string is how a user ends up with a dead button.
   */
  it('names why the other shapes cannot self-update', () => {
    expect(updaterGate({ enabled: true, capability: 'portable' }).reason).toBe('portable');
    expect(updaterGate({ enabled: true, capability: 'appimage' }).reason).toBe('appimage');
    expect(updaterGate({ enabled: true, capability: 'deb' }).reason).toBe('deb');
    expect(updaterGate({ enabled: true, capability: 'dev' }).reason).toBe('dev');
    expect(updaterGate({ enabled: true, capability: 'unsupported' }).reason).toBe('unsupported');
  });
});

const idle: UpdaterState = { kind: 'idle' };

describe('updaterReducer', () => {
  it('walks the happy path', () => {
    let s = updaterReducer(idle, { type: 'check-start' });
    expect(s).toEqual({ kind: 'checking' });
    s = updaterReducer(s, { type: 'check-result', version: '1.0.4', newer: true });
    expect(s).toEqual({ kind: 'available', version: '1.0.4' });
    s = updaterReducer(s, { type: 'download-start' });
    s = updaterReducer(s, { type: 'download-progress', percent: 42 });
    expect(s).toEqual({ kind: 'downloading', version: '1.0.4', percent: 42 });
    s = updaterReducer(s, { type: 'downloaded' });
    expect(s).toEqual({ kind: 'ready', version: '1.0.4' });
    s = updaterReducer(s, { type: 'install-confirmed' });
    expect(s).toEqual({ kind: 'installing', version: '1.0.4' });
  });

  it('reports up to date without ever offering an install', () => {
    const s = updaterReducer(
      updaterReducer(idle, { type: 'check-start' }),
      { type: 'check-result', version: '1.0.4', newer: false },
    );
    expect(s).toEqual({ kind: 'upToDate', version: '1.0.4' });
    expect(canInstall(s, { confirmed: true, capability: 'nsis' })).toBe(false);
  });

  it('cannot be talked into installing from a state with nothing downloaded', () => {
    for (const s of [
      idle,
      { kind: 'checking' } as UpdaterState,
      { kind: 'available', version: '1.0.4' } as UpdaterState,
      { kind: 'downloading', version: '1.0.4', percent: 12 } as UpdaterState,
      { kind: 'failed', reason: 'x' } as UpdaterState,
    ]) {
      expect(updaterReducer(s, { type: 'install-confirmed' })).toEqual(s);
    }
  });

  it('keeps the version it learned when a later step fails', () => {
    const ready: UpdaterState = { kind: 'ready', version: '1.0.4' };
    expect(updaterReducer(ready, { type: 'failed', reason: 'hash mismatch' })).toEqual({
      kind: 'failed',
      version: '1.0.4',
      reason: 'hash mismatch',
    });
  });

  it('survives a progress event arriving after the download finished', () => {
    // electron-updater emits download-progress and update-downloaded from
    // different ticks; a late frame must not roll the banner back to 98%.
    const ready: UpdaterState = { kind: 'ready', version: '1.0.4' };
    expect(updaterReducer(ready, { type: 'download-progress', percent: 97 })).toEqual(ready);
  });

  it('is terminal once the installer has been handed off', () => {
    // quitAndInstall closes the windows before app.quit(), so events keep coming
    // while the process is on its way out; re-entering them must not re-open a
    // confirmation the user already gave. The one thing that may still get
    // through is the handover failing — see the dead-end suite below.
    const installing: UpdaterState = { kind: 'installing', version: '1.0.4' };
    expect(updaterReducer(installing, { type: 'check-start' })).toEqual(installing);
    expect(updaterReducer(installing, { type: 'downloaded', version: '1.0.4' })).toEqual(
      installing,
    );
  });

  it('carries the version the library re-announces into ready', () => {
    // electron-updater puts the version on update-downloaded too; taking it
    // must not walk the state back through `available`, which is what made the
    // banner flicker from 下载中 back to a download button in the real glue
    const downloading: UpdaterState = { kind: 'downloading', version: '1.0.4', percent: 96 };
    expect(updaterReducer(downloading, { type: 'downloaded', version: '1.0.4' })).toEqual({
      kind: 'ready',
      version: '1.0.4',
    });
  });

  it('restarts cleanly from failed and ignores progress it has no version for', () => {
    const failed: UpdaterState = { kind: 'failed', reason: 'network' };
    expect(updaterReducer(failed, { type: 'check-start' })).toEqual({ kind: 'checking' });
    expect(updaterReducer(idle, { type: 'download-progress', percent: 50 })).toEqual(idle);
    expect(updaterReducer(idle, { type: 'downloaded' })).toEqual(idle);
  });

  it('clamps a percentage the same way the settings clamps everything else', () => {
    const downloading = (percent: number): UpdaterState => ({
      kind: 'downloading',
      version: '1.0.4',
      percent,
    });
    const base: UpdaterState = { kind: 'available', version: '1.0.4' };
    expect(updaterReducer(base, { type: 'download-progress', percent: 140 })).toEqual(
      downloading(100),
    );
    expect(updaterReducer(base, { type: 'download-progress', percent: -3 })).toEqual(
      downloading(0),
    );
    expect(updaterReducer(base, { type: 'download-progress', percent: Number.NaN })).toEqual(
      downloading(0),
    );
  });
});

/**
 * Three paths a real user walks into, each of which used to dead-end:
 * retrying after a failure that never had a version, re-checking while a
 * download already finished, and asking for a download the machine should not
 * grant because its state says there is nothing to fetch.
 */
describe('the paths that used to dead-end', () => {
  it('keeps a finished download across a redundant re-check of the same version', () => {
    // 检查更新 is always clickable in the tray; a second click must not throw
    // away the 118 MB already paid for
    const ready: UpdaterState = { kind: 'ready', version: '1.0.4' };
    expect(updaterReducer(ready, { type: 'check-start' })).toEqual(ready);
    expect(updaterReducer(ready, { type: 'check-result', version: '1.0.4', newer: true })).toEqual(
      ready,
    );
  });

  it('does offer the newer file when the check finds a different version', () => {
    const ready: UpdaterState = { kind: 'ready', version: '1.0.4' };
    expect(
      updaterReducer(ready, { type: 'check-result', version: '1.0.5', newer: true }),
    ).toEqual({ kind: 'available', version: '1.0.5' });
  });

  it('lets a failed handover out of `installing`, and nothing else', () => {
    // quitAndInstall() returns false and dispatches an error when the cached
    // installer is gone; a strip stuck on 正在交给安装程序… is indistinguishable
    // from a hang
    const installing: UpdaterState = { kind: 'installing', version: '1.0.4' };
    expect(updaterReducer(installing, { type: 'failed', reason: 'no installer' })).toEqual({
      kind: 'failed',
      version: '1.0.4',
      reason: 'no installer',
    });
    expect(updaterReducer(installing, { type: 'check-start' })).toEqual(installing);
    expect(updaterReducer(installing, { type: 'downloaded', version: '1.0.4' })).toEqual(
      installing,
    );
  });

  it('refuses to start a download from a state that has nothing to download', () => {
    for (const s of [
      idle,
      { kind: 'checking' } as UpdaterState,
      { kind: 'upToDate', version: '1.0.4' } as UpdaterState,
      { kind: 'installing', version: '1.0.4' } as UpdaterState,
      { kind: 'failed', reason: 'no version here' } as UpdaterState,
    ]) {
      expect(updaterReducer(s, { type: 'download-start' })).toEqual(s);
    }
    const available: UpdaterState = { kind: 'available', version: '1.0.4' };
    expect(updaterReducer(available, { type: 'download-start' })).toEqual({
      kind: 'downloading',
      version: '1.0.4',
      percent: 0,
    });
  });
});

describe('canDownload', () => {
  it('allows the click exactly when there is a version to fetch', () => {
    const ok = { allowed: true };
    expect(canDownload({ kind: 'available', version: '1.0.4' }, 'nsis')).toEqual(ok);
    expect(canDownload({ kind: 'failed', version: '1.0.4', reason: 'x' }, 'nsis')).toEqual(ok);
    expect(
      canDownload({ kind: 'upToDate', version: '1.0.4' }, 'nsis'),
    ).toEqual({ allowed: false, reason: 'no-version' });
    expect(canDownload({ kind: 'idle' }, 'nsis')).toEqual({ allowed: false, reason: 'no-version' });
    // a machine that may not install may not download either, whatever the state
    expect(canDownload({ kind: 'available', version: '1.0.4' }, 'portable')).toEqual({
      allowed: false,
      reason: 'portable',
    });
  });
});

describe('canInstall', () => {
  it('needs both a finished download and an explicit confirmation', () => {
    const ready: UpdaterState = { kind: 'ready', version: '1.0.4' };
    expect(canInstall(ready, { confirmed: true, capability: 'nsis' })).toBe(true);
    expect(canInstall(ready, { confirmed: false, capability: 'nsis' })).toBe(false);
    // an unwinnable capability must not install even after a confirmation:
    // the gate is checked at the moment of action, not only when the menu is built
    expect(canInstall(ready, { confirmed: true, capability: 'portable' })).toBe(false);
  });
});

describe('updaterFeedUrl', () => {
  it('is empty unless an https mirror is given (mirrors are not exposed yet)', () => {
    expect(updaterFeedUrl('')).toBe('');
    expect(updaterFeedUrl('http://gh.example.com')).toBe('');
    expect(updaterFeedUrl('https://gh.example.com/')).toBe('https://gh.example.com');
  });
});
