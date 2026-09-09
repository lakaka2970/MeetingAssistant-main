/**
 * The exam-mode window (做题模式) — a small always-on-top, capture-protected
 * panel the user floats next to an online assessment.
 *
 * Differences from the main interview overlay, and why:
 *   • content protection is ALWAYS on here: the whole point is that the OA
 *     screen recorder cannot see it (there is no "recording the meeting" mode
 *     where it should leak);
 *   • much smaller and narrower, because the answer must sit beside the test
 *     page without covering it;
 *   • it hides on close instead of quitting, and the app keeps running in the
 *     tray with the interview window;
 *   • it has its own preload surface (examPreload.ts): the interview McApi is
 *     far too wide for a window whose only jobs are "read the screen" and
 *     "answer", and the sandboxed-preload chunking rule forbids sharing
 *     runtime modules between preloads (see the comment in electron.vite.config.ts).
 */
import { BrowserWindow } from 'electron';
import { join } from 'path';
import type { SettingsStore } from './settings';

/** logged so the packaged smoke test can prove the exam window boots */
export const EXAM_WINDOW_MARKER = '[exam] window created';

const DEFAULT_SIZE = { width: 380, height: 560 };

export interface ExamWindowHandle {
  win: BrowserWindow;
  /** the window was only hidden — reuse it instead of creating a second one */
  reuse: boolean;
}

export function createExamWindow(settings: SettingsStore): ExamWindowHandle {
  const bounds = settings.data.exam?.bounds;
  const win = new BrowserWindow({
    width: bounds?.width ?? DEFAULT_SIZE.width,
    height: bounds?.height ?? DEFAULT_SIZE.height,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 320,
    minHeight: 360,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/exam.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // no user setting here: an exam window that can be captured is useless
  win.setContentProtection(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());

  // closing hides: the scan state, the persona ledger and the last answer are
  // all in this window's renderer, and losing them on ✕ would be hostile
  let quitting = false;
  (win as BrowserWindow & { __examQuitting?: boolean }).__examQuitting = false;
  win.on('close', (e) => {
    if ((win as BrowserWindow & { __examQuitting?: boolean }).__examQuitting) return;
    if (win.isDestroyed()) return;
    e.preventDefault();
    win.hide();
  });
  const saveBounds = (): void => {
    if (win.isDestroyed() || !win.isVisible()) return;
    const b = win.getBounds();
    settings.applyPatch({ exam: { bounds: { x: b.x, y: b.y, width: b.width, height: b.height } } });
  };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/exam.html`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/exam.html'));
  }

  console.log(EXAM_WINDOW_MARKER);
  return { win, reuse: false };
}

/** let it actually close (app quit / explicit destroy) */
export function destroyExamWindow(win: BrowserWindow): void {
  (win as BrowserWindow & { __examQuitting?: boolean }).__examQuitting = true;
  if (!win.isDestroyed()) win.close();
}
