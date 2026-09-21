/**
 * SDD contract: IPC protocol between main <-> renderer, and the settings schema.
 * Version this file; breaking changes bump PROTOCOL_VERSION.
 */
export const PROTOCOL_VERSION = 1;

import type { ProviderCapability, ProviderId } from './providerCatalog';
export type { ProviderCapability, ProviderId } from './providerCatalog';
import type { ThinkingLevel } from './thinking';
export type { ThinkingLevel } from './thinking';
import type { QuestionKind } from './textHeuristics';
export type { QuestionKind } from './textHeuristics';
import type { TrayRendererCommand } from './trayMenu';
export type { TrayCommand, TrayRendererCommand } from './trayMenu';
import type { SearchProviderId } from './searchProviders';
export type { SearchProviderId } from './searchProviders';
import type { ExamSubMode } from './bankStore';
export type { ExamSubMode } from './bankStore';
import type { Persona as ExamPersona } from './persona';
export type { Persona as ExamPersona, TraitTarget as ExamTraitTarget } from './persona';

// ---------- Settings ----------

export type AsrLanguage = 'auto' | 'chinese' | 'english';
export type AnswerLang = 'chinese' | 'english';
/** who is speaking: the other party (system audio) vs the user (microphone) */
export type Speaker = 'them' | 'me';
/** answer-body font size (right pane only) */
export type FontScale = 'small' | 'medium' | 'large';
/** UI theme; 'system' follows prefers-color-scheme */
export type ThemeMode = 'dark' | 'light' | 'system';
/** UI display language (independent of answerLang, which steers the LLM) */
export type UiLang = 'zh' | 'en';
/** per-session material slots: resume vs job description */
export type KbSlot = 'resume' | 'jd';

/** outcome of a provider connection test (Phase 3 runs them; the settings
 * schema stores the last result so the UI can show it after a restart) */
export type ProviderTestCode =
  | 'OK'
  | 'INVALID_KEY'
  | 'PERMISSION_DENIED'
  | 'INSUFFICIENT_BALANCE'
  | 'RATE_LIMITED'
  | 'MODEL_NOT_FOUND'
  | 'REGION_MISMATCH'
  | 'NETWORK_UNREACHABLE'
  | 'DNS_ERROR'
  | 'TLS_ERROR'
  | 'PROXY_ERROR'
  | 'TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'UNKNOWN_ERROR';

/** last connection-test result for one provider slot */
export interface ProviderVerification {
  /** ISO-8601 */
  lastTestAt?: string;
  lastTestOk?: boolean;
  lastTestCode?: ProviderTestCode;
  latencyMs?: number;
}

/**
 * Which stored credential/verification slot a test belongs to. Mirrors the
 * settings layout: `asr.cloud` and `asr.realtime` are separate slots so
 * switching backends never clobbers the other one's key or test result.
 */
export type ProviderSlot = 'llm' | 'vision' | 'asr-cloud' | 'asr-realtime';

/**
 * renderer -> main: run ONE connection test. Explicit user action only — the
 * app never tests on startup, and every test costs the user a (minimal) API
 * call: 1 token, ~1.4 s of audio, or a 64x64 image.
 */
export interface ProviderTestRequest {
  /** catalog preset the user picked, when the choice came from the catalog */
  presetId?: string;
  capability: ProviderCapability;
  providerId: ProviderId;
  baseUrl: string;
  model: string;
  /**
   * Plaintext key to test BEFORE it is saved. renderer -> main only: it is
   * never persisted by this call, never logged, and never echoed back.
   */
  candidateApiKey?: string;
  /** test the key already stored in `slot` instead of supplying one */
  useStoredKey?: boolean;
  /** where to read the stored key from and where to record the verdict */
  slot?: ProviderSlot;
  /** vision only: '127.0.0.1:7897'-style local proxy */
  proxyUrl?: string;
  /**
   * ASR only: which bundled test clip to send and which language hint to pass.
   * Absent = main fills it in from `asr.language`.
   */
  language?: AsrLanguage;
}

/**
 * main -> renderer verdict. The messages are built by the unified mapper
 * (electron/providerErrors.ts), so the renderer never has to interpret a raw
 * provider error — which is also what keeps keys and Authorization headers out
 * of the UI.
 */
export interface ProviderTestResult {
  ok: boolean;
  code: ProviderTestCode;
  /** round-trip of the test call itself, present on success and on failure */
  latencyMs?: number;
  messageZh: string;
  messageEn: string;
  /** for the collapsible advanced detail, when the provider volunteered one */
  providerRequestId?: string;
  retryable: boolean;
}

/** the plan the user picked in the first-run wizard */
export type OnboardingPlan = 'recommended' | 'mimo-simple' | 'transcription-only' | 'advanced';

/** first-run wizard state (settings v2) */
export interface OnboardingState {
  /** wizard-state schema, independent of the settings-file version */
  schemaVersion: 1;
  /** false = the setup window owns startup; the main window never opens */
  completed: boolean;
  /** ISO-8601 timestamp of completion */
  completedAt?: string;
  /** 1-based step the user got to (for 保存并稍后继续) */
  lastStep?: number;
  selectedPlan?: OnboardingPlan;
  /** grandfathered users dismissed the "there is a wizard now" notice */
  dismissedUpgradePrompt?: boolean;
  /** set once by the v1 -> v2 migration: this profile was configured by hand
   * before the wizard existed, so the main window offers the upgrade notice.
   * A fresh profile that completed the wizard never carries it. */
  migratedFromV1?: boolean;
}

/** renderer -> main partial onboarding update (never touches `completed`) */
export interface OnboardingProgressPatch {
  lastStep?: number;
  selectedPlan?: OnboardingPlan;
  dismissedUpgradePrompt?: boolean;
}

/** wizard -> main: finish onboarding and hand over to the main window */
export interface OnboardingCompletePayload {
  selectedPlan?: OnboardingPlan;
}

/** identity of the running build (shown in the wizard footer / about) */
export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  /** false in `npm run dev`, true inside an installed build */
  packaged: boolean;
}

/**
 * Transcript-pane width bounds, shared by the renderer's drag handler and the
 * main-process clamp. Two independent copies of these numbers always drift.
 */
export const PANE_SPLIT_MIN = 0.15;
export const PANE_SPLIT_MAX = 0.85;
export const PANE_SPLIT_DEFAULT = 0.5;

/** NaN / Infinity / absent all land on the default instead of poisoning the layout */
export function clampPaneSplit(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return PANE_SPLIT_DEFAULT;
  return Math.min(PANE_SPLIT_MAX, Math.max(PANE_SPLIT_MIN, v));
}

