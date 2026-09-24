import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppInfo,
  type AsrEvent,
  type CompanionState,
  type ExamEvent,
  type KbSlot,
  type KnowledgeFilesState,
  type KnowledgeImportProgress,
  type KnowledgeImportResult,
  type LlmAskPayload,
  type LlmEvent,
  type LlmGateResult,
  type NotesSaveResult,
  type OnboardingProgressPatch,
  type OnboardingState,
  type PersonaDraftResult,
  type PreparedQaView,
  type PromptPreviewResult,
  type ProviderTestRequest,
  type ProviderTestResult,
  type PublicSettings,
  type RagHitView,
  type RagStatus,
  type SessionsFile,
  type SettingsPatch,
  type SkillView,
  type TrayCommandPayload,
} from '../shared/protocol';

export interface McApi {
  readonly platform: NodeJS.Platform;
  getSettings(): Promise<PublicSettings>;
  setSettings(patch: SettingsPatch): Promise<PublicSettings>;
  /** first-run wizard state (the main window only reads it / dismisses the
   * upgrade notice — completing onboarding belongs to the setup window) */
  getOnboarding(): Promise<OnboardingState>;
  saveOnboardingProgress(patch: OnboardingProgressPatch): Promise<OnboardingState>;
  /** reopen the setup wizard without closing the app (settings / upgrade notice) */
  rerunOnboarding(): Promise<boolean>;
  importKnowledge(): Promise<{ chars: number }>;
  clearKnowledge(): Promise<{ chars: number }>;
  /** document library (multi-file knowledge base, L3 semantic recall) */
  importKnowledgeFiles(): Promise<KnowledgeImportResult>;
  importKnowledgeDir(): Promise<KnowledgeImportResult>;
  listKnowledgeFiles(): Promise<KnowledgeFilesState>;
  removeKnowledgeFile(ref: string): Promise<KnowledgeFilesState>;
  clearKnowledgeFiles(): Promise<KnowledgeFilesState>;
  /** pick a resume/JD document for the current session (.md/.txt/.docx/.pdf);
   * sessionId also lands the parsed text in the RAG index (upgrade P0) */
  pickKnowledge(slot: KbSlot, sessionId?: string): Promise<{ name: string; text: string; chars: number } | null>;
  /** drop a session slot's indexed chunks + its prepared Q&A */
  dropKnowledgeSlot(slot: KbSlot, sessionId?: string): Promise<{ dropped: number }>;
  loadSessions(): Promise<SessionsFile>;
  saveSessions(data: SessionsFile): void;
  /** drop a deleted session's vector material (resume/JD/facts) in main */
  deleteSession(sessionId: string): Promise<{ dropped: number }>;
  setStealth(on: boolean): Promise<boolean>;
  sendPcm(buf: ArrayBuffer, captureTs: number, channel: 'them' | 'me'): void;
  captureStarted(): void;
  captureStopped(): void;
  translate(text: string): Promise<string>;
  onAsrEvent(cb: (ev: AsrEvent) => void): () => void;
  /** pull the last ready/status events (call AFTER onAsrEvent subscription) */
  asrReplay(): Promise<{ ready: AsrEvent | null; status: AsrEvent | null }>;
  llmAsk(payload: LlmAskPayload): void;
  shotAsk(payload: {
    requestId: string;
    question: string;
    background?: string;
    imageDataUrl?: string;
  }): void;
  /** capture full screen, drag a stealth region overlay; returns cropped dataURL or null */
  pickRegion(): Promise<string | null>;
  /** overlay-only: fetch the captured background image */
  regionImage(): Promise<string | null>;
  /** overlay-only: report chosen rect */
  regionRect(r: { x: number; y: number; width: number; height: number }): void;
  /** overlay-only: cancel */
  regionCancel(): void;
  llmCancel(requestId: string): void;
  /** P1-6: warm the DeepSeek prefix cache with the session's material;
   * immediate=true warms even when not capturing (▶ start / material import) */
  prewarm(payload: { resume?: string; jd?: string; immediate?: boolean }): void;
  /** P1-5: fold a finished Q&A into the rolling memo ('' = keep the old one);
   * sessionId also refreshes the session's claimed-fact vectors (upgrade P3) */
  memoUpdate(p: { memo: string; question: string; answer: string; sessionId?: string }): Promise<string>;
  onLlmEvent(cb: (ev: LlmEvent) => void): () => void;
  /** 截屏问答热键 (main-initiated): the exam-event stream mirrored to this
   * window so the answer lands on the prompt surface too */
  onExamEvent(cb: (ev: ExamEvent) => void): () => void;
  onShotHotkey(cb: () => void): () => void;
  /** tray menu entries only the renderer can service (capture / session /
   * panels). Main has already made the window visible when this fires. */
  onTrayCommand(cb: (payload: TrayCommandPayload) => void): () => void;
  /** open an allowlisted https documentation link in the OS browser;
   * false = refused by the main-process allowlist */
  openExternal(url: string): Promise<boolean>;
  /** read the clipboard — call ONLY from an explicit paste-button click */
  readClipboardText(): Promise<string>;
  getAppInfo(): Promise<AppInfo>;
  /** run ONE real provider connection test; explicit user action only (it
   * costs the user a minimal billable request). Main maps every failure to a
   * ProviderTestCode + zh/en message, so nothing raw reaches the UI. */
  providerTest(req: ProviderTestRequest): Promise<ProviderTestResult>;
  /** plaintext support report, built locally on request. Contains no keys, no
   * transcripts and no knowledge-base text — safe to paste into an issue. */
  getDiagnostics(): Promise<string>;
  /** reveal %APPDATA%/MeetingAssistant (settings, sessions, knowledge) */
  openLogsFolder(): Promise<boolean>;
  // ---- upgrade P0: RAG knowledge layers + L2 notes ----
  /** embed-worker + index health (pull) */
  ragStatus(): Promise<RagStatus>;
  /** knowledge-panel search playground (embeds the query on the fly) */
  ragSearch(p: { query: string; sessionId?: string }): Promise<{ hits: RagHitView[]; ms: number }>;
  /** re-embed every stored chunk; pass a model to switch first */
  ragReindex(model?: string): Promise<RagStatus>;
  /** pick a pre-chunked knowledge base folder; null = cancelled (binding kept) */
  ragBindKb(): Promise<RagStatus | null>;
  /** forget the knowledge base binding */
  ragUnbindKb(): Promise<RagStatus>;
  /** the prepared Q&A pairs the knowledge base auto-detected */
  ragQaList(sessionId?: string): Promise<PreparedQaView[]>;
  /** pushed whenever the embed worker state changes */
  onRagStatus(cb: (s: RagStatus) => void): () => void;
  /** pushed once per file while a document-library import runs */
  onKnowledgeImportProgress(cb: (p: KnowledgeImportProgress) => void): () => void;
  /** L2 personal notes (userData/notes.md); strict 8000-char cap */
  notesGet(): Promise<{ text: string; chars: number; maxChars: number }>;
  notesSet(text: string): Promise<NotesSaveResult>;
  /** v1.0.1 A5: draft an 应答人设 from this session's resume/JD. main returns a
   * draft only — the persona library UI stays the single writer of settings */
  personaDraft(sessionId?: string): Promise<PersonaDraftResult>;
  /** v1.0.1 A5: the exact stable prefix main would send next for this session,
   * so 高级设置 can preview the real bytes instead of a hand-waved summary */
  promptPreview(sessionId?: string): Promise<PromptPreviewResult>;
  /** loaded /trigger skills (upgrade P3) */
  skillsList(): Promise<SkillView[]>;
  // ---- upgrade P1.5: optional native loopback capture ----
  nativeCaptureStart(deviceId?: string): void;
  nativeCaptureStop(): void;
  onNativeCaptureError(cb: (message: string) => void): () => void;
  /** raise the 做题模式 small window; that window has its own minimal bridge */
  openExam(): Promise<boolean>;
  // ---- LAN companion (手机显示) ----
  /** live bridge state: reach URL, bound port, paired devices, lag */
  companionState(): Promise<CompanionState>;
  /** rebind after a settings change (port / HTTPS / enabled) */
  companionApply(): Promise<CompanionState>;
  /** show a fresh 6-digit pairing code on THIS screen only */
  companionPair(): Promise<CompanionState>;
  companionRevoke(name: string): Promise<CompanionState>;
  /** SVG markup of the reach-URL QR code ('' when the bridge is not running) */
  companionQr(): Promise<string>;
  /** capture now, push to the phones and answer with the 做题 pipeline */
  companionShot(): Promise<{ ok: boolean; ms: number; seq: number }>;
  /** raise the QR / pairing window (the 双屏 switch calls this on the way in) */
  openConnect(): Promise<CompanionState>;
  /** main -> renderer: the answer-latest-line hotkey fired while the window was hidden */
  onAnswerHotkey(cb: () => void): () => void;
  /** main -> renderer: a phone authenticated; the overlay hands the display over */
  onCompanionConnected(cb: () => void): () => void;
  /** main -> renderer (⑦): a phone asked to start or stop transcription */
  onCtlCapture(cb: (on: boolean) => void): () => void;
  /** main -> renderer (⑦): a phone asked for continuous answering on or off */
  onCtlContinuous(cb: (on: boolean) => void): () => void;
  /** main -> renderer (⑦): ask this text as if it had been typed on this machine */
  onCtlAsk(cb: (text: string) => void): () => void;
  /** renderer -> main (⑦): the continuous switch moved, so the phone's echo must follow */
  companionContinuous(on: boolean): void;
  /** 面试模式持续答 gate: answer this transcript line or stay quiet? */
  gate(p: { requestId: string; line: string; recent: string[] }): Promise<LlmGateResult>;
  /** continuous mode only: warm the speculative retrieval cache with a partial */
  speculate(p: { text: string; sessionId?: string }): void;
  hide(): void;
  quit(): void;
}

