import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppInfo,
  type AsrEvent,
  type KbSlot,
  type KnowledgeFilesState,
  type KnowledgeImportResult,
  type LlmAskPayload,
  type LlmEvent,
  type NotesSaveResult,
  type OnboardingProgressPatch,
  type OnboardingState,
  type PreparedQaView,
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
  /** the prepared Q&A pairs the knowledge base auto-detected */
  ragQaList(sessionId?: string): Promise<PreparedQaView[]>;
  /** pushed whenever the embed worker state changes */
  onRagStatus(cb: (s: RagStatus) => void): () => void;
  /** L2 personal notes (userData/notes.md); strict 8000-char cap */
  notesGet(): Promise<{ text: string; chars: number; maxChars: number }>;
  notesSet(text: string): Promise<NotesSaveResult>;
  /** loaded /trigger skills (upgrade P3) */
  skillsList(): Promise<SkillView[]>;
  // ---- upgrade P1.5: optional native loopback capture ----
  nativeCaptureStart(deviceId?: string): void;
  nativeCaptureStop(): void;
  onNativeCaptureError(cb: (message: string) => void): () => void;
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
  ragQaList: (sessionId) => ipcRenderer.invoke(IPC.ragQaList, { sessionId }),
  onRagStatus: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, s: RagStatus) => cb(s);
    ipcRenderer.on(IPC.ragStatusPush, listener);
    return () => ipcRenderer.removeListener(IPC.ragStatusPush, listener);
  },
  notesGet: () => ipcRenderer.invoke(IPC.notesGet),
  notesSet: (text) => ipcRenderer.invoke(IPC.notesSet, { text }),
  skillsList: () => ipcRenderer.invoke(IPC.skillsList),
  nativeCaptureStart: (deviceId) => ipcRenderer.send(IPC.nativeCaptureStart, deviceId),
  nativeCaptureStop: () => ipcRenderer.send(IPC.nativeCaptureStop),
  onNativeCaptureError: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, message: string) => cb(message);
    ipcRenderer.on(IPC.nativeCaptureError, listener);
    return () => ipcRenderer.removeListener(IPC.nativeCaptureError, listener);
  },
  hide: () => ipcRenderer.send(IPC.winHide),
  quit: () => ipcRenderer.send(IPC.appQuit),
};

contextBridge.exposeInMainWorld('mc', api);
