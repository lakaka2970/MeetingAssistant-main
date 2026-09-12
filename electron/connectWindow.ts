/**
 * The dual-screen connect window (双屏连接窗).
 *
 * Why this exists as its own window rather than a row in 设置: the one thing a
 * user must do with it is point a phone camera at the screen. Behind a scroll
 * pane at the bottom of a settings dialog, past 通用/路由/音频, with a 保存 click
 * required before any address appears, that step is invisible — which is
 * exactly how it was first shipped, and the report came back as 「没有网址或者二维
 * 码」. So: one click on 双屏, and a QR fills a window.
 *
 * It closes itself once a phone authenticates (main wires that to the bridge's
 * onAuthenticated), because a QR left on screen is a credential left on screen
 * in anything that captures the display.
 *
 * Content protection is always on, like the exam window: the physical screen
 * still shows it (that is the point — a camera has to read it), but a screen
 * share or recorder gets black.
 */
import { BrowserWindow } from 'electron';
import { join } from 'path';

export const CONNECT_WINDOW_MARKER = '[connect] window created';

/** tall enough that 退出双屏 / 推送内容 are reachable without hunting */
const DEFAULT_SIZE = { width: 380, height: 620 };

export interface ConnectWindowHandle {
  win: BrowserWindow;
  /** it was merely hidden — reused instead of building a second one */
  reused: boolean;
}

export function showConnectWindow(existing: BrowserWindow | null): ConnectWindowHandle {
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return { win: existing, reused: true };
  }
  const win = new BrowserWindow({
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    minWidth: 320,
    minHeight: 420,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: true,
    show: false,
    title: '双屏连接',
    webPreferences: {
      preload: join(__dirname, '../preload/connect.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // 'screen-saver' level: this window has to survive another app going
  // full-screen, because the user may be pairing while a meeting is up
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());

  // ✕ hides: quitting the app over a helper window would be hostile
  win.on('close', (e) => {
    if (win.isDestroyed()) return;
    e.preventDefault();
    win.hide();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/connect.html`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/connect.html'));
  }

  console.log(CONNECT_WINDOW_MARKER);
  return { win, reused: false };
}

/** real teardown (app quit) — bypasses the hide-on-close behaviour */
export function destroyConnectWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  win.removeAllListeners('close');
  win.close();
}
