/**
 * Preload bridge for the exam window: `window.mcExam` only.
 *
 * It must share NO runtime module with electron/preload.ts: preloads run
 * sandboxed, where `require` cannot resolve sibling chunks, so a shared import
 * would be split into out/preload/chunks/*.js and BOTH preloads would fail to
 * load (window.mc / window.mcExam silently undefined). The channel names are
 * therefore restated here as literals and pinned to the real table with a
 * type-only `satisfies Pick<typeof IPC, …>` — a rename in shared/protocol.ts
 * breaks this file at compile time without any runtime import.
 *
 * The surface is deliberately narrow: read the screen, ask, cancel, look at
 * bank status, manage the persona. Nothing that could touch the interview
 * session store, ASR, or settings beyond the exam section.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ExamAskPayload, type ExamEvent, type ExamStatusView, type ExamSubMode, type ExamPersona, type PublicSettings, type LlmGateResult } from '../shared/protocol';

const CH = {
  examAsk: 'exam:ask',
  examCancel: 'exam:cancel',
  examEvent: 'exam:event',
  examStatus: 'exam:status',
  examBind: 'exam:bind',
  examRescan: 'exam:rescan',
  examBankSearch: 'exam:bank-search',
  examPersonaResearch: 'exam:persona-research',
  examPersonaSet: 'exam:persona-set',
  examSetMode: 'exam:set-mode',
  examProgress: 'exam:progress',
  examShot: 'exam:shot',
  examClose: 'exam:close',
  settingsGet: 'settings:get',
  regionPick: 'region:pick',
  llmGate: 'llm:gate',
} as const satisfies Pick<
  typeof IPC,
  | 'examAsk'
  | 'examCancel'
  | 'examEvent'
  | 'examStatus'
  | 'examBind'
  | 'examRescan'
  | 'examBankSearch'
  | 'examPersonaResearch'
  | 'examPersonaSet'
  | 'examSetMode'
  | 'examProgress'
  | 'examShot'
  | 'examClose'
  | 'settingsGet'
  | 'regionPick'
  | 'llmGate'
>;

export interface ExamBankProbeResult {
  mode: ExamSubMode;
  stem: string;
  answer: string;
  answerKey?: string;
  letter?: string;
  options: { key: string; text: string }[];
  explanation?: string;
  ref: string;
  section?: string;
  score: number;
  confidence: string;
}

export interface McExamApi {
  readonly platform: NodeJS.Platform;
  getSettings(): Promise<PublicSettings>;
  /** capture a region (the shared overlay) and answer it */
  pickRegion(): Promise<string | null>;
  ask(payload: ExamAskPayload): void;
  cancel(requestId: string): void;
  onExamEvent(cb: (ev: ExamEvent) => void): () => void;
  onProgress(cb: (p: { scanning: boolean; current?: string; done: unknown[] }) => void): () => void;
  /** the global ask hotkey fired: capture the screen and answer it */
  onShot(cb: () => void): () => void;
  status(): Promise<ExamStatusView>;
  bindBank(subMode: ExamSubMode): Promise<{ dir: string } | null>;
  rescan(subMode?: ExamSubMode): Promise<ExamStatusView>;
  probeBank(subMode: ExamSubMode, question: string): Promise<ExamBankProbeResult[]>;
  researchPersona(role: string, company: string): Promise<ExamPersona | null>;
  setPersona(persona: ExamPersona | null): Promise<PublicSettings>;
  /** remember the sub-mode for the next time the window opens */
  setSubMode(subMode: ExamSubMode): Promise<boolean>;
  /** ask the interview-mode gate whether a line deserves an answer (shared logic) */
  gate(p: { requestId: string; line: string; recent: string[] }): Promise<LlmGateResult>;
  hide(): void;
}

const api: McExamApi = {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke(CH.settingsGet),
  pickRegion: () => ipcRenderer.invoke(CH.regionPick),
  ask: (payload) => ipcRenderer.send(CH.examAsk, payload),
  cancel: (requestId) => ipcRenderer.send(CH.examCancel, requestId),
  onExamEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: ExamEvent) => cb(ev);
    ipcRenderer.on(CH.examEvent, listener);
    return () => ipcRenderer.removeListener(CH.examEvent, listener);
  },
  onProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, p: { scanning: boolean; current?: string; done: unknown[] }) => cb(p);
    ipcRenderer.on(CH.examProgress, listener);
    return () => ipcRenderer.removeListener(CH.examProgress, listener);
  },
  onShot: (cb) => {
    const listener = () => cb();
    ipcRenderer.on(CH.examShot, listener);
    return () => ipcRenderer.removeListener(CH.examShot, listener);
  },
  status: () => ipcRenderer.invoke(CH.examStatus),
  bindBank: (subMode) => ipcRenderer.invoke(CH.examBind, { subMode }),
  rescan: (subMode) => ipcRenderer.invoke(CH.examRescan, { subMode }),
  probeBank: (subMode, question) => ipcRenderer.invoke(CH.examBankSearch, { subMode, question }),
  researchPersona: (role, company) => ipcRenderer.invoke(CH.examPersonaResearch, { role, company }),
  setPersona: (persona) => ipcRenderer.invoke(CH.examPersonaSet, { persona }),
  setSubMode: (subMode) => ipcRenderer.invoke(CH.examSetMode, subMode),
  gate: (p) => ipcRenderer.invoke(CH.llmGate, p),
  hide: () => ipcRenderer.send(CH.examClose),
};

contextBridge.exposeInMainWorld('mcExam', api);
