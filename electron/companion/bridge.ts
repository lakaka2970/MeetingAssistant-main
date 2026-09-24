/**
 * Companion bridge: pushes this machine's live output to phones on the LAN.
 *
 * Everything published here already originates in the main process — the ASR
 * host, the LLM answer stream and the exam pipeline all emit before any window
 * is involved. Tapping them at the source means the phone costs no renderer
 * round-trip, and the display path stays independent of whether a window is
 * open, hidden or stealth. That is the whole reason this is a main-process
 * module rather than a relay off the UI.
 *
 * Latency rules this file exists to enforce:
 *  1. Never block. No `await` sits between an event arriving and it being
 *     queued; the only expensive step (screen capture) is already async.
 *  2. Coalesce the firehose, never the truth. Partials and streamed deltas are
 *     merged into one send per tick — a local engine re-transcribes a whole
 *     segment every ~1.4 s and a realtime engine pushes far more, which would
 *     otherwise be dozens of frames per second over Wi-Fi. Final lines, bank
 *     hits and `done` are sent immediately and are never dropped.
 *  3. Flush before terminal state. A buffered delta must reach the phone
 *     before the `done` that closes its card, or the phone shows a truncated
 *     answer that it will never update again.
 */

import { desktopCapturer, screen } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import QRCode from 'qrcode';

import type {
  AsrEvent,
  CompanionControlItems,
  CompanionDeviceView,
  CompanionState,
  ExamEvent,
  LlmEvent,
} from '@shared/protocol';
import { COMPANION_CONTROL_GRANTS } from '../../shared/protocol';
import { getResourceRoot } from '../resourcePaths';
import { CompanionServer } from './server';
import { PairingManager } from './pairing';
import { ensureCertificate, primaryLanIp, lanAddresses } from './tls';
import { buildFrame, type CompanionCaps, type CompanionMessage } from './protocol';

/** merge window for partials and streamed deltas, in ms */
const FLUSH_MS = 80;

export interface CompanionSettings {
  enabled: boolean;
  port: number;
  pushExam: boolean;
  pushInterview: boolean;
  pushTranscript: boolean;
  pushScreenshot: boolean;
  useHttps: boolean;
  jpegQuality: number;
  maxDim: number;
  /** ⑦ remote control: master switch plus the six per-item grants */
  allowControl: boolean;
  allowItems: CompanionControlItems;
}

export class CompanionBridge {
  private server: CompanionServer | null = null;
  private pairing: PairingManager | null = null;
  private caps: CompanionCaps = {
    transcript: true,
    interview: true,
    exam: true,
    screenshot: true,
    control: true,
    controlItems: { ...COMPANION_CONTROL_GRANTS },
  };
  private started = false;
  private boundPort = 0;
  private boundHttps = false;
  private lastError = '';
  /** latest text per speaker, waiting for the flush tick */
  private partials = new Map<string, string>();
  /** accumulated delta text per request id, waiting for the flush tick */
  private deltas = new Map<string, string>();
  /** which channel a buffered delta belongs to, so the flush can re-wrap it */
  private deltaKind = new Map<string, 'a' | 'x'>();
  /** when each in-flight interview answer started, for the ms the phone shows */
  private answerStartedAt = new Map<string, number>();
  private flushTimer: NodeJS.Timeout | null = null;
  private seq = 0;

  constructor(
    private readonly settings: () => CompanionSettings,
    private readonly userDataDir: string,
    /** reported through the tray/settings so a wrong port is visible, not silent */
    private readonly onStateChange: () => void = () => {},
    /** a phone just finished pairing/authenticating — the connect window self-closes */
    private readonly onPhoneConnected: () => void = () => {},
  ) {}

  // ---- lifecycle ----

