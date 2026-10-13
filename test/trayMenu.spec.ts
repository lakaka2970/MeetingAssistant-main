import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  buildTrayMenu,
  isRendererCommand,
  trayTooltip,
  type TrayMenuLabels,
  type TrayMenuState,
} from '../shared/trayMenu';
import { trayIconPath } from '../electron/tray';
import { mainStrings } from '../electron/uiStrings';

const labels: TrayMenuLabels = {
  brand: 'MeetingAssistant',
  showWindow: 'show',
  hideWindow: 'hide',
  startCapture: 'start',
  stopCapture: 'stop',
  newSession: 'new',
  settings: 'settings',
  serviceStatus: 'status',
  help: 'help',
  checkUpdates: 'updates',
  updateLatest: 'up to date',
  updateAvailable: (v: string) => `v${v} available`,
  updateFailed: 'check failed',
  openReleasePage: 'download',
  updateDownload: (v: string) => `install v${v}`,
  updateDownloading: (pct: number) => `downloading ${pct}%`,
  updateReady: (v: string) => `restart to install v${v}`,
  updateInstalling: 'installing',
  quit: 'quit',
  capturing: 'transcribing',
};

const state = (patch: Partial<TrayMenuState> = {}): TrayMenuState => ({
  windowVisible: true,
  capturing: false,
  ...patch,
});

describe('tray menu model', () => {
  it('offers every documented entry, in order', () => {
    const ids = buildTrayMenu(state(), labels)
      .filter((e) => e.kind === 'command')
      .map((e) => e.id);
    expect(ids).toEqual([
      'toggle-window',
      'toggle-capture',
      'new-session',
      'open-settings',
      'open-health',
      'open-help',
      'check-updates',
      'quit',
    ]);
  });

  it('opens with a disabled brand label so the menu identifies the app', () => {
    const [first] = buildTrayMenu(state(), labels);
    expect(first).toEqual({ id: 'brand', label: 'MeetingAssistant', kind: 'label' });
  });

  it('flips the window entry with visibility', () => {
    const labelFor = (visible: boolean) =>
      buildTrayMenu(state({ windowVisible: visible }), labels).find(
        (e) => e.id === 'toggle-window',
      )?.label;
    expect(labelFor(true)).toBe('hide');
    expect(labelFor(false)).toBe('show');
  });

  it('flips the capture entry with the capture state', () => {
    const labelFor = (capturing: boolean) =>
      buildTrayMenu(state({ capturing }), labels).find((e) => e.id === 'toggle-capture')?.label;
    expect(labelFor(false)).toBe('start');
    expect(labelFor(true)).toBe('stop');
  });

  it('separates the groups instead of running eleven entries together', () => {
    const kinds = buildTrayMenu(state(), labels).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'separator')).toHaveLength(4);
    // never a leading or trailing divider
    expect(kinds[0]).toBe('label');
    expect(kinds.at(-1)).toBe('command');
  });

  it('shows the capture state in the tooltip', () => {
    expect(trayTooltip(state(), labels)).toBe('MeetingAssistant');
    expect(trayTooltip(state({ capturing: true }), labels)).toBe('MeetingAssistant · transcribing');
  });

  it('routes only renderer-owned actions to the renderer', () => {
    expect(isRendererCommand('toggle-capture')).toBe(true);
    expect(isRendererCommand('new-session')).toBe(true);
    expect(isRendererCommand('open-settings')).toBe(true);
    expect(isRendererCommand('open-health')).toBe(true);
    expect(isRendererCommand('open-help')).toBe(true);
    // main owns these: the renderer cannot show a window or quit the app
    expect(isRendererCommand('toggle-window')).toBe(false);
    expect(isRendererCommand('check-updates')).toBe(false);
    expect(isRendererCommand('quit')).toBe(false);
  });
});

describe('tray update state', () => {
  const ids = (s: ReturnType<typeof state>) =>
    buildTrayMenu(s, labels).filter((e) => e.kind === 'command').map((e) => e.id);

  it('offers a plain 检查更新 until a check has happened', () => {
    expect(ids(state())).not.toContain('open-release-page');
    const entry = buildTrayMenu(state(), labels).find((e) => e.id === 'check-updates');
    expect(entry?.label).toBe('updates');
  });

  it('adds a download entry and names the version once one is available', () => {
    const withUpdate = state({
      update: { at: 1, state: 'available', version: '1.9.0', url: 'https://example/1' },
    });
    expect(ids(withUpdate)).toContain('open-release-page');
    const entry = buildTrayMenu(withUpdate, labels).find((e) => e.id === 'check-updates');
    expect(entry?.label).toContain('updates');
    expect(entry?.label).toContain('v1.9.0 available');
  });

  it('reports up-to-date without a download entry, and keeps the page after a failure', () => {
    const latest = state({ update: { at: 1, state: 'latest', version: '1.0.2' } });
    expect(buildTrayMenu(latest, labels).find((e) => e.id === 'check-updates')!.label).toBe(
      'updates · up to date',
    );
    expect(ids(latest)).not.toContain('open-release-page');

    // a failed check still offers the page: that is what this item did before
    // any check existed, and the page remains the only way to download
    const failed = state({ update: { at: 1, state: 'failed', reason: 'timeout' } });
    expect(buildTrayMenu(failed, labels).find((e) => e.id === 'check-updates')!.label).toContain(
      'check failed',
    );
    expect(ids(failed)).toContain('open-release-page');
  });

  it('is handled by main, not the renderer', () => {
    expect(isRendererCommand('open-release-page')).toBe(false);
  });
});

