/**
 * Linux system-audio loopback (the counterpart of the Windows WASAPI module).
 *
 * Electron's `audio: 'loopback'` display-media token is Windows-only, and
 * Chromium on Linux refuses to list a sink monitor as a `getUserMedia` device
 * (measured: enumerateDevices returns only the physical mic). PipeWire does
 * however expose every sink's monitor ports, and `pw-record --target <sink>`
 * records from them while resampling on the way in — so one child process
 * yields exactly the 16 kHz mono f32 stream the ASR host already expects, with
 * no change to the user's routing and no effect on what they hear.
 *
 * HARD FALLBACK RULE (same contract as NativeAudioCapture): `available()`
 * false means the renderer keeps its current Web Audio path; a missing
 * pipewire-utils install must never break capture.
 */
import { spawn, type ChildProcessByStdio } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import type { Readable } from 'stream';
import type { LoopbackSink } from '../../shared/protocol';

/** pw-record with stdin ignored, stdout+stderr piped */
type CaptureChild = ChildProcessByStdio<null, Readable, Readable>;
/** pw-dump / wpctl with only stdout piped */
type QueryChild = ChildProcessByStdio<null, Readable, null>;

/** 16 kHz mono float32 — the ASR wire format, requested from PipeWire directly */
export const LOOPBACK_SAMPLE_RATE = 16000;

/**
 * Samples discarded outright at the start of a capture: one frame (64 ms) of a
 * freshly linked monitor is whatever the sink's ring buffer happened to hold.
 */
export const LOOPBACK_MIN_SETTLE_SAMPLES = 1024;

/**
 * How long out-of-range frames are rejected after capture starts. The stale
 * leading frames are not silence but garbage — measured on PipeWire 1.0.5 at
 * |peak| 1.09, above full scale, which the VAD reads as someone shouting the
 * instant ▶ is pressed. Filtering by value rather than by a fixed 500 ms window
 * lets audio that is genuinely in range reach the ASR host ~440 ms earlier.
 */
export const LOOPBACK_JUNK_WINDOW_SAMPLES = LOOPBACK_SAMPLE_RATE;

/** true when a frame cannot be real audio: non-finite, or over full scale */
export function isStaleFrame(pcm: Float32Array): boolean {
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i];
    if (!Number.isFinite(v) || v > 1 || v < -1) return true;
  }
  return false;
}

/**
 * Apply the settling rule across frames, carrying how many samples have been
 * seen (dropped AND accepted) so the junk window closes on its own.
 */
export function trimSettlingFrames(
  pcm: Float32Array,
  seen: number,
): { out: Float32Array; seen: number } {
  if (seen >= LOOPBACK_JUNK_WINDOW_SAMPLES) return { out: pcm, seen };
  const next = seen + pcm.length;
  if (seen < LOOPBACK_MIN_SETTLE_SAMPLES || isStaleFrame(pcm)) {
    return { out: pcm.subarray(0, 0), seen: next };
  }
  return { out: pcm, seen: next };
}

/** node.name prefix for the capture stream — pid-suffixed so a stale instance
 * from a crashed run can never be mistaken for the current one */
export const LOOPBACK_NODE_PREFIX = 'ma-loop-';

interface PwDumpObject {
  id?: number | string;
  info?: {
    props?: Record<string, unknown>;
  };
}

/**
 * Split a `pw-dump` stream into the objects of every top-level JSON document it
 * contains. pw-dump 1.0.5 really does print more than one array (measured: the
 * graph, then a second `[{…}]` for an object that registered while it was
 * dumping), so a single JSON.parse over the whole stdout throws and the app
 * would report "no audio output to capture" on a machine with a working sound
 * card.
 */
export function parseJsonDocuments(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text.slice(start, i + 1));
        } catch {
          parsed = null;
        }
        if (Array.isArray(parsed)) objects.push(...(parsed as Record<string, unknown>[]));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return objects;
}

