/**
 * Moonshine-tiny local engine (upgrade P1): the low-latency English lane.
 * ~30 MB q8 ONNX, sub-300 ms transcribes on desktop CPUs — 2-3x faster than
 * whisper-turbo on short English utterances. English-only by design; Chinese
 * stays on whisper / FunASR (see strategy.ts for the routing rules).
 */
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { pathToFileURL } from 'url';
import type { AsrEngine, TranscribeResult } from './engine';

/** same import dance as engine.ts — patched node ESM build, CJS-safe */
const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;

async function importTransformers(): Promise<any> {
  try {
    const { createRequire } = await import('module');
    const req = createRequire(__filename);
    const cjsPath = req.resolve('@huggingface/transformers');
    const mjsPath = join(dirname(cjsPath), 'transformers.node.mjs');
    if (existsSync(mjsPath)) return await dynamicImport(pathToFileURL(mjsPath).href);
  } catch {
    // fall through
  }
  return await import('@huggingface/transformers');
}

export const MOONSHINE_MODEL_ID = 'onnx-community/moonshine-tiny-ONNX';

export class MoonshineEngine implements AsrEngine {
  private constructor(
    private readonly pipe: any,
    public readonly loadMs: number,
    public warmMs = 0,
  ) {}

  get ep(): string {
    return 'moonshine-cpu';
  }

  get lidAvailable(): boolean {
    return false; // en-only: LID stays whisper's job
  }

  async warmup(): Promise<number> {
    const t0 = Date.now();
    await this.pipe(new Float32Array(4800)).catch(() => undefined);
    this.warmMs = Date.now() - t0;
    return this.warmMs;
  }

  async transcribe(pcm: Float32Array, language: 'auto' | string): Promise<TranscribeResult> {
    const t0 = Date.now();
    // language is deliberately ignored: moonshine-tiny is English-only, and
    // feeding it zh audio is never the intent (strategy.ts gates the routing)
    const out = await this.pipe(pcm);
    const text = (out?.text ?? '').toString().trim();
    return { text, lang: 'english', inferMs: Date.now() - t0 };
  }

  static async load(init: { modelsDir: string; remoteHost?: string }): Promise<MoonshineEngine> {
    const t0 = Date.now();
    const mod = await importTransformers();
    const { pipeline, env } = mod;

    env.cacheDir = init.modelsDir;
    env.allowLocalModels = true;
    const haveLocal = existsSync(join(init.modelsDir, MOONSHINE_MODEL_ID, 'config.json'));
    if (haveLocal) {
      env.allowRemoteModels = false;
    } else {
      // first use on a machine without the model: fetch through the mirror so
      // the very next boot is fully offline
      env.allowRemoteModels = true;
      if (init.remoteHost) env.remoteHost = init.remoteHost;
    }
    const pipe = await pipeline('automatic-speech-recognition', MOONSHINE_MODEL_ID, { dtype: 'q8' });
    return new MoonshineEngine(pipe, Date.now() - t0);
  }
}
