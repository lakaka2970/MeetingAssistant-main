/**
 * Live knowledge-first E2E: seeds an ISOLATED profile (never the user's real
 * userData), writes prepared Q&A in the three grammars a real library uses,
 * then drives the built app with the existing MC_E2E_LLM hook and asserts:
 *
 *   - the knowledge base warms and the notes' Q&A become searchable
 *     (model download + ingest happen in the background at boot),
 *   - a spoken question gets a PREPARED-ANSWER direct hit, surfaced fast,
 *   - the AI enrichment streams under it and keeps the prepared facts,
 *   - the answer pane renders KaTeX (no raw `$…$`, no `**`) — the reported bug,
 *   - nothing reaches the network except the LLM (web search stays off).
 *
 *   node tools/qa-e2e.mjs [--keep]
 */
import { spawn, execFile } from 'child_process';
import { createRequire } from 'module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');

const appData =
  process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const realSettings = join(appData, 'MeetingCopilot', 'settings.json');
// a fresh dir per process: two runs must never share (or rmSync) one profile
const profile = join(tmpdir(), `mc-qa-e2e-${Date.now().toString(36)}-${process.pid}`);

/** the questions under test, with what each one must prove */
const CASES = [
  {
    id: 'table-hit',
    q: 'Kafka 怎么保证消息不丢失',
    rag: true,
    expect: {
      qa: true,
      answerContains: 'acks=all',
      note: 'a 高频考点 → 一句话要点 table row must surface verbatim',
    },
  },
  {
    id: 'formula-hit',
    q: 'sigmoid 函数的公式是什么？',
    rag: true,
    expect: {
      qa: true,
      answerContains: 'e',
      katex: true,
      noRawDollar: true,
      noRawBold: true,
      note: 'the reported bug: a formula answer must typeset, not show markdown',
    },
  },
  {
    // the same question with the knowledge base off: pure render-path check,
    // independent of whether the embedding worker can start on this machine
    id: 'formula-only',
    q: 'sigmoid 函数的公式是什么？',
    rag: false,
    expect: {
      qa: false,
      katex: true,
      noRawDollar: true,
      noRawBold: true,
      note: 'KaTeX + markdown-lite must typeset a formula answer',
    },
  },
];

const NOTES = `# 面试准备（E2E 种子）

问：sigmoid 函数的公式是什么？
答：Sigmoid 的公式是 $ \\sigma(x) = \\frac{1}{1 + e^{-x}} $，输出落在 (0,1) 区间，导数满足 $ \\sigma'(x) = \\sigma(x)(1 - \\sigma(x)) $，所以梯度最大只有 0.25，这也是它容易梯度消失的原因。**常用于二分类的输出层**。

## 速查表

| 高频考点 | 一句话要点 |
|---|---|
| Kafka 如何保证消息不丢失 | 生产端 acks=all 且重试、Broker 端副本数≥3 且 min.insync.replicas=2、消费端关闭自动提交并在处理成功后手动提交位移 |
| 为什么 ReLU 比 Sigmoid 常用 | ReLU 正区间梯度恒为 1，不会像 Sigmoid 那样在两端饱和，收敛更快 |
`;

/**
 * Pre-seed the light embedding model so the app loads it fully offline.
 *
 * Why the seed instead of the app's own download-on-demand: on this machine
 * DNS resolution fails inside Electron's utilityProcess (Winsock
 * `WSALookupServiceBegin … 10108`) while plain Node and the main process
 * resolve fine — so the worker sits in `loading` forever without an error.
 * That is a pre-existing environment issue on the download path, not a RAG
 * behaviour issue, and the worker's documented first branch is a local copy
 * under `<modelsDir>/<hfId>`, which is what this provides.
 */
const MODEL_HF = 'Xenova/bge-small-zh-v1.5';
const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'onnx/model_quantized.onnx',
];
const modelCache = join(tmpdir(), 'mc-qa-e2e-model');

