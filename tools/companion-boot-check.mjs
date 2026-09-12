/**
 * Companion boot smoke: launch the REAL main process with the LAN bridge
 * enabled and prove a phone could load the display page.
 *
 *   npm run smoke:companion
 *
 * Unit tests cover the decisions (auth, framing, pairing); an HTTP-only test
 * covers the transport. Only a real boot covers this file's claims, each of
 * which has bitten similar features:
 *  - CompanionBridge constructs with app.getPath('userData') at the right time;
 *  - apply() is actually reached during startMainApp;
 *  - node-forge generates a usable self-signed cert inside Electron;
 *  - the page and KaTeX resolve from getResourceRoot()/resources/companion and
 *    node_modules — the paths that differ between dev and a packaged asar build.
 *
 * Uses a throwaway profile (MC_USERDATA), so it never touches the real
 * settings, sessions or paired devices.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18799;

const get = (url) =>
  new Promise((res, rej) => {
    const r = request(url, { rejectUnauthorized: false, timeout: 4000 }, (response) => {
      let body = '';
      response.on('data', (c) => (body += c));
      response.on('end', () => res({ status: response.statusCode, body }));
    });
    r.on('error', rej);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.end();
  });

const dir = mkdtempSync(join(tmpdir(), 'mc-smoke-'));
writeFileSync(
  join(dir, 'settings.json'),
  JSON.stringify({
    version: 2,
    // completed: startMainApp owns the bridge, and it is the only caller of
    // apply() — the first-run wizard would never bind a port
    onboarding: { schemaVersion: 1, completed: true },
    companion: { enabled: true, useHttps: true, port: PORT },
  }),
  'utf8',
);

const child = spawn(electronBin, [root], {
  cwd: root,
  env: { ...process.env, MC_USERDATA: dir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (c) => (out += c));
child.stderr.on('data', (c) => (out += c));
let exited = false;
child.on('exit', () => (exited = true));

const finish = (label, detail) => {
  console.log(detail ?? '');
  console.log(label);
  // SIGTERM does not reliably stop a GUI Electron on Windows — the child and
  // its helper processes keep running and hold the single-instance lock, which
  // then makes the developer's own next start.bat appear to do nothing. Ask the
  // OS to tear down the whole tree instead.
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } catch {
      /* best effort */
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
  setTimeout(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows may still hold a file */
    }
    process.exit(label === 'COMPANION_SMOKE_OK' ? 0 : 1);
  }, 500);
};

const deadline = Date.now() + 90_000;
let page = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  if (exited) {
    // NOT child.connected — piped stdio leaves that false from the first tick
    break;
  }
  try {
    page = await get(`https://127.0.0.1:${PORT}/`);
    if (page.status === 200) break;
    page = null;
  } catch {
    continue;
  }
}

if (!page) {
  finish('COMPANION_SMOKE_FAIL', `--- electron output ---\n${out}`);
} else {
  const [appJs, mdJs, crt, katex] = await Promise.all([
    get(`https://127.0.0.1:${PORT}/app.js`),
    get(`https://127.0.0.1:${PORT}/markdown.js`),
    get(`https://127.0.0.1:${PORT}/server.crt`),
    get(`https://127.0.0.1:${PORT}/vendor/katex/katex.min.js`),
  ]);
  const checks = {
    page: page.body.includes('id="hero"'),
    appJs: appJs.status === 200 && appJs.body.includes('renderMarkdown'),
    markdownJs: mdJs.status === 200,
    certDownload: crt.status === 200 && crt.body.includes('BEGIN CERTIFICATE'),
    katex: katex.status === 200,
    boundLog: new RegExp(`\\[companion\\] 已监听 :${PORT}`).test(out),
  };
  const ok = Object.values(checks).every(Boolean);
  finish(ok ? 'COMPANION_SMOKE_OK' : 'COMPANION_SMOKE_FAIL', JSON.stringify(checks, null, 1));
}
