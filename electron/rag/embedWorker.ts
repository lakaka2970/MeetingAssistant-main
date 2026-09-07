/**
 * Embedding worker: runs the local BGE embedder inside an Electron
 * utilityProcess (same rationale as the ASR worker — heavy ONNX inference
 * must not run in the main process), speaking a tiny request/response
 * protocol over postMessage.
 *
 * Model source resolution (offline-first, CN-friendly):
 *   1. a pre-seeded local copy under <modelsDir>/<hfId> — network never touched;
 *   2. otherwise download-on-demand through `remoteHost` (default hf-mirror)
 *      straight into <modelsDir>, so the next boot is fully offline.
 */
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { pathToFileURL } from 'url';
import { getEmbeddingModel, vectorToB64 } from './embedding';

// Same import dance as asr/engine.ts: the bare specifier is a fallback; the
// explicit path guarantees we load the patched node ESM build even though the
// worker bundle is CJS (a rollup-rewritten import() would become require()).
const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;

async function importTransformers(): Promise<any> {
  try {
    const { createRequire } = await import('module');
    const req = createRequire(__filename);
    const cjsPath = req.resolve('@huggingface/transformers');
    const mjsPath = join(join(dirname(cjsPath)), 'transformers.node.mjs');
    if (existsSync(mjsPath)) {
      return await dynamicImport(pathToFileURL(mjsPath).href);
    }
  } catch {
    // fall through to bare import
  }
  return await import('@huggingface/transformers');
}

// ---------- protocol ----------

export type EmbedWorkerIn =
  | {
      type: 'init';
      modelKey: string;
      modelsDir: string;
      /** mirror origin for download-on-demand; '' = default huggingface.co */
      remoteHost?: string;
    }
  | { type: 'embed'; reqId: number; texts: string[] }
  | { type: 'shutdown' };

export type EmbedWorkerOut =
  | { type: 'progress'; stage: 'download'; file?: string; loaded?: number; total?: number; pct?: number }
  | { type: 'ready'; modelKey: string; dim: number; source: 'local' | 'download' }
  | { type: 'embedResult'; reqId: number; vectors: string[]; ms: number }
  | { type: 'error'; reqId?: number; message: string };

function send(msg: EmbedWorkerOut): void {
  (process as unknown as { postMessage: (m: EmbedWorkerOut) => void }).postMessage(msg);
}

let extractor: any = null;
let loadedKey = '';
let loadedDim = 0;

async function load(msg: Extract<EmbedWorkerIn, { type: 'init' }>): Promise<void> {
  const desc = getEmbeddingModel(msg.modelKey);
  const t0 = Date.now();
  const mod = await importTransformers();
  const { pipeline, env } = mod;

  env.cacheDir = msg.modelsDir;
  env.allowLocalModels = true;
  const localDir = join(msg.modelsDir, desc.hfId);
  const haveLocal = existsSync(join(localDir, 'config.json'));
  if (haveLocal) {
    env.allowRemoteModels = false;
  } else {
    env.allowRemoteModels = true;
    if (msg.remoteHost) env.remoteHost = msg.remoteHost;
  }

  const progressCb = (p: { status?: string; file?: string; loaded?: number; total?: number; progress?: number }) => {
    if (p?.status === 'progress') {
      send({
        type: 'progress',
        stage: 'download',
        file: p.file,
        loaded: p.loaded,
        total: p.total,
        pct: p.progress,
      });
    }
  };

  extractor = await pipeline('feature-extraction', haveLocal ? localDir : desc.hfId, {
    dtype: desc.dtype,
    progress_callback: progressCb,
  });
  loadedKey = desc.key;
  loadedDim = desc.dim;
  // a real inference warms lazy kernels so the first embed is not 10x slower
  const warm = await extractor(['预热'], { pooling: desc.pooling, normalize: true });
  void warm;
  console.log(`[embedWorker] ready ${desc.key} dim=${desc.dim} in ${Date.now() - t0}ms (${haveLocal ? 'local' : 'download'})`);
  send({ type: 'ready', modelKey: desc.key, dim: desc.dim, source: haveLocal ? 'local' : 'download' });
}

async function embed(reqId: number, texts: string[]): Promise<void> {
  if (!extractor) {
    send({ type: 'error', reqId, message: 'embed worker not initialized' });
    return;
  }
  const t0 = Date.now();
  try {
    const desc = getEmbeddingModel(loadedKey);
    const out = await extractor(texts, { pooling: desc.pooling, normalize: true });
    const [n, d] = out.dims as [number, number];
    const data = out.data as Float32Array;
    if (n * d !== data.length) throw new Error(`tensor size mismatch: ${n}x${d} vs ${data.length}`);
    const vectors: string[] = [];
    for (let i = 0; i < n; i++) {
      vectors.push(vectorToB64(data.subarray(i * d, (i + 1) * d)));
    }
    send({ type: 'embedResult', reqId, vectors, ms: Date.now() - t0 });
  } catch (e) {
    send({ type: 'error', reqId, message: (e as Error).message });
  }
}

process.on('message', (msg: EmbedWorkerIn) => {
  switch (msg.type) {
    case 'init':
      load(msg).catch((e: Error) => send({ type: 'error', message: `embed init failed: ${e.message}` }));
      break;
    case 'embed':
      void embed(msg.reqId, msg.texts);
      break;
    case 'shutdown':
      process.exit(0);
      break;
  }
});