  /**
   * Reconcile the running server with the settings. Cheap to call after every
   * patch; it only rebinds when the port or the TLS mode actually changed.
   */
  async apply(): Promise<void> {
    const s = this.settings();
    this.caps.transcript = s.pushTranscript;
    this.caps.interview = s.pushInterview;
    this.caps.exam = s.pushExam;
    this.caps.screenshot = s.pushScreenshot;
    this.caps.control = s.allowControl;
    this.caps.controlItems = { ...s.allowItems };

    if (!s.enabled) {
      await this.shutdown();
      return;
    }
    if (this.started && this.boundPort === s.port && this.boundHttps === s.useHttps) {
      this.onStateChange();
      return;
    }
    await this.shutdown();

    this.pairing ??= new PairingManager(join(this.userDataDir, 'companion-devices.json'));
    const pairing = this.pairing;

    let tls: { cert: string; key: string } | undefined;
    // Kept apart from lastError on purpose: a successful bind must not wipe the
    // one clue that the user asked for HTTPS and silently did not get it. The
    // URL alone is easy to dismiss, and this is the failure where everything
    // still "works" except the phone's screen keeps dimming.
    let downgrade = '';
    if (s.useHttps) {
      // Key generation is synchronous and costs ~1 s the first time only;
      // afterwards the stored cert is reused until the LAN address moves. Dedup
      // the candidate addresses because `certCovers` requires *every* one.
      const ips = [...new Set([...lanAddresses(), primaryLanIp()])];
      const pair = ensureCertificate(this.userDataDir, ips);
      if (pair) tls = { cert: pair[0], key: pair[1] };
      else downgrade = '无法生成本地 HTTPS 证书，已改用明文 HTTP（手机将无法保持常亮）';
    }

    const katexDir = this.katexDir();
    const server = new CompanionServer({
      pairing,
      caps: this.caps,
      assetsDir: join(getResourceRoot(), 'resources', 'companion'),
      ...(katexDir ? { katexDir } : {}),
      port: s.port,
      portFallback: 5,
      ...(tls ? { tls } : {}),
      onPairingCode: (code) => {
        console.log(`[companion] 配对码：${code}`);
        this.onStateChange();
      },
      onAuthenticated: () => this.onPhoneConnected(),
    });
    try {
      await server.start();
      this.started = true;
      this.boundPort = s.port;
      this.boundHttps = s.useHttps && !!tls;
      this.lastError = downgrade;
      console.log(
        `[companion] 已监听 :${server.port}${this.boundHttps ? ' (https)' : ' (http)'}` +
          (downgrade ? ` — ${downgrade}` : ''),
      );
    } catch (e) {
      this.lastError = (e as Error).message;
      console.warn('[companion] 启动失败：', this.lastError);
    }
    this.server = this.started ? server : null;
    if (!this.started) server.stop().catch(() => {});
    this.onStateChange();
  }

  private async shutdown(): Promise<void> {
    await this.server?.stop();
    this.server = null;
    this.started = false;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.partials.clear();
    this.deltas.clear();
    this.deltaKind.clear();
    this.answerStartedAt.clear();
  }

  async dispose(): Promise<void> {
    await this.shutdown();
  }

  private katexDir(): string | undefined {
    try {
      // A concrete file, not the directory: katex's package `exports` map has no
      // "./dist" entry, so resolving the directory throws even though the files
      // are on disk. Resolved at call time so a missing optional asset degrades
      // to plain text instead of breaking the bridge at import.
      const dir = dirname(require.resolve('katex/dist/katex.min.js'));
      return existsSync(dir) ? dir : undefined;
    } catch {
      return undefined;
    }
  }

  // ---- publishing ----

  get listening(): boolean {
    return !!this.server && this.server.authenticatedCount > 0;
  }

  private push(msg: CompanionMessage, lossy = false): void {
    if (!this.server || this.server.authenticatedCount === 0) return;
    if (lossy) this.server.broadcastLossy(msg);
    else this.server.broadcastJson(msg);
  }

  /** transcript: partials coalesce, final lines always go out */
  publishAsr(ev: AsrEvent): void {
    if (!this.server || !this.caps.transcript) return;
    switch (ev.kind) {
      case 'partial':
        this.partials.set(ev.speaker, ev.text);
        this.scheduleFlush();
        break;
      case 'segment':
        // the final line supersedes whatever was streaming for that speaker
        this.partials.delete(ev.speaker);
        this.push({
          type: 'line',
          id: ev.id,
          speaker: ev.speaker,
          text: ev.text,
          ts: ev.timings?.speechEndTs ?? Date.now(),
        });
        break;
      case 'status':
        this.push({ type: 'asr', state: ev.state });
        break;
      case 'error':
        this.push({ type: 'asr', state: `error: ${ev.message}` });
        break;
      case 'ready':
        this.push({ type: 'asr', state: 'ready' });
        break;
    }
  }

