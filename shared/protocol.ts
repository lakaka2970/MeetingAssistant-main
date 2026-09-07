/**
 * SDD contract: IPC protocol between main <-> renderer, and the settings schema.
 * Version this file; breaking changes bump PROTOCOL_VERSION.
 */
export const PROTOCOL_VERSION = 1;

import type { ProviderCapability, ProviderId } from './providerCatalog';
export type { ProviderCapability, ProviderId } from './providerCatalog';
import type { QuestionKind } from './textHeuristics';
export type { QuestionKind } from './textHeuristics';
import type { TrayRendererCommand } from './trayMenu';
export type { TrayCommand, TrayRendererCommand } from './trayMenu';

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
    /** override models dir; default %APPDATA%/MeetingCopilot/models */
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
    opacity: number;
    /** answer-body font size (small=13px / medium=16px / large=19px) */
    fontScale: FontScale;
    theme: ThemeMode;
    /** UI display language; absent = follow OS locale (zh → zh, else en) */
    lang?: UiLang;
    /** start MeetingCopilot with the OS session; DEFAULT OFF, user opt-in only */
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
  /** invoke: () => SessionsFile — load persisted sessions */
  sessionsLoad: 'sessions:load',
  /** send: (SessionsFile) — persist sessions (debounced by renderer) */
  sessionsSave: 'sessions:save',
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
   * memo update (P1-5); cheap off-critical-path deepseek-chat call, '' = keep old */
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
  /** invoke: () => { text, chars } — L2 personal notes (userData/notes.md) */
  notesGet: 'notes:get',
  /** invoke: ({text}) => { ok, chars, error? } — strict 8000-char cap */
  notesSet: 'notes:set',
  /** invoke: () => SkillView[] — loaded /trigger skills (upgrade P3) */
  skillsList: 'skills:list',
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
} as const;