export interface SettingsFile {
  version: 2;
  /** first-run wizard state; added in v2 (migrated files are grandfathered) */
  onboarding: OnboardingState;
  llm: {
    baseUrl: string;
    model: string;
    /** reply language for AI answers (R: 模式选择); default chinese */
    answerLang: AnswerLang;
    /** answer with the vision/multimodal provider instead of the text model */
    answerWithVision?: boolean;
    /** encrypted-at-rest (safeStorage, base64); never exposed raw to renderer */
    apiKeyEnc?: string;
    /** catalog provider behind baseUrl+model; 'custom' when unmatched */
    providerId?: ProviderId;
    /** last <=4 characters of the saved key, computed main-side at save time */
    apiKeyHint?: string;
    verification?: ProviderVerification;
    /** model thinking effort for the primary slot; absent = never send the
     * parameter (provider default). Per routing target in thinkingByPreset. */
    thinking?: ThinkingLevel;
    /** presetId -> thinking level for routed backends */
    thinkingByPreset?: Record<string, ThinkingLevel>;
    /** upgrade P1: per-question-kind backend routing + failover chain.
     * byKind maps a QuestionKind to a catalog preset id ('' = primary slot);
     * fallbackChain lists preset ids tried after the chosen backend fails. */
    routing?: {
      enabled?: boolean;
      byKind?: Partial<Record<QuestionKind, string>>;
      fallbackChain?: string[];
    };
    /** per-preset API keys for routing targets (presetId -> slot); encrypted.
     * Only targets that do NOT share the primary provider's key need an
     * entry (keyless providers like Ollama never do). */
    routeKeys?: Record<string, { apiKeyEnc?: string; apiKeyHint?: string }>;
  };
  vision: {
    baseUrl?: string;
    model?: string;
    apiKeyEnc?: string;
    /** proxy for blocked providers (e.g. Gemini): '127.0.0.1:7897'; empty = direct */
    proxyUrl?: string;
    /** upgrade P2: OCR prefilter — text-rich region shots answer via the fast
     * text LLM from locally extracted text; requires tesseract.js installed */
    ocrPrefilter?: boolean;
    providerId?: ProviderId;
    apiKeyHint?: string;
    verification?: ProviderVerification;
  };
  asr: {
    language: AsrLanguage;
    /** override models dir; default %APPDATA%/MeetingAssistant/models */
    modelsDir?: string;
    /** catalog provider behind the ACTIVE cloud slot; absent for local backends */
    providerId?: ProviderId;
    /** 'local-realtime' = auto-spawned local sidecar (FunASR or MOSS);
     * 'local' = whisper turbo on-device; 'cloud' = OpenAI-compatible ASR API;
     * 'cloud-realtime' = remote WebSocket streaming (e.g. Aliyun fun-asr-realtime) */
    backend?: 'local' | 'cloud' | 'cloud-realtime' | 'local-realtime';
    /** cloud ASR provider (used when backend === 'cloud') */
    cloud?: {
      baseUrl?: string;
      model?: string;
      apiKeyEnc?: string;
      apiKeyHint?: string;
      verification?: ProviderVerification;
    };
    /** streaming cloud ASR provider (used when backend === 'cloud-realtime');
     * separate slot so switching backends never clobbers the other's config */
    realtime?: {
      /** wss:// endpoint, e.g. wss://{ws}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference */
      baseUrl?: string;
      model?: string;
      apiKeyEnc?: string;
      apiKeyHint?: string;
      verification?: ProviderVerification;
    };
    /** local sidecar (backend === 'local-realtime'); fixed localhost endpoint,
     * model is FunASR Nano, paraformer streaming, or experimental MOSS */
    localRealtime?: {
      model?: string;
    };
    /** upgrade P1: dual-engine strategy — moonshine-tiny as the English fast
     * lane alongside whisper. 'accuracy' = whisper-only, 'latency' = all
     * English on moonshine, 'balanced' = short English segments on moonshine */
    strategy?: 'accuracy' | 'balanced' | 'latency';
    /** load the moonshine fast lane at all (default off — opt-in download) */
    moonshineEnabled?: boolean;
  };
  ui: {
    stealth: boolean;
    hotkeyToggle: string;
    /** global hotkey for region-screenshot Q&A */
    hotkeyShot: string;
    /**
     * Global hotkey for "answer the latest line". Exists because in dual-screen
     * mode the main window is hidden and the per-line ⚡答 button is
     * unreachable — without it the phone could only ever show the transcript.
     */
    hotkeyAnswer?: string;
    /**
     * Start answering while the other party is still speaking, as soon as the
     * in-flight line reads as a complete question, instead of waiting for the
     * VAD hangover (~1.4 s of silence) plus the continuous-mode debounce.
     */
    earlyAnswer?: boolean;
    /**
     * Width of the transcript pane as a fraction of the window (clamped to
     * 0.15–0.85). Persisted because the useful split depends on how dense the
     * other party talks and on the screen size — nobody wants to re-drag the
     * divider every launch.
     */
    paneSplit?: number;
    /** Collapse the transcript away and give the whole window to the answer. */
    answerOnly?: boolean;
    opacity: number;
    /** answer-body font size (small=13px / medium=16px / large=19px) */
    fontScale: FontScale;
    theme: ThemeMode;
    /** UI display language; absent = follow OS locale (zh → zh, else en) */
    lang?: UiLang;
    /** start MeetingAssistant with the OS session; DEFAULT OFF, user opt-in only */
    autoLaunch?: boolean;
    /** the "still running in the tray" balloon was shown once; never repeated */
    trayNoticeShown?: boolean;
  };
  audio: {
    /** input used for the other-party channel on platforms without loopback */
    themDeviceId?: string;
    /** also capture the microphone (dual-channel transcription: 对方 + 我) */
    micEnabled: boolean;
    /** chosen mic device id ('' / undefined = system default) */
    micDeviceId?: string;
    /** upgrade P1.5: 'native' = WASAPI loopback via the optional napi-rs
     * module (Windows); 'webaudio' = the default renderer capture path.
     * Native mode degrades to webaudio automatically when the artifact is
     * missing or fails to start. */
    captureBackend?: 'webaudio' | 'native';
  };
  /** upgrade P0: RAG knowledge layers (pure-JS vector index + local embedder) */
  rag: {
    /** master switch; off = never spawn the embed worker, zero RAM cost */
    enabled?: boolean;
    /** embedding model key (EMBEDDING_MODELS); default 'bge-m3' */
    model?: string;
    /** retrieval result count injected per question */
    topK?: number;
    /** minimum cosine similarity to accept a hit */
    minScore?: number;
    /** mirror origin for model download-on-demand (HF blocked in CN);
     * '' = default huggingface.co */
    remoteHost?: string;
    /**
     * Path to a pre-chunked knowledge base (its `991_index.jsonl`, or any
     * folder inside it). When set, those chunks are retrieved verbatim instead
     * of being re-chunked, preserving the author's section boundaries.
     */
    kbIndex?: string;
  };
  /**
   * Web search fallback for questions the knowledge base could not answer.
   * Off by default and BYOK: no search request ever leaves the machine until
   * the user stores a key here (electron/websearch.ts).
   */
  webSearch: {
    enabled?: boolean;
    providerId?: SearchProviderId;
    /** encrypted-at-rest (safeStorage, base64); never exposed raw to renderer */
    apiKeyEnc?: string;
    /** last <=4 characters, computed main-side at save time */
    apiKeyHint?: string;
    /** results per query, 1-10; default 5 */
    maxResults?: number;
    /** hard deadline for one search; default 2500ms */
    timeoutMs?: number;
  };
  /**
   * 做题模式 (exam mode) — a separate small window for online assessments.
   * Its banks and persona live here and NEVER enter the interview RAG index, so
   * an 行测 pack can't start answering interview questions (shared/bankStore.ts).
   */
  exam: {
    /** local question-bank directory per sub-mode (undefined = unbound) */
    banks?: Partial<Record<ExamSubMode, string>>;
    /** sub-mode the small window opens in */
    subMode?: ExamSubMode;
    /** fixed personality-test persona (targets + why), built by research or by hand */
    persona?: ExamPersona;
    /** where the user parked the small window */
    bounds?: { x: number; y: number; width: number; height: number };
    /** read the screen with local OCR first, vision model only as a fallback */
    preferOcr?: boolean;
    /** fall back to web search when neither the bank nor the model is sure */
    webFallback?: boolean;
    /** global hotkey that opens/raises the exam window */
    hotkeyOpen?: string;
    /** global hotkey for "capture the screen and answer" */
    hotkeyAsk?: string;
  };
  /**
   * Privacy access audit: when on, sensitive local-capability use and system
   * inventory probes are written as JSONL with the API name and the actual
   * system response (secrets redacted, payloads truncated).
   */
  privacy: {
    auditEnabled?: boolean;
    /** include full system probe payloads (process list, extensions, devices) */
    captureReturns?: boolean;
    /** ring / file cap; older entries drop first */
    maxEntries?: number;
  };
  /**
   * LAN companion bridge: phone (mobile web app) connects over the local
   * network and receives exam/interview answers pushed from this machine.
   */
  companion: {
    enabled?: boolean;
    /** HTTP+WS port; default 18765 */
    port?: number;
    /** auto-push finished exam answers to connected phones */
    pushExam?: boolean;
    /** also push finished interview answers when continuous answers fire */
    pushInterview?: boolean;
    /** push the live transcript (streaming partial + final lines) */
    pushTranscript?: boolean;
    /** send the captured screenshot itself, not only the answer it produced */
    pushScreenshot?: boolean;
    /**
     * Serve over HTTPS with a self-signed cert. Worth having: Screen Wake Lock
     * (so the phone does not dim mid-meeting) only exists in a secure context,
     * and it encrypts the LAN hop. The bridge falls back to plaintext when the
     * cert cannot be produced rather than failing to start.
     */
    useHttps?: boolean;
    /**
     * The exam ask hotkey captures and answers straight to the phone without
     * raising the small window — for running headless while the PC is unseen.
     */
    hotkeyToPhone?: boolean;
    /** jpeg quality (1-100) and longest edge for the pushed screenshot */
    jpegQuality?: number;
    maxDim?: number;
  };
}

