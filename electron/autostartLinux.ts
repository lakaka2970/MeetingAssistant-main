/**
 * Login autostart on Linux. Electron implements `setLoginItemSettings` only for
 * Windows and macOS, so the setting would otherwise be silently dropped while
 * the UI still offered it — the XDG autostart spec is what GNOME/KDE actually
 * read, and it is a plain file we can write and remove ourselves.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
// POSIX on purpose: this writes an XDG autostart file, whose paths are forward-
// slashed no matter which OS the test suite happens to run on. platform.join()
// would hand back `C:\...\autostart`-shaped strings on Windows, where this module
// is never used but is still imported and asserted on.
import { posix as path } from 'path';
import { homedir } from 'os';

export const AUTOSTART_ENTRY_NAME = 'com.lakaka2970.meetingassistant.desktop';

/** the binary the desktop should launch, not the running process's path:
 * an AppImage reports an arbitrary /tmp mount point while it runs */
export function autostartExecPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.APPIMAGE || process.execPath;
}

export function autostartDir(configDir: string = path.join(homedir(), '.config')): string {
  return path.join(configDir, 'autostart');
}

export function autostartEntryPath(configDir?: string): string {
  return path.join(autostartDir(configDir), AUTOSTART_ENTRY_NAME);
}

/**
 * `X-GNOME-Autostart-enabled` is what GNOME's session helper checks; the plain
 * `Hidden` key is the generic answer for the other implementations.
 */
export function desktopEntryFor(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=MeetingAssistant',
    'Comment=Real-time meeting assistant',
    `Exec="${execPath.replace(/"/g, '\\"')}"`,
    'Terminal=false',
    'Hidden=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function linuxAutostartEnabled(configDir?: string): boolean {
  return existsSync(autostartEntryPath(configDir));
}

export function applyLinuxAutostart(
  enabled: boolean,
  deps: {
    execPath?: string;
    configDir?: string;
    write?: (path: string, content: string) => void;
    remove?: (path: string) => void;
    mkdir?: (path: string, options?: { recursive?: boolean }) => void;
  } = {},
): string {
  const path = autostartEntryPath(deps.configDir);
  if (!enabled) {
    try {
      (deps.remove ?? unlinkSync)(path);
    } catch {
      /* absent already — removing a missing entry is success */
    }
    return path;
  }
  const mkdir = deps.mkdir ?? mkdirSync;
  const write = deps.write ?? ((p: string, c: string) => writeFileSync(p, c, 'utf8'));
  mkdir(autostartDir(deps.configDir), { recursive: true });
  write(path, desktopEntryFor(deps.execPath ?? autostartExecPath()));
  return path;
}
