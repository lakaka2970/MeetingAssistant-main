export type CaptureKind = 'loopback' | 'input';

/** Electron's display-media loopback token is currently Windows-only. */
export function captureKindForPlatform(platform: string): CaptureKind {
  return platform === 'win32' ? 'loopback' : 'input';
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