/** What the renderer is allowed to see (no secrets). */
export interface PublicSettings {
  version: 2;
  /**
   * true when the OS credential store is unavailable and API keys can only be
   * obfuscated (the plainCipher fallback). NOT persisted — it describes the
   * running machine, and both `settings:get` and `settings:set` report it so
   * the UI can warn BEFORE a key is sent for saving.
   */
  weakCrypto: boolean;
  /** first-run wizard state — public so the UI can show the upgrade notice */
  onboarding: OnboardingState;
  llm: {
    baseUrl: string;
    model: string;
    answerLang: AnswerLang;
    answerWithVision: boolean;
    apiKeySet: boolean;
    providerId?: ProviderId;
    /** last <=4 characters of the saved key — never the key itself */
    apiKeyHint?: string;
    verification?: ProviderVerification;
    thinking?: ThinkingLevel;
    /** presetId -> level; always a map on the wire ({} when unset) */
    thinkingByPreset: Record<string, ThinkingLevel>;
    routing: {
      enabled: boolean;
      byKind: Partial<Record<QuestionKind, string>>;
      fallbackChain: string[];
    };
    /** routing-target key metadata only — never the key itself */
    routeKeys: Record<string, { apiKeySet: boolean; apiKeyHint?: string }>;
  };
  vision: {
    baseUrl?: string;
    model?: string;
    proxyUrl?: string;
    apiKeySet: boolean;
    ocrPrefilter: boolean;
    providerId?: ProviderId;
    apiKeyHint?: string;
    verification?: ProviderVerification;
  };
  /** personal knowledge base (resume/notes) loaded from an .md file */
  knowledge: { chars: number };
  asr: {
    language: AsrLanguage;
    modelsDir?: string;
    backend: 'local' | 'cloud' | 'cloud-realtime' | 'local-realtime';
    providerId?: ProviderId;
    cloud: {
      baseUrl?: string;
      model?: string;
      apiKeySet: boolean;
      apiKeyHint?: string;
      verification?: ProviderVerification;
    };
    realtime: {
      baseUrl?: string;
      model?: string;
      apiKeySet: boolean;
      apiKeyHint?: string;
      verification?: ProviderVerification;
    };
    localRealtime: { model?: string };
    /** upgrade P1: dual-engine strategy + English fast lane toggle */
    strategy: 'accuracy' | 'balanced' | 'latency';
    moonshineEnabled: boolean;
  };
  ui: {
    stealth: boolean;
    hotkeyToggle: string;
    hotkeyShot: string;
    /** see SettingsFile.ui.hotkeyAnswer — the dual-screen answer trigger */
    hotkeyAnswer: string;
    /** transcript pane fraction, already clamped by getPublic() */
    paneSplit: number;
    answerOnly: boolean;
    opacity: number;
    fontScale: FontScale;
    theme: ThemeMode;
    lang: UiLang;
    autoLaunch: boolean;
    trayNoticeShown: boolean;
  };
  audio: {
    themDeviceId?: string;
    micEnabled: boolean;
    micDeviceId?: string;
    captureBackend: 'webaudio' | 'native';
  };
  /** upgrade P0: RAG knowledge layers — public view (no paths, no secrets) */
  rag: {
    enabled: boolean;
    model: string;
    topK: number;
    minScore: number;
    remoteHost: string;
    /**
     * Path to a pre-chunked knowledge base (its `991_index.jsonl`, or any
     * folder inside it). When set, those chunks are retrieved verbatim instead
     * of being re-chunked, which preserves the author's section boundaries.
     */
    kbIndex?: string;
  };
  /** web-search fallback — public view (key metadata only, never the key) */
  webSearch: {
    enabled: boolean;
    providerId: SearchProviderId;
    apiKeySet: boolean;
    apiKeyHint?: string;
    maxResults: number;
  };
  /** 做题模式 — banks/persona/window prefs (paths are the user's own, on their machine) */
  exam: {
    banks: Partial<Record<ExamSubMode, string>>;
    subMode: ExamSubMode;
    persona?: ExamPersona;
    bounds?: { x: number; y: number; width: number; height: number };
    preferOcr: boolean;
    webFallback: boolean;
    hotkeyOpen: string;
    hotkeyAsk: string;
  };
  /** privacy audit — public view (no log payloads, no secrets) */
  privacy: {
    auditEnabled: boolean;
    captureReturns: boolean;
    maxEntries: number;
  };
  /** LAN companion bridge — public view (no token) */
  companion: {
    enabled: boolean;
    port: number;
    pushExam: boolean;
    pushInterview: boolean;
    pushTranscript: boolean;
    pushScreenshot: boolean;
    useHttps: boolean;
    hotkeyToPhone: boolean;
    jpegQuality: number;
    maxDim: number;
  };
}