/**
 * The install half of v1.0.4 has to live in the same menu as 检查更新, because
 * the menu is the one surface that is guaranteed to exist even when the overlay
 * is hidden and the hotkey did not register.
 */
describe('tray updater entries', () => {
  const entries = (s: ReturnType<typeof state>) => buildTrayMenu(s, labels);
  const byId = (s: ReturnType<typeof state>, id: string) =>
    entries(s).find((e) => e.id === id);

  const up = (updater: Record<string, unknown>) => state({ updater: updater as never });

  it('offers the download once a newer release is confirmed', () => {
    const menu = byId(up({ kind: 'available', version: '1.9.0' }), 'update-download');
    expect(menu).toEqual({
      id: 'update-download',
      label: 'install v1.9.0',
      kind: 'command',
    });
  });

  it('shows progress as a dead line, not a clickable entry', () => {
    // a clickable 下载中 would let a second click start a second download
    const menu = byId(up({ kind: 'downloading', version: '1.9.0', percent: 42 }), 'update-download');
    expect(menu?.kind).toBe('label');
    expect(menu?.label).toBe('downloading 42%');
  });

  it('switches to the install entry when the file is on disk', () => {
    const ready = up({ kind: 'ready', version: '1.9.0' });
    expect(byId(ready, 'update-download')).toBeUndefined();
    expect(byId(ready, 'update-install')?.label).toBe('restart to install v1.9.0');
    // and the restart confirmation belongs to the overlay, so the renderer gets it
    expect(isRendererCommand('update-install')).toBe(true);
    expect(isRendererCommand('update-download')).toBe(false);
  });

  it('offers nothing when there is nothing to install', () => {
    for (const updater of [
      { kind: 'idle' },
      { kind: 'checking' },
      { kind: 'upToDate', version: '1.0.2' },
      { kind: 'failed', reason: 'network' },
    ]) {
      const menu = buildTrayMenu(up(updater), labels).map((e) => e.id);
      expect(menu).not.toContain('update-download');
      expect(menu).not.toContain('update-install');
    }
  });

  it('stops answering clicks once the handover to the installer began', () => {
    const menu = byId(up({ kind: 'installing', version: '1.9.0' }), 'update-install');
    expect(menu?.kind).toBe('label');
    expect(menu?.label).toBe('installing');
  });

  it('keeps the manual fallback next to the automatic one', () => {
    // the automatic path can fail for reasons that have nothing to do with the
    // release existing, so 打开下载页面 must not disappear with it
    const s = state({
      update: { at: 1, state: 'available', version: '1.9.0', url: 'https://example/1' },
      updater: { kind: 'available', version: '1.9.0' } as never,
    });
    const ids = buildTrayMenu(s, labels).map((e) => e.id);
    expect(ids).toContain('open-release-page');
    expect(ids).toContain('update-download');
    expect(ids.indexOf('open-release-page')).toBeLessThan(ids.indexOf('update-download'));
  });
});

describe('tray strings and icon', () => {
  it('has a distinct zh and en label set (MainDict enforces both exist)', () => {
    const zh = mainStrings('zh', 'en').tray;
    const en = mainStrings('en', 'zh').tray;
    expect(zh.startCapture).toBe('开始转写');
    expect(en.startCapture).toBe('Start transcription');
    expect(zh.quit).not.toBe(en.quit);
  });

  it('ships an icon for the platform, and it exists in the repo', () => {
    expect(trayIconPath('/root', 'win32')).toBe(join('/root', 'resources', 'tray', 'tray.png'));
    // macOS gets the black+alpha template so the menu bar can recolour it
    expect(trayIconPath('/root', 'darwin')).toBe(
      join('/root', 'resources', 'tray', 'trayTemplate.png'),
    );
    const repoRoot = join(__dirname, '..');
    for (const platform of ['win32', 'darwin'] as const) {
      expect(existsSync(trayIconPath(repoRoot, platform))).toBe(true);
    }
    // Electron picks the @2x variant on HiDPI displays by filename convention
    expect(existsSync(join(repoRoot, 'resources', 'tray', 'tray@2x.png'))).toBe(true);
    expect(existsSync(join(repoRoot, 'resources', 'tray', 'trayTemplate@2x.png'))).toBe(true);
  });
});
