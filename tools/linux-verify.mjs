/**
 * Linux functional verification + size/latency measurement.
 *
 * Runs the PACKAGED app (release/linux-unpacked) with a throwaway profile and
 * asserts the markers that prove each Linux-specific capability, because none
 * of them are visible from the window: the display-backend relaunch, global
 * hotkey registration, the tray item, the PipeWire system-audio tap and the XDG
 * autostart entry.
 *
 *   node tools/linux-verify.mjs [--keep-home]
 *
 * Exits non-zero on the first failed check so CI can use it directly.
 */
import { spawn, execFileSync } from 'child_process';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const unpacked = join(root, 'release', 'linux-unpacked');
const binary = join(unpacked, 'meeting-assistant');
const keepHome = process.argv.includes('--keep-home');

const HOME = join(root, '.tmp-verify-home');
const PROFILE = join(HOME, '.config', 'MeetingAssistant');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function du(path) {
  try {
    return Number(
      execFileSync('du', ['-sb', path], { encoding: 'utf8' }).split('\t')[0],
    );
  } catch {
    return 0;
  }
}

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- launch
if (!existsSync(binary)) {
  console.error(`missing ${binary} — run \`npx electron-builder --dir --linux\` first`);
  process.exit(2);
}
if (existsSync(HOME) && !keepHome) rmSync(HOME, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
// onboarding completed → the main window path, plus autostart enabled so the
// XDG entry has to be written
writeFileSync(
  join(PROFILE, 'settings.json'),
  JSON.stringify({
    version: 2,
    onboarding: { schemaVersion: 1, completed: true },
    ui: { autoLaunch: true, lang: 'zh' },
  }),
);

const t0 = Date.now();
const marks = {};
const child = spawn(binary, [], {
  cwd: root,
  detached: true, // its own process group: the app relaunches itself for X11
  env: {
    ...process.env,
    HOME,
    XDG_CONFIG_HOME: join(HOME, '.config'),
    MC_USERDATA: PROFILE,
    MC_DEV_DEFAULT_LOCAL_ASR: '1',
    MC_E2E_LOOPBACK: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
const eat = (chunk) => {
  const text = chunk.toString();
  log += text;
  process.stdout.write(text);
  for (const marker of [
    'linux display backend',
    'relaunching with',
    'hotkeys registered',
    'hotkey registration failed',
    '[tray] created',
    'system-loopback] available',
    'e2e-loopback]',
  ]) {
    if (text.includes(marker) && !(marker in marks)) marks[marker] = Date.now() - t0;
  }
};
child.stdout.on('data', eat);
child.stderr.on('data', eat);

const deadline = setTimeout(() => kill(9), 60_000);
function kill(signal = 15) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}
let finished = false;
// The relaunched instance does the work and this process never sees its exit
// code, so grade on the markers it prints rather than on a status. The
// generation that exits first is only the relaunch parent.
child.on('exit', () => {
  if (log.includes('relaunching with') && !('e2e-loopback]' in marks)) return;
  finishOnce();
});
const waiter = setInterval(() => {
  if ('e2e-loopback]' in marks) {
    clearInterval(waiter);
    setTimeout(finishOnce, 2500);
    kill(15);
  }
}, 200);

function finishOnce() {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  kill(15);
  finish();
}

function finish() {
  clearInterval(waiter);
  console.log('\n================ linux verification ================');

  const relaunches = log.split('\n').filter((l) => l.includes('relaunching with')).length;
  // The relaunch exists only to move a Wayland session onto XWayland. On an X11
  // session (this shell's env decides, not the code) there is nothing to move,
  // so asserting it there would fail for the wrong reason.
  const wayland = process.env.XDG_SESSION_TYPE === 'wayland';
  console.log(`session: XDG_SESSION_TYPE=${process.env.XDG_SESSION_TYPE || 'unset'} DISPLAY=${process.env.DISPLAY || '-'}`);
  if (wayland) {
    record(
      'display backend relaunch (XWayland)',
      relaunches === 1 && /linux display backend: x11 \(--ozone-platform=x11\)/.test(log),
      `${relaunches} relaunch(es)`,
    );
    record(
      'no relaunch loop',
      log.split('\n').filter((l) => l.includes('linux display backend')).length === 2,
    );
  } else {
    console.log(
      `SKIP  display-backend relaunch — not a Wayland session (${relaunches} relaunch(es) seen)\n`,
    );
  }
  record('global hotkeys registered', /\[main\] hotkeys registered/.test(log));
  record('no hotkey failures', !log.includes('hotkey registration failed'));
  record('system tray created', /\[tray\] created/.test(log));
  record(
    'PipeWire tap available',
    /\[system-loopback\] available: pipewire/.test(log),
  );

  const loop = log.match(
    /\[e2e-loopback\] frames=(\d+) samples=(\d+) startToFirstPcmMs=(-?\d+)/,
  );
  const samples = loop ? Number(loop[2]) : 0;
  const firstFrameMs = loop ? Number(loop[3]) : -1;
  record(
    'system audio reaches the ASR host',
    samples > 16000, // more than a second of 16 kHz mono
    loop ? `${loop[1]} frames / ${(samples / 16000).toFixed(2)} s` : 'no PCM',
  );
  record(
    '▶ to first PCM frame under 400 ms',
    firstFrameMs >= 0 && firstFrameMs < 400,
    `${firstFrameMs} ms`,
  );
  const entry = join(HOME, '.config', 'autostart', 'com.lakaka2970.meetingassistant.desktop');
  const entryOk = existsSync(entry);
  record('XDG autostart entry written', entryOk);
  if (entryOk) {
    const text = readFileSync(entry, 'utf8');
    record(
      'autostart entry points at a launchable binary',
      /^Exec="/m.test(text) && !text.includes('node_modules'),
      text.split('\n').find((l) => l.startsWith('Exec='))?.slice(0, 72),
    );
  }

  // ---------------------------------------------------------------- size
  console.log('\n================ package size ================');
  const total = du(unpacked);
  const asar = join(unpacked, 'resources', 'app.asar');
  const unpack = join(unpacked, 'resources', 'app.asar.unpacked');
  const rows = [
    ['linux-unpacked (total)', total],
    ['resources/app.asar', du(asar)],
    ['resources/app.asar.unpacked', du(unpack)],
  ];
  const extras = join(unpacked, 'resources');
  for (const name of ['transformers', 'onnxruntime-node', '@huggingface']) {
    const p = join(unpack, 'node_modules', name);
    if (existsSync(p)) rows.push([`  └ unpacked/${name}`, du(p)]);
  }
  for (const [label, bytes] of rows) {
    console.log(`${label.padEnd(34)} ${mb(bytes).padStart(10)}  ${(bytes / total * 100).toFixed(1)}%`);
  }
  const asarBuf = existsSync(asar) ? readFileSync(asar) : null;
  if (asarBuf) {
    console.log(`app.asar sha size ${asarBuf.length} bytes`);
  }

  // ------------------------------------------------------------- latency
  console.log('\n================ startup latency (ms from spawn) ================');
  for (const [k, v] of Object.entries(marks)) console.log(`${k.padEnd(34)} ${String(v).padStart(7)}`);
  if (firstFrameMs >= 0) {
    console.log(
      `${'tap start → first PCM'.padEnd(34)} ${String(firstFrameMs).padStart(7)} (measured in-app)`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed${
      failed.length ? ` — FAILED: ${failed.map((f) => f.name).join('; ')}` : ''
    }`,
  );
  if (!keepHome && existsSync(HOME)) rmSync(HOME, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}