/** renderer -> main settings update. Plaintext apiKey in transit only.
 * `apiKeyHint` is deliberately absent: it is derived main-side when a key is
 * saved, so the renderer can never desync (or spoof) it.
 */
export interface SettingsPatch {
  llm?: {
    baseUrl?: string;
    model?: string;
    answerLang?: AnswerLang;
    answerWithVision?: boolean;
    apiKey?: string;
    providerId?: ProviderId;
    verification?: ProviderVerification;
    /** ThinkingLevel to set; `''` = choose 跟随默认 → clear back to unset */
    thinking?: ThinkingLevel | '';
    thinkingByPreset?: Record<string, ThinkingLevel>;
    routing?: {
      enabled?: boolean;
      byKind?: Partial<Record<QuestionKind, string>>;
      fallbackChain?: string[];
    };
    /** plaintext apiKey in transit only; '' clears the preset's key slot */
    routeKeys?: Record<string, { apiKey?: string }>;
  };
  vision?: {
    baseUrl?: string;
    model?: string;
    proxyUrl?: string;
    apiKey?: string;
    ocrPrefilter?: boolean;
    providerId?: ProviderId;
    verification?: ProviderVerification;
  };
  asr?: {
    language?: AsrLanguage;
    backend?: 'local' | 'cloud' | 'cloud-realtime' | 'local-realtime';
    providerId?: ProviderId;
    cloud?: {
      baseUrl?: string;
      model?: string;
      apiKey?: string;
      verification?: ProviderVerification;
    };
    realtime?: {
      baseUrl?: string;
      model?: string;
      apiKey?: string;
      verification?: ProviderVerification;
    };
    localRealtime?: { model?: string };
    strategy?: 'accuracy' | 'balanced' | 'latency';
    moonshineEnabled?: boolean;
  };
  ui?: {
    stealth?: boolean;
    hotkeyToggle?: string;
    hotkeyShot?: string;
    hotkeyAnswer?: string;
    paneSplit?: number;
    answerOnly?: boolean;
    opacity?: number;
    fontScale?: FontScale;
    theme?: ThemeMode;
    lang?: UiLang;
    autoLaunch?: boolean;
    trayNoticeShown?: boolean;
  };
  audio?: { themDeviceId?: string; micEnabled?: boolean; micDeviceId?: string; captureBackend?: 'webaudio' | 'native' };
  rag?: {
    enabled?: boolean;
    model?: string;
    topK?: number;
    minScore?: number;
    remoteHost?: string;
    kbIndex?: string;
  };
  webSearch?: {
    enabled?: boolean;
    providerId?: SearchProviderId;
    /** plaintext key in transit only; '' clears it */
    apiKey?: string;
    maxResults?: number;
    timeoutMs?: number;
  };
  exam?: {
    banks?: Partial<Record<ExamSubMode, string | undefined>>;
    subMode?: ExamSubMode;
    persona?: ExamPersona | null;
    bounds?: { x: number; y: number; width: number; height: number };
    preferOcr?: boolean;
    webFallback?: boolean;
    hotkeyOpen?: string;
    hotkeyAsk?: string;
  };
  privacy?: {
    auditEnabled?: boolean;
    captureReturns?: boolean;
    maxEntries?: number;
  };
  companion?: {
    enabled?: boolean;
    port?: number;
    pushExam?: boolean;
    pushInterview?: boolean;
    pushTranscript?: boolean;
    pushScreenshot?: boolean;
    useHttps?: boolean;
    hotkeyToPhone?: boolean;
    jpegQuality?: number;
    maxDim?: number;
  };
}

// ---------- ASR events (main -> renderer) ----------

export interface SegmentTimings {
  /** Date.now() of the first speech sample of the segment */
  speechStartTs: number;
  /** Date.now() of the last audio sample of the segment (speech end) */
  speechEndTs: number;
  /** when VAD closed the segment (speechEndTs + hangover) */
  vadCloseTs: number;
  inferStartTs: number;
  inferEndTs: number;
}

export interface AsrSegmentEvent {
  kind: 'segment';
  id: number;
  text: string;
  lang?: string;
  speaker: Speaker;
  audioMs: number;
  timings: SegmentTimings;
}

export interface AsrReadyEvent {
  kind: 'ready';
  loadMs: number;
  warmMs: number;
  ep: string;
  gpuSuspect: boolean; // true when warm timing suggests CPU fallback
}

