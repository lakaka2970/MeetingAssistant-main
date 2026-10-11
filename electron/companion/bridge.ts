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
  StoredTurn,
} from '@shared/protocol';
import { COMPANION_CONTROL_GRANTS } from '../../shared/protocol';
import { getResourceRoot } from '../resourcePaths';
import { CompanionServer } from './server';
import { PairingManager } from './pairing';
import { ensureCertificate, refreshLanIp, lanAddresses } from './tls';
import { buildFrame, type CompanionCaps, type CompanionMessage, type StateMessage } from './protocol';
import {
  buildHistoryPayload,
  buildStatePayload,
  sameState,
  type ControlCommand,
} from './control';

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
  /** ⑦ remote control: master switch plus the eight per-item grants */
  allowControl: boolean;
  allowItems: CompanionControlItems;
}

/**
 * ⑦ The desktop's side of remote control, answered by the main process on
 * demand: the bridge never keeps a copy of the truth it echoes to phones, so a
 * forgotten push shows up as a stale switch instead of a second source of
 * facts.
 */
export interface CompanionControlDeps {
  /** live values for the `st` payload */
  state(): Omit<StateMessage, 'type'>;
  /** this session's turns, oldest first — `hx` caps and reverses them */
  turns(): StoredTurn[];
  /**
   * one command the server has already authorized, validated and budgeted.
   * A returned refusal code means the desktop declined the work itself (a
   * re-check with nothing to re-check, one already in flight): it travels back
   * as an `error` keyed to this press, so the phone can say so out loud.
   */
  run(cmd: ControlCommand): string | undefined;
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
  /** ⑦ attached by the main process; no deps means no control, and no `st` */
  private control: CompanionControlDeps | null = null;
  /** last `st` sent, so a desktop that idles on one state costs no traffic */
  private lastState: StateMessage | null = null;
  /** latest text per speaker, waiting for the flush tick */
  private partials = new Map<string, string>();
  /** accumulated delta text per request id, waiting for the flush tick */
  private deltas = new Map<string, string>();
  /** which channel a buffered delta belongs to, so the flush can re-wrap it */
  private deltaKind = new Map<string, 'a' | 'x'>();
  /**
   * The check round's delta text, kept out of `deltas` on purpose. That map is
   * keyed by request id alone, and a check round rides the id of the answer it
   * reviews — sharing it would append revision tokens onto the first answer its
   * `done` has already settled, which reads as the model quietly rewriting
   * itself. Keyed by id *and* turn, so two re-check rounds of one answer cannot
   * interleave and a late tick from round 1 cannot land on round 2's card.
   */
  private checkDeltas = new Map<string, { id: string; turn: number; text: string }>();
  /** when each in-flight interview answer started, for the ms the phone shows */
  private answerStartedAt = new Map<string, number>();
  private flushTimer: NodeJS.Timeout | null = null;
  private checkFlushTimer: NodeJS.Timeout | null = null;
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
      // The SAN takes every address this machine has, so typing one in by hand
      // still works; but only the advertised address decides whether the stored
      // cert gets re-issued, and a re-issue reuses the private key — key
      // generation costs ~1 s on the main thread. `certCovers` requires *every*
      // address it is given, so dedup the candidates.
      const advertised = await refreshLanIp();
      const san = [...new Set([...lanAddresses(), advertised])];
      const pair = ensureCertificate(this.userDataDir, { san, mustCover: [advertised] });
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
      onAuthenticated: () => {
        this.onPhoneConnected();
        // A fresh phone has no idea what the desktop looks like, and the dedupe
        // in publishState would otherwise swallow the state its panel needs.
        this.lastState = null;
        this.publishState();
      },
      onControl: (cmd) => this.runControl(cmd),
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
    // Both halves of the check stream die with the connection. `push` already
    // drops while disconnected, so the leak alone would be bounded — but a
    // `start()` inside the pending tick's window would replay this session's
    // tokens to a freshly-connected phone, and a surviving buffer would let the
    // next round resume a sentence the old bridge abandoned.
    if (this.checkFlushTimer) clearTimeout(this.checkFlushTimer);
    this.checkFlushTimer = null;
    this.partials.clear();
    this.deltas.clear();
    this.deltaKind.clear();
    this.checkDeltas.clear();
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

