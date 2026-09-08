/**
 * Diagnostic probe (not part of the app): fork the BUILT embed worker through
 * the same Electron utilityProcess path the app uses, point it at a
 * pre-seeded local model, and print every message/stdout line with timestamps.
 * Purpose: localise why `ragStatus.state` stays `loading` with no error.
 *
 *   npx electron tools/embed-probe.cjs <modelsDir> [modelKey]
 */
const { app, utilityProcess } = require('electron');
const { join } = require('path');
const { existsSync } = require('fs');

const modelsDir = process.argv[2];
const modelKey = process.argv[3] ?? 'bge-small-zh-v1.5';
const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

app.whenReady().then(() => {
  const worker = join(__dirname, '..', 'out', 'main', 'embedWorker.js');
  log('worker exists:', existsSync(worker), worker);
  log('model exists:', existsSync(join(modelsDir, 'Xenova', 'bge-small-zh-v1.5', 'config.json')));
  const child = utilityProcess.fork(worker, [], { serviceName: 'probe', stdio: 'pipe' });
  child.stdout?.on('data', (d) => log('[worker stdout]', d.toString().trim()));
  child.stderr?.on('data', (d) => log('[worker stderr]', d.toString().trim()));
  child.on('message', (m) => log('[worker msg]', JSON.stringify(m).slice(0, 240)));
  child.on('exit', (code) => log('[worker exit] code=', code));
  child.on('error', (e) => log('[worker error]', e?.message));
  child.postMessage({
    type: 'init',
    modelKey,
    modelsDir,
    remoteHost: 'https://hf-mirror.com',
  });
  log('init posted');
  // a hard stop so the probe always returns something
  setTimeout(() => {
    log('giving up after 120s of silence');
    try {
      child.kill();
    } catch {}
    app.exit(0);
  }, 120_000);
});
