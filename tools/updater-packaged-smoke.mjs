/**
 * Packaged smoke for the v1.0.4 install surface.
 *
 *   npm run dist:win && npm run smoke:updater
 *
 * dist:win, not dist:dir: app-update.yml is only written for the nsis target
 * (PublishManager gates on isSuitableWindowsTarget), and without it the library
 * has no feed to read.
 *
 * Unit tests cover the reducer and, against a stand-in library, the three
 * electron-updater defaults that decide whether the app installs or restarts on
 * its own. What only a packaged run can answer is whether the shipped bundle is
 * wired at all: that `electron-updater` resolves inside app.asar, that
 * `resources/app-update.yml` is where the library looks, that no IPC channel is
 * registered twice, and that the answer the feed gives is reported instead of
 * swallowed.
 *
 * It runs the exe with MC_UPDATER_CHECK=1, which forces the manifest request the
 * ordinary path cannot make during testing (the newest published release is
 * older than the build under test, so 检查更新 answers 已是最新 and never asks
 * the installer). Whatever the answer is — a newer version or a failed lookup —
 * the point of this run is that the app says so and stays standing.
 *
 * Uses a throwaway profile on this drive; never touches the real one.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// MC_PACKAGED_EXE points the smoke at another build tree, which is what you want
// when release/win-unpacked is wedged by a handle some other process forgot
const exePath =
  process.env.MC_PACKAGED_EXE ?? join(root, 'release', 'win-unpacked', 'MeetingAssistant.exe');
if (!existsSync(exePath)) {
  console.error(`[updater-smoke] missing ${exePath} — run \`npm run dist:dir\` first.`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'mc-updater-smoke-'));
writeFileSync(
  join(dir, 'settings.json'),
  JSON.stringify({
    version: 2,
    // completed, so the boot goes straight to the overlay and creates its
    // window — the updater only exists alongside the main app
    onboarding: { schemaVersion: 1, completed: true },
    asr: { backend: 'cloud' },
    update: { autoCheck: false, autoUpdate: true },
  }),
  'utf8',
);

const child = spawn(exePath, [], {
  cwd: dirname(exePath),
  env: {
    ...process.env,
    MC_USERDATA: dir,
    MC_UPDATER_CHECK: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let out = '';
child.stdout.on('data', (b) => (out += b.toString()));
child.stderr.on('data', (b) => (out += b.toString()));

const kill = () => {
  try {
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
};

const fail = (msg) => {
  console.error(`[updater-smoke] FAIL ${msg}`);
  console.error(out.slice(-4000));
  kill();
  process.exit(1);
};

// The manifest request goes out at boot; the answer is what matters. Collect for
// a settle window after the first [updater] line so a slow GitHub round trip
// cannot be mistaken for a hang, and so the verdict below is the terminal one.
const firstUpdaterLine = () => /\[updater\]/.test(out);
const settledAt = { t: 0 };
const deadline = Date.now() + 150_000;

const poll = () => {
  if (/Attempted to register a second handler/.test(out)) fail('a channel is registered twice');
  if (/Cannot find module 'electron-updater'/.test(out)) {
    fail('electron-updater did not load in the packaged app');
  }
  // an unhandled rejection is the shape a duplicate handle() takes at runtime —
  // Electron does not crash, it just breaks that channel silently
  if (/UnhandledPromiseRejection/.test(out)) fail('an unhandled rejection in the packaged app');
  if (firstUpdaterLine() && settledAt.t === 0) settledAt.t = Date.now();
  if (settledAt.t > 0 && Date.now() - settledAt.t > 25_000) {
    const lines = out.split('\n').filter((l) => /\[updater\]/.test(l));
    console.log('[updater-smoke] updater lines:');
    for (const l of lines) console.log('   ', l.trim());
    const terminal = lines.some((l) =>
      /is not available|New update|update for version|Error|not available here/i.test(l),
    );
    if (!terminal) fail('the manifest request never reached a verdict');
    // dist:dir does not write app-update.yml — only the nsis target does
    // (PublishManager.onAfterPack gates on isSuitableWindowsTarget), so an
    // ENOENT here means this smoke ran against the wrong build, not that the
    // feature is broken
    if (/ENOENT.*app-update\.yml/.test(out)) {
      fail('no app-update.yml in this build — run `npm run dist:win`, not dist:dir');
    }
    console.log('[updater-smoke] app stayed up, no duplicate handler, no module failure');
    kill();
    process.exit(0);
  }
  if (Date.now() < deadline) return setTimeout(poll, 500);
  fail('no [updater] line within the deadline');
};
poll();
