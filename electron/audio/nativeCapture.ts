/**
 * Optional native audio capture (upgrade P1.5): loads the napi-rs artifact
 * (rust/, see rust/README.md) from resources/native and feeds 16 kHz mono f32
 * frames straight into the ASR host — the same wire format the renderer's Web
 * Audio path produces. HARD FALLBACK RULE: a missing/failed .node artifact
 * never breaks capture; callers check `available()` and stay on Web Audio.
 */
import { createRequire } from 'module';
import { existsSync } from 'fs';
import { join } from 'path';

export type NativeCaptureKind = 'loopback' | 'mic';

interface NativeBinding {
  AudioCapture: new () => {
    startLoopback(cb: (err: Error | null, data: Buffer) => void): void;
    startMic(deviceId: string | null, cb: (err: Error | null, data: Buffer) => void): void;
    stop(): void;
    isRunning(): boolean;
  };
}

export interface NativeCaptureOptions {
  /** repo root in dev / process.resourcesPath when packaged */
  resourceRoot: string;
  /** 16 kHz mono f32 frames (~100 ms) */
  onPcm(pcm: Float32Array, captureTs: number): void;
  onError(message: string): void;
}

export class NativeAudioCapture {
  private capture: InstanceType<NonNullable<NativeBinding['AudioCapture']>> | null = null;
  private bindingPath = '';

  constructor(private readonly opts: NativeCaptureOptions) {}

  /** binding artifact resolution — resources/native next to the app */
  private resolveBindingPath(): string {
    if (!this.bindingPath) {
      this.bindingPath = join(this.opts.resourceRoot, 'resources', 'native', 'meeting-copilot-audio.node');
    }
    return this.bindingPath;
  }

  /** false = the artifact is absent (or platform-unsupported) — stay on Web Audio */
  available(): boolean {
    try {
      return existsSync(this.resolveBindingPath());
    } catch {
      return false;
    }
  }

  async start(kind: NativeCaptureKind, deviceId?: string): Promise<void> {
    if (this.capture) return;
    const path = this.resolveBindingPath();
    if (!existsSync(path)) {
      throw new Error('native audio module not built (resources/native missing)');
    }
    // napi .node artifacts are ABI-stable; a plain require is enough and needs
    // no electron-rebuild (that is the point of napi-rs)
    const require = createRequire(__filename);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const binding = require(path) as NativeBinding;
    this.capture = new binding.AudioCapture();
    const callback = (err: Error | null, data: Buffer): void => {
      if (err) {
        this.opts.onError(err.message);
        return;
      }
      const pcm = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
      this.opts.onPcm(pcm, Date.now());
    };
    if (kind === 'loopback') this.capture.startLoopback(callback);
    else this.capture.startMic(deviceId ?? null, callback);
    if (!this.capture.isRunning()) {
      // the napi call spawns a thread; give it a beat, then treat silence as
      // failure so the caller falls back cleanly
      await new Promise((r) => setTimeout(r, 150));
      if (!this.capture?.isRunning()) {
        this.capture = null;
        throw new Error('native capture did not start');
      }
    }
  }

  stop(): void {
    try {
      this.capture?.stop();
    } catch {
      /* already gone */
    }
    this.capture = null;
  }
}