  publishLlm(ev: LlmEvent): void {
    if (!this.server || !this.caps.interview) return;
    // The interview answer stream carries no timing of its own (unlike the exam
    // pipeline, which reports ms.total), so measure the machine-side wall time
    // here — the phone cannot tell model latency from wire latency otherwise.
    if (!this.answerStartedAt.has(ev.requestId)) this.answerStartedAt.set(ev.requestId, Date.now());
    // A cancelled answer never emits done (main returns on abort), so the map is
    // pruned by age rather than relying on a terminal event that may not come.
    if (this.answerStartedAt.size > 32) {
      const cutoff = Date.now() - 120_000;
      for (const [id, at] of this.answerStartedAt) if (at < cutoff) this.answerStartedAt.delete(id);
    }
    let ms = 0;
    if (ev.kind === 'done' || ev.kind === 'error') {
      ms = Date.now() - (this.answerStartedAt.get(ev.requestId) ?? Date.now());
      this.answerStartedAt.delete(ev.requestId);
    }
    switch (ev.kind) {
      case 'delta':
        this.bufferDelta('a', ev.requestId, ev.text);
        break;
      case 'qa':
        this.flush();
        this.push({
          type: 'a',
          phase: 'qa',
          id: ev.requestId,
          question: ev.hit.question,
          answer: ev.hit.answer,
          ...(ev.hit.ref ? { ref: ev.hit.ref } : {}),
        });
        break;
      case 'web':
        this.flush();
        this.push({ type: 'a', phase: 'web', id: ev.requestId, sources: ev.sources });
        break;
      case 'done':
        this.flush(ev.requestId);
        this.push({ type: 'a', phase: 'done', id: ev.requestId, text: ev.text, ms });
        break;
      case 'error':
        this.flush(ev.requestId);
        this.push({ type: 'a', phase: 'error', id: ev.requestId, message: ev.message });
        break;
    }
  }

  publishExam(ev: ExamEvent): void {
    if (!this.server || !this.caps.exam) return;
    const id = ev.requestId;
    switch (ev.kind) {
      case 'stage':
        this.flush(id);
        this.push({ type: 'x', phase: 'stage', id, stage: ev.stage });
        break;
      case 'question':
        this.flush(id);
        this.push({ type: 'x', phase: 'question', id, text: ev.text, via: ev.via });
        break;
      case 'note':
        this.flush(id);
        this.push({ type: 'x', phase: 'note', id, text: ev.text });
        break;
      case 'bank':
        this.flush(id);
        this.push({
          type: 'x',
          phase: 'bank',
          id,
          answer: ev.hit.answer,
          ...(ev.letter ? { letter: ev.letter } : {}),
          ref: ev.hit.ref,
          stem: ev.hit.stem,
        });
        break;
      case 'ambiguous':
        this.flush(id);
        this.push({
          type: 'x',
          phase: 'note',
          id,
          text: `题库里有 ${ev.candidates.length} 道相近题，答案不完全一致：\n${ev.candidates
            .map((c, i) => `${i + 1}. ${c.stem.slice(0, 60)} → ${c.answer}`)
            .join('\n')}`,
        });
        break;
      case 'delta':
        this.bufferDelta('x', id, ev.text);
        break;
      case 'done':
        this.flush(id);
        this.push({ type: 'x', phase: 'done', id, text: ev.text, origin: ev.origin, ms: ev.ms?.total ?? 0 });
        break;
      case 'error':
        this.flush(id);
        this.push({ type: 'x', phase: 'error', id, message: ev.message });
        break;
    }
  }

  // ---- coalescing ----

