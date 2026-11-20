/**
 * Pre-download models for offline use (upgrade P0/P1, China-friendly):
 *   node tools/fetch-models.mjs [dir] [--models bge-m3,moonshine-tiny]
 *
 * Downloads through the mirror (default https://hf-mirror.com, override with
 * --remote-host) straight into <dir> (default ./models — the app's default
 * asr.modelsDir / RAG cacheDir). After this, the app never touches the
 * network for embeddings or the Moonshine fast lane.
 *
 * Uses the same @huggingface/transformers build the app ships (patched), so
 * the cache layout matches the runtime exactly.
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const outDir = resolve(args.find((a) => !a.startsWith('--')) ?? join(process.cwd(), 'models'));
const models = (flag('--models', 'bge-m3') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const remoteHost = flag('--remote-host', 'https://hf-mirror.com');

// same import dance as electron/asr/engine.ts (patched node ESM build)
const dynamicImport = new Function('u', 'return import(u)');

const TARGETS = {
  'bge-m3': { hfId: 'Xenova/bge-m3', kind: 'feature-extraction', dtype: 'q8' },
  'bge-small-zh-v1.5': { hfId: 'Xenova/bge-small-zh-v1.5', kind: 'feature-extraction', dtype: 'q8' },
  'moonshine-tiny': { hfId: 'onnx-community/moonshine-tiny-ONNX', kind: 'automatic-speech-recognition', dtype: 'q8' },
};

if (!existsSync(join(process.cwd(), 'node_modules', '@huggingface', 'transformers'))) {
  console.error('[fetch-models] node_modules missing — run `npm install` first');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
for (const key of models) {
  const t = TARGETS[key];
  if (!t) {
    console.error(`[fetch-models] unknown model "${key}" (known: ${Object.keys(TARGETS).join(', ')})`);
    continue;
  }
  console.log(`[fetch-models] ${key} (${t.hfId}) via ${remoteHost} -> ${outDir}`);
  // same resolution as rag/embedWorker.ts: the patched ESM bundle lives in
  // dist/, and a POSIX absolute path needs pathToFileURL (a hand-built
  // 'file:///' + '/abs/...' yields four slashes and ERR_MODULE_NOT_FOUND)
  const req = createRequire(import.meta.url);
  const cjsPath = req.resolve('@huggingface/transformers');
  const mjsPath = join(dirname(cjsPath), 'transformers.node.mjs');
  const mod = await dynamicImport(
    existsSync(mjsPath) ? pathToFileURL(mjsPath).href : '@huggingface/transformers',
  );
  mod.env.cacheDir = outDir;
  mod.env.allowLocalModels = false;
  mod.env.allowRemoteModels = true;
  mod.env.remoteHost = remoteHost;
  const t0 = Date.now();
  await mod.pipeline(t.kind, t.hfId, {
    dtype: t.dtype,
    progress_callback: (p) => {
      if (p?.status === 'progress' && p.file) {
        const pct = typeof p.progress === 'number' ? ` ${Math.round(p.progress)}%` : '';
        process.stdout.write(`  ${p.file}${pct}\r`);
      }
    },
  });
  console.log(`[fetch-models] ${key} done in ${((Date.now() - t0) / 1000).toFixed(1)}s        `);
}
console.log('[fetch-models] all requested models cached — the app now runs fully offline for them');
