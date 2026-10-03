export type CaptureKind = 'loopback' | 'input';

/** Electron's display-media loopback token is currently Windows-only. */
export function captureKindForPlatform(platform: string): CaptureKind {
  return platform === 'win32' ? 'loopback' : 'input';
}

/**
 * Which Ozone/Toolkit platform a Linux session runs Electron on.
 *
 * 'x11' is the shipped default because under a native Wayland session
 * `globalShortcut` cannot register anything (mutter gives clients no cross-client
 * key grab — measured: all five accelerators fail), and this app starts hidden
 * with the hotkey as its only way back on screen. XWayland restores the grab,
 * desktopCapturer and translucent windows. 'wayland' is there for users who want
 * native scaling instead and are willing to use the tray.
 */
export type LinuxDisplayBackend = 'auto' | 'wayland' | 'x11';

/** the --ozone-platform value to force, or null to leave Electron alone */
export function linuxOzonePlatform(
  stored: LinuxDisplayBackend | undefined,
): 'wayland' | 'x11' | null {
  return stored === 'x11' || stored === 'wayland' ? stored : null;
}

/**
 * Whether a frameless overlay window can be trusted to blend with the desktop.
 *
 * Linux says no. Measured on Electron 41 / GNOME-X11: one rectangular region of
 * the transparent overlay composited at full opacity and ignored `--panel-alpha`
 * outright, while the rest of the same window blended correctly. The rectangle
 * corresponds to nothing in the DOM (no element, no pseudo-element, no
 * layer-promoting property), the region does repaint (an injected opaque probe
 * shows up in it), and it survives `--disable-gpu` as happily as it survives GPU
 * rendering — so it is Chromium's presentation of a transparent X11 top-level,
 * not our CSS and not a driver bug.
 *
 * A "translucent" overlay with one solid slab in it is worse than an honest
 * opaque one, so on Linux the overlay windows are created opaque and the opacity
 * control is taken away rather than left dead on the wall.
 */
export function overlayAlphaSupported(platform: string): boolean {
  return platform !== 'linux';
}

/**
 * Which code actually records the 对方 channel.
 *
 * 'display-media' is the Windows `audio: 'loopback'` token; 'main-process' is
 * a capture the app cannot do in a renderer at all (Windows WASAPI module,
 * Linux PipeWire monitor tap); 'input-device' is a plain microphone/virtual
 * source chosen in Settings — the only option on macOS, and the Linux fallback.
 */
export type ThemSource = 'main-process' | 'display-media' | 'input-device';

export function themSourceFor(options: {
  platform: string;
  captureBackend?: 'webaudio' | 'native';
  mainLoopbackAvailable: boolean;
}): ThemSource {
  if (options.mainLoopbackAvailable && options.captureBackend === 'native') {
    return 'main-process';
  }
  // a Linux renderer has no loopback API to fall back to, so an unavailable
  // main-process capture always lands on the input-device path instead
  return options.platform === 'win32' ? 'display-media' : 'input-device';
}

/** Defaults apply only to newly created settings; saved user choices win. */
export function defaultHotkeysForPlatform(platform: string): {
  toggle: string;
  shot: string;
  /** answer the latest transcript line — the only trigger left when the window is hidden */
  answer: string;
} {
  if (platform === 'darwin') {
    // Cmd+Alt+A is owned by common Mac tools (clipboard managers, WeChat/QQ's
    // screenshot grab), so the answer trigger lands on D there; Windows stays on A.
    return { toggle: 'Command+B', shot: 'Command+Shift+S', answer: 'Command+Alt+D' };
  }
  return { toggle: 'Control+B', shot: 'Control+Shift+S', answer: 'Control+Alt+A' };
}

export function whisperExecutionProvidersForPlatform(
  platform: string,
): ('dml' | 'cpu')[] {
  return platform === 'win32' ? ['dml', 'cpu'] : ['cpu'];
}