  private bufferDelta(kind: 'a' | 'x', id: string, text: string): void {
    this.deltaKind.set(id, kind);
    this.deltas.set(id, (this.deltas.get(id) ?? '') + text);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_MS);
    this.flushTimer.unref?.();
  }

  /** Send whatever is buffered, for one request id or for all of them. */
  private flush(onlyId?: string): void {
    for (const [speaker, text] of [...this.partials]) {
      if (onlyId) continue;
      this.partials.delete(speaker);
      this.push({ type: 'partial', speaker, text }, true);
    }
    for (const [id, text] of [...this.deltas]) {
      if (onlyId && id !== onlyId) continue;
      const kind = this.deltaKind.get(id) ?? 'a';
      this.deltas.delete(id);
      this.deltaKind.delete(id);
      if (text) this.push({ type: kind, phase: 'delta', id, text } as CompanionMessage, true);
    }
  }

  // ---- screenshot ----

  /**
   * Grab the primary display, push a receipt frame and hand back the JPEG so
   * the caller can feed it to the answering pipeline. Encoding is a single
   * native call; the cost that matters here is the model downstream, not this.
   */
  async captureAndPush(): Promise<{ ok: boolean; seq: number; imageDataUrl?: string; ms: number }> {
    const t0 = Date.now();
    const s = this.settings();
    const disp = screen.getPrimaryDisplay();
    const sf = disp.scaleFactor;
    const w = Math.round(disp.size.width * sf);
    const h = Math.round(disp.size.height * sf);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
    const src = sources.find((x) => x.display_id === String(disp.id)) ?? sources[0];
    if (!src || src.thumbnail.isEmpty()) return { ok: false, seq: 0, ms: Date.now() - t0 };

    let image = src.thumbnail;
    const size = image.getSize();
    if (Math.max(size.width, size.height) > s.maxDim) {
      image = image.resize({ width: s.maxDim, quality: 'best' });
    }
    const after = image.getSize();
    const jpeg = image.toJPEG(s.jpegQuality);
    const seq = ++this.seq;
    const ts = Date.now();

    // The frame header already carries seq / size / timestamp, so there is no
    // announcement message: the phone reads the receipt straight off the binary
    // frame it just received.
    if (this.caps.screenshot) {
      this.server?.broadcastFrame(buildFrame(seq, ts, after.width, after.height, jpeg));
    }
    return {
      ok: true,
      seq,
      ms: Date.now() - t0,
      imageDataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    };
  }

  // ---- observability ----

  async state(): Promise<CompanionState> {
    const s = this.settings();
    const ip = primaryLanIp();
    const port = this.server?.port ?? s.port;
    const https = !!this.server?.https;
    const url = `${https ? 'https' : 'http'}://${ip}:${port}/`;
    const devices: CompanionDeviceView[] = (this.pairing?.list() ?? []).map((d) => ({
      name: d.name,
      lastSeen: Math.max(d.lastSeen, this.server?.seen(d.name) ?? 0),
      online: this.server?.views.some((v) => v.device === d.name) ?? false,
    }));
    const pending = this.pairing?.currentCode();
    const stats = this.server?.stats ?? { sentEvents: 0, droppedEvents: 0 };
    return {
      running: !!this.server,
      error: this.server ? this.lastError : s.enabled ? this.lastError : '',
      port,
      https,
      url: this.server ? url : '',
      pairingCode: pending?.code ?? '',
      pairingExpiresAt: pending?.expiresAt ?? 0,
      devices: devices.sort((a, b) => b.lastSeen - a.lastSeen),
      sentEvents: stats.sentEvents,
      droppedEvents: stats.droppedEvents,
      lagMs: this.server?.lagMs ?? -1,
    };
  }

  /** QR of the reach URL, rendered as SVG so it scales on a phone camera. */
  async qrSvg(): Promise<string> {
    const st = await this.state();
    if (!st.url) return '';
    return QRCode.toString(st.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  }

  /** the URL a phone should be pointed at — always the actually bound port */
  async reachUrl(): Promise<string> {
    return (await this.state()).url;
  }

  startPairing(): string {
    const code = this.pairing?.startPairing() ?? '';
    if (code) console.log(`[companion] 配对码：${code}`);
    this.onStateChange();
    return code;
  }

  revoke(name: string): boolean {
    const ok = this.pairing?.revoke(name) ?? false;
    this.onStateChange();
    return ok;
  }
}
