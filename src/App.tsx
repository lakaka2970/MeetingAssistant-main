import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnswerLang,
  AsrEvent,
  KbSlot,
  LlmAskPayload,
  PublicSettings,
  StoredSession,
} from '../shared/protocol';
import {
  appendSegment,
  nextSegmentId,
  percentile,
  reindexSegments,
  type TranscriptSegment,
} from '../shared/transcript';
import { heuristic } from '../shared/questionGate';
import { captureKindForPlatform } from '../shared/platform';
import { deriveServiceHealth } from '../shared/healthState';
import { LoopbackCapture } from './audio/loopbackCapture';
import { MicCapture, listMics } from './audio/micCapture';
import { TitleBar } from './components/TitleBar';
import { SettingsPanel } from './components/SettingsPanel';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { HelpPanel } from './components/HelpPanel';
import type { SettingsTab } from './components/settings/types';
import { StatusBar } from './components/StatusBar';
import { PromptFocus, type AnswerTurn } from './components/prompt/PromptFocus';
import { TranscriptRail } from './components/prompt/TranscriptRail';
import { I18nProvider, getDict, type Dict } from './i18n';

/** the one in-window overlay that can be open at a time (knowledge/health are hub tabs) */
type OverlayPanel =
  | { view: 'settings'; tab: SettingsTab }
  | { view: 'diagnostics' }
  | { view: 'help' };

export interface AsrUiState {
  phase: 'loading' | 'ready' | 'error';
  ep?: string;
  gpuSuspect?: boolean;
  workerState: 'loading' | 'listening' | 'speech' | 'transcribing' | 'stopped';
  lastError?: string;
}

export interface HudStats {
  lastE2eMs?: number;
  lastInferMs?: number;
  p50?: number;
  p95?: number;
  count: number;
}

const MAX_TURNS = 200;
// v2: only the last 8 turns ride along verbatim — the rolling memo carries
// older context, keeping per-request tokens flat as the interview runs long
const HISTORY_TURNS = 8;

let seq = 0;
const uid = (p: string) => `${p}-${++seq}-${Date.now()}`;

function newSession(name: string): StoredSession {
  return { id: uid('s'), name, createdAt: Date.now(), turns: [], segments: [] };
}

/** legacy single-slot KB → resume slot (dual-slot material, P0-2) */
function migrateKbSlots(s: StoredSession, fallbackName: string): StoredSession {
  if (!s.kbText || s.resumeText) return s;
  const { kbName, kbText, ...rest } = s;
  return { ...rest, resumeName: kbName ?? fallbackName, resumeText: kbText };
}

/** first-question topic → a short session title */
function deriveName(text: string, fallback: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return fallback;
  return t.length > 14 ? t.slice(0, 14) + '…' : t;
}

