/**
 * Reproduce the v1.0.3 stealth black slab against the REAL app.
 *
 *   npm run build && node tools/stealth-app-probe.mjs
 *
 * tools/stealth-wda-probe.cjs proved a hand-built transparent, protected window
 * stays excluded across hide/show, so whatever a share actually receives has to
 * come out of the app's own window. This drives the running app the way the
 * title-bar minus button does (Win32 ShowWindow SW_HIDE / SW_SHOW) and reads,
 * at every step:
 *
 *   - Win32's GetWindowDisplayAffinity for every top-level window it owns
 *     (0 = WDA_NONE, 1 = WDA_MONITOR, 17 = WDA_EXCLUDEFROMCAPTURE = 隐身 on)
 *   - what GDI BitBlt of the window centre returns   (legacy capture path)
 *   - what the OS screen-capture API returns there   (share/recording path)
 *
 * Two phases, so a run cannot quietly measure nothing:
 *
 *   CONTROL  settings ui.stealth=false  -> the panel MUST be visible in both
 *            capture paths. If this phase does not show the panel, the probe is
 *            blind and the second phase proves nothing.
 *   REPORTED settings ui.stealth=true   -> the healthy answer is the desktop
 *            baseline (same rgb as after the app is killed), before and after
 *            the hide/show round trip. 0,0,0 while the baseline is not 0,0,0 is
 *            the reported black slab.
 *
 * Uses throwaway profiles (MC_USERDATA); never touches the real settings.
 * On screen: the overlay opens, disappears and returns, twice.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ps1 = join(root, 'tools', 'stealth-winstate.ps1');
const probe = join(root, 'tools', 'stealth-wda-probe.cjs');

const MAIN_RE = /MAIN hwnd=(\d+) rect=(-?\d+),(-?\d+),(\d+)x(\d+) visible=\w+ affinity=(\d+)/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = (label, text) => console.log(`  ${label.padEnd(32)} ${text}`);

const winstate = (args) =>
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args], {
    encoding: 'utf8',
  });

/** one screen point (physical px) through both capture paths, via a throwaway Electron */
function captureSample(x, y) {
  const out = execFileSync(electronBin, [probe, '--sample', '--point', `${x},${y}`], {
    encoding: 'utf8',
    cwd: root,
    timeout: 90_000,
  });
  const m = out.match(/SAMPLE ([\s\S]*)/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : 'NO-SAMPLE';
}

const killTree = (pid) => {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
};

async function runPhase({ tag, stealth }) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-stealth-'));
  const log = join(dir, 'app.log');
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      version: 2,
      onboarding: { schemaVersion: 1, completed: true },
      asr: { backend: 'cloud' }, // no python sidecar, no microphone, nothing to wait for
      ui: { stealth, panelAlpha: 1, theme: 'light' },
    }),
    'utf8',
  );
  console.log(`\n=== ${tag} (profile ${dir}) ===`);
  const child = spawn(electronBin, [root], {
    cwd: root,
    env: { ...process.env, MC_USERDATA: dir },
    stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')],
  });
  let centre = null;
  try {
    const until = Date.now() + 90_000;
    let state = null;
    while (Date.now() < until) {
      const s = winstate(['-ProcId', String(child.pid)]);
      if (MAIN_RE.test(s)) {
        state = s;
        break;
      }
      await wait(500);
    }
    if (!state) {
      console.log(`[probe] no window appeared; log tail:\n${readFileSync(log, 'utf8').slice(-2500)}`);
      return;
    }
    await wait(3500); // let the panel paint
    state = winstate(['-ProcId', String(child.pid)]);
    console.log(state.trimEnd());
    const m = state.match(MAIN_RE);
    const hwnd = m[1];
    centre = { x: Number(m[2]) + Math.round(Number(m[4]) / 2), y: Number(m[3]) + Math.round(Number(m[5]) / 2) };
    report('first show', `affinity=${m[6]} ${captureSample(centre.x, centre.y)}`);

    for (const n of [1, 2]) {
      console.log('  ' + winstate(['-ProcId', String(child.pid), '-Action', 'hide', '-Hwnd', hwnd]).trim());
      await wait(1000);
      report(`round ${n} hidden`, winstate(['-ProcId', String(child.pid)]).match(/MAINWINDOW[^\n]*/)?.[0] ?? 'listed');
      console.log('  ' + winstate(['-ProcId', String(child.pid), '-Action', 'show', '-Hwnd', hwnd]).trim());
      await wait(1800);
      const s2 = winstate(['-ProcId', String(child.pid)]).match(MAIN_RE);
      if (!s2) {
        report(`round ${n} shown`, 'no MAIN line');
        continue;
      }
      const c2 = { x: Number(s2[2]) + Math.round(Number(s2[4]) / 2), y: Number(s2[3]) + Math.round(Number(s2[5]) / 2) };
      report(`round ${n} shown`, `affinity=${s2[6]} ${captureSample(c2.x, c2.y)}`);
    }
    // Frame-resolution view: a slab that only exists for the frames around the
    // transition is invisible to a sample taken 1.8 s later, so film the whole
    // hide/show cycle through GDI and collapse identical runs.
    const film = winstate([
      '-ProcId', String(child.pid), '-Action', 'film', '-Hwnd', hwnd,
      '-Ms', '7000', '-HideAt', '1800', '-ShowAt', '4200', '-Fps', '30',
    ]);
    const runs = [];
    for (const line of film.split(/\r?\n/)) {
      const f = line.match(/^FRAME (\d+) vis=(\S+) aff=(\d+) alive=(\S+) px=(\S+)$/);
      if (f) {
        const k = `vis=${f[2]} aff=${f[3]} alive=${f[4]} px=${f[5]}`;
        const last = runs[runs.length - 1];
        if (last && last.k === k) last.n += 1;
        else runs.push({ k, t: Number(f[1]), n: 1 });
      } else if (line.startsWith('EVENT')) {
        console.log(`  ${line.trim()}`);
      }
    }
    for (const r of runs) report(`t>=${r.t}ms`, `${r.k}  (${r.n} frames)`);
    await wait(800);

    const appLog = readFileSync(log, 'utf8');
    report(
      'app own events',
      `${appLog.split('[window] hidden').length - 1} hidden / ${appLog.split('[window] shown').length - 1} shown logged by Electron itself`,
    );
  } finally {
    killTree(child.pid);
    await wait(1500);
    if (centre) {
      report('BASELINE app killed, same px', captureSample(centre.x, centre.y));
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const phases = [
  { tag: 'CONTROL  stealth OFF (panel must be visible)', stealth: false },
  { tag: 'REPORTED stealth ON  (window must be excluded)', stealth: true },
];
for (const phase of process.argv.includes('--only-reported') ? phases.slice(1) : phases) {
  await runPhase(phase);
}

console.log(
  '\n[probe] compare the rgb triples: equal to the BASELINE line = excluded (stealth correct); 0,0,0 with a non-black baseline = the reported slab; a light grey = the panel is visible.',
);
