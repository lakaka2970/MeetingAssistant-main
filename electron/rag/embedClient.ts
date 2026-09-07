/**
 * Main-process client for the embedding worker (utilityProcess). Promise-based
 * request/response over postMessage, with lazy spawn, serialised embed calls,
 * crash recovery and progress forwarding for the first-run model download.
 */
import { utilityProcess } from 'electron';
import { join } from 'path';
import type { EmbedWorkerIn, EmbedWorkerOut } from './embedWorker';
import { getEmbeddingModel } from './embedding';

export interface EmbedClientEvents {
  onState?(state: EmbedClientState): void;
  onDownloadProgress?(p: { file?: string; pct?: number }): void;
}

export type EmbedClientState = 'idle' | 'loading' | 'ready' | 'error';

export interface EmbedReadyInfo {
  modelKey: string;
  dim: number;
  source: 'local' | 'download';
  loadMs: number;
}

interface Pending {
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EmbedClient {
  private child: Electron.UtilityProcess | null = null;
  private pending = new Map<number, Pending>();
  private reqSeq = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private initPromise: Promise<EmbedReadyInfo> | null = null;
  private initKey = '';

  state: EmbedClientState = 'idle';
  ready: EmbedReadyInfo | null = null;
  lastError = '';

  constructor(private readonly events: EmbedClientEvents = {}) {}

  private setState(s: EmbedClientState): void {
    if (this.state === s) return;
    this.state = s;
    this.events.onState?.(s);
  }

  /**
   * Ensure the worker is up for `modelKey`. Restarting with a different model
   * is supported but the caller must re-index (dimension change).
   */
  ensure(opts: { modelKey: string; modelsDir: string; remoteHost?: string }): Promise<EmbedReadyInfo> {
    if (this.initPromise && this.initKey === opts.modelKey) return this.initPromise;
    if (this.initPromise && this.initKey !== opts.modelKey) {
      void this.dispose();
    }
    this.initKey = opts.modelKey;
    this.setState('loading');
    this.initPromise = new Promise<EmbedReadyInfo>((resolve, reject) => {
      const child = utilityProcess.fork(join(__dirname, 'embedWorker.js'), [], {
        serviceName: 'MeetingAssistant Embeddings',
        stdio: 'pipe',
      });
      this.child = child;
      child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
      child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
      const t0 = Date.now();
      child.on('message', (msg: EmbedWorkerOut) => this.onMessage(msg, resolve, reject, t0));
      child.on('exit', (code) => {
        this.child = null;
        const err = new Error(
          code === 0 ? 'embed worker stopped' : `embed worker exited with code ${code}`,
        );
        this.failAll(err);
        if (this.state !== 'ready') {
          this.lastError = err.message;
          this.setState('error');
          reject(err);
          this.initPromise = null;
        }
      });
      this.post({ type: 'init', modelKey: opts.modelKey, modelsDir: opts.modelsDir, remoteHost: opts.remoteHost });
    });
    return this.initPromise;
  }

  private onMessage(
    msg: EmbedWorkerOut,
    resolveReady: (v: EmbedReadyInfo) => void,
    rejectReady: (e: Error) => void,
    t0: number,
  ): void {
    switch (msg.type) {
      case 'ready': {
        this.ready = { modelKey: msg.modelKey, dim: msg.dim, source: msg.source, loadMs: Date.now() - t0 };
        this.lastError = '';
        this.setState('ready');
        resolveReady(this.ready);
        break;
      }
      case 'embedResult': {
        const p = this.pending.get(msg.reqId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.reqId);
          p.resolve(msg.vectors.map((b64) => new Float32Array(Buffer.from(b64, 'base64').buffer)));
        }
        break;
      }
      case 'error': {
        const err = new Error(msg.message);
        if (msg.reqId !== undefined) {
          const p = this.pending.get(msg.reqId);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(msg.reqId);
            p.reject(err);
          }
        } else {
          // init failure
          this.lastError = msg.message;
          this.setState('error');
          rejectReady(err);
          this.initPromise = null;
        }
        break;
      }
      case 'progress':
        this.events.onDownloadProgress?.({ file: msg.file, pct: msg.pct });
        break;
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private post(msg: EmbedWorkerIn): void {
    this.child?.postMessage(msg);
  }

  /**
   * Embed a batch. Calls are serialised through a promise chain so a burst of
   * ingest work cannot pile up unbounded GPU/CPU queues in the worker.
   */
  embed(texts: string[], timeoutMs = 60_000): Promise<Float32Array[]> {
    if (!texts.length) return Promise.resolve([]);
    if (!this.child || this.state !== 'ready') {
      return Promise.reject(new Error('embed worker not ready'));
    }
    const run = (): Promise<Float32Array[]> =>
      new Promise<Float32Array[]>((resolve, reject) => {
        const reqId = this.reqSeq++;
        const timer = setTimeout(() => {
          this.pending.delete(reqId);
          reject(new Error(`embed timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        this.pending.set(reqId, { resolve, reject, timer });
        this.post({ type: 'embed', reqId, texts });
      });
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  async embedOne(text: string, timeoutMs?: number): Promise<Float32Array> {
    const [v] = await this.embed([text], timeoutMs);
    return v;
  }

  get dim(): number {
    return this.ready?.dim ?? getEmbeddingModel(this.initKey).dim;
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.initPromise = null;
    this.initKey = '';
    this.ready = null;
    this.setState('idle');
    if (!child) return;
    this.failAll(new Error('embed worker disposed'));
    child.postMessage({ type: 'shutdown' } satisfies EmbedWorkerIn);
    const timeout = new Promise<void>((res) => setTimeout(res, 1500));
    const exited = new Promise<void>((res) => child.once('exit', () => res()));
    await Promise.race([exited, timeout]);
    child.kill();
  }
}