export interface AsrStatusEvent {
  kind: 'status';
  state: 'loading' | 'listening' | 'speech' | 'transcribing' | 'stopped';
  queuedSegments: number;
}

export interface AsrErrorEvent {
  kind: 'error';
  message: string;
  fatal: boolean;
}

/** live streaming partial (transient; replaced by the final segment) */
export interface AsrPartialEvent {
  kind: 'partial';
  speaker: Speaker;
  text: string;
}

export type AsrEvent =
  | AsrSegmentEvent
  | AsrPartialEvent
  | AsrReadyEvent
  | AsrStatusEvent
  | AsrErrorEvent;

// ---------- Sessions (multi-conversation, persisted) ----------

export interface StoredTurn {
  id: string;
  kind: 'segment' | 'continuous' | 'free' | 'translate' | 'vision';
  label: string;
  text: string;
  status: 'streaming' | 'done' | 'error';
  error?: string;
  /** streamed reasoning_content of a thinking model, shown collapsed */
  reasoning?: string;
  /**
   * Prepared-answer direct hit shown above the AI answer (knowledge-base Q&A).
   * Persisted with the turn so a re-read of an old interview shows what the KB
   * said, not just what the model rewrote.
   */
  qa?: QaHitView;
  /** web sources behind an answer the knowledge base could not cover */
  web?: WebSourceView[];
  /** ③ model-written web supplement block (persisted; webPending never is —
   * a stale 'searching' after a restart would be a lie) */
  webSup?: string;
}

/** one knowledge-base Q&A direct hit (rendered verbatim, then enriched) */
export interface QaHitView {
  question: string;
  answer: string;
  /** document the pair came from (file name / 'notes'), for the badge */
  ref?: string;
  /** retrieval confidence in [0,1] (cosine, or 1 for a literal question match) */
  score: number;
  /** true when the question matched literally, not just semantically */
  exact: boolean;
}

export interface WebSourceView {
  title: string;
  url: string;
}

// ---------- 做题模式 (exam mode): screen → bank → answer ----------

/** one candidate the user's bank produced, before semantic confirmation */
export interface ExamBankCandidateView {
  subMode: ExamSubMode;
  stem: string;
  /** option letters + texts, as stored in the bank */
  options: { key: string; text: string }[];
  answer: string;
  answerKey?: string;
  explanation?: string;
  /** the paper/note it came from */
  ref: string;
  section?: string;
  /** lexical confidence from the bank index */
  score: number;
}

/** how an exam answer was produced — the UI labels the result with it */
export type ExamOrigin = 'bank' | 'bank+model' | 'model' | 'model+web' | 'none';

export interface ExamAskPayload {
  requestId: string;
  subMode: ExamSubMode;
  /** question text already known (typed, or transcribed earlier); empty = read the image */
  question?: string;
  /** cropped screenshot of the question */
  imageDataUrl?: string;
  /**
   * The image is a whole screen rather than a crop the user selected, so the
   * reader must first locate the intended question among unrelated content.
   */
  wholeScreen?: boolean;
  /** extra instruction typed alongside the capture */
  instruction?: string;
  /** re-ask the same screen with a new instruction */
  priorAnswer?: string;
  /** the user picked this candidate manually after a "confirm" prompt */
  forceCandidate?: ExamBankCandidateView;
}

export type ExamEvent =
  | { requestId: string; kind: 'stage'; stage: 'reading' | 'searching' | 'thinking' | 'searching-web'; subMode?: ExamSubMode }
  | { requestId: string; kind: 'question'; text: string; via: 'ocr' | 'vision' | 'typed' }
  /** a caveat worth showing but not blocking on (e.g. a second question on
   * screen was also a plausible match for the whole-screen capture) */
  | { requestId: string; kind: 'note'; text: string }
  /** the bank has it and the confidence is high — this IS the answer */
  | { requestId: string; kind: 'bank'; hit: ExamBankCandidateView; letter?: string }
  /** several bank questions scored similarly: the user (or the model) must pick */
  | { requestId: string; kind: 'ambiguous'; candidates: ExamBankCandidateView[] }
  | { requestId: string; kind: 'delta'; text: string }
  | { requestId: string; kind: 'done'; text: string; origin: ExamOrigin; ms: Record<string, number> }
  | { requestId: string; kind: 'error'; message: string }

export interface ExamBankStatusView {
  subMode: ExamSubMode;
  dir: string;
  entries: number;
  mc: number;
  unanswered: number;
  files: number;
  scanned: number;
  ms: number;
  skipped: { name: string; reason: string }[];
  /** repeated copies of the same question, folded into one record */
  duplicates?: number;
  /** questions where two of the user's own files give different answers */
  conflicts?: number;
}

export interface ExamStatusView {
  scanning: boolean;
  current?: string;
  banks: ExamBankStatusView[];
  /** per sub-mode, straight from the store (dir/entries/mc) */
  table: Record<ExamSubMode, { dir?: string; files: number; entries: number; mc: number; loadedAt?: number }>;
}

// ---------- continuous-mode question gate (面试模式) ----------

export interface LlmGateResult {
  requestId: string;
  /** what the caller should do with this transcript line */
  verdict: 'answer' | 'skip';
  /** 'heuristic' = decided for free, 'model' = one classifier call */
  via: 'heuristic' | 'model';
  ms: number;
}

export interface StoredSession {
  id: string;
  name: string;
  createdAt: number;
  turns: StoredTurn[];
  /** per-session transcript (isolated per meeting, same as the conversation) */
  segments?: import('./transcript').TranscriptSegment[];
  /** true once named (auto from first question, or manually renamed) */
  titled?: boolean;
  /** legacy single-slot KB (pre dual-slot); migrated to the resume slot on load */
  kbName?: string;
  kbText?: string;
  /** dual-slot session material: resume + job description (P0-2) */
  resumeName?: string;
  resumeText?: string;
  jdName?: string;
  jdText?: string;
  /** rolling interview memo (P1): ≤800-char structured summary, async-updated */
  memo?: string;
}

export interface SessionsFile {
  sessions: StoredSession[];
  currentId: string | null;
}

// ---------- LLM (R4): renderer <-> main ----------