async function seedModel(profileDir) {
  const target = join(profileDir, 'models', MODEL_HF);
  mkdirSync(join(target, 'onnx'), { recursive: true });
  mkdirSync(modelCache, { recursive: true });
  for (const f of MODEL_FILES) {
    const cached = join(modelCache, f);
    if (!existsSync(cached)) {
      mkdirSync(dirname(cached), { recursive: true });
      const url = `https://hf-mirror.com/${MODEL_HF}/resolve/main/${f}`;
      const t0 = Date.now();
      const res = await fetch(url);
      if (!res.ok) throw new Error(`model fetch ${f}: HTTP ${res.status}`);
      writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
      console.log(`  seeded ${f} (${Math.round(res.headers.get('content-length') / 1024)}KB, ${Date.now() - t0}ms)`);
    }
    const dst = join(target, f);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(cached, dst);
  }
}

function seedProfile(ragEnabled) {
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  if (!existsSync(realSettings)) {
    console.error(`qa-e2e: no source profile at ${realSettings} — cannot test the LLM path`);
    process.exit(2);
  }
  // the encrypted API key is only decryptable with the Chromium os_crypt key,
  // which lives in the profile's "Local State" — copy it alongside settings
  for (const f of ['Local State']) {
    const src = join(appData, 'MeetingCopilot', f);
    if (existsSync(src)) copyFileSync(src, join(profile, f));
  }
  const src = JSON.parse(readFileSync(realSettings, 'utf8'));
  const next = {
    ...src,
    onboarding: { ...src.onboarding, schemaVersion: 1, completed: true },
    // local sidecar / cloud ASR are irrelevant here: keep the boot quiet
    asr: { ...src.asr, backend: 'cloud', cloud: {}, localRealtime: { model: 'none' } },
    ui: { ...src.ui, stealth: false, autoLaunch: false, trayNoticeShown: true },
    // the 24 MB light model: a real embedding run without a 620 MB download
    rag: { enabled: ragEnabled, model: 'bge-small-zh-v1.5', topK: 3, minScore: 0.2, remoteHost: 'https://hf-mirror.com' },
    webSearch: { enabled: false, providerId: 'tavily', maxResults: 5 },
  };
  writeFileSync(join(profile, 'settings.json'), JSON.stringify(next, null, 2), 'utf8');
  writeFileSync(join(profile, 'notes.md'), NOTES, 'utf8');
  writeFileSync(join(profile, 'sessions.json'), JSON.stringify({ sessions: [], currentId: null }), 'utf8');
  return { llmKeySet: !!src.llm?.apiKeyEnc };
}

/** one app boot, one question; resolves with the harness JSON line */
function runCase(q) {
  return new Promise((resolveRun) => {
    const child = spawn(electron, [root], {
      cwd: root,
      env: {
        ...process.env,
        MC_USERDATA: profile,
        MC_DEV_DEFAULT_LOCAL_ASR: '1',
        MC_E2E_LLM: q,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let result = null;
    const collect = (chunk) => {
      const text = chunk.toString();
      out += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.includes('[e2e-llm]') && line.includes('{') && !result) {
          try {
            result = JSON.parse(line.slice(line.indexOf('{')));
          } catch {
            /* partial line — the poll below retries from the full buffer */
          }
        }
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const stop = () => {
      if (child.exitCode === null && child.pid) {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined);
        } else {
          child.kill('SIGTERM');
        }
      }
    };
    const deadline = setTimeout(() => {
      stop();
      resolveRun({ result, timedOut: true, log: out });
    }, 300_000);
    const poll = setInterval(() => {
      if (!result) return;
      clearInterval(poll);
      clearTimeout(deadline);
      setTimeout(() => {
        stop();
        resolveRun({ result, log: out });
      }, 500);
    }, 1000);
  });
}

function check(c, r) {
  const fails = [];
  if (!r) return ['no result from the app'];
  if (r.timedOut) fails.push('timed out waiting for the answer');
  const res = r.result ?? {};
  if (!res.ok) fails.push(`answer failed: ${res.error ?? 'no done event'}`);
  if (c.expect.qa && !res.qa) fails.push('no prepared-answer direct hit');
  if (c.expect.qa === false && res.qa) fails.push('unexpected prepared-answer hit with the kb off');
  if (c.expect.answerContains && !(res.qa?.answer || '').includes(c.expect.answerContains)) {
    fails.push(`hit answer lacks 「${c.expect.answerContains}」`);
  }
  const dom = res.dom ?? {};
  if (c.expect.katex && !(dom.katex > 0)) fails.push('answer pane rendered no KaTeX');
  if (c.expect.noRawDollar && dom.rawDollar) fails.push('answer pane still shows raw $…$');
  if (c.expect.noRawBold && dom.md) fails.push('answer pane still shows raw ** markers');
  if (dom.mathErr) fails.push(`KaTeX error markup present (${dom.mathErr})`);
  if (res.ms?.qa != null && res.ms.qa > 5000) fails.push(`prepared answer took ${res.ms.qa}ms`);
  return fails;
}

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('qa-e2e: run `npm run build` first (this drives the built app)');
  process.exit(2);
}
if (!existsSync(realSettings)) {
  console.error(`qa-e2e: no source profile at ${realSettings} — cannot test the LLM path`);
  process.exit(2);
}

