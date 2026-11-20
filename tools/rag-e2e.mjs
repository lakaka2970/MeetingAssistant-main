/**
 * RAG + streaming end-to-end check in a THROWAWAY profile (MC_USERDATA), so a
 * developer's live profile is never touched:
 *   notesSet → embed worker (local bge-m3) → vector index → ragSearch hits,
 *   then a typed question measures first-token latency on the streaming path
 *   even with answerWithVision=true (the text-only answer must not take the
 *   non-streaming vision detour).
 *
 *   node tools/rag-e2e.mjs <userDataDir-with-settings.json>
 *
 * Prints one [rag-e2e] JSON line; RAG_E2E_OK / RAG_E2E_FAIL verdict.
 */
import { spawn, execFile } from 'child_process';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = process.argv[2];
if (!profile) {
  console.error('usage: node tools/rag-e2e.mjs <userDataDir>');
  process.exit(1);
}

const child = spawn(electron, [root, '--no-sandbox'], {
  cwd: root,
  env: {
    ...process.env,
    MC_USERDATA: profile,
    MC_DEV_DEFAULT_LOCAL_ASR: '1',
    MC_RAG_E2E: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let finished = false;
const collect = (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
};
child.stdout.on('data', collect);
child.stderr.on('data', collect);

const stop = () => {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined);
  } else {
    child.kill('SIGTERM');
  }
};

const timeout = setTimeout(() => {
  if (finished) return;
  console.error('RAG_E2E_FAIL: no result within 150s');
  stop();
  process.exitCode = 1;
}, 150_000);

const poll = setInterval(() => {
  const line = output
    .split(/\r?\n/)
    .filter((s) => s.includes('[rag-e2e]'))
    .at(-1);
  if (!line) return;
  finished = true;
  clearTimeout(timeout);
  clearInterval(poll);
  try {
    const r = JSON.parse(line.slice(line.indexOf('[rag-e2e]') + '[rag-e2e]'.length).trim());
    const kbOk = r.rag?.state === 'ready' && r.rag?.chunks > 0 && r.hits?.length > 0;
    const streamOk = r.answer?.ok && r.answer?.firstToken !== null && r.answer?.firstToken < r.answer?.done;
    if (kbOk && streamOk) console.log('RAG_E2E_OK');
    else {
      console.error(`RAG_E2E_FAIL: kbOk=${kbOk} streamOk=${streamOk} ${line}`);
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(`RAG_E2E_FAIL: bad json ${e.message}`);
    process.exitCode = 1;
  }
  stop();
}, 250);

child.on('exit', (code) => {
  if (finished) return;
  clearTimeout(timeout);
  clearInterval(poll);
  console.error(`RAG_E2E_FAIL: app exited early (${code})`);
  process.exitCode = 1;
});