export interface LlmAskPayload {
  requestId: string;
  mode: 'segment' | 'continuous' | 'free' | 'translate';
  /** the sentence to answer (segment) or text to translate (translate) */
  question?: string;
  /** free-form question (mode === 'free') */
  freeQuestion?: string;
  /** recent transcript lines, oldest first */
  recentTranscript: string[];
  /** reply language for segment/continuous/free (translate is always zh) */
  answerLang?: AnswerLang;
  /** prior Q&A turns for session coherence (oldest first) */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** legacy single-slot KB (kept for compat; treated as resume material) */
  background?: string;
  /** dual-slot session material (P0-2) */
  resume?: string;
  jd?: string;
  /** rolling interview memo (P1) */
  memo?: string;
  /** owning session id (upgrade P0) — scopes RAG retrieval to this session's
   * material plus the global knowledge layers; absent = global layers only */
  sessionId?: string;
}

export type LlmEvent =
  | { requestId: string; kind: 'delta'; text: string }
  /** streamed reasoning_content from a thinking model — shown collapsed, the
   * deltas below stay the answer itself */
  | { requestId: string; kind: 'reasoning'; text: string }
  /** a knowledge-base Q&A direct hit: the renderer shows it immediately, the
   * streamed deltas below are the AI's enrichment of it */
  | { requestId: string; kind: 'qa'; hit: QaHitView }
  /** the KB missed and the web search ran: the sources behind the answer */
  | { requestId: string; kind: 'web'; sources: WebSourceView[] }
  /** ③ 先答后补: the KB missed and a web search is running behind the main
   * answer — the renderer may show a waiting hint */
  | { requestId: string; kind: 'web-pending' }
  /** the finished supplement block, delivered whole (sentinel already filtered) */
  | { requestId: string; kind: 'web-sup'; text: string }
  /** the supplement path is over: appended, silent (no hits), failed or cancelled */
  | { requestId: string; kind: 'web-done' }
  | {
      requestId: string;
      kind: 'done';
      text: string;
      /** token accounting from the serving provider (DeepSeek adds cache
       * counters); used by the latency HUD for the prefix-cache hit rate */
      usage?: {
        promptTokens?: number;
        completionTokens?: number;
        promptCacheHit?: number;
        promptCacheMiss?: number;
      };
      /** pipeline-latency ④: per-stage ms of this answer (main-side clocks).
       * retrieveMs = rag.retrieve wall time, ttftMs = ask received → 1st delta */
      timings?: { retrieveMs?: number; ttftMs?: number };
    }
  | { requestId: string; kind: 'error'; message: string };

// ---------- RAG knowledge layers (upgrade P0) ----------

/** result of saving L2 personal notes (strict 8000-char cap, never truncated) */
export interface NotesSaveResult {
  ok: boolean;
  chars: number;
  error?: 'too-long';
}

/** renderer view of one retrieval hit (no ids, no vectors) */
export interface RagHitView {
  text: string;
  source: string;
  ref?: string;
  score: number;
}

/** a /trigger skill (upgrade P3) — metadata only, body stays main-side */
export interface SkillView {
  name: string;
  trigger: string;
  description: string;
}

// ---------- document library (multi-file knowledge base) ----------

/** one imported document in the global knowledge library (L3 semantic recall) */
export interface KnowledgeFile {
  /** unique label used as the RAG record ref (basename or dir-relative path) */
  ref: string;
  /** display name (basename) */
  name: string;
  /** source path — diagnostics only, never shown raw */
  path: string;
  chars: number;
  /** ISO-8601 */
  addedAt: string;
}

/** the imported-document manifest, for the knowledge panel file list */
export interface KnowledgeFilesState {
  files: KnowledgeFile[];
  chars: number;
}

/**
 * One auto-detected prepared answer (knowledge-base Q&A pair), as listed by
 * the knowledge panel. `sessionId` absent = global (a document / note), set =
 * it came from that interview's own resume / JD.
 */
export interface PreparedQaView {
  question: string;
  answer: string;
  /** document the pair came from (file name, or 'notes') */
  ref?: string;
  sessionId?: string;
}

/** result of importing a set of files / a directory into the library */
export interface KnowledgeImportResult {
  /** files whose text was ingested into the RAG index */
  imported: number;
  /** unsupported extension or empty text */
  skipped: number;
  /** parse threw (corrupt file, bad encoding, …) */
  failed: number;
  /** total chars ingested */
  chars: number;
  /** total RAG chunks added */
  chunks: number;
}

/** embed-worker / index health, polled by the knowledge panel */
export interface RagStatus {
  /** RAG master switch (settings) */
  enabled: boolean;
  /** worker state: idle (not spawned), loading, ready, error */
  state: 'idle' | 'loading' | 'ready' | 'error';
  modelKey: string;
  modelHfId: string;
  dim: number;
  /** true once the model files are cached locally (no download needed) */
  modelLocal: boolean;
  source: 'local' | 'download' | null;
  loadMs: number | null;
  chunks: number;
  bySource: Record<string, number>;
  lastError: string;
  /** first-run download progress (0-100) when loading and not local */
  downloadPct: number | null;
  /** pre-chunked knowledge base bound via rag.kbIndex */
  kb: {
    /** the configured path, shown even before anything has been loaded */
    configured: string;
    loaded: boolean;
    chunks: number;
    docs: number;
    aliases: number;
    error: string;
  };
}

// ---------- System tray (main -> renderer) ----------

/**
 * A tray menu entry the MAIN process cannot service on its own: capture,
 * sessions and every panel live in the renderer. Main always makes the window
 * visible first, so the renderer may assume it is on screen.
 */
export interface TrayCommandPayload {
  command: TrayRendererCommand;
}

// ---------- LAN companion bridge (mobile display) ----------

/** one phone that has been paired with this machine */
export interface CompanionDeviceView {
  /** device label the phone gave when it paired */
  name: string;
  /** when it last completed an authenticated handshake (epoch ms, 0 = never) */
  lastSeen: number;
  /** true while a socket for it is open right now */
  online: boolean;
}

/**
 * Live state of the bridge — never persisted. The URL must carry the
 * **actually bound** port: when the configured port is taken the bridge falls
 * back to the next one, and a QR encoding the configured port points the phone
 * at nothing while still looking perfectly plausible.
 */
export interface CompanionState {
  running: boolean;
  /** why it is not running / not reachable ('' when fine) */
  error: string;
  port: number;
  https: boolean;
  /** full reach URL incl. scheme, e.g. https://192.168.10.231:18765/ */
  url: string;
  /** pending pairing code shown only on this machine ('' = none pending) */
  pairingCode: string;
  /** epoch ms when the pending code dies */
  pairingExpiresAt: number;
  devices: CompanionDeviceView[];
  /** coalesced event count actually sent since the bridge started */
  sentEvents: number;
  /** events dropped because a phone could not keep up (backpressure) */
  droppedEvents: number;
  /** mean one-way wire latency in ms measured by ping/pong (-1 = unmeasured) */
  lagMs: number;
}