export function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [asr, setAsr] = useState<AsrUiState>({ phase: 'loading', workerState: 'loading' });
  const [capturing, setCapturing] = useState(false);
  /**
   * The single in-window overlay surface. 知识库 and 服务状态 are now tabs of
   * the settings hub, so they open it on their tab rather than owning a boolean
   * each; help and diagnostics stay separate full panels.
   */
  const [openPanel, setOpenPanel] = useState<OverlayPanel | null>(null);
  /** upgrade P0: prefix-cache hit rate over the last answers (0-100, null = n/a) */
  const [cacheHitRate, setCacheHitRate] = useState<number | null>(null);
  /** upgrade P0: embed worker state for the status-bar chip */
  const [ragState, setRagState] = useState<'idle' | 'loading' | 'ready' | 'error' | 'off'>('idle');
  const [showHud, setShowHud] = useState(true);
  const [hud, setHud] = useState<HudStats>({ count: 0 });
  const [continuous, setContinuous] = useState(false);
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([]);
  const [micActive, setMicActive] = useState(false);
  const [partials, setPartials] = useState<{ them?: string; me?: string }>({});
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  const [kbNotice, setKbNotice] = useState<string | null>(null);

  const loopbackRef = useRef<LoopbackCapture | null>(null);
  const themInputRef = useRef<MicCapture | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const settingsRef = useRef<PublicSettings | null>(null);
  const e2eSamples = useRef<number[]>([]);
  const sessionsRef = useRef<StoredSession[]>([]);
  const currentIdRef = useRef<string>('');
  const answerLangRef = useRef<AnswerLang>('chinese');
  const loaded = useRef(false);
  /** rolling {hit, miss} samples for the prefix-cache chip (last 10 answers) */
  const cacheWindowRef = useRef<{ hit: number; miss: number }[]>([]);
  /** upgrade P1.5: the main-process native loopback is driving 'them' audio */
  const nativeActiveRef = useRef(false);

  // UI language: settings-driven; ref mirror so stable callbacks stay fresh
  const t = getDict(settings?.ui.lang);
  const tRef = useRef<Dict>(t);
  tRef.current = t;

  if (!loopbackRef.current) loopbackRef.current = new LoopbackCapture();
  if (!themInputRef.current) themInputRef.current = new MicCapture();
  if (!micRef.current) micRef.current = new MicCapture();
  settingsRef.current = settings;
  sessionsRef.current = sessions;
  currentIdRef.current = currentId;

  const current = useMemo(
    () => sessions.find((s) => s.id === currentId) ?? null,
    [sessions, currentId],
  );
  const segments = current?.segments ?? [];

  const patchSession = useCallback((id: string, fn: (s: StoredSession) => StoredSession) => {
    setSessions((list) => list.map((s) => (s.id === id ? fn(s) : s)));
  }, []);

  const appendTurn = useCallback(
    (sessionId: string, turn: AnswerTurn) => {
      patchSession(sessionId, (s) => {
        const turns = [...s.turns, turn];
        return { ...s, turns: turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns };
      });
    },
    [patchSession],
  );

  const buildHistory = useCallback((): { role: 'user' | 'assistant'; content: string }[] => {
    const s = sessionsRef.current.find((x) => x.id === currentIdRef.current);
    if (!s) return [];
    const done = s.turns.filter((t) => t.status === 'done' && t.kind !== 'translate').slice(-HISTORY_TURNS);
    return done.flatMap((t) => [
      { role: 'user' as const, content: t.label },
      { role: 'assistant' as const, content: t.text },
    ]);
  }, []);

  /** current session's dual-slot material (resume / JD / rolling memo) */
  const currentMaterial = useCallback((): { resume?: string; jd?: string; memo?: string } => {
    const s = sessionsRef.current.find((x) => x.id === currentIdRef.current);
    return {
      resume: s?.resumeText || undefined,
      jd: s?.jdText || undefined,
      memo: s?.memo || undefined,
    };
  }, []);

  /** P1-6: ask main to warm the DeepSeek prefix cache for the current material */
  const prewarm = useCallback(
    (immediate: boolean) => {
      const m = currentMaterial();
      window.mc.prewarm({ resume: m.resume, jd: m.jd, immediate });
    },
    [currentMaterial],
  );

  // P1-5: rolling memo — fold each finished Q&A in asynchronously, one update
  // at a time per session (promise chain), never on the answer critical path
  const memoChain = useRef(new Map<string, Promise<void>>());
  const enqueueMemoUpdate = useCallback(
    (sid: string, question: string, answer: string) => {
      if (!question.trim() || !answer.trim()) return;
      const prev = memoChain.current.get(sid) ?? Promise.resolve();
      const next = prev
        .then(async () => {
          const old = sessionsRef.current.find((x) => x.id === sid)?.memo ?? '';
          const memo = await window.mc.memoUpdate({ memo: old, question, answer, sessionId: sid });
          if (memo) patchSession(sid, (s) => ({ ...s, memo }));
        })
        .catch(() => {});
      memoChain.current.set(sid, next);
    },
    [patchSession],
  );

  /** auto-name a session from its first real question (once) */
  const maybeTitle = useCallback(
    (sid: string, text?: string) => {
      if (!text?.trim()) return;
      patchSession(sid, (s) =>
        s.titled ? s : { ...s, name: deriveName(text, tRef.current.app.newSession), titled: true },
      );
    },
    [patchSession],
  );

  const askLlm = useCallback(
    (mode: 'segment' | 'continuous' | 'free' | 'translate', text?: string) => {
      const sid = currentIdRef.current;
      if (!sid) return;
      const requestId = uid('req');
      const segs = sessionsRef.current.find((x) => x.id === sid)?.segments ?? [];
      // continuous: resolve the actual question NOW — the other party's latest
      // line — so the turn label (and thus session history) carries the real
      // question instead of a constant '对方最新发言' (v1 history-label bug)
      let question = text;
      if (mode === 'continuous') {
        for (let i = segs.length - 1; i >= 0; i--) {
          if ((segs[i].speaker ?? 'them') === 'them') {
            question = segs[i].text;
            break;
          }
        }
      }
      const label = question ?? (mode === 'continuous' ? tRef.current.app.latestRemark : '');
      appendTurn(sid, { id: requestId, kind: mode, label, text: '', status: 'streaming' });
      if (mode === 'segment' || mode === 'free') maybeTitle(sid, text);
      const material = mode === 'translate' ? {} : currentMaterial();
      const payload: LlmAskPayload = {
        requestId,
        mode,
        question: mode === 'free' ? undefined : question,
        freeQuestion: mode === 'free' ? text : undefined,
        recentTranscript: segs.slice(-30).map((s) => s.text),
        answerLang: answerLangRef.current,
        history: mode === 'translate' ? undefined : buildHistory(),
        // upgrade P0: scope RAG retrieval to this session's material
        sessionId: sid,
        ...material,
      };
      window.mc.llmAsk(payload);
    },
    [appendTurn, buildHistory, currentMaterial, maybeTitle],
  );
  // The global answer hotkey is wired in the deps-free mount effect below, so it
  // has to reach the freshest askLlm through a ref rather than close over one.
  const askLlmRef = useRef(askLlm);
  useEffect(() => {
    askLlmRef.current = askLlm;
  }, [askLlm]);

  const askShot = useCallback(
    (question: string, imageDataUrl?: string) => {
      const sid = currentIdRef.current;
      if (!sid) return;
      const requestId = uid('shot');
      appendTurn(sid, {
        id: requestId,
        kind: 'vision',
        label: question || tRef.current.app.readShot,
        text: '',
        status: 'streaming',
      });
      maybeTitle(sid, question || tRef.current.app.shotQuestion);
      const m = currentMaterial();
      const background = [m.resume, m.jd].filter(Boolean).join('\n\n') || undefined;
      window.mc.shotAsk({ requestId, question, background, imageDataUrl });
    },
    [appendTurn, currentMaterial, maybeTitle],
  );

  /** region screenshot flow (📷 button or hotkey): drag a region, then ask */
  const doRegionShot = useCallback(async () => {
    const img = await window.mc.pickRegion();
    if (img) askShot('', img);
  }, [askShot]);

  // ---- boot: load settings + sessions ----
  useEffect(() => {
    void window.mc.getSettings().then((s) => {
      setSettings(s);
      answerLangRef.current = s.llm.answerLang;
    });
    void window.mc.loadSessions().then((f) => {
      if (f.sessions.length) {
        // heal legacy duplicate segment ids (worker counter used to reset per
        // engine rebuild — translations then landed on multiple bubbles)
        setSessions(
          f.sessions.map((s) =>
            migrateKbSlots(
              { ...s, segments: reindexSegments(s.segments ?? []) },
              tRef.current.app.legacyKbName,
            ),
          ),
        );
        setCurrentId(f.currentId && f.sessions.some((s) => s.id === f.currentId) ? f.currentId : f.sessions[0].id);
      } else {
        const s = newSession(tRef.current.app.sessionN(1));
        setSessions([s]);
        setCurrentId(s.id);
      }
      loaded.current = true;
    });

    const handleAsrEvent = (ev: AsrEvent) => {
      if (ev.kind === 'ready') {
        setAsr((s) => ({ ...s, phase: 'ready', ep: ev.ep, gpuSuspect: ev.gpuSuspect, workerState: 'listening' }));
      } else if (ev.kind === 'status') {
        setAsr((s) => ({ ...s, workerState: ev.state }));
      } else if (ev.kind === 'error') {
        setAsr((s) => ({ ...s, phase: ev.fatal ? 'error' : s.phase, lastError: ev.message }));
      } else if (ev.kind === 'partial') {
        setPartials((p) => ({ ...p, [ev.speaker]: ev.text }));
      } else if (ev.kind === 'segment') {
        setPartials((p) => ({ ...p, [ev.speaker]: undefined })); // final replaces the live partial
        const e2eMs = Date.now() - ev.timings.speechEndTs;
        const inferMs = ev.timings.inferEndTs - ev.timings.inferStartTs;
        e2eSamples.current.push(e2eMs);
        if (e2eSamples.current.length > 200) e2eSamples.current.shift();
        setHud({
          lastE2eMs: e2eMs,
          lastInferMs: inferMs,
          p50: percentile(e2eSamples.current, 50),
          p95: percentile(e2eSamples.current, 95),
          count: e2eSamples.current.length,
        });
        const sid = currentIdRef.current;
        setSessions((list) =>
          list.map((s) =>
            s.id === sid
              ? {
                  ...s,
                  segments: appendSegment(s.segments ?? [], {
                    // NOT ev.id: the worker counter resets per engine rebuild,
                    // duplicating ids inside a persisted session
                    id: nextSegmentId(s.segments ?? []),
                    text: ev.text,
                    lang: ev.lang,
                    speaker: ev.speaker,
                    startTs: ev.timings.speechStartTs,
                    endTs: ev.timings.speechEndTs,
                    e2eMs,
                    inferMs,
                  }),
                }
              : s,
          ),
        );
      }
    };
    const off = window.mc.onAsrEvent(handleAsrEvent);
    // instant-ready cloud engines emit ready/status BEFORE this subscription
    // exists — pull the last ones so the UI never sticks at "模型加载中"
    void window.mc.asrReplay().then(({ ready, status }) => {
      if (ready) handleAsrEvent(ready);
      if (status) handleAsrEvent(status);
    });

    const offLlm = window.mc.onLlmEvent((ev) => {
      setSessions((list) =>
        list.map((s) => ({
          ...s,
          turns: s.turns.map((t) => {
            if (t.id !== ev.requestId) return t;
            if (ev.kind === 'delta') return { ...t, text: t.text + ev.text };
            if (ev.kind === 'reasoning') return { ...t, reasoning: (t.reasoning ?? '') + ev.text };
            if (ev.kind === 'done') return { ...t, text: ev.text || t.text, status: 'done' };
            // a prepared answer arrives before any token: show it at once and
            // let the stream below it be the AI's enrichment
            if (ev.kind === 'qa') return { ...t, qa: ev.hit };
            if (ev.kind === 'web') return { ...t, web: ev.sources };
            return { ...t, status: 'error', error: ev.message };
          }),
        })),
      );
      // upgrade P1: rolling prefix-cache hit rate over the last 10 answers
      if (ev.kind === 'done' && ev.usage) {
        const { promptCacheHit: hit, promptCacheMiss: miss } = ev.usage;
        if (typeof hit === 'number' || typeof miss === 'number') {
          const arr = cacheWindowRef.current;
          arr.push({ hit: hit ?? 0, miss: miss ?? 0 });
          if (arr.length > 10) arr.shift();
          const th = arr.reduce((s, x) => s + x.hit, 0);
          const tm = arr.reduce((s, x) => s + x.miss, 0);
          setCacheHitRate(th + tm > 0 ? Math.round((th / (th + tm)) * 100) : null);
        }
      }
      // fold finished ANSWER turns into the session memo (async, off-path);
      // translate/vision turns are not interview Q&A
      if (ev.kind === 'done') {
        const s = sessionsRef.current.find((x) => x.turns.some((t) => t.id === ev.requestId));
        const t = s?.turns.find((x) => x.id === ev.requestId);
        if (s && t && (t.kind === 'segment' || t.kind === 'continuous' || t.kind === 'free')) {
          enqueueMemoUpdate(s.id, t.label, ev.text || t.text);
        }
      }
    });

    const offShot = window.mc.onShotHotkey(() => void doRegionShot());
    // 双屏: the window is hidden, so the only way to ask about what was just
    // said is this key. 'continuous' already resolves the other party's latest
    // line, which is exactly what ⚡答 on a bubble does.
    const offAnswer = window.mc.onAnswerHotkey(() => askLlmRef.current('continuous'));
    // A phone connected: hand the display over. Transcription and answering run
    // in the main process, so hiding this window costs the phone nothing.
    const offConnected = window.mc.onCompanionConnected(() => window.mc.hide());

    window.__mcAutoStart = () => void startCapture();
    // visual-QA hooks (MC_MAIN_SHOT in electron/main.ts): open a panel from the
    // main process so it can be screenshotted
    window.__mcOpenSettings = () => setOpenPanel({ view: 'settings', tab: 'model' });
    window.__mcOpenHelp = () => setOpenPanel({ view: 'help' });
    window.__mcOpenKnowledge = () => setOpenPanel({ view: 'settings', tab: 'knowledge' });
    return () => {
      off();
      offLlm();
      offShot();
      offAnswer();
      offConnected();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- persist sessions (debounced) ----
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => window.mc.saveSessions({ sessions, currentId }), 400);
    return () => clearTimeout(t);
  }, [sessions, currentId]);

  // ---- apply UI theme + answer font scale to the document root ----
  useEffect(() => {
    const ui = settings?.ui;
    if (!ui) return;
    document.documentElement.dataset.fontScale = ui.fontScale ?? 'medium';
    const apply = () => {
      const mode = ui.theme ?? 'dark';
      const dark =
        mode === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : mode === 'dark';
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    if ((ui.theme ?? 'dark') !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);

  // auto-dismiss the KB parse notice
  useEffect(() => {
    if (!kbNotice) return;
    const t = setTimeout(() => setKbNotice(null), 8000);
    return () => clearTimeout(t);
  }, [kbNotice]);

  // upgrade P0: embed worker state for the status-bar chip (pull + push)
  useEffect(() => {
    let alive = true;
    void window.mc
      .ragStatus()
      .then((s) => alive && setRagState(s.enabled ? s.state : 'off'))
      .catch(() => {});
    const off = window.mc.onRagStatus((s) => setRagState(s.enabled ? s.state : 'off'));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // switching sessions swaps the material → prefix dirty (reheats if capturing)
  useEffect(() => {
    if (!loaded.current || !currentId) return;
    prewarm(false);
  }, [currentId, prewarm]);

  // Continuous mode: only the OTHER party's lines trigger it (never my own
  // mic). The debounce window still exists — it waits for a follow-up half
  // sentence — but nothing inside it is idle now: the free two-ended
  // `heuristic` decides the obvious cases up front (an obvious ask never
  // costs a gate round-trip at all), and a genuinely ambiguous line runs its
  // model gate IN PARALLEL with the debounce, collapsing the worst-case
  // serial wait (1100ms + gate) into max(1100ms, gate).
  const lastSeg = segments.length ? segments[segments.length - 1] : null;
  const answeredRef = useRef<number>(-1);
  useEffect(() => {
    if (!continuous || !lastSeg) return;
    if ((lastSeg.speaker ?? 'them') !== 'them') return; // ignore my own voice
    if (answeredRef.current === lastSeg.id) return; // this line is already handled
    const h = heuristic(lastSeg.text);
    if (h.verdict === 'skip') return; // greeting / fragment / logistics ask
    let cancelled = false;
    const fire = (): void => {
      if (cancelled || answeredRef.current === lastSeg.id) return;
      answeredRef.current = lastSeg.id;
      askLlm('continuous');
    };
    // obvious ask → answer at debounce expiry straight away; ambiguous → the
    // gate call is already in flight (started with the debounce), and a gate
    // that somehow failed falls back to answering, exactly as before
    const gateP: Promise<{ verdict: 'answer' | 'skip' }> | undefined = h.verdict
      ? undefined
      : window.mc
          .gate({
            requestId: `gate-${lastSeg.id}`,
            line: lastSeg.text,
            recent: segments.slice(-6).map((s) => s.text),
          })
          .catch(() => ({ verdict: 'answer' as const }));
    const timer = setTimeout(() => {
      if (!gateP) fire();
      else void gateP.then((g) => { if (g.verdict === 'answer') fire(); });
    }, 1100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continuous, lastSeg?.id, lastSeg?.endTs]);

  // Windows: Electron system loopback (or the optional native WASAPI module).
  // macOS/Linux: selected ordinary input (typically a virtual audio device).
  const startCapture = useCallback(async () => {
    const inputMode = captureKindForPlatform(window.mc.platform) === 'input';
    const cap = inputMode ? themInputRef.current! : loopbackRef.current!;
    if (cap.running || nativeActiveRef.current) return;
    try {
      if (inputMode) {
        await themInputRef.current!.start(
          settingsRef.current?.audio.themDeviceId,
          (buf, ts) => window.mc.sendPcm(buf, ts, 'them'),
          { audioProcessing: false },
        );
        void listMics().then(setMics).catch(() => undefined);
      } else if (settingsRef.current?.audio.captureBackend === 'native' && !nativeFallbackRef.current) {
        // upgrade P1.5: main-process WASAPI loopback. Failures push a
        // nativeCaptureError → the fallback below starts Web Audio instead.
        nativeActiveRef.current = true;
        window.mc.nativeCaptureStart(settingsRef.current?.audio.themDeviceId);
      } else {
        await loopbackRef.current!.start((buf, ts) => window.mc.sendPcm(buf, ts, 'them'));
      }
      window.mc.captureStarted();
      setCapturing(true);
      prewarm(true); // ▶ = the meeting starts — build the KV prefix cache now
    } catch (e) {
      setAsr((s) => ({ ...s, lastError: tRef.current.app.captureStartFail((e as Error).message) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopCapture = useCallback(async () => {
    if (nativeActiveRef.current) {
      window.mc.nativeCaptureStop();
      nativeActiveRef.current = false;
    } else {
      const cap =
        captureKindForPlatform(window.mc.platform) === 'input'
          ? themInputRef.current!
          : loopbackRef.current!;
      await cap.stop();
    }
    window.mc.captureStopped();
    setCapturing(false);
  }, []);

  // upgrade P1.5: native loopback failed (artifact missing / device gone) →
  // transparently restart on the renderer Web Audio path
  const nativeFallbackRef = useRef(false);
  const startCaptureRef = useRef(startCapture);
  useEffect(() => {
    startCaptureRef.current = startCapture;
  }, [startCapture]);
  useEffect(() => {
    return window.mc.onNativeCaptureError((message) => {
      if (!nativeActiveRef.current) return;
      nativeActiveRef.current = false;
      nativeFallbackRef.current = true;
      console.warn('[native-audio] falling back to Web Audio:', message);
      setAsr((s) => ({ ...s, lastError: tRef.current.app.nativeFallback(message) }));
      window.mc.captureStopped();
      void startCaptureRef.current();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 🎤 独立麦克风采集：只转麦克风(我)，与系统声音互不影响，按钮直接控制起停
  const toggleMicCapture = useCallback(async () => {
    const mic = micRef.current!;
    if (mic.running) {
      await mic.stop();
      setMicActive(false);
      return;
    }
    try {
      await mic.start(settings?.audio.micDeviceId, (buf, ts) => window.mc.sendPcm(buf, ts, 'me'));
      setMicActive(true);
      if (mics.length === 0) void listMics().then(setMics);
    } catch (e) {
      setAsr((s) => ({ ...s, lastError: tRef.current.app.micStartFail((e as Error).message) }));
    }
  }, [settings, mics]);

  const setSeg = useCallback(
    (segId: number, patch: Partial<TranscriptSegment>) => {
      const sid = currentIdRef.current;
      setSessions((list) =>
        list.map((s) =>
          s.id === sid
            ? { ...s, segments: (s.segments ?? []).map((g) => (g.id === segId ? { ...g, ...patch } : g)) }
            : s,
        ),
      );
    },
    [],
  );

  const translateSegment = useCallback(
    (seg: TranscriptSegment) => {
      if (seg.translating) return; // re-translating an already-translated bubble is allowed
      setSeg(seg.id, { translating: true });
      window.mc
        .translate(seg.text)
        .then((zh) => setSeg(seg.id, { translation: zh, translating: false }))
        .catch(() => setSeg(seg.id, { translation: tRef.current.app.translateFail, translating: false }));
    },
    [setSeg],
  );

  const toggleStealth = useCallback(async () => {
    if (!settings) return;
    const on = await window.mc.setStealth(!settings.ui.stealth);
    setSettings({ ...settings, ui: { ...settings.ui, stealth: on } });
  }, [settings]);

  /**
   * 单屏 ⇄ 双屏. Dual means the phone becomes the display: the LAN bridge
   * starts, the QR window comes up, and 持续答 switches on — because with the
   * overlay out of the way the per-line ⚡答 button is unreachable, and a
   * display that can only show the other party's words is half a feature.
   * Stealth rides along for the same reason the whole mode exists: nothing on
   * this screen should end up in a shared capture.
   */
  const switchMode = useCallback(
    async (next: boolean) => {
      if (!settings) return;
      if (next === settings.companion.enabled) {
        // already in it — re-raise the QR rather than appearing to do nothing
        if (next) void window.mc.openConnect();
        return;
      }
      const updated = await window.mc.setSettings({
        companion: { enabled: next },
        ...(next ? { ui: { stealth: true } } : {}),
      });
      setSettings(updated);
      if (next) setContinuous(true);
    },
    [settings],
  );

  const dual = !!settings?.companion?.enabled;
  /** how many phones are receiving right now — polled only while 双屏 is on */
  const [cOnline, setCOnline] = useState(0);
  useEffect(() => {
    if (!dual) {
      setCOnline(0);
      return;
    }
    let dead = false;
    const tick = async (): Promise<void> => {
      try {
        const s = await window.mc.companionState();
        if (!dead) setCOnline(s.devices.filter((d) => d.online).length);
      } catch {
        /* main is not answering; the count just stays put */
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), 3000);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, [dual]);

  const toggleAnswerLang = useCallback(async () => {
    if (!settings) return;
    const next: AnswerLang = settings.llm.answerLang === 'chinese' ? 'english' : 'chinese';
    answerLangRef.current = next;
    const updated = await window.mc.setSettings({ llm: { answerLang: next } });
    setSettings(updated);
    answerLangRef.current = updated.llm.answerLang;
    prewarm(false); // lang is part of the stable prefix → mark dirty / reheat
  }, [settings, prewarm]);

  const toggleAnswerModel = useCallback(async () => {
    if (!settings) return;
    const updated = await window.mc.setSettings({ llm: { answerWithVision: !settings.llm.answerWithVision } });
    setSettings(updated);
  }, [settings]);

  const selectMic = useCallback(
    async (deviceId: string) => {
      const updated = await window.mc.setSettings({ audio: { micDeviceId: deviceId || undefined } });
      setSettings(updated);
      // if the mic is currently on, restart it on the newly chosen device
      const mic = micRef.current!;
      if (mic.running) {
        await mic.stop();
        await mic
          .start(deviceId || undefined, (buf, ts) => window.mc.sendPcm(buf, ts, 'me'))
          .catch(() => setMicActive(false));
      }
    },
    [],
  );

  const selectThemInput = useCallback(async (deviceId: string) => {
    const updated = await window.mc.setSettings({ audio: { themDeviceId: deviceId || undefined } });
    setSettings(updated);
    settingsRef.current = updated;
    const input = themInputRef.current!;
    if (input.running) {
      await input.stop();
      await input
        .start(
          deviceId || undefined,
          (buf, ts) => window.mc.sendPcm(buf, ts, 'them'),
          { audioProcessing: false },
        )
        .catch((e) => {
          window.mc.captureStopped();
          setCapturing(false);
          setAsr((s) => ({ ...s, lastError: tRef.current.app.themInputSwitchFail((e as Error).message) }));
        });
    }
  }, []);

  const clearTranscript = useCallback(() => {
    patchSession(currentIdRef.current, (s) => ({ ...s, segments: [] }));
  }, [patchSession]);

  const cancelTurn = useCallback(
    (id: string) => {
      window.mc.llmCancel(id);
      patchSession(currentIdRef.current, (s) => ({
        ...s,
        turns: s.turns.map((t) => (t.id === id ? { ...t, status: 'done' } : t)),
      }));
    },
    [patchSession],
  );

  const createSession = useCallback(() => {
    const s = newSession(tRef.current.app.sessionN(sessionsRef.current.length + 1));
    setSessions((list) => [...list, s]);
    setCurrentId(s.id);
  }, []);

  /**
   * Delete one conversation for good: the record in sessions.json, its turns
   * and transcript, and its vector material in main (resume/JD/facts —
   * otherwise a deleted interview keeps answering future questions). Reads the
   * refs instead of nesting setState calls (React updaters must stay pure).
   */
  const deleteSession = useCallback((id: string) => {
    const target = sessionsRef.current.find((s) => s.id === id);
    if (!target) return;
    if (!window.confirm(tRef.current.answer.deleteConfirm(target.name))) return;
    void window.mc.deleteSession(id).catch(() => {});
    const next = sessionsRef.current.filter((s) => s.id !== id);
    if (next.length === 0) {
      const fresh = newSession(tRef.current.app.sessionN(1));
      setSessions([fresh]);
      setCurrentId(fresh.id);
      return;
    }
    setSessions(next);
    if (currentIdRef.current === id) setCurrentId(next[0].id);
  }, []);

  const renameSession = useCallback(
    (id: string, name: string) => {
      patchSession(id, (s) => ({ ...s, name: name.trim() || s.name, titled: true }));
    },
    [patchSession],
  );

  /**
   * Tray menu -> renderer (Phase 4 §A). Main only forwards what it cannot do
   * itself, and it has already made the window visible. 开始/停止转写
   * deliberately runs the SAME code path as the title-bar button, readiness
   * gate included, so the two can never disagree. Re-subscribed whenever that
   * state changes — cheaper and less error-prone than a fistful of refs.
   */
  useEffect(() => {
    return window.mc.onTrayCommand(({ command }) => {
      switch (command) {
        case 'toggle-capture':
          if (capturing) void stopCapture();
          else if (asr.phase === 'ready') void startCapture();
          return;
        case 'new-session':
          createSession();
          return;
        case 'open-settings':
          setOpenPanel({ view: 'settings', tab: 'model' });
          return;
        case 'open-health':
          setOpenPanel({ view: 'settings', tab: 'health' });
          return;
        case 'open-help':
          setOpenPanel({ view: 'help' });
          return;
      }
    });
  }, [capturing, asr.phase, startCapture, stopCapture, createSession]);

  const pickKb = useCallback(
    async (slot: KbSlot) => {
      const sid = currentIdRef.current;
      const r = await window.mc.pickKnowledge(slot, sid ?? undefined);
      if (!r) return;
      if (!r.text.trim()) {
        // deterministic parsers return '' for scanned/image-only PDFs
        setKbNotice(tRef.current.app.kbNoText(r.name));
        return;
      }
      setKbNotice(null);
      patchSession(sid, (s) =>
        slot === 'resume'
          ? { ...s, resumeName: r.name, resumeText: r.text }
          : { ...s, jdName: r.name, jdText: r.text },
      );
      // material changed → reheat the prefix cache with the fresh bytes;
      // patchSession is async (React state), so pass the new slots directly
      window.mc.prewarm({
        resume: slot === 'resume' ? r.text : currentMaterial().resume,
        jd: slot === 'jd' ? r.text : currentMaterial().jd,
        immediate: true,
      });
    },
    [patchSession, currentMaterial],
  );

  const clearKb = useCallback(
    (slot: KbSlot) => {
      const sid = currentIdRef.current;
      patchSession(sid, (s) =>
        slot === 'resume'
          ? { ...s, resumeName: undefined, resumeText: undefined }
          : { ...s, jdName: undefined, jdText: undefined },
      );
      // the vector index has to forget the document too, including the prepared
      // answers parsed from it — otherwise a "removed" resume keeps answering
      void window.mc.dropKnowledgeSlot(slot, sid || undefined).catch(() => {});
      // prefix went stale; reheats now if capturing, else at the next ▶
      window.mc.prewarm({
        resume: slot === 'resume' ? undefined : currentMaterial().resume,
        jd: slot === 'jd' ? undefined : currentMaterial().jd,
      });
    },
    [patchSession, currentMaterial],
  );

  /** the v1 -> v2 migration marks hand-configured profiles; show the notice
   * once until the user dismisses it (persisted in onboarding state) */
  const showUpgradeNotice =
    !!settings &&
    settings.version === 2 &&
    settings.onboarding.completed &&
    !!settings.onboarding.migratedFromV1 &&
    !settings.onboarding.dismissedUpgradePrompt;

  const dismissUpgradeNotice = async () => {
    const onboarding = await window.mc.saveOnboardingProgress({ dismissedUpgradePrompt: true });
    setSettings((s) => (s ? { ...s, onboarding } : s));
  };

  const visionReady =
    !!settings?.llm.answerWithVision &&
    !!settings?.vision.baseUrl &&
    !!settings?.vision.model &&
    !!settings?.vision.apiKeySet;

  /**
   * One derivation for the status chips, the health panel and the answer
   * gating (shared/healthState.ts). A missing LLM key disables the answer
   * buttons with an explanation instead of letting every click produce the
   * same main-process error turn — but it never blocks transcription.
   */
  const health = useMemo(
    () => (settings ? deriveServiceHealth({ settings, asr, capturing }) : null),
    [settings, asr, capturing],
  );
  const answersReady = health?.answersAvailable ?? true;

  return (
    <I18nProvider lang={settings?.ui.lang}>
    <div className="app">
      <TitleBar
        capturing={capturing}
        asrReady={asr.phase === 'ready'}
        captureKind={captureKindForPlatform(window.mc.platform)}
        mics={mics}
        themDeviceId={settings?.audio.themDeviceId ?? ''}
        micDeviceId={settings?.audio.micDeviceId ?? ''}
        micActive={micActive}
        continuous={continuous}
        visionOn={!!settings?.llm.answerWithVision}
        answerLangEn={settings?.llm.answerLang === 'english'}
        stealth={!!settings?.ui.stealth}
        showHud={showHud}
        dual={dual}
        phonesOnline={cOnline}
        onStartStop={() => (capturing ? void stopCapture() : void startCapture())}
        onSelectThem={(id) => void selectThemInput(id)}
        onSelectMic={(id) => void selectMic(id)}
        onToggleContinuous={() => setContinuous((v) => !v)}
        onToggleModel={() => void toggleAnswerModel()}
        onToggleAnswerLang={() => void toggleAnswerLang()}
        onToggleMic={() => void toggleMicCapture()}
        onSwitchMode={(d) => void switchMode(d)}
        onToggleStealth={() => void toggleStealth()}
        onToggleHud={() => setShowHud((v) => !v)}
        onOpenExam={() => void window.mc.openExam()}
        onOpenKnowledge={() =>
          setOpenPanel((p) =>
            p?.view === 'settings' && p.tab === 'knowledge' ? null : { view: 'settings', tab: 'knowledge' },
          )
        }
        onOpenSettings={() =>
          setOpenPanel((p) =>
            p?.view === 'settings' && p.tab === 'model' ? null : { view: 'settings', tab: 'model' },
          )
        }
        onOpenDiagnostics={() => setOpenPanel({ view: 'diagnostics' })}
        onOpenHelp={() => setOpenPanel({ view: 'help' })}
        onRerunWizard={() => void window.mc.rerunOnboarding()}
        onHide={() => window.mc.hide()}
        onQuit={() => window.mc.quit()}
      />

      {/* grandfathered users (settings.json predates the wizard) get one
          dismissible pointer at the new wizard; wizard-created profiles never
          carry onboarding.migratedFromV1, so they never see it */}
      {showUpgradeNotice && (
        <div className="upgrade-banner">
          <span>{t.app.upgradeNotice}</span>
          <button className="btn btn-sm btn-primary" onClick={() => void window.mc.rerunOnboarding()}>
            {t.app.upgradeCheck}
          </button>
          <button className="btn btn-sm" onClick={() => void dismissUpgradeNotice()}>
            {t.app.upgradeSkip}
          </button>
        </div>
      )}

      {openPanel?.view === 'diagnostics' && (
        <DiagnosticsPanel onClose={() => setOpenPanel(null)} />
      )}

      {openPanel?.view === 'help' && (
        <HelpPanel
          onClose={() => setOpenPanel(null)}
          onOpenSettings={() => setOpenPanel({ view: 'settings', tab: 'model' })}
          onOpenDiagnostics={() => setOpenPanel({ view: 'diagnostics' })}
        />
      )}

      {openPanel?.view === 'settings' && settings && (
        <SettingsPanel
          key={openPanel.tab}
          settings={settings}
          initialTab={openPanel.tab}
          health={health ?? undefined}
          sessionId={currentId}
          onSettingsRefreshed={setSettings}
          onSaved={(s) => {
            setSettings(s);
            answerLangRef.current = s.llm.answerLang;
            setOpenPanel(null);
          }}
          onClose={() => setOpenPanel(null)}
          onRerunWizard={() => {
            setOpenPanel(null);
            void window.mc.rerunOnboarding();
          }}
          onOpenDiagnostics={() => setOpenPanel({ view: 'diagnostics' })}
          onOpenHelp={() => setOpenPanel({ view: 'help' })}
        />
      )}

      <div className="prompt-shell">
        <TranscriptRail
          segments={segments}
          partials={partials}
          answersReady={answersReady}
          answersHint={t.health.answersDisabled}
          onAsk={(text) => askLlm('segment', text)}
          onTranslate={translateSegment}
          onClear={clearTranscript}
        />
        <PromptFocus
          sessions={sessions}
          currentId={currentId}
          turns={current?.turns ?? []}
          resumeName={current?.resumeName}
          resumeChars={current?.resumeText?.length ?? 0}
          jdName={current?.jdName}
          jdChars={current?.jdText?.length ?? 0}
          notice={kbNotice}
          visionReady={visionReady}
          answersReady={answersReady}
          answersHint={t.health.answersDisabled}
          onSwitch={setCurrentId}
          onNew={createSession}
          onDelete={deleteSession}
          onRename={renameSession}
          onPickKb={(slot) => void pickKb(slot)}
          onClearKb={clearKb}
          onCancel={cancelTurn}
          onClear={() => patchSession(currentIdRef.current, (s) => ({ ...s, turns: [] }))}
          onFreeAsk={(q) => askLlm('free', q)}
          onShotAsk={askShot}
        />
      </div>

      <StatusBar
        asr={asr}
        capturing={capturing}
        hud={showHud ? hud : undefined}
        health={health ?? undefined}
        cacheHitRate={cacheHitRate}
        ragState={ragState}
        onOpenHealth={() =>
          setOpenPanel((p) =>
            p?.view === 'settings' && p.tab === 'health' ? null : { view: 'settings', tab: 'health' },
          )
        }
        onOpenKnowledge={() =>
          setOpenPanel((p) =>
            p?.view === 'settings' && p.tab === 'knowledge' ? null : { view: 'settings', tab: 'knowledge' },
          )
        }
      />
    </div>
    </I18nProvider>
  );
}
