/**
 * Main-process client for the embedding worker (utilityProcess). Promise-based
 * request/response over postMessage, with lazy spawn, serialised embed calls,
 * crash recovery and progress forwarding for the first-run model download.
 */
import { utilityProcess } from 'electron';
import { join } from 'path';
import type { EmbedWorkerIn, EmbedWorkerOut } from './embedWorker';
import { getEmbeddingModel, vectorFromB64 } from './embedding';

export interface EmbedClientEvents {
  onState?(state: EmbedClientState): void;
  onDownloadProgress?(p: { file?: string; pct?: number }): void;
}

export type EmbedClientState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * How long the worker may stay completely silent after `init` before the client
 * gives up: long enough for a cold ONNX session on a slow CPU, short enough
 * that a stuck knowledge base reports itself instead of spinning at `loading`.
 */
export const INIT_SILENCE_TIMEOUT_MS = 90_000;

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
  /**
   * Watchdog for a worker that starts but never answers. Without it an ONNX
   * session that stalls in the utilityProcess (seen on Windows: the child gets
   * `init`, then emits nothing at all) leaves the knowledge base stuck at
   * `loading` forever — silently, with no way for the UI or the answer path to
   * know the retrieval layer is dead. Reset on every download-progress event so
   * a slow first fetch of a 600 MB model is never cut off; only true silence
   * fails.
   */
  private initWatchdog: ReturnType<typeof setTimeout> | null = null;
  /**
   * Reject hook for the init currently in flight. A model switch disposes the
   * old worker and forks a new one; without this the superseded ensure()
   * promise would settle (or never settle) through whoever disposes, not the
   * exit event of a process that no longer owns the client.
   */
  private rejectInit: ((e: Error) => void) | null = null;

  state: EmbedClientState = 'idle';
  ready: EmbedReadyInfo | null = null;
  lastError = '';

  constructor(private readonly events: EmbedClientEvents = {}) {}

  private setState(s: EmbedClientState): void {
    if (s !== 'loading') this.clearWatchdog();
    if (this.state === s) return;
    this.state = s;
    this.events.onState?.(s);
  }

  private clearWatchdog(): void {
    if (this.initWatchdog) clearTimeout(this.initWatchdog);
    this.initWatchdog = null;
  }

  private armWatchdog(child: Electron.UtilityProcess, reject: (e: Error) => void): void {
    this.clearWatchdog();
    this.initWatchdog = setTimeout(() => {
      this.initWatchdog = null;
      const err = new Error(
        `embed worker silent for ${INIT_SILENCE_TIMEOUT_MS / 1000}s (model load or download stalled)`,
      );
      this.lastError = err.message;
      this.setState('error');
      this.failAll(err);
      this.initPromise = null;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      reject(err);
    }, INIT_SILENCE_TIMEOUT_MS);
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
      this.rejectInit = reject;
      child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
      child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
      const t0 = Date.now();
      child.on('message', (msg: EmbedWorkerOut) =>
        this.onMessage(msg, resolve, reject, t0, child),
      );
      child.on('exit', (code) => {
        // a worker that was already replaced (model switch → dispose → fork)
        // must not sabotage the one now in charge
        if (this.child !== child) return;
        this.child = null;
        this.clearWatchdog();
        const err = new Error(
          code === 0 ? 'embed worker stopped' : `embed worker exited with code ${code}`,
        );
        this.failAll(err);
        if (this.state !== 'ready') {
          this.lastError = err.message;
          this.setState('error');
          this.rejectInit = null;
          reject(err);
          this.initPromise = null;
        }
      });
      this.post({ type: 'init', modelKey: opts.modelKey, modelsDir: opts.modelsDir, remoteHost: opts.remoteHost });
      this.armWatchdog(child, reject);
    });
    return this.initPromise;
  }

  private onMessage(
    msg: EmbedWorkerOut,
    resolveReady: (v: EmbedReadyInfo) => void,
    rejectReady: (e: Error) => void,
    t0: number,
    child: Electron.UtilityProcess,
  ): void {
    // late messages from a superseded worker are not for this client anymore
    if (this.child !== child) return;
    switch (msg.type) {
      case 'ready': {
        this.ready = { modelKey: msg.modelKey, dim: msg.dim, source: msg.source, loadMs: Date.now() - t0 };
        this.lastError = '';
        this.rejectInit = null;
        this.setState('ready');
        resolveReady(this.ready);
        break;
      }
      case 'embedResult': {
        const p = this.pending.get(msg.reqId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.reqId);
          p.resolve(msg.vectors.map(vectorFromB64));
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
        // bytes moving = the worker is alive; restart the silence window
        this.armWatchdog(child, rejectReady);
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
    // the replaced child's exit handler now early-returns, so whoever waits on
    // this init must be released here instead
    this.rejectInit?.(new Error('embed worker disposed'));
    this.rejectInit = null;
    child.postMessage({ type: 'shutdown' } satisfies EmbedWorkerIn);
    const timeout = new Promise<void>((res) => setTimeout(res, 1500));
    const exited = new Promise<void>((res) => child.once('exit', () => res()));
    await Promise.race([exited, timeout]);
    child.kill();
  }
}