// ---------- IPC channel names ----------

export const IPC = {
  /** renderer -> main, fire and forget: (ArrayBuffer pcmF32, captureTs, Speaker) */
  capturePcm: 'capture:pcm',
  /** invoke: (text) => string — cheap one-shot translation to Chinese (inline, off-session) */
  translateText: 'llm:translate',
  /** renderer -> main: capture lifecycle */
  captureStarted: 'capture:started',
  captureStopped: 'capture:stopped',
  /** main -> renderer: AsrEvent */
  asrEvent: 'asr:event',
  /** invoke: () => {ready, status} — pull the last ready/status AsrEvents.
   * Cloud engines are ready in ms, BEFORE React subscribes; push-replay on
   * did-finish-load still races the subscription, so the renderer pulls. */
  asrReplay: 'asr:replay',
  /** invoke: () => PublicSettings */
  settingsGet: 'settings:get',
  /** invoke: (SettingsPatch) => PublicSettings */
  settingsSet: 'settings:set',
  /** invoke: () => {chars:number} — import a .md into the GLOBAL default KB (opens dialog) */
  knowledgeImport: 'knowledge:import',
  /** invoke: () => {chars:number} — clear the global default KB */
  knowledgeClear: 'knowledge:clear',
  /** invoke: () => KnowledgeImportResult — multi-select file import into the
   * document library (.md/.txt/.docx/.pdf/.pptx), ingested for semantic recall */
  knowledgeImportFiles: 'knowledge:import-files',
  /** invoke: () => KnowledgeImportResult — recursive directory import */
  knowledgeImportDir: 'knowledge:import-dir',
  /** invoke: () => KnowledgeFilesState — the imported-document manifest */
  knowledgeFilesList: 'knowledge:files-list',
  /** invoke: (ref) => KnowledgeFilesState — drop one document + its chunks */
  knowledgeRemoveFile: 'knowledge:remove-file',
  /** invoke: () => KnowledgeFilesState — clear the whole document library */
  knowledgeFilesClear: 'knowledge:files-clear',
  /** invoke: (KbSlot) => {name,text,chars} | null — pick a resume/JD document
   * (.md/.txt/.docx/.pdf, parsed deterministically) for the CURRENT session */
  knowledgePick: 'knowledge:pick',
  /** invoke: ({slot, sessionId}) => { dropped: number } — a session removed its
   * resume/JD, so its indexed chunks AND its prepared Q&A must go too */
  knowledgeDropSlot: 'knowledge:drop-slot',
  /** invoke: () => SessionsFile — load persisted sessions */
  sessionsLoad: 'sessions:load',
  /** send: (SessionsFile) — persist sessions (debounced by renderer) */
  sessionsSave: 'sessions:save',
  /** invoke: (sessionId) => { dropped: number } — a session was deleted in the
   * UI: drop its RAG material (resume/JD/facts) so the index stays in lock-step
   * with sessions.json. The renderer removes the record from the file itself. */
  sessionDelete: 'sessions:delete',
  /** invoke: () => string|null — full-screen capture, drag a region (stealth overlay), returns cropped dataURL */
  regionPick: 'region:pick',
  /** invoke (overlay→main): () => string|null — the captured full-screen image to draw */
  regionImage: 'region:image',
  /** send (overlay→main): (rect) — chosen region */
  regionRect: 'region:rect',
  /** send (overlay→main): () — cancel selection */
  regionCancel: 'region:cancel',
  /** invoke: (boolean) => boolean — toggles content protection live */
  stealthSet: 'stealth:set',
  /** send: hide window */
  winHide: 'win:hide',
  /** send: quit app (clean) */
  appQuit: 'app:quit',
  /** main -> renderer: request auto start capture (dev/E2E) */
  autoStart: 'capture:auto-start',
  /** main -> renderer: the screenshot hotkey was pressed */
  shotHotkey: 'shot:hotkey',
  /** renderer -> main: start a streaming answer (LlmAskPayload) */
  llmAsk: 'llm:ask',
  /** renderer -> main: screenshot + vision question ({requestId, question}); answer streams on llmEvent */
  shotAsk: 'shot:ask',
  /** renderer -> main: cancel a running request (requestId) */
  llmCancel: 'llm:cancel',
  /** main -> renderer: LlmEvent stream */
  llmEvent: 'llm:event',
  /** send: ({resume?, jd?}) — warm the DeepSeek KV prefix cache (P1-6):
   * one max_tokens=1 request whose system prompt is byte-identical to real
   * answer requests, so the first real question prefills from cache */
  llmPrewarm: 'llm:prewarm',
  /** invoke: ({memo, question, answer}) => string — async rolling interview
   * memo update (P1-5); cheap off-critical-path deepseek-flash call, '' = keep old */
  memoUpdate: 'llm:memo',
  /** invoke: () => OnboardingState — first-run wizard state */
  onboardingGet: 'onboarding:get',
  /** invoke: (OnboardingProgressPatch) => OnboardingState — 保存并稍后继续 /
   * dismissing the upgrade notice; never flips `completed` */
  onboardingSaveProgress: 'onboarding:save-progress',
  /** invoke: (OnboardingCompletePayload) => OnboardingState — wizard finished:
   * persist completion, close the setup window and hand over to the main app */
  onboardingComplete: 'onboarding:complete',
  /** invoke: () => boolean — main window asks for the wizard again ("重新运行
   * 配置向导" / the upgrade notice). Re-run mode keeps the main window alive
   * and never quits the app when the wizard is closed. */
  onboardingRerun: 'onboarding:rerun',
  /** invoke: (url) => boolean — open an allowlisted https URL in the OS
   * browser; the renderer can never navigate or window.open by itself */
  externalOpen: 'app:open-external',
  /** invoke: () => string — read the clipboard, ONLY from an explicit
   * paste-button click (never polled) */
  clipboardReadText: 'app:clipboard-read',
  /** invoke: () => AppInfo */
  appGetInfo: 'app:get-info',
  /** invoke: (ProviderTestRequest) => ProviderTestResult — run one real
   * connection test against a provider. Explicit user action only: never on
   * startup, never polled, one minimal billable request per call. Main also
   * records the verdict into the slot's `verification` (a dedicated store
   * write that deliberately does NOT go through settings:set, which would
   * restart the ASR engine). */
  providerTest: 'provider:test',
  /** invoke: () => string — plaintext, locally built support report. Contains
   * no keys, no transcripts and no knowledge-base text (electron/diagnostics.ts) */
  diagnosticsGet: 'diagnostics:get',
  /** invoke: () => boolean — reveal the userData folder in Explorer/Finder */
  logsOpenFolder: 'logs:open-folder',
  /** main -> renderer: TrayCommandPayload — a tray menu entry that only the
   * renderer can service (start/stop capture, new session, open a panel).
   * Main shows the window before sending, so the UI is always visible. */
  trayCommand: 'tray:command',
  // ---- RAG knowledge layers (upgrade P0) ----
  /** invoke: () => RagStatus — embed worker + index health */
  ragStatus: 'rag:status',
  /** invoke: ({query, topK?, sessionId?}) => { hits: RagHitView[], ms } —
   * knowledge-panel search playground; embeds the query on the fly */
  ragSearch: 'rag:search',
  /** invoke: ({model?}) => RagStatus — re-embed every stored chunk (model switch) */
  ragReindex: 'rag:reindex',
  /**
   * invoke: () => RagStatus|null — pick a folder holding a pre-chunked
   * knowledge base (991_index.jsonl) and load it. null = dialog cancelled, so
   * the UI leaves the existing binding alone instead of clearing it.
   */
  ragBindKb: 'rag:bind-kb',
  /** invoke: () => RagStatus — forget the knowledge base binding */
  ragUnbindKb: 'rag:unbind-kb',
  /** invoke: ({sessionId?}) => PreparedQaView[] — the Q&A pairs the knowledge
   * base auto-detected (what a direct hit can serve), for the knowledge panel */
  ragQaList: 'rag:qa-list',
  /** invoke: () => { text, chars } — L2 personal notes (userData/notes.md) */
  notesGet: 'notes:get',
  /** invoke: ({text}) => { ok, chars, error? } — strict 8000-char cap */
  notesSet: 'notes:set',
  /** invoke: () => SkillView[] — loaded /trigger skills (upgrade P3) */
  skillsList: 'skills:list',
  // ---- 做题模式 (exam mode) ----
  /** invoke: () => void — open / raise the small exam window */
  examOpen: 'exam:open',
  /** invoke: () => void — hide it again (Esc / ✕ in the small window) */
  examClose: 'exam:close',
  /** send: (ExamAskPayload) — read the screen and answer; events stream on examEvent */
  examAsk: 'exam:ask',
  /** send: (requestId) — abandon the current exam answer */
  examCancel: 'exam:cancel',
  /** main -> exam window: ExamEvent stream */
  examEvent: 'exam:event',
  /** invoke: () => ExamStatusView — bank scan state per sub-mode */
  examStatus: 'exam:status',
  /** invoke: ({subMode}) => {dir}|null — pick a bank directory, then rescans in background */
  examBind: 'exam:bind',
  /** invoke: ({subMode?}) => ExamStatusView — rescan now (after the user edits files) */
  examRescan: 'exam:rescan',
  /** invoke: ({subMode, question}) => candidates — the panel's bank self-test */
  examBankSearch: 'exam:bank-search',
  /** invoke: ({role, company}) => ExamPersona|null — research what this employer wants */
  examPersonaResearch: 'exam:persona-research',
  /** invoke: ({persona}) => PublicSettings — save a hand-written persona */
  examPersonaSet: 'exam:persona-set',
  /** main -> exam window: BankProgress (scan state) */
  examProgress: 'exam:progress',
  /** invoke: (subMode) => true — remember which sub-mode the window was left in */
  examSetMode: 'exam:set-mode',
  /** main -> exam window: the ask hotkey was pressed — capture and answer */
  examShot: 'exam:shot',
  // ---- question gate (面试模式持续答) ----
  /** invoke: ({requestId, line, recent}) => LlmGateResult — should this line be answered? */
  llmGate: 'llm:gate',
  /** send: ({text, sessionId}) — fire-and-forget: prefetch retrieval for a
   * live ASR partial so the final question hits the cache (pipeline-latency ②) */
  llmSpeculate: 'llm:speculate',
  // ---- upgrade P1.5: optional native audio capture (Windows WASAPI loopback) ----
  /** send: (deviceId?) — main starts the native loopback capture and feeds
   * the ASR host directly; failures push nativeCaptureError (renderer then
   * falls back to Web Audio) */
  nativeCaptureStart: 'native:capture-start',
  /** send: () — stop the native capture */
  nativeCaptureStop: 'native:capture-stop',
  /** main -> renderer: string — the native capture failed (fallback cue) */
  nativeCaptureError: 'native:capture-error',
  /** main -> renderer: RagStatus — pushed whenever the embed worker state
   * changes (loading/ready/error); ragStatus remains the pull channel */
  ragStatusPush: 'rag:status-push',
  // ---- LAN companion bridge (mobile display) ----
  /** invoke: () => CompanionState — live bridge state for the settings panel */
  companionState: 'companion:state',
  /** invoke: () => CompanionState — start/stop the bridge after a settings change */
  companionApply: 'companion:apply',
  /** invoke: () => CompanionState — issue a fresh pairing code (shown on this PC only) */
  companionPair: 'companion:pair',
  /** invoke: (name) => CompanionState — forget a paired device */
  companionRevoke: 'companion:revoke',
  /** invoke: () => string — SVG of the reach-URL QR code, for the settings panel */
  companionQr: 'companion:qr',
  /** invoke: () => { ok, ms, seq } — capture now and push to every paired phone */
  companionShot: 'companion:shot',
  /**
   * invoke: (SettingsPatch['companion']) => CompanionState — narrow write
   * channel for the connect window, which must be able to flip push flags and
   * the enabled switch without being handed the full settings:set (that could
   * rewrite API keys).
   */
  companionPatch: 'companion:patch',
  /** invoke: () => CompanionState — raise the connect window (QR + address) */
  connectOpen: 'connect:open',
  /** send: () — hide the connect window (it never quits the app) */
  connectClose: 'connect:close',
  /**
   * main -> renderer: the answer hotkey was pressed while the main window was
   * hidden. Only reachable in dual-screen mode; the per-line ⚡答 button is not.
   */
  answerHotkey: 'answer:hotkey',
  /**
   * main -> renderer: a phone just authenticated on the bridge. The overlay
   * hides itself on this — from here on the phone is the display, and the PC
   * screen should be showing nothing worth capturing. Ctrl+B or the tray
   * brings it back.
   */
  companionConnected: 'companion:connected',
} as const;