  /** @returns how many phones actually took it (0 when none is connected) */
  private push(msg: CompanionMessage, lossy = false): number {
    if (!this.server || this.server.authenticatedCount === 0) return 0;
    return lossy ? this.server.broadcastLossy(msg) : this.server.broadcastJson(msg);
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
      case 'check':
        this.flush(id);
        // the round's own tokens go out before its verdict, same rule as above:
        // a terminal event must never overtake the stream it is closing
        this.flushCheck(id, ev.turn);
        this.push({ type: 'x', phase: 'check', id, turn: ev.turn, verdict: ev.verdict, note: ev.note, ms: ev.ms });
        break;
      case 'checkDelta':
        this.bufferCheck(id, ev.turn, ev.text);
        break;
      case 'checkDone':
        this.flushCheck(id, ev.turn);
        this.push({ type: 'x', phase: 'checkDone', id, turn: ev.turn, text: ev.text });
        break;
      case 'subMode':
        // no push: the phone's own segment state comes from `st.examSubMode`,
        // and publishing it as an answer event would invent a blank answer card
        break;
      case 'error':
        this.flush(id);
        this.push({ type: 'x', phase: 'error', id, message: ev.message });
        break;
    }
  }

  // ---- remote control (⑦) ----

  /**
   * Hand the bridge the desktop's side of control. The main process owns every
   * one of these answers; the bridge only echoes them and relays commands, so
   * there is no second copy of the truth to fall out of step with.
   */
  attachControl(deps: CompanionControlDeps): void {
    this.control = deps;
  }

  /**
   * Echo the desktop's live state to the phones, but only when it moved.
   *
   * Reliable, not lossy: this few-dozen-byte message is the confirmation that a
   * command landed (R9), and the dedupe below has no per-client view — a
   * snapshot skipped because one phone was behind would never be resent, and
   * that phone's ladder highlight would stay wrong until something else moved.
   */
  publishState(): void {
    const deps = this.control;
    if (!deps || !this.server || !this.caps.control) return;
    const next = buildStatePayload(deps.state());
    if (this.lastState && sameState(this.lastState, next)) return;
    this.lastState = next;
    // Nothing was listening — the next phone in still has to be told.
    if (!this.push(next)) this.lastState = null;
  }

  /**
   * One command the server already authorized, validated and budgeted.
   *
   * `history` is the bridge's own answer — it is a read of state the main
   * process already handed us. Everything else is applied by the desktop, and
   * the `st` that follows is what tells the phone it worked (R9): a switch the
   * renderer refused to throw shows up as unmoved, not as an error.
   *
   * The desktop call is wrapped because this stack runs inside the ws message
   * callback and main has no uncaughtException handler: `settings.save()` can
   * fail on a full disk and `webContents.send` on a window that is going away,
   * and either would take the whole app down under a connected phone. The
   * commands are not atomic, so the state echo afterwards — not a retry — is
   * what reports how far the desktop actually got.
   */
  private runControl(cmd: ControlCommand): string | undefined {
    const deps = this.control;
    if (!deps) return;
    let refusal: string | undefined;
    try {
      if (cmd.op === 'history') {
        // a panel the phone asked for by name must not be dropped for being slow
        this.push(buildHistoryPayload(deps.turns()));
        return;
      }
      refusal = deps.run(cmd);
    } catch (e) {
      console.error(`[companion-ctl] ${cmd.op} failed on the desktop:`, (e as Error).message);
    }
    this.publishState();
    return refusal;
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

  /**
   * Coalesce one check-round token. Deliberately not `bufferDelta`: that one
   * keys by request id, and a check round reuses the id of the answer it
   * reviews, so routing it there would append revision tokens to an answer the
   * `done` event already finalised.
   */
  private bufferCheck(id: string, turn: number, text: string): void {
    const key = `${id}#${turn}`;
    const prev = this.checkDeltas.get(key);
    this.checkDeltas.set(key, { id, turn, text: (prev?.text ?? '') + text });
    this.scheduleCheckFlush();
  }

  /**
   * Its own tick rather than `scheduleFlush()`, so the first-answer coalescing
   * path — the latency-critical one — keeps flushing exactly what it always did.
   */
  private scheduleCheckFlush(): void {
    if (this.checkFlushTimer) return;
    this.checkFlushTimer = setTimeout(() => {
      this.checkFlushTimer = null;
      this.flushCheck();
    }, FLUSH_MS);
    this.checkFlushTimer.unref?.();
  }

  /** Send buffered check tokens for one round, or for every round in flight. */
  private flushCheck(id?: string, turn?: number): void {
    const only = id === undefined ? null : `${id}#${turn}`;
    for (const [key, buf] of [...this.checkDeltas]) {
      if (only && key !== only) continue;
      this.checkDeltas.delete(key);
      // lossy like the answer deltas: a dropped token is retold by the round's
      // `checkDone`, which is not lossy
      if (buf.text) this.push({ type: 'x', phase: 'checkDelta', id: buf.id, turn: buf.turn, text: buf.text }, true);
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
    const ip = await refreshLanIp();
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