let bad = 0;
let ran = 0;
const only = process.argv.indexOf('--case');
const wanted = only > 0 ? process.argv[only + 1] : null;
for (const c of CASES) {
  if (wanted && c.id !== wanted) continue;
  ran++;
  const { llmKeySet } = seedProfile(c.rag);
  await seedModel(profile);
  console.log(`\n=== ${c.id}: 「${c.q}」 — ${c.expect.note} ===`);
  console.log(`  profile: ${profile}${llmKeySet ? '' : '  (NO LLM KEY)'}  rag=${c.rag ? 'on' : 'off'}`);
  const r = await runCase(c.q);
  const res = r.result ?? {};
  console.log(`  question echoed to the model: ${JSON.stringify(res.q)}`);
  console.log(`  kb pairs: ${res.kb?.pairs ?? 0}${res.kb?.exhausted ? ' (poll exhausted)' : ''}${res.kb?.disabled ? ' (kb off)' : ''}`);
  console.log(`  rag: ${JSON.stringify(res.rag)}`);
  if (res.kb?.error) console.log(`  kb error: ${res.kb.error}`);
  console.log(
    `  ms: prepared=${res.ms?.qa ?? '—'} firstToken=${res.ms?.firstToken ?? '—'} done=${res.ms?.done ?? '—'}`,
  );
  console.log(`  hit: ${res.qa ? `${res.qa.exact ? 'literal' : 'semantic'} ${res.qa.score} 「${res.qa.question}」` : 'none'}`);
  console.log(`  dom: ${JSON.stringify(res.dom)}`);
  if (res.dom?.qaText) console.log(`  hit block shows: 「${res.dom.qaText}」`);
  console.log(`  web: ${res.web ? res.web.length : 0} sources`);
  console.log(`  answer: ${(res.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
  const fails = check(c, r);
  for (const f of fails) console.log(`  ✗ ${f}`);
  if (fails.length) {
    bad++;
    // the app's own console is the only place that says WHY the index stayed
    // empty (model download, worker spawn, ingest), so dump its interesting lines
    const lines = (r.log ?? '')
      .split(/\r?\n/)
      .filter((l) => /\[rag\]|\[websearch\]|\[knowledge\]|embed|worker|Error|error|failed|main\]/.test(l));
    console.log('  --- app log ---');
    for (const l of lines.slice(-14)) console.log(`  | ${l.slice(0, 150)}`);
  } else console.log('  ✓ pass');
}

if (!keep) rmSync(profile, { recursive: true, force: true });
console.log(bad ? `\nQA_E2E_FAIL (${bad}/${ran})` : `\nQA_E2E_OK (${ran} case(s))`);
process.exitCode = bad ? 1 : 0;