/**
 * Pull the recordable sinks out of a `pw-dump` document. Pure so the
 * parser is testable without a running PipeWire.
 */
export function parsePwDumpSinks(stdout: string): LoopbackSink[] {
  const sinks: LoopbackSink[] = [];
  for (const item of parseJsonDocuments(stdout) as PwDumpObject[]) {
    const props = item?.info?.props ?? {};
    if (props['media.class'] !== 'Audio/Sink') continue;
    const name = typeof props['node.name'] === 'string' ? props['node.name'] : '';
    if (!name) continue;
    const description =
      (typeof props['node.description'] === 'string' && props['node.description']) ||
      (typeof props['node.nick'] === 'string' && props['node.nick']) ||
      name;
    sinks.push({ id: String(item.id ?? ''), name, description: String(description) });
  }
  return sinks;
}

/**
 * `wpctl status -n` prints one section per object class; the default sink is
 * the row starred inside `Sinks:`, e.g.
 *   `│  *   56. alsa_output.pci-0000_65_00.6.analog-stereo [vol: 0.40]`
 * PipeWire's own `default.audio.sink` metadata cannot be used here: WirePlumber
 * 0.5 keeps that choice to itself and leaves the key unset.
 */
export function parseWpctlDefaultSink(stdout: string): { id: string; name: string } | null {
  let inSinks = false;
  for (const line of stdout.split('\n')) {
    if (/^\s*[├└]?─?\s*Sinks:/.test(line) || /^\s*Sinks:/.test(line)) {
      inSinks = true;
      continue;
    }
    if (inSinks && /Sources:|Endpoints:|Devices:/.test(line)) break;
    if (!inSinks) continue;
    const starred = line.match(/\*\s+(\d+)\.\s+(\S+)/);
    if (starred?.[1] && starred[2]) return { id: starred[1], name: starred[2].replace(/\[.*$/, '') };
  }
  return null;
}

/**
 * argv for the capture child. `--target` is mandatory for loopback: without it
 * pw-record captures the *default source*, which is the microphone. It is not
 * sufficient either — WirePlumber 0.5 still links the stream to alsa_input…
 * (measured: target.object names the sink, the link does not), so start()
 * rewires the ports afterwards and `node.name` gives that search something
 * stable to match against.
 */
export function pwRecordArgs(target: string, nodeName: string): string[] {
  return [
    '--target',
    target,
    '--rate',
    String(LOOPBACK_SAMPLE_RATE),
    '--channels',
    '1',
    '--format',
    'f32',
    '--properties',
    `node.name=${nodeName}`,
    // `-` streams the samples to stdout instead of leaving a half-written .wav
    // behind when the child is killed
    '-',
  ];
}

/** one established PipeWire port link, in canonical direction */
export interface LinkPair {
  output: string;
  input: string;
}

/**
 * `pw-link --links` prints every link twice, once from each end:
 *     <port>
 *       |-> <other>        this side is the output
 *       |<- <other>        this side is the input
 */
export function parseLinkPairs(text: string): LinkPair[] {
  const lines = text.split('\n');
  const pairs: LinkPair[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 1 < lines.length; i++) {
    const left = lines[i].trim();
    const rel = lines[i + 1].trim();
    if (!left || !rel) continue;
    const fwd = rel.match(/^\|->\s+(.+)$/);
    const back = rel.match(/^\|<-\s+(.+)$/);
    const pair: LinkPair | null = fwd
      ? { output: left, input: fwd[1].trim() }
      : back
        ? { output: back[1].trim(), input: left }
        : null;
    if (!pair) continue;
    const key = `${pair.output}>${pair.input}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(pair);
    i++;
  }
  return pairs;
}

/** every port belonging to `nodeName` in a `pw-link -i` / `-o` listing */
export function portsOf(text: string, nodeName: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`${nodeName}:`));
}

/** `…:monitor_FL` → `FL`; pairs a monitor channel with the matching input */
export function channelOf(port: string): string {
  return port.match(/_[A-Z0-9]+$/)?.[0].slice(1) ?? '';
}

export interface RewirePlan {
  disconnect: LinkPair[];
  connect: LinkPair[];
  /** our input ports the sink offered no monitor channel for */
  unmatched: string[];
}

/**
 * Move the capture stream off the microphone and onto the sink monitor.
 * `pw-link --disconnect` refuses a lone port (measured: "failed to unlink
 * ports"), so the plan names both ends of everything it tears down.
 */
export function planMonitorRewire(
  ourPorts: string[],
  links: LinkPair[],
  monitorPorts: string[],
): RewirePlan {
  const disconnect: LinkPair[] = [];
  const connect: LinkPair[] = [];
  const unmatched: string[] = [];
  for (const port of ourPorts) {
    const channel = channelOf(port);
    const monitor =
      monitorPorts.find((m) => channelOf(m) === channel) ??
      (monitorPorts.length === 1 ? monitorPorts[0] : undefined);
    if (!monitor) {
      unmatched.push(port);
      continue;
    }
    const into = links.filter((l) => l.input === port);
    // an already-correct monitor link must survive: tearing it down with
    // nothing to re-establish it would leave the port silent
    disconnect.push(...into.filter((l) => l.output !== monitor));
    if (!into.some((l) => l.output === monitor)) {
      connect.push({ output: monitor, input: port });
    }
  }
  return { disconnect, connect, unmatched };
}

/** true when every one of our ports is fed by a monitor port of this sink */
export function isTappedAt(ourPorts: string[], links: LinkPair[], sinkName: string): boolean {
  if (ourPorts.length === 0) return false;
  return ourPorts.every((port) =>
    links.some((l) => l.input === port && l.output.startsWith(`${sinkName}:monitor_`)),
  );
}

/**
 * The sink to tap: an explicit user pick wins, then PipeWire's own default,
 * then the only sink there is. Nothing left = no loopback (caller degrades).
 */
export function pickLoopbackSink(
  sinks: LoopbackSink[],
  preferredName?: string,
  defaultId?: string | null,
): LoopbackSink | null {
  if (sinks.length === 0) return null;
  if (preferredName) {
    const picked = sinks.find((s) => s.name === preferredName || s.id === preferredName);
    if (picked) return picked;
  }
  if (defaultId) {
    const byId = sinks.find((s) => s.id === defaultId);
    if (byId) return byId;
  }
  return sinks.length === 1 ? sinks[0] : null;
}

/**
 * Turn the child's stdout into 16 kHz mono Float32 frames.
 *
 * Measured on PipeWire 1.0.5: `pw-record … f32 -` writes **bare samples**, no
 * RIFF header. A file-backed reader (or any future version that containerizes
 * the stream) would prefix one, so the magic is checked rather than assumed —
 * and a header that straddles two reads must not cost the caller any samples.
 */
const MAX_HEADER_BYTES = 64 * 1024;

export class F32StreamDecoder {
  private pending = Buffer.alloc(0);
  private headerResolved = false;

  /** true once the stream is known to be payload rather than header bytes */
  get started(): boolean {
    return this.headerResolved;
  }

  push(chunk: Buffer): Float32Array | null {
    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    let payloadStart = 0;

    if (!this.headerResolved) {
      // 'RIFF' at offset 0 is the only way to tell a container from bare
      // samples, and four bytes is enough to rule it out — waiting on 12 would
      // stall a short live stream for no reason
      if (buf.length < 4) {
        this.pending = buf;
        return null;
      }
      const isWav =
        buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
        (buf.length < 12 || buf.subarray(8, 12).toString('ascii') === 'WAVE');
      if (isWav) {
        if (buf.length < 12) {
          this.pending = buf;
          return null;
        }
        const offset = findDataOffset(buf);
        if (offset === null) {
          if (buf.length >= MAX_HEADER_BYTES) {
            // never a RIFF stream we can finish parsing — read it as samples
            this.headerResolved = true;
          } else {
            this.pending = buf;
            return null;
          }
        } else {
          this.headerResolved = true;
          payloadStart = offset;
        }
      } else {
        this.headerResolved = true;
      }
    }

    const payload = buf.subarray(payloadStart);
    const usable = payload.length - (payload.length % 4);
    if (payload.length > usable) this.pending = Buffer.from(payload.subarray(usable));
    if (usable === 0) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, usable);
    const out = new Float32Array(usable / 4);
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }
}

function tag(view: DataView, off: number): string {
  return String.fromCharCode(
    view.getUint8(off),
    view.getUint8(off + 1),
    view.getUint8(off + 2),
    view.getUint8(off + 3),
  );
}

/** Byte offset of the data chunk body, or null while the header is incomplete. */
function findDataOffset(bytes: Buffer): number | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 12;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(view, off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'data') {
      // a streamed writer declares 0xFFFFFFFF (size still unknown) — the body
      // begins right here either way
      return body;
    }
    const next = body + size + (size % 2);
    if (next <= off) return null;
    off = next;
  }
  return null;
}

export interface LinuxLoopbackOptions {
  /** 16 kHz mono f32 frames */
  onPcm(pcm: Float32Array, captureTs: number): void;
  onError(message: string): void;
  /** override for tests / non-standard installs */
  pwRecordPath?: string;
}

export class LinuxLoopbackCapture {
  private child: CaptureChild | null = null;
  private decoder = new F32StreamDecoder();
  private stopping = false;

  constructor(private readonly opts: LinuxLoopbackOptions) {}

  /** pipewire-utils present and a PipeWire daemon reachable */
  available(): boolean {
    return !!this.resolvePwRecord() && pipeWireSocketPresent();
  }

  private resolvePwRecord(): string | null {
    if (this.opts.pwRecordPath) return this.opts.pwRecordPath;
    const dirs = (process.env.PATH ?? '').split(':');
    for (const dir of dirs) {
      if (!dir) continue;
      const candidate = join(dir, 'pw-record');
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /**
   * @param sinkName PipeWire node.name chosen in Settings; empty = the current
   * default sink, resolved here because pw-record's own default is the mic.
   */
  async start(sinkName = ''): Promise<void> {
    if (this.child) return;
    const bin = this.resolvePwRecord();
    if (!bin) throw new Error('pw-record not found — install pipewire-utils');
    let target = sinkName;
    if (!target) {
      const { sinks, defaultSink } = await listLinuxLoopbackSinks();
      const picked = pickLoopbackSink(sinks, undefined, defaultSink?.id ?? null);
      if (!picked) throw new Error('没有可捕获的系统音频输出设备');
      target = picked.name;
    }
    this.decoder = new F32StreamDecoder();
    this.stopping = false;
    let settleSeen = 0;
    const nodeName = `${LOOPBACK_NODE_PREFIX}${process.pid}`;
    const child = spawn(bin, pwRecordArgs(target, nodeName), { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', (buf: Buffer) => {
      const decoded = this.decoder.push(buf);
      if (!decoded || !decoded.length) return;
      const trimmed = trimSettlingFrames(decoded, settleSeen);
      settleSeen = trimmed.seen;
      if (trimmed.out.length) this.opts.onPcm(trimmed.out, Date.now());
    });
    let stderrTail = '';
    child.stderr.on('data', (buf: Buffer) => {
      stderrTail = (stderrTail + buf.toString('utf8')).slice(-400);
    });
    child.on('error', (e) => {
      this.child = null;
      this.opts.onError(e.message);
    });
    child.on('close', (code) => {
      const wasStopping = this.stopping;
      this.child = null;
      if (wasStopping || code === 0) return;
      const detail = stderrTail.trim() || `exit code ${code}`;
      this.opts.onError(`pw-record stopped: ${detail}`);
    });
    // A child that dies immediately (bad target) surfaces through the port poll
    // below — no fixed sleep here, that wait was part of what made ▶ slow.
    try {
      await this.rewireToMonitor(nodeName, target);
    } catch (e) {
      // leaving it up would silently transcribe the microphone as if it were
      // the remote party, which is worse than no capture at all
      this.stop();
      throw e;
    }
  }

  /**
   * Pull the stream from the microphone onto the sink's monitor ports and
   * refuse to report success unless the graph really ends up there.
   *
   * Every step is a separate CLI round-trip to the daemon, so the ordering is
   * what costs time (measured 405 ms for start()): the graph reads run
   * concurrently, the disconnects and the connects are fired in one batch each,
   * and the verification polls instead of sleeping a fixed 200 ms.
   */
  private async rewireToMonitor(nodeName: string, sinkName: string): Promise<void> {
    const deadline = Date.now() + 3000;
    let ourPorts: string[] = [];
    while (Date.now() < deadline) {
      // pw-record died on its own (bad target, device gone): stop polling and
      // fail now rather than after the full deadline
      if (!this.child) throw new Error('pw-record 立即退出了');
      const [listed, outsText] = await Promise.all([
        runCli('pw-link', ['-i']),
        runCli('pw-link', ['-o']),
      ]);
      ourPorts = listed ? portsOf(listed, nodeName) : [];
      if (ourPorts.length > 0) {
        const monitorPorts = (outsText?.split('\n').map((l) => l.trim()) ?? []).filter((p) =>
          p.startsWith(`${sinkName}:monitor_`),
        );
        const links = parseLinkPairs((await runCli('pw-link', ['--links'])) ?? '');
        const plan = planMonitorRewire(ourPorts, links, monitorPorts);
        if (plan.unmatched.length > 0) {
          throw new Error(`输出设备没有监听端口：${plan.unmatched.join(', ')}`);
        }
        await Promise.all(
          plan.disconnect.map((l) => runCli('pw-link', ['--disconnect', l.output, l.input])),
        );
        await Promise.all(plan.connect.map((l) => runCli('pw-link', [l.output, l.input])));
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    if (ourPorts.length === 0) throw new Error(`找不到捕获节点 ${nodeName} 的端口`);

    const verifyBy = Date.now() + 1500;
    for (;;) {
      const verified = parseLinkPairs((await runCli('pw-link', ['--links'])) ?? '');
      if (isTappedAt(ourPorts, verified, sinkName)) return;
      if (Date.now() >= verifyBy) {
        throw new Error('系统音频监听端口未能连上（PipeWire 图形被重写）');
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  stop(): void {
    this.stopping = true;
    try {
      this.child?.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    this.child = null;
  }
}

/** $XDG_RUNTIME_DIR/pipewire-0 — the daemon's native socket */
export function pipeWireSocketPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = env.XDG_RUNTIME_DIR;
  if (!dir) return false;
  return existsSync(join(dir, 'pipewire-0'));
}

/** One-shot `pw-dump` + `wpctl` read for the Settings device list. */
export async function listLinuxLoopbackSinks(): Promise<{
  sinks: LoopbackSink[];
  defaultSink: { id: string; name: string } | null;
}> {
  const [dump, status] = await Promise.all([
    runCli('pw-dump', []),
    runCli('wpctl', ['status', '-n']),
  ]);
  return {
    sinks: dump ? parsePwDumpSinks(dump) : [],
    defaultSink: status ? parseWpctlDefaultSink(status) : null,
  };
}

async function runCli(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let child: QueryChild;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    // pw-dump carries CJK node descriptions; decoding each chunk on its own
    // would split a multi-byte sequence and leave JSON.parse looking at
    // replacement characters, so accumulate bytes and decode once
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : null);
    }, 4000);
    child.stdout.on('data', (b: Buffer) => {
      chunks.push(b as Buffer);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : null);
    });
  });
}
