/**
 * Cross-platform paths for the dev/QA tools.
 *
 * These mirror what `app.getPath('userData')` resolves to at runtime — the tools
 * run outside Electron, so they have to compute it themselves. The old
 * `process.env.APPDATA` reads threw on Linux (undefined) and silently pointed at
 * a stale product name.
 */
import { homedir, platform } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export const APP_NAME = 'MeetingAssistant';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** the directory the running app stores settings.json / models / sessions in */
export function userDataDir(env = process.env) {
  if (env.MC_USERDATA) return env.MC_USERDATA;
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(env.APPDATA || join(home, 'AppData', 'Roaming'), APP_NAME);
    case 'darwin':
      return join(home, 'Library', 'Application Support', APP_NAME);
    default:
      return join(env.XDG_CONFIG_HOME || join(home, '.config'), APP_NAME);
  }
}

/** the unpacked binary `electron-builder --dir` produced on this platform */
export function packagedBinary(root = repoRoot) {
  const exe = platform() === 'win32' ? 'MeetingAssistant.exe' : 'meeting-assistant';
  const dir =
    platform() === 'win32' ? 'win-unpacked' : platform() === 'darwin' ? 'mac' : 'linux-unpacked';
  return join(root, 'release', dir, exe);
}