const api: McApi = {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  getOnboarding: () => ipcRenderer.invoke(IPC.onboardingGet),
  saveOnboardingProgress: (patch) => ipcRenderer.invoke(IPC.onboardingSaveProgress, patch),
  rerunOnboarding: () => ipcRenderer.invoke(IPC.onboardingRerun),
  importKnowledge: () => ipcRenderer.invoke(IPC.knowledgeImport),
  clearKnowledge: () => ipcRenderer.invoke(IPC.knowledgeClear),
  importKnowledgeFiles: () => ipcRenderer.invoke(IPC.knowledgeImportFiles),
  importKnowledgeDir: () => ipcRenderer.invoke(IPC.knowledgeImportDir),
  listKnowledgeFiles: () => ipcRenderer.invoke(IPC.knowledgeFilesList),
  removeKnowledgeFile: (ref) => ipcRenderer.invoke(IPC.knowledgeRemoveFile, ref),
  clearKnowledgeFiles: () => ipcRenderer.invoke(IPC.knowledgeFilesClear),
  pickKnowledge: (slot, sessionId) => ipcRenderer.invoke(IPC.knowledgePick, slot, sessionId),
  dropKnowledgeSlot: (slot, sessionId) => ipcRenderer.invoke(IPC.knowledgeDropSlot, { slot, sessionId }),
  loadSessions: () => ipcRenderer.invoke(IPC.sessionsLoad),
  saveSessions: (data) => ipcRenderer.send(IPC.sessionsSave, data),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC.sessionDelete, sessionId),
  setStealth: (on) => ipcRenderer.invoke(IPC.stealthSet, on),
  sendPcm: (buf, captureTs, channel) => ipcRenderer.send(IPC.capturePcm, buf, captureTs, channel),
  captureStarted: () => ipcRenderer.send(IPC.captureStarted),
  captureStopped: () => ipcRenderer.send(IPC.captureStopped),
  translate: (text) => ipcRenderer.invoke(IPC.translateText, text),
  onAsrEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: AsrEvent) => cb(ev);
    ipcRenderer.on(IPC.asrEvent, listener);
    return () => ipcRenderer.removeListener(IPC.asrEvent, listener);
  },
  asrReplay: () => ipcRenderer.invoke(IPC.asrReplay),
  llmAsk: (payload) => ipcRenderer.send(IPC.llmAsk, payload),
  shotAsk: (payload) => ipcRenderer.send(IPC.shotAsk, payload),
  pickRegion: () => ipcRenderer.invoke(IPC.regionPick),
  regionImage: () => ipcRenderer.invoke(IPC.regionImage),
  regionRect: (r) => ipcRenderer.send(IPC.regionRect, r),
  regionCancel: () => ipcRenderer.send(IPC.regionCancel),
  llmCancel: (requestId) => ipcRenderer.send(IPC.llmCancel, requestId),
  prewarm: (payload) => ipcRenderer.send(IPC.llmPrewarm, payload),
  memoUpdate: (p) => ipcRenderer.invoke(IPC.memoUpdate, p),
  onLlmEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: LlmEvent) => cb(ev);
    ipcRenderer.on(IPC.llmEvent, listener);
    return () => ipcRenderer.removeListener(IPC.llmEvent, listener);
  },
  onExamEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: ExamEvent) => cb(ev);
    ipcRenderer.on(IPC.examEvent, listener);
    return () => ipcRenderer.removeListener(IPC.examEvent, listener);
  },
  onShotHotkey: (cb) => {
    const listener = () => cb();
    ipcRenderer.on(IPC.shotHotkey, listener);
    return () => ipcRenderer.removeListener(IPC.shotHotkey, listener);
  },
  onTrayCommand: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: TrayCommandPayload) => cb(payload);
    ipcRenderer.on(IPC.trayCommand, listener);
    return () => ipcRenderer.removeListener(IPC.trayCommand, listener);
  },
  openExternal: (url) => ipcRenderer.invoke(IPC.externalOpen, url),
  readClipboardText: () => ipcRenderer.invoke(IPC.clipboardReadText),
  getAppInfo: () => ipcRenderer.invoke(IPC.appGetInfo),
  providerTest: (req) => ipcRenderer.invoke(IPC.providerTest, req),
  getDiagnostics: () => ipcRenderer.invoke(IPC.diagnosticsGet),
  openLogsFolder: () => ipcRenderer.invoke(IPC.logsOpenFolder),
  ragStatus: () => ipcRenderer.invoke(IPC.ragStatus),
  ragSearch: (p) => ipcRenderer.invoke(IPC.ragSearch, p),
  ragReindex: (model) => ipcRenderer.invoke(IPC.ragReindex, { model }),
  ragBindKb: () => ipcRenderer.invoke(IPC.ragBindKb),
  ragUnbindKb: () => ipcRenderer.invoke(IPC.ragUnbindKb),
  ragQaList: (sessionId) => ipcRenderer.invoke(IPC.ragQaList, { sessionId }),
  onRagStatus: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, s: RagStatus) => cb(s);
    ipcRenderer.on(IPC.ragStatusPush, listener);
    return () => ipcRenderer.removeListener(IPC.ragStatusPush, listener);
  },
  onKnowledgeImportProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, p: KnowledgeImportProgress) => cb(p);
    ipcRenderer.on(IPC.knowledgeImportProgress, listener);
    return () => ipcRenderer.removeListener(IPC.knowledgeImportProgress, listener);
  },
  notesGet: () => ipcRenderer.invoke(IPC.notesGet),
  notesSet: (text) => ipcRenderer.invoke(IPC.notesSet, { text }),
  personaDraft: (sessionId) => ipcRenderer.invoke(IPC.llmPersonaDraft, { sessionId }),
  promptPreview: (sessionId) => ipcRenderer.invoke(IPC.llmPromptPreview, { sessionId }),
  skillsList: () => ipcRenderer.invoke(IPC.skillsList),
  nativeCaptureStart: (deviceId) => ipcRenderer.send(IPC.nativeCaptureStart, deviceId),
  nativeCaptureStop: () => ipcRenderer.send(IPC.nativeCaptureStop),
  openExam: () => ipcRenderer.invoke(IPC.examOpen),
  companionState: () => ipcRenderer.invoke(IPC.companionState),
  companionApply: () => ipcRenderer.invoke(IPC.companionApply),
  companionPair: () => ipcRenderer.invoke(IPC.companionPair),
  companionRevoke: (name) => ipcRenderer.invoke(IPC.companionRevoke, name),
  companionQr: () => ipcRenderer.invoke(IPC.companionQr),
  companionShot: () => ipcRenderer.invoke(IPC.companionShot),
  openConnect: () => ipcRenderer.invoke(IPC.connectOpen),
  onAnswerHotkey: (cb) => {
    const listener = () => cb();
    ipcRenderer.on(IPC.answerHotkey, listener);
    return () => ipcRenderer.removeListener(IPC.answerHotkey, listener);
  },
  onCompanionConnected: (cb) => {
    const listener = () => cb();
    ipcRenderer.on(IPC.companionConnected, listener);
    return () => ipcRenderer.removeListener(IPC.companionConnected, listener);
  },
  onCtlCapture: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, on: boolean) => cb(!!on);
    ipcRenderer.on(IPC.companionCtlCapture, listener);
    return () => ipcRenderer.removeListener(IPC.companionCtlCapture, listener);
  },
  onCtlContinuous: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, on: boolean) => cb(!!on);
    ipcRenderer.on(IPC.companionCtlContinuous, listener);
    return () => ipcRenderer.removeListener(IPC.companionCtlContinuous, listener);
  },
  onCtlAsk: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, text: string) => cb(String(text ?? ''));
    ipcRenderer.on(IPC.companionCtlAsk, listener);
    return () => ipcRenderer.removeListener(IPC.companionCtlAsk, listener);
  },
  companionContinuous: (on) => ipcRenderer.send(IPC.companionContinuous, !!on),
  gate: (p) => ipcRenderer.invoke(IPC.llmGate, p),
  speculate: (p) => ipcRenderer.send(IPC.llmSpeculate, p),
  onNativeCaptureError: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, message: string) => cb(message);
    ipcRenderer.on(IPC.nativeCaptureError, listener);
    return () => ipcRenderer.removeListener(IPC.nativeCaptureError, listener);
  },
  hide: () => ipcRenderer.send(IPC.winHide),
  quit: () => ipcRenderer.send(IPC.appQuit),
};

contextBridge.exposeInMainWorld('mc', api);
