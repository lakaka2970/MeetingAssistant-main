/**
 * MeetingAssistant main process: overlay window, stealth, hotkeys,
 * settings, IPC hub, ASR worker host. PLAN.en.md §5.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron';
import { mkdirSync, statSync, writeFileSync } from 'fs';
import { release } from 'os';
import { join } from 'path';
import {
  captureKindForPlatform,
  whisperExecutionProvidersForPlatform,
} from '../shared/platform';
import { AsrHost } from './asrHost';
import {
  LocalPythonProbe,
  buildDiagnosticsReport,
  recentDiagnosticErrors,
  recordDiagnosticError,
} from './diagnostics';
import { openExternalUrl } from './externalLinks';
import { FunasrSidecar, parseLocalWsPort, pythonCandidates, resolvePython } from './funasrSidecar';
import { resolveTestApiKey, runProviderTest, withoutCandidateKey } from './providerTest';
import { getResourceRoot } from './resourcePaths';
import { SettingsStore, plainCipher, type SecretCipher } from './settings';
import { SETUP_READY_MARKER, createSetupWindow } from './setupWindow';
import { AppTray, trayIconPath } from './tray';
import { isRendererCommand, type TrayCommand, type TrayMenuState } from '../shared/trayMenu';
import { KnowledgeStore } from './knowledge';
import { KnowledgeFileStore } from './knowledgeFiles';
import { SessionStore } from './sessions';
import { RagService, MIN_QUERY_CHARS, type RetrieveResult } from './rag/service';
import { createLibraryImporter, emptyImportResult } from './rag/library';
import { SpeculativeCache, after, specKey } from './rag/speculative';
import { SkillsManager } from './skills/manager';
import { extractMemoFacts, formatFactsHint } from './consistency/facts';
import { NativeAudioCapture } from './audio/nativeCapture';
import { decideRoute, isOcrConfigured, ocrDataUrl } from './vision/ocrPrefilter';
import { formatWebLines, webSearch, webSources, type WebSearchOutcome } from './websearch';
import { supplementMessages, isNoSupplement } from '../shared/webSupplement';
import { DEFAULT_SEARCH_PROVIDER } from '../shared/searchProviders';
import { ExamBanks } from './exam/banks';
import { CompanionBridge, type CompanionSettings } from './companion/bridge';
import type { ControlCommand } from './companion/control';
import { destroyConnectWindow, showConnectWindow } from './connectWindow';
import { createExamWindow, destroyExamWindow } from './examWindow';
import {
  buildExamAskMessages,
  buildPersonaResearchMessages,
  buildTranscribeMessages,
  withScreenImage,
} from './llm/examPrompts';
import { parseSingleQuestion, type BankEntry } from '../shared/bankParse';
import { decideBankAnswer, formatBankBlock, type ExamSubMode } from '../shared/bankStore';
import { buildPersonaBlock, defaultPersona, parsePersona } from '../shared/persona';
import { GATE_TIMEOUT_MS, gateMessages, heuristic, parseVerdict, GateMemory } from '../shared/questionGate';
import { decideShotWeb, shouldRaiseLocalExamWindow } from '../shared/shotWeb';
import type {
  CompanionState,
  ExamAskPayload,
  ExamBankCandidateView,
  ExamEvent,
  ExamOrigin,
  ExamStatusView,
  LlmGateResult,
} from '../shared/protocol';
import type { RagHitView } from '../shared/protocol';
import { DOC_EXTENSIONS, LIBRARY_EXTENSIONS, extractDocText, isLibraryExtension } from './docparse';
import { importGlobalKnowledge } from './globalKnowledgeImport';
import { basename } from 'path';
import { chatOnce, chatStream, type ChatResult, type LlmConfig } from './llm/adapter';
import { findPresetByEndpoint } from '../shared/providerCatalog';
import {
  FailureBook,
  planBackends,
  resolveEndpointForPreset,
  streamWithFallback,
  type Endpoint,
} from './llm/router';
import { visionChat } from './llm/vision';
import {
  buildAnswerMessages,
  buildMemoUpdateMessages,
  buildOcrAnswerMessages,
  buildPrewarmMessages,
  buildStablePrefix,
  buildTranslateMessages,
  buildVisionMessages,
  clampMemo,
  classifyQuestion,
  type PromptLayers,
} from './llm/prompts';
import { buildPersonaDraftMessages, finalizePersonaDraft } from './llm/personaPrompts';
import {
  buildStyleDirectives,
  DEFAULT_EXPERTISE,
  DEFAULT_RICHNESS,
  type AnswerExpertise,
  type AnswerRichness,
} from '../shared/answerStyle';
import { resolveActivePersona } from '../shared/personas';
import type { AppInfo, KnowledgeFilesState, KnowledgeImportResult, PublicSettings, UiLang } from '../shared/protocol';
import {
  IPC,
  type AsrEvent,
  type LlmAskPayload,
  type LlmEvent,
  type OnboardingCompletePayload,
  type OnboardingProgressPatch,
  type ProviderTestRequest,
  type ProviderTestResult,
  type SessionsFile,
  type SettingsPatch,
  type StoredSession,
  type StoredTurn,
} from '../shared/protocol';
import { mainStrings } from './uiStrings';

const MODEL_ID = 'onnx-community/whisper-large-v3-turbo-ONNX';

/** tray 「检查更新」 (Phase 4). A real updater is Phase 5; until then the honest
 * answer is the releases page, opened through the same allowlist as every other
 * documentation link. */
const RELEASES_URL = 'https://github.com/lakaka2970/MeetingAssistant-main/releases/latest';

/**
 * Transcripts and questions are the most sensitive bytes this app touches —
 * they never reach the default log. Set MC_VERBOSE_LOGS=1 when diagnosing a
 * pipeline issue on your own machine; never ship it in a support bundle.
 */
const VERBOSE_LOGS = process.env.MC_VERBOSE_LOGS === '1';

/** Region-selection overlay: shows the captured screen as an opaque bg (so a
 * content-protected window never renders black locally) and lets the user drag
 * a rectangle. Uses window.mc from the shared preload. */
const regionOverlayHtml = (tip: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;cursor:crosshair;user-select:none}
#img{position:fixed;inset:0;width:100vw;height:100vh;object-fit:fill}
#dim{position:fixed;inset:0;background:rgba(0,0,0,0.35)}
#sel{position:fixed;display:none;border:2px solid #2a6df4;box-shadow:0 0 0 9999px rgba(0,0,0,0.35)}
#tip{position:fixed;top:14px;left:50%;transform:translateX(-50%);color:#fff;background:rgba(0,0,0,0.65);padding:6px 14px;border-radius:8px;font:13px 'Microsoft YaHei',sans-serif;z-index:9}
</style></head><body>
<img id="img"/><div id="dim"></div><div id="sel"></div>
<div id="tip">${tip}</div>
<script>
(async()=>{try{const u=await window.mc.regionImage();if(u){document.getElementById('img').src=u;}}catch(e){}})();
let sx,sy,drag=false;const sel=document.getElementById('sel'),dim=document.getElementById('dim');
function rect(e){return{x:Math.min(sx,e.clientX),y:Math.min(sy,e.clientY),width:Math.abs(e.clientX-sx),height:Math.abs(e.clientY-sy)};}
function upd(e){const r=rect(e);sel.style.left=r.x+'px';sel.style.top=r.y+'px';sel.style.width=r.width+'px';sel.style.height=r.height+'px';}
addEventListener('mousedown',e=>{drag=true;sx=e.clientX;sy=e.clientY;dim.style.display='none';sel.style.display='block';upd(e);});
addEventListener('mousemove',e=>{if(drag)upd(e);});
addEventListener('mouseup',e=>{if(!drag)return;drag=false;const r=rect(e);if(r.width>4&&r.height>4)window.mc.regionRect(r);else window.mc.regionCancel();});
addEventListener('keydown',e=>{if(e.key==='Escape')window.mc.regionCancel();});
</script></body></html>`;

app.setName('MeetingAssistant');

// E2E/demo hook: run against an isolated profile — must precede the
// single-instance lock so a test instance never collides with a real one
if (process.env.MC_USERDATA) app.setPath('userData', process.env.MC_USERDATA);

if (!app.requestSingleInstanceLock()) {
  // Never exit silently here. The instance this collides with is stealth by
  // default and has no taskbar entry, so from the user's side there is nothing
  // on screen to notice, let alone close — a quiet exit is indistinguishable
  // from "the app is broken and will not start". Say what is running and how to
  // get out of it.
  app
    .whenReady()
    .then(() => {
      const zh = app.getLocale().toLowerCase().startsWith('zh');
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'MeetingAssistant',
        message: zh ? 'MeetingAssistant 已经在运行了。' : 'MeetingAssistant is already running.',
        detail: zh
          ? '窗口默认隐身、且不出现在任务栏，所以你可能完全看不到它。\n\n' +
            '请到系统托盘找 MeetingAssistant 图标 → 右键 → 退出，再重新打开。\n' +
            '托盘里也没有的话，在任务管理器中结束 MeetingAssistant 进程。'
          : 'The window is stealth by default and has no taskbar entry, so it may be entirely invisible.\n\n' +
            'Find the MeetingAssistant icon in the system tray → right-click → Quit, then open it again.\n' +
            'If the tray has no icon either, end the MeetingAssistant process in Task Manager.',
        buttons: [zh ? '知道了' : 'OK'],
      });
    })
    .finally(() => app.exit(0));
} else {
  bootstrap();
}

function bootstrap(): void {
  let win: BrowserWindow | null = null;
  /** first-run wizard window; mutually exclusive with `win` until completion */
  let setupWin: BrowserWindow | null = null;
  /** the wizard was reopened from a running main window (设置 → 重新运行配置
   * 向导 / the upgrade notice). Re-run mode never quits the app. */
  let setupRerun = false;
  let settings: SettingsStore;
  let knowledge: KnowledgeStore;
  let knowledgeFiles: KnowledgeFileStore;
  let sessionStore: SessionStore;
  let rag: RagService;
  let skills: SkillsManager;
  /** 做题模式: its own window, its own banks, its own answer pipeline */
  let examWin: BrowserWindow | null = null;
  /** 双屏: the QR / pairing window, shown when the bridge is turned on */
  let connectWin: BrowserWindow | null = null;
  const examBanks = new ExamBanks();
  /** one classifier call per transcript line, never twice for the same text */
  const gateMemory = new GateMemory();
  let osLang: UiLang = 'zh';
  /** set by before-quit so window handlers stop prompting mid-shutdown */
  let quitting = false;
  /** an ASR-affecting settings patch arrived while the wizard owned the flow */
  let pendingAsrRestart = false;
  /**
   * Whole-screen capture → read the question → 题库 → AI → 网络. Bound to
   * 截屏问答热键 (ui.hotkeyShot) and to the connect window's button.
   *
   * Named through this binding because registerHotkeys() runs before
   * `startMainApp` builds the pipeline it closes over.
   *
   * When the dual-screen companion is off, the exam window is raised first: an
   * answer that goes only to a hidden overlay is an answer nobody sees. When
   * it is on, the paired device is the display and this machine stays silent
   * (shouldRaiseLocalExamWindow).
   */
  let screenShotAsk: (() => Promise<{ ok: boolean; ms: number; seq: number }>) | null = null;
  /** renderer capture lifecycle; the tray menu and the diagnostics report read it */
  let capturing = false;
  /**
   * v1.0.1 ⑦: the two things main cannot observe otherwise, cached so the
   * companion `st` state costs no IPC round-trip when a phone asks. Declared
   * here — before the handlers that write them — because every one of those
   * listeners is registered in this same scope.
   */
  let ctlContinuous = false;
  let ctlSessions: SessionsFile | null = null;
  const asr = new AsrHost();
  const sidecar = new FunasrSidecar();
  const tray = new AppTray();
  /**
   * LAN companion: phones on the same network show the transcript and the
   * answers. Taps the event streams at their source in this process, so the
   * display works with no window open at all — which is also what makes the
   * whole thing invisible to a screen share.
   *
   * `settings` is only assigned later, inside whenReady; the closure defers the
   * read to the first call, which is after that.
   */
  const companion = new CompanionBridge(
    (): CompanionSettings => {
      const c = settings.getPublic().companion;
      return {
        enabled: c.enabled,
        port: c.port,
        pushExam: c.pushExam,
        pushInterview: c.pushInterview,
        pushTranscript: c.pushTranscript,
        pushScreenshot: c.pushScreenshot,
        useHttps: c.useHttps,
        jpegQuality: c.jpegQuality,
        maxDim: c.maxDim,
        allowControl: c.allowControl,
        allowItems: c.allowItems,
      };
    },
    app.getPath('userData'),
    () => {},
    // a phone just got onto the bridge: put the QR away. Leaving it up is
    // leaving a live credential up, and it is no longer needed by anyone.
    () => {
      if (connectWin && !connectWin.isDestroyed() && connectWin.isVisible()) {
        console.log('[connect] 手机已连上，收起连接窗口');
        connectWin.hide();
      }
      // and hand the display over: the overlay hides, the phone becomes the screen
      if (win && !win.isDestroyed()) win.webContents.send(IPC.companionConnected);
    },
  );
  /** one place where an ASR event reaches the overlay AND the phones */
  const publishAsr = (ev: AsrEvent): void => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.asrEvent, ev);
    companion.publishAsr(ev);
  };
  const publishLlm = (ev: LlmEvent): void => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.llmEvent, ev);
    companion.publishLlm(ev);
  };
  /** upgrade P1.5: optional napi-rs loopback — absent artifact = graceful
   * fallback to the renderer Web Audio path (settings.audio.captureBackend) */
  const nativeAudio = new NativeAudioCapture({
    resourceRoot: getResourceRoot(),
    onPcm: (pcm, captureTs) => {
      // copy: the worker owns this Buffer's lifecycle; sendPcm expects an
      // offset-free ArrayBuffer (1600 f32 samples = 6.4 KB — negligible)
      asr.sendPcm(pcm.slice().buffer as ArrayBuffer, captureTs, 'them');
    },
    onError: (message) => {
      console.warn('[native-audio]', message);
      win?.webContents.send(IPC.nativeCaptureError, message);
    },
  });

  /** main-process strings in the current UI language */
  const T = () => mainStrings(settings.data.ui.lang, osLang);

  /** getPublic() + real knowledge char count (KB lives outside settings.json) */
  function publicSettings(): PublicSettings {
    const pub = settings.getPublic();
    pub.knowledge = { chars: knowledge.chars };
    return pub;
  }

  function buildAsrOptions() {
    const a = settings.data.asr;
    const backend = a.backend ?? 'local';
    // each backend has its own config slot so switching never clobbers the others
    let cloud: { baseUrl: string; model: string; apiKey: string } | undefined;
    if (backend === 'local-realtime') {
      // fixed localhost sidecar (auto-spawned); only the model is a choice
      cloud = {
        baseUrl: 'ws://127.0.0.1:10097',
        model: a.localRealtime?.model ?? 'fun-asr-nano',
        apiKey: '',
      };
    } else if (backend === 'cloud-realtime') {
      const rtKey = settings.getRealtimeAsrApiKey() ?? '';
      if (a.realtime?.baseUrl && a.realtime?.model && rtKey) {
        cloud = { baseUrl: a.realtime.baseUrl, model: a.realtime.model, apiKey: rtKey };
      }
    } else if (a.cloud?.baseUrl && a.cloud?.model && settings.getCloudAsrApiKey()) {
      cloud = { baseUrl: a.cloud.baseUrl, model: a.cloud.model, apiKey: settings.getCloudAsrApiKey()! };
    }
    return {
      // the worker treats both realtime flavors identically (same WS engine)
      backend: (backend === 'local-realtime' ? 'cloud-realtime' : backend) as
        | 'local'
        | 'cloud'
        | 'cloud-realtime',
      modelsDir: a.modelsDir ?? join(app.getPath('userData'), 'models'),
      modelId: MODEL_ID,
      ep: whisperExecutionProvidersForPlatform(process.platform),
      language: a.language,
      cloud,
      // upgrade P1: English fast lane (moonshine-tiny) + strategy mode
      strategy:
        backend === 'local' && a.moonshineEnabled
          ? {
              mode: a.strategy ?? 'balanced',
              moonshine: true,
              remoteHost: settings.data.rag?.remoteHost ?? 'https://hf-mirror.com',
            }
          : undefined,
    };
  }

  /** start the ASR worker; a local ws:// realtime backend auto-spawns the
   * python sidecar first (selecting the preset is all the user does) */
  async function startAsr(): Promise<void> {
    const opts = buildAsrOptions();
    const port = opts.backend === 'cloud-realtime' ? parseLocalWsPort(opts.cloud?.baseUrl) : null;
    if (port) {
      try {
        // NOT app.getAppPath(): packaged that resolves inside app.asar, which
        // python cannot read and the OS cannot use as a spawn cwd
        await sidecar.ensureRunning(port, getResourceRoot(), opts.cloud?.model);
        console.log(`[sidecar] local ASR ready on :${port}`);
      } catch (e) {
        const message = T().sidecarFail((e as Error).message);
        console.error(`[sidecar] ${message}`);
        recordDiagnosticError('sidecar', (e as Error).message);
        publishAsr({ kind: 'error', message, fatal: true });
        return;
      }
    } else {
      await sidecar.stop(); // switched away from local — reclaim its RAM/VRAM
    }
    asr.start(opts);
  }

  const safeCipher: SecretCipher = {
    available: () => safeStorage.isEncryptionAvailable(),
    secure: true,
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  };

  function cipher(): SecretCipher {
    if (safeCipher.available()) return safeCipher;
    console.warn('[security] OS secret storage unavailable; API keys will only be obfuscated');
    return plainCipher;
  }

  // ---- window visibility + system tray ----------------------------------
  // Quit/hide matrix (Phase 4):
  //   hide  (hotkey / 「—」 / tray toggle) -> window stays alive, app keeps
  //         running, tray is the way back; NEVER quits.
  //   quit  (titlebar ✕ / tray 退出 / OS shutdown) -> app.quit() -> before-quit
  //         reaps the ASR utilityProcess, the python sidecar and the tray.
  //   first-run wizard closed without completing -> app.quit() (Phase 2), since
  //         nothing is configured and no main window exists yet.
  //   re-run wizard closed -> main window keeps running; window-all-closed does
  //         not fire because the overlay is still open (possibly hidden).

  function showWindow(): void {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function toggleWindow(): void {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else showWindow();
  }

  function trayState(): TrayMenuState {
    return { windowVisible: !!win?.isVisible(), capturing };
  }

  /** rebuild the tray menu — call after anything the menu shows has changed */
  function refreshTray(): void {
    tray.refresh();
  }

  /**
   * Effective content protection. The 隐身 toggle is the user's preference;
   * while a meeting is being captured the window is ADDITIONALLY forced
   * content-protected so it can never leak into a shared screen (auto-hide).
   * setContentProtection(true) → WDA_EXCLUDEFROMCAPTURE (Windows) /
   * NSWindowSharingNone (macOS): the window stays interactive locally but is
   * invisible to screen capture. Restored to the preference on capture stop.
   */
  function applyStealth(): void {
    if (!win) return;
    win.setContentProtection(settings.data.ui.stealth || capturing);
  }

  function handleTrayCommand(command: TrayCommand): void {
    if (command === 'quit') {
      app.quit();
      return;
    }
    if (command === 'toggle-window') {
      toggleWindow();
      return;
    }
    if (command === 'check-updates') {
      void openExternalUrl(RELEASES_URL);
      return;
    }
    if (isRendererCommand(command)) {
      // capture, sessions and the panels live in the renderer; a hidden window
      // would swallow the result, so make it visible first
      showWindow();
      win?.webContents.send(IPC.trayCommand, { command });
    }
  }

  function ensureTray(): void {
    if (tray.exists) return;
    tray.create({
      iconPath: trayIconPath(getResourceRoot()),
      labels: () => T().tray,
      state: trayState,
      onCommand: handleTrayCommand,
      onClick: toggleWindow,
      onDoubleClick: showWindow,
    });
  }

  /** one-shot balloon the first time the window disappears (spec §A) */
  function noticeWindowHidden(): void {
    if (!tray.exists || settings.data.ui.trayNoticeShown) return;
    settings.applyPatch({ ui: { trayNoticeShown: true } });
    const t = T();
    tray.notifyHidden(t.trayNoticeTitle, t.trayNoticeBody);
    console.log('[tray] hide notice shown once');
  }

  /**
   * 开机自动启动. Deliberately inert in development: `setLoginItemSettings`
   * would register the electron.exe dev launcher (and on Linux Electron does
   * not implement it at all), so the stored intent is kept and applied by the
   * installed build instead.
   */
  function applyAutoLaunch(enabled: boolean): void {
    if (process.platform === 'linux') return;
    if (!app.isPackaged) {
      console.log(`[autolaunch] ${enabled ? 'on' : 'off'} stored; not applied in a dev build`);
      return;
    }
    try {
      app.setLoginItemSettings({ openAtLogin: enabled });
    } catch (e) {
      console.warn('[autolaunch] could not be applied:', (e as Error).message);
    }
  }

  /** the OS is the source of truth; reconcile it with the stored intent once */
  function syncAutoLaunch(): void {
    if (process.platform === 'linux' || !app.isPackaged) return;
    const wanted = !!settings.data.ui.autoLaunch;
    try {
      if (app.getLoginItemSettings().openAtLogin !== wanted) applyAutoLaunch(wanted);
    } catch (e) {
      console.warn('[autolaunch] could not be read:', (e as Error).message);
    }
  }

  /**
   * Raise (or create) the exam window. Top level in bootstrap because both the
   * global hotkeys and the tray reach it, not just the IPC handlers. Banks are
   * scanned on first open — never on boot, so an unbound or huge folder cannot
   * delay the interview window.
   */
  function openExamWindow(): BrowserWindow {
    if (examWin && !examWin.isDestroyed()) {
      examWin.show();
      examWin.focus();
      return examWin;
    }
    examWin = createExamWindow(settings).win;
    examWin.on('closed', () => {
      examWin = null;
    });
    const binds = (settings.data.exam?.banks ?? {}) as Partial<Record<ExamSubMode, string>>;
    if (Object.keys(binds).length) {
      void examBanks.bindAll(binds, (p) => {
        if (examWin && !examWin.isDestroyed()) examWin.webContents.send(IPC.examProgress, p);
      });
    }
    return examWin;
  }

  function registerHotkeys(): void {
    globalShortcut.unregisterAll();
    const failed: string[] = [];
    // one poisoned or occupied accelerator must not silence every other key —
    // register each in isolation and surface the aggregate to the user
    const reg = (key: string | undefined, handler: () => void): void => {
      if (!key) return;
      try {
        if (!globalShortcut.register(key, handler)) failed.push(key);
      } catch {
        failed.push(key);
      }
    };
    reg(settings.data.ui.hotkeyToggle, () => toggleWindow());
    // 截屏问答热键 = 整屏抓取 → 题库 → AI → 网络. It used to hand off to the
    // renderer's drag-a-region flow, which needs you to look at this screen
    // and answers through the vision model only — useless when the display is
    // a phone and wasteful even when it is not, since the local bank is both
    // faster and the source of truth. The 📷 button still does the region
    // flow for anyone who wants to crop first.
    // Before startMainApp exists there is no pipeline to call, so the old
    // renderer-routed flow remains the fallback rather than a dead key.
    reg(settings.data.ui.hotkeyShot, () => {
      if (screenShotAsk) void screenShotAsk();
      else if (win && !win.isDestroyed()) win.webContents.send(IPC.shotHotkey);
    });
    // Dual-screen has no reachable ⚡答 button (the window is hidden), so the
    // one thing you still need — "answer what they just said" — gets a key.
    reg(settings.data.ui.hotkeyAnswer, () => {
      if (win && !win.isDestroyed()) win.webContents.send(IPC.answerHotkey);
    });
    // 做题模式: one hotkey raises the small window, one captures + answers.
    // The ask hotkey opens the window first so a cold press still works.
    reg(settings.data.exam?.hotkeyOpen, () => openExamWindow());
    reg(settings.data.exam?.hotkeyAsk, () => {
      // Phone-only mode: nothing appears on this screen, so a press works
      // even when the PC is face-down and the display is the phone.
      const c = settings.data.companion;
      if (c?.enabled && c.hotkeyToPhone && screenShotAsk) {
        void screenShotAsk();
        return;
      }
      const w = openExamWindow();
      // A cold-just-created window has no renderer to receive the event yet;
      // sending immediately silently drops the press.
      const sendShot = (): void => {
        if (!w.isDestroyed()) w.webContents.send(IPC.examShot);
      };
      if (w.webContents.isLoading()) w.webContents.once('did-finish-load', sendShot);
      else sendShot();
    });
    if (failed.length) {
      console.warn(`[main] hotkey registration failed (in use or invalid): ${failed.join(', ')}`);
      const t = T();
      tray.notifyHidden(t.hotkeyFailTitle, t.hotkeyFailBody(failed.join(', ')));
    }
  }

  function createWindow(): void {
    win = new BrowserWindow({
      width: 940,
      height: 560,
      minWidth: 640,
      minHeight: 380,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      resizable: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    applyStealth();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    win.webContents.on('did-finish-load', () => {
      // replay cached ASR state for late-attaching renderer
      if (asr.lastReady) publishAsr(asr.lastReady);
      if (asr.lastStatus) publishAsr(asr.lastStatus);
      if (process.env.MC_AUTOSTART === '1') {
        // executeJavaScript(code, true) supplies the user gesture that
        // getDisplayMedia needs — used by the E2E smoke test.
        void win?.webContents.executeJavaScript(
          'window.__mcAutoStart && window.__mcAutoStart()',
          true,
        );
      }
      // E2E: exercise the FULL path a user takes — type in the answer box,
      // press Enter, renderer turn -> IPC -> knowledge routing -> LLM -> stream
      // -> DOM. Reports the prepared-answer hit with its latency and what the
      // pane actually rendered (KaTeX / markdown), so the knowledge-first
      // design and the formula rendering are both checkable from the console.
      if (process.env.MC_E2E_LLM) {
        const q = process.env.MC_E2E_LLM;
        const js = `(async()=>{
  const inp=document.querySelector('.answer-input input');
  if(!inp)return{ok:false,error:'answer input not found (window not painted yet?)'};
  if(inp.disabled)return{ok:false,error:'answer input disabled (no LLM key?)'};
  let kb=null;let st=null;
  for(let i=0;i<180;i++){
    st=await window.mc.ragStatus().catch(()=>null);
    if(st&&!st.enabled){kb={pairs:0,disabled:true};break;}
    try{const l=await window.mc.ragQaList();if(l&&l.length){kb={pairs:l.length};break;}}catch(_){}
    if(st&&st.state==='error'){kb={pairs:0,error:st.lastError};break;}
    await new Promise(r=>setTimeout(r,500));
  }
  if(!kb)kb={pairs:0,exhausted:true};
  const d=[];let qa=null,web=null,rid=null;let tQa=null,tFirst=null;
  const out=new Promise(r=>{const off=window.mc.onLlmEvent(e=>{
    if(rid===null)rid=e.requestId;
    if(e.requestId!==rid)return;
    if(e.kind==='delta'){if(tFirst===null)tFirst=performance.now();d.push(e.text);}
    else if(e.kind==='qa'){qa=e.hit;tQa=performance.now();}
    else if(e.kind==='web'){web=e.sources;}
    else if(e.kind==='done'){off();r({ok:true,text:e.text||d.join('')});}
    else if(e.kind==='error'){off();r({ok:false,error:e.message});}});});
  const t0=performance.now();
  inp.value=${JSON.stringify(q)};
  inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  const res=await out;
  await new Promise(r=>setTimeout(r,400));
  const turn=[...document.querySelectorAll('.turn')].pop();
  const body=turn?turn.querySelector('.turn-body'):null;
  const dom=body?{turn:true,katex:body.querySelectorAll('.katex').length,mathErr:body.querySelectorAll('.katex-error').length,qa:!!turn.querySelector('.turn-qa'),qaText:(turn.querySelector('.turn-qa-body')?.textContent||'').slice(0,80),md:body.innerHTML.includes('**'),rawDollar:/\\$[^$]*\\$/.test(body.textContent),textLen:(body.textContent||'').length}:null;
  return {...res,q:${JSON.stringify(q)},rid,qa,web,dom,kb,rag:{enabled:st?.enabled,state:st?.state,modelKey:st?.modelKey,modelLocal:st?.modelLocal,downloadPct:st?.downloadPct,chunks:st?.chunks,bySource:st?.bySource,lastError:st?.lastError},ms:{qa:qa&&tQa!==null?Math.round(tQa-t0):null,firstToken:tFirst!==null?Math.round(tFirst-t0):null,done:Math.round(performance.now()-t0)}};
})()`;
        void win?.webContents
          .executeJavaScript(js, true)
          .then((r) => console.log('[e2e-llm]', JSON.stringify(r)))
          .catch((e) => console.log('[e2e-llm] threw', (e as Error).message));
      }
      // Visual QA of the main window (same spirit as MC_SETUP_SHOT for the
      // wizard): open the settings panel, let it paint, capture a PNG.
      if (process.env.MC_MAIN_SHOT) {
        const dir = process.env.MC_MAIN_SHOT;
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const shoot = async (name: string): Promise<void> => {
          const image = await win?.webContents.capturePage();
          if (!image) return;
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${name}.png`);
          writeFileSync(file, image.toPNG());
          console.log(`[main] screenshot ${file}`);
        };
        void (async () => {
          try {
            await win?.webContents.executeJavaScript(
              'window.__mcOpenSettings && window.__mcOpenSettings()',
              true,
            );
            await wait(1200);
            await shoot('main-settings-common');
            // expand 高级 and scroll to it, so the collapsed half is reviewable too
            await win?.webContents.executeJavaScript(
              `(()=>{const p=document.querySelector('.settings');if(!p)return 0;p.querySelectorAll('details').forEach(d=>d.open=true);p.scrollTop=p.scrollHeight;return p.scrollHeight;})()`,
            );
            await wait(600);
            await shoot('main-settings-advanced');
            // the knowledge panel carries the pre-chunked knowledge-base row
            await win?.webContents.executeJavaScript(
              'window.__mcOpenKnowledge && window.__mcOpenKnowledge()',
              true,
            );
            await wait(1200);
            await shoot('main-knowledge');
          } catch (e) {
            console.warn('[main] screenshot failed:', (e as Error).message);
          }
        })();
      }
      /**
       * Visual QA of the resizable two-pane layout: shoot the bare window, click
       * the collapse handle, shoot again, restore, shoot once more — so the
       * lopsided split, the answer-only rail and the round trip are all
       * reviewable as real pixels. Same spirit as MC_MAIN_SHOT / MC_CONNECT_SHOT.
       */
      if (process.env.MC_PANES_SHOT) {
        const dir = process.env.MC_PANES_SHOT;
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const shoot = async (name: string): Promise<void> => {
          const image = await win?.webContents.capturePage();
          if (!image) return;
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${name}.png`);
          writeFileSync(file, image.toPNG());
          console.log(`[panes] ${name} -> ${file}`);
        };
        void (async () => {
          try {
            await wait(2500);
            await shoot('panes-split');
            console.log(
              '[panes] collapse:',
              await win?.webContents.executeJavaScript(
                `(()=>{const b=document.querySelector('.pane-collapse');if(!b)return 'NO-HANDLE';b.click();return 'clicked';})()`,
                true,
              ),
            );
            await wait(900);
            await shoot('panes-answer-only');
            console.log(
              '[panes] restore:',
              await win?.webContents.executeJavaScript(
                `(()=>{const b=document.querySelector('.pane-rail');if(!b)return 'NO-RAIL';b.click();return 'clicked';})()`,
                true,
              ),
            );
            await wait(900);
            await shoot('panes-restored');
          } catch (e) {
            console.warn('[panes] screenshot failed:', (e as Error).message);
          }
        })();
      }
      /**
       * Visual QA of the 双屏 connect window: raise it, let the QR paint, write a
       * PNG. Reviewing a layout requires seeing it, and a boolean assertion
       * cannot tell you the pairing code is clipped.
       *
       * Content protection is lifted for the capture only — capturePage() on a
       * protected window returns a black rectangle by design, which would make
       * the whole exercise useless.
       */
      if (process.env.MC_CONNECT_SHOT) {
        const dir = process.env.MC_CONNECT_SHOT;
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        void (async () => {
          try {
            const { win: w } = showConnectWindow(connectWin);
            connectWin = w;
            w.setContentProtection(false);
            await new Promise<void>((r) => {
              w.webContents.once('did-finish-load', () => r());
              setTimeout(r, 8000).unref();
            });
            await wait(1500); // let the QR and the polled state arrive
            const image = await w.webContents.capturePage();
            mkdirSync(dir, { recursive: true });
            const file = join(dir, 'connect.png');
            writeFileSync(file, image.toPNG());
            console.log(`[connect] screenshot ${file}`);
            w.setContentProtection(true);
          } catch (e) {
            console.warn('[connect] screenshot failed:', (e as Error).message);
          }
        })();
      }
      if (process.env.MC_E2E_SHOT) {
        const q = process.env.MC_E2E_SHOT;
        const js = `(async()=>{const d=[];const done=new Promise(r=>{const off=window.mc.onLlmEvent(e=>{if(e.kind==='delta')d.push(e.text);else if(e.kind==='done'){off();r({ok:true,text:e.text||d.join('')});}else if(e.kind==='error'){off();r({ok:false,error:e.message});}});});window.mc.shotAsk({requestId:'e2e-shot',question:${JSON.stringify(q)}});return await done;})()`;
        void win?.webContents
          .executeJavaScript(js, true)
          .then((r) => console.log('[e2e-shot]', JSON.stringify(r)))
          .catch((e) => console.log('[e2e-shot] threw', (e as Error).message));
      }
    });

    // the tray menu shows 显示/隐藏窗口, so it has to follow the real state —
    // whichever of the four hide paths was used (hotkey, 「—」, tray, IPC)
    // "where did my window go" is THE support question for a frameless,
    // taskbar-less, content-protected overlay, so both transitions are logged
    win.on('show', () => {
      console.log('[window] shown');
      refreshTray();
    });
    win.on('hide', () => {
      console.log('[window] hidden');
      refreshTray();
      noticeWindowHidden();
    });

    win.on('closed', () => {
      win = null;
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'));
    }

    // the tray belongs to the running app, not to the first-run wizard: an
    // unconfigured machine that closes the wizard must still quit (Phase 2)
    ensureTray();
  }

  /** normal boot: warm the ASR worker, bind hotkeys, show the overlay */
  function startMainApp(): void {
    void startAsr();
    registerHotkeys();
    syncAutoLaunch();
    // warm the embedding model at launch when documents are imported, so the
    // first question recalls them without a cold-start model download
    if (knowledgeFiles.list().length > 0) void rag.ensureReady();
    // notes written before the Q&A scan existed (or by an older build) still
    // carry prepared answers — index them once, in the background, on launch
    if (rag.notes.chars > 0) {
      void (async () => {
        if (await rag.ensureReady()) {
          if (!rag.hasNotesRecords()) {
            const res = await rag.ingestNotes(rag.notes.text);
            if (res?.qa) console.log(`[rag] notes backfill: ${res.qa} prepared answers indexed`);
          }
        }
      })();
    }
    createWindow();
  }

  /**
   * First-run gate. While the wizard is up there is no ASR worker, no python
   * sidecar, no cloud connection and no LLM prewarm — an unconfigured machine
   * must not spawn anything.
   */
  function openSetupWindow(rerun = false): void {
    if (setupWin) {
      if (setupWin.isMinimized()) setupWin.restore();
      setupWin.show();
      setupWin.focus();
      return;
    }
    setupRerun = rerun;
    const w = createSetupWindow();
    setupWin = w;

    // E2E: drive the wizard->main-app handover without a human click
    if (process.env.MC_E2E_ONBOARDING_COMPLETE === '1') {
      w.webContents.on('did-finish-load', () => {
        void w.webContents.executeJavaScript('window.mcSetup.completeOnboarding({})', true);
      });
    }

    w.on('close', (e) => {
      // completion closes this window programmatically, an OS shutdown /
      // app.quit() must never be blocked by a modal, and a re-run just puts
      // the user back into a working app — no prompt in any of those cases
      if (quitting || setupRerun || settings.data.onboarding.completed) return;
      const t = T();
      const choice = dialog.showMessageBoxSync(w, {
        type: 'warning',
        title: t.setupQuitTitle,
        message: t.setupQuitTitle,
        detail: t.setupQuitMessage,
        buttons: [t.setupQuitConfirm, t.setupQuitCancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (choice !== 0) e.preventDefault();
    });

    w.on('closed', () => {
      const wasRerun = setupRerun;
      setupWin = null;
      setupRerun = false;
      if (wasRerun) {
        // keys saved before the user backed out still have to reach the engine
        if (pendingAsrRestart) {
          pendingAsrRestart = false;
          void asr.stop().then(() => startAsr());
        }
        win?.focus();
        return;
      }
      // first-run launch closed without finishing => nothing is configured and
      // there is no other window; Phase 4 adds a tray
      if (!settings.data.onboarding.completed) app.quit();
    });
  }

  app.whenReady().then(() => {
    // users who never chose a UI language get their OS language (zh → zh, else en)
    osLang = app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
    settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'), cipher(), osLang);
    knowledge = new KnowledgeStore(join(app.getPath('userData'), 'knowledge.md'));
    knowledgeFiles = new KnowledgeFileStore(join(app.getPath('userData'), 'knowledge-files.json'));
    sessionStore = new SessionStore(join(app.getPath('userData'), 'sessions.json'));
    // upgrade P0: L1/L2/L3 knowledge stack — fully lazy (no worker, no disk
    // IO) until the first ingest/search; capture start warms it in background
    rag = new RagService({
      userDataDir: app.getPath('userData'),
      modelsDir: settings.data.asr.modelsDir ?? join(app.getPath('userData'), 'models'),
      getSettings: () => ({
        enabled: settings.data.rag?.enabled !== false,
        model: settings.data.rag?.model ?? 'bge-m3',
        topK: settings.data.rag?.topK ?? 5,
        minScore: settings.data.rag?.minScore ?? 0.2,
        remoteHost: settings.data.rag?.remoteHost ?? 'https://hf-mirror.com',
        kbIndex: settings.data.rag?.kbIndex ?? '',
      }),
      onStatusChange: () => win?.webContents.send(IPC.ragStatusPush, rag.status()),
    });
    // Bind the pre-chunked knowledge base at boot rather than lazily on the
    // first question: it costs ~100 ms of tokenising a few hundred blocks, and
    // in exchange the settings row can state "569 块 / 69 篇" immediately and a
    // wrong or moved path is reported now instead of mid-interview.
    {
      const kbPath = (settings.data.rag?.kbIndex ?? '').trim();
      if (kbPath) {
        const r = rag.bindKb(kbPath);
        console.log(
          r.ok
            ? `[rag] KB bound at boot: ${r.chunks} chunks / ${r.docs} docs / ${r.aliases} aliases`
            : `[rag] KB at "${kbPath}" unavailable: ${r.error}`,
        );
      }
    }
    // upgrade P3: skills — builtin (resources/skills) + user (userData/skills);
    // the resources root trick mirrors tray icons (repo root in dev)
    skills = new SkillsManager();
    skills.loadFromDirs([
      join(getResourceRoot(), 'resources', 'skills'),
      join(app.getPath('userData'), 'skills'),
    ]);

    // Electron's `audio: loopback` display-media source is Windows-only.
    // macOS/Linux use a selectable ordinary input in the renderer instead.
    if (captureKindForPlatform(process.platform) === 'loopback') {
      session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen'] })
          .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
          .catch((e) => {
            console.error('[main] display media handler failed:', e);
            callback({});
          });
      });
    }

    // ---- IPC ----
    ipcMain.on(IPC.capturePcm, (_e, buf: ArrayBuffer, captureTs: number, channel: 'them' | 'me') => {
      asr.sendPcm(buf, captureTs, channel === 'me' ? 'me' : 'them');
    });

    // ---- P1-6: DeepSeek prefix-cache prewarm + keep-warm while capturing ----
    // One max_tokens=1 request with the byte-identical stable prefix builds the
    // provider-side KV cache, so the first real answer prefills at 0.1x price
    // and lower latency. Re-ping when the cache would go cold (same pattern as
    // the ASR 45s keep-warm). Real answer requests refresh the cache themselves.
    const PREWARM_IDLE_MS = 4 * 60_000;
    let lastPrefix: string | null = null;
    let lastPrefixActivity = 0; // last time the answer prefix hit the provider
    let lastPrewarmMaterial: { resume?: string; jd?: string } = {};
    let keepWarmTimer: NodeJS.Timeout | null = null;

    /** llm settings baked into the stable prefix: change one mid-session and the
     * provider-side cache is cold for the new bytes */
    const PROMPT_PREFIX_KEYS = [
      'answerLang',
      'answerRichness',
      'answerExpertise',
      'personas',
      'activePersonaId',
      'promptPersona',
      'promptStyle',
      'promptExtra',
    ] as const;

    /** v1.0.1: the ONE reader of the editable prompt layers. Prewarm and real
     * requests both go through it, so their prefixes stay byte-identical */
    function promptLayers(): PromptLayers {
      const s = settings.data.llm;
      return {
        persona: s.promptPersona ?? '',
        styleOverride: s.promptStyle ?? '',
        styleDirectives: buildStyleDirectives(
          s.answerRichness ?? DEFAULT_RICHNESS,
          s.answerExpertise ?? DEFAULT_EXPERTISE,
        ),
        answerPersona: resolveActivePersona(s.personas ?? [], s.activePersonaId ?? ''),
        extra: s.promptExtra ?? '',
      };
    }

    /** same material fallback as llmAsk — prewarm MUST match real requests
     * byte-for-byte, personal notes and prompt layers included (upgrade P0) */
    function stablePrefixFor(resume?: string, jd?: string): string {
      const hasMaterial = !!(resume || jd);
      const effResume = resume || (hasMaterial ? '' : knowledge.text);
      return buildStablePrefix({
        resume: effResume,
        jd: jd ?? '',
        lang: settings.data.llm.answerLang,
        notes: rag.notes.text,
        layers: promptLayers(),
      });
    }

    async function doPrewarm(prefix: string, reason: string): Promise<void> {
      const apiKey = settings.getLlmApiKey();
      if (!apiKey || settings.data.llm.answerWithVision) return; // vision path ≠ DeepSeek
      lastPrefix = prefix;
      lastPrefixActivity = Date.now();
      try {
        const r = await chatOnce(
          { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
          buildPrewarmMessages(prefix),
          { maxTokens: 1 },
        );
        console.log(
          `[prewarm] ${reason}: cache_hit=${r.usage?.prompt_cache_hit_tokens ?? '?'} cache_miss=${r.usage?.prompt_cache_miss_tokens ?? '?'} prompt=${r.usage?.prompt_tokens ?? '?'}`,
        );
      } catch (e) {
        console.warn('[prewarm] failed:', (e as Error).message);
      }
    }

    /**
     * A prompt-layer change makes the cached prefix cold the moment it lands.
     * Re-warm right away while capturing: switching 回答风格 / 应答人设
     * mid-meeting should not charge the next answer for a cold prefill.
     */
    function markPromptPrefixCold(via: string): void {
      lastPrefix = null;
      if (capturing) void doPrewarm(stablePrefixFor(lastPrewarmMaterial.resume, lastPrewarmMaterial.jd), via);
    }

    ipcMain.on(
      IPC.llmPrewarm,
      (_e, payload: { resume?: string; jd?: string; immediate?: boolean } = {}) => {
        // remembered so a settings change can re-warm the SAME bytes the
        // renderer is currently working with
        lastPrewarmMaterial = { resume: payload.resume, jd: payload.jd };
        const prefix = stablePrefixFor(payload.resume, payload.jd);
        const dirty = prefix !== lastPrefix;
        const cold = Date.now() - lastPrefixActivity >= PREWARM_IDLE_MS;
        if (!dirty && !cold) return;
        if (payload.immediate || capturing) {
          void doPrewarm(prefix, dirty ? 'dirty' : 'refresh');
        } else {
          lastPrefix = null; // mark stale; the next ▶ prewarm sees dirty and reheats
        }
      },
    );

    // ---- v1.0.1 A5: answer-persona draft + stable-prefix preview ----
    /** The renderer owns sessions.json, so main looks the material up by id —
     * the same slot fallback llmAsk uses (resume slot, then legacy single slot). */
    function materialFor(sessionId?: string): { resume?: string; jd?: string } {
      const s = sessionId ? sessionStore.load().sessions.find((x) => x.id === sessionId) : undefined;
      return { resume: s?.resumeText || s?.kbText, jd: s?.jdText };
    }

    // The editor's 只读预览 shows the bytes main would actually send next — never
    // a second copy of the assembly logic.
    ipcMain.handle(IPC.llmPromptPreview, (_e, p: { sessionId?: string } = {}) => {
      const m = materialFor(p?.sessionId);
      const prefix = stablePrefixFor(m.resume, m.jd);
      return { prefix, chars: prefix.length };
    });

    ipcMain.handle(IPC.llmPersonaDraft, async (_e, p: { sessionId?: string } = {}) => {
      const apiKey = settings.getLlmApiKey();
      if (!apiKey) return { error: T().noApiKey };
      const m = materialFor(p?.sessionId);
      const resume = (m.resume ?? '').trim() || knowledge.text.trim();
      const jd = (m.jd ?? '').trim();
      if (!resume && !jd) return { error: T().personaNoMaterial };
      try {
        const r = await chatOnce(
          { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
          buildPersonaDraftMessages({ resume, jd, lang: settings.data.llm.answerLang }),
          { maxTokens: 600, temperature: 0.3 },
        );
        const text = finalizePersonaDraft(r.text);
        if (!text) return { error: T().personaDraftEmpty };
        console.log(`[persona-draft] ${text.length} chars`);
        return { text };
      } catch (e) {
        console.warn('[persona-draft] failed:', (e as Error).message);
        return { error: (e as Error).message };
      }
    });

    // last-known capture lifecycle, for the diagnostics report only
    let lastCaptureStartedAt: string | undefined;
    let lastCaptureStoppedAt: string | undefined;

  ipcMain.on(IPC.captureStarted, () => {
    console.log('[main] capture started');
    lastCaptureStartedAt = new Date().toISOString();
    capturing = true;
    applyStealth(); // auto-hide: force content protection while a meeting runs
    refreshTray(); // 开始转写 -> 停止转写
    // upgrade P0: warm the RAG stack in the background (model load/download)
    // so the first retrieval does not pay the cold-start cost mid-meeting
    void rag.ensureReady();
      if (!keepWarmTimer) {
        keepWarmTimer = setInterval(() => {
          if (!capturing || !lastPrefix) return;
          if (Date.now() - lastPrefixActivity >= PREWARM_IDLE_MS) {
            void doPrewarm(lastPrefix, 'keep-warm');
          }
        }, 60_000);
      }
    });
    companion.publishState();
    ipcMain.on(IPC.captureStopped, () => {
      console.log('[main] capture stopped');
      lastCaptureStoppedAt = new Date().toISOString();
      capturing = false;
      applyStealth(); // restore the manual stealth preference
      refreshTray();
      if (keepWarmTimer) {
        clearInterval(keepWarmTimer);
        keepWarmTimer = null;
      }
      asr.flush();
    });
    companion.publishState(); // ⑦ the phone's ● 转录 follows this, not its own tap
    ipcMain.handle(IPC.settingsGet, () => publicSettings());
    // pull-based replay: renderer asks after subscribing, so instant-ready
    // cloud engines can't race the subscription (stuck "模型加载中" bug)
    ipcMain.handle(IPC.asrReplay, () => ({ ready: asr.lastReady, status: asr.lastStatus }));
    ipcMain.handle(IPC.settingsSet, (_e, patch: SettingsPatch) => {
      // captured before applyPatch so the transition can be detected
      const companionWas = !!settings.data.companion?.enabled;
      settings.applyPatch(patch);
      if (patch.companion?.enabled !== undefined) {
        syncConnectWindow(companionWas, !!patch.companion.enabled);
      }
      if (
        patch.ui?.hotkeyToggle !== undefined ||
        patch.ui?.hotkeyShot !== undefined ||
        patch.ui?.hotkeyAnswer !== undefined ||
        patch.exam?.hotkeyOpen !== undefined ||
        patch.exam?.hotkeyAsk !== undefined
      ) {
        registerHotkeys();
      }
      if (patch.ui?.stealth !== undefined) {
        applyStealth();
      }
      // A prompt-layer change makes the cached prefix cold the moment it lands.
      if (patch.llm && PROMPT_PREFIX_KEYS.some((k) => patch.llm![k] !== undefined)) {
        markPromptPrefixCold('settings');
      }
      // the tray menu is a snapshot: rebuild it in the newly chosen language
      if (patch.ui?.lang !== undefined) refreshTray();
      if (patch.ui?.autoLaunch !== undefined) applyAutoLaunch(patch.ui.autoLaunch);
      // turning the bridge on/off, or changing its port or TLS mode, rebinds it.
      // Not awaited: a phone toggle must never delay the settings round-trip,
      // and a port collision surfaces as state().error rather than a throw.
      if (patch.companion) void companion.apply();
      // backend/cloud change => rebuild the ASR worker with the new engine.
      // language alone can hot-update without a restart.
      if (
        patch.asr &&
        (patch.asr.backend !== undefined ||
          patch.asr.cloud !== undefined ||
          patch.asr.realtime !== undefined ||
          patch.asr.localRealtime !== undefined)
      ) {
        // While the wizard is up the engine must NOT be rebuilt per key save:
        // on a first run nothing is configured yet (a restart would spawn the
        // local python sidecar the user never agreed to), and in a re-run it
        // would bounce the live engine once per card. The wizard writes its
        // plan as one final patch; the restart happens exactly once after it.
        if (setupWin || !settings.data.onboarding.completed) pendingAsrRestart = true;
        else void asr.stop().then(() => startAsr());
      } else if (patch.asr?.language) {
        asr.setLanguage(patch.asr.language);
      }
      // ⑦ a desktop-side change to one of the four `st` fields is a phone-side
      // change too — the panel recolours without being told by the click
      companion.publishState();
      return publicSettings();
    });
    // ---- first-run wizard state (settings v2) ----
    let wizardReadyLogged = false;
    ipcMain.handle(IPC.onboardingGet, (e) => {
      // one-shot boot marker: the wizard's own renderer reached main, which
      // proves setup.html loaded, its module graph ran and the setup preload
      // bridge is live. tools/packaged-smoke.mjs asserts it.
      if (!wizardReadyLogged && setupWin && e.sender === setupWin.webContents) {
        wizardReadyLogged = true;
        console.log(SETUP_READY_MARKER);
      }
      return settings.getOnboarding();
    });
    ipcMain.handle(IPC.onboardingSaveProgress, (_e, patch: OnboardingProgressPatch = {}) =>
      settings.saveOnboardingProgress(patch ?? {}),
    );
    ipcMain.handle(IPC.onboardingComplete, (_e, payload: OnboardingCompletePayload = {}) => {
      const state = settings.completeOnboarding(payload ?? {});
      // create the main window BEFORE closing the wizard: closing the last
      // window first would fire window-all-closed and quit the app mid-handover
      if (!win) {
        // startMainApp() already builds the engine from the finished settings
        startMainApp();
      } else if (pendingAsrRestart) {
        // re-run: the main window kept running, so apply the deferred rebuild
        void asr.stop().then(() => startAsr());
      }
      pendingAsrRestart = false;
      setupWin?.close();
      return state;
    });
    // main window -> "重新运行配置向导" / the upgrade notice
    ipcMain.handle(IPC.onboardingRerun, () => {
      openSetupWindow(true);
      return true;
    });

    // ---- app shell services (wizard + main window) ----
    // The renderer never navigates: window.open is denied and will-navigate is
    // prevented, so documentation links come back here to be validated.
    ipcMain.handle(IPC.externalOpen, (_e, url: unknown) => openExternalUrl(url));
    // read on an explicit paste-button click only — never polled
    ipcMain.handle(IPC.clipboardReadText, () => clipboard.readText());
    ipcMain.handle(
      IPC.appGetInfo,
      (): AppInfo => ({
        version: app.getVersion(),
        platform: process.platform,
        packaged: app.isPackaged,
      }),
    );

    // ---- provider connection tests (Phase 3) ----
    // Runs ONLY on an explicit user action from the wizard or Settings. The
    // candidate key lives in a local const for the duration of one call: it is
    // never persisted here, never logged, and never travels back to the
    // renderer inside the result.
    ipcMain.handle(
      IPC.providerTest,
      async (_e, incoming: ProviderTestRequest): Promise<ProviderTestResult> => {
        const req = incoming ?? ({} as ProviderTestRequest);
        const apiKey = resolveTestApiKey(req, (slot) => settings.getApiKeyForSlot(slot));
        // the plaintext candidate stops here: everything downstream sees a
        // request without it, and the key only as a separate argument
        const request = withoutCandidateKey(req);
        const result = await runProviderTest(
          { ...request, language: request.language ?? settings.data.asr.language },
          apiKey,
        );
        // one dedicated write; applyPatch() would restart the ASR engine
        if (request.slot) {
          settings.recordVerification(request.slot, {
            lastTestAt: new Date().toISOString(),
            lastTestOk: result.ok,
            lastTestCode: result.code,
            latencyMs: result.latencyMs,
          });
        }
        if (!result.ok) {
          recordDiagnosticError(
            `provider-test/${request.capability}`,
            `${result.code} (${request.providerId} ${request.model})`,
          );
        }
        console.log(
          `[provider-test] ${request.capability} ${request.providerId} -> ${result.code} (${result.latencyMs ?? '?'}ms)`,
        );
        return result;
      },
    );

    // ---- local diagnostics (Phase 3) ----
    // Purely local: built on request, returned to the renderer for the user to
    // copy. Nothing is uploaded, nothing is written to disk, and the builder
    // never receives a key, a transcript or any knowledge-base text.
    const pythonProbe = new LocalPythonProbe(() =>
      resolvePython(pythonCandidates(getResourceRoot())),
    );

    ipcMain.handle(IPC.diagnosticsGet, (): string => {
      pythonProbe.start(); // background; 'unknown' until it settles
      const ready = asr.lastReady?.kind === 'ready' ? asr.lastReady : null;
      const status = asr.lastStatus?.kind === 'status' ? asr.lastStatus : null;
      return buildDiagnosticsReport({
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        uiLang: osLang,
        settings: settings.data,
        weakCrypto: settings.getPublic().weakCrypto,
        knowledgeChars: knowledge.chars,
        capture: {
          active: capturing,
          lastStartedAt: lastCaptureStartedAt,
          lastStoppedAt: lastCaptureStoppedAt,
        },
        asr: {
          ready: !!ready,
          ep: ready?.ep,
          gpuSuspect: ready?.gpuSuspect,
          state: status?.state,
        },
        localPython: pythonProbe.status,
        errors: recentDiagnosticErrors(),
        generatedAt: new Date(),
      });
    });

    ipcMain.handle(IPC.logsOpenFolder, async (): Promise<boolean> => {
      // userData holds settings.json, sessions.json and knowledge.md -- the
      // exact folder a user needs when asked to check or wipe their data
      const err = await shell.openPath(app.getPath('userData'));
      if (err) console.warn('[diagnostics] could not open the data folder:', err);
      return err === '';
    });

    ipcMain.handle(IPC.knowledgeImport, async () => {
      const r = await dialog.showOpenDialog({
        title: T().kbImportTitle,
        filters: [{ name: T().docFilter, extensions: [...DOC_EXTENSIONS] }],
        properties: ['openFile'],
      });
      if (!r.canceled && r.filePaths[0]) {
        const file = r.filePaths[0];
        await importGlobalKnowledge(file, {
          set: (text) => knowledge.setFromText(text),
          ingest: (text) =>
            rag.ingest({ text, source: 'knowledge', ref: basename(file), replace: true }),
          parse: extractDocText,
          log: (msg) => console.log(msg),
        });
      }
      return { chars: knowledge.chars };
    });
    ipcMain.handle(IPC.knowledgeClear, () => {
      knowledge.clear();
      const dropped = rag.clearSource('knowledge');
      if (dropped) console.log(`[rag] knowledge clear: dropped ${dropped} chunks`);
      return { chars: knowledge.chars };
    });

    // ---- document library (multi-file knowledge base) ----
    // Import many files / a whole directory into the L3 semantic-recall index
    // (source 'doc', one ref per file) so answers recall them by relevance
    // instead of stuffing everything into the always-in-context prompt.
    // The walk / ref / ingest rules live in electron/rag/library.ts, where they
    // are unit-tested; this is the wiring to the real parser and index.
    const library = createLibraryImporter({
      manifest: knowledgeFiles,
      extract: extractDocText,
      ingest: (req) => rag.ingest(req),
      stat: (path) => {
        try {
          const s = statSync(path);
          return { mtimeMs: s.mtimeMs, size: s.size };
        } catch {
          return null;
        }
      },
      now: () => new Date(),
      summarize: ({ ref, text, name }) => rag.summarizeDocument(ref, text, name),
      log: (m) => console.log(m),
      onProgress: (p) => {
        if (win && !win.isDestroyed()) win.webContents.send(IPC.knowledgeImportProgress, p);
      },
    });

    ipcMain.handle(IPC.knowledgeImportFiles, async (): Promise<KnowledgeImportResult> => {
      const r = await dialog.showOpenDialog({
        title: T().kbImportFilesTitle,
        filters: [{ name: T().docFilter, extensions: [...LIBRARY_EXTENSIONS] }],
        properties: ['openFile', 'multiSelections'],
      });
      if (r.canceled || !r.filePaths.length) {
        return emptyImportResult();
      }
      const out = await library.ingestFiles(r.filePaths);
      // one write for the whole batch: ingest only queued a save per chunk
      rag.flushPersist();
      return out;
    });

    ipcMain.handle(IPC.knowledgeImportDir, async (): Promise<KnowledgeImportResult> => {
      const r = await dialog.showOpenDialog({
        title: T().kbImportDirTitle,
        properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) {
        return emptyImportResult();
      }
      const files: string[] = [];
      library.walk(r.filePaths[0], files);
      if (!files.length) {
        return emptyImportResult();
      }
      const out = await library.ingestFiles(files, r.filePaths[0]);
      rag.flushPersist();
      return out;
    });

    ipcMain.handle(IPC.knowledgeFilesList, (): KnowledgeFilesState => knowledgeFiles.state());

    ipcMain.handle(IPC.knowledgeRemoveFile, (_e, ref: string): KnowledgeFilesState => {
      knowledgeFiles.remove(ref);
      const dropped = rag.removeDocument(ref);
      if (dropped) console.log(`[knowledge-files] removed "${ref}": dropped ${dropped} chunks`);
      return knowledgeFiles.state();
    });

    ipcMain.handle(IPC.knowledgeFilesClear, (): KnowledgeFilesState => {
      knowledgeFiles.clear();
      const dropped = rag.clearSource('doc');
      if (dropped) console.log(`[knowledge-files] cleared library: dropped ${dropped} chunks`);
      return knowledgeFiles.state();
    });
    ipcMain.handle(IPC.knowledgePick, async (_e, slot: 'resume' | 'jd' = 'resume', sessionId?: string) => {
      const r = await dialog.showOpenDialog({
        title: slot === 'jd' ? T().pickJdTitle : T().pickResumeTitle,
        filters: [{ name: T().docFilter, extensions: [...DOC_EXTENSIONS] }],
        properties: ['openFile'],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      try {
        // deterministic parse (mammoth / pdf-parse) — no LLM in the loop;
        // '' for scanned PDFs, the renderer warns the user
        const text = await extractDocText(r.filePaths[0]);
        // upgrade P0: session material also lands in the vector index
        void rag.ingestSessionMaterial(slot, sessionId, basename(r.filePaths[0]), text);
        return { name: basename(r.filePaths[0]), text, chars: text.length };
      } catch (e) {
        console.error('[knowledge] pick failed:', (e as Error).message);
        return null;
      }
    });
    // removing a session's resume/JD must also drop its indexed chunks and the
    // prepared Q&A parsed from them, or a replaced document keeps answering
    ipcMain.handle(IPC.knowledgeDropSlot, (_e, p: { slot: 'resume' | 'jd'; sessionId?: string }) => {
      const slot = p?.slot === 'jd' ? 'jd' : 'resume';
      const dropped = rag.dropSessionSlot(slot, p?.sessionId);
      if (dropped) console.log(`[rag] ${slot} cleared: dropped ${dropped} chunks`);
      return { dropped };
    });
    ipcMain.handle(IPC.sessionsLoad, () => sessionStore.load());
    ipcMain.on(IPC.sessionsSave, (_e, data) => {
      // the renderer owns the session lifecycle; keep the shot pipeline's
      // fallback session pointer fresh (it fires from a hotkey, no payload)
      const cid = (data as { currentId?: unknown })?.currentId;
      if (typeof cid === 'string' && cid) lastKnownSessionId = cid;
      // ⑦ the phone's `st.session` and `hx` snapshot are read from here, so the
      // bridge never has to touch sessions.json while a command is in flight
      ctlSessions = data as SessionsFile;
      sessionStore.save(data);
      companion.publishState();
    });
    // ⑦ `continuous` lives in the renderer; main only learns it second-hand
    ipcMain.on(IPC.companionContinuous, (_e, on: unknown) => {
      ctlContinuous = !!on;
      companion.publishState();
    });
    // the renderer owns the JSON file, so a delete has to also reach the vector
    // index: otherwise the session's resume/JD/facts keep answering questions
    ipcMain.handle(IPC.sessionDelete, (_e, sessionId: string) => {
      const id = String(sessionId ?? '');
      if (!id) return { dropped: 0 };
      const dropped = rag.dropSession(id);
      if (dropped) console.log(`[rag] session deleted: dropped ${dropped} chunks`);
      return { dropped };
    });

    // ---- upgrade P0: RAG knowledge layers + L2 notes IPC ----
    ipcMain.handle(IPC.ragStatus, () => rag.status());
    ipcMain.handle(IPC.ragSearch, async (_e, p: { query: string; sessionId?: string }) => {
      const r = await rag.searchForUi(String(p?.query ?? ''), p?.sessionId);
      return { hits: r.hits, ms: r.ms };
    });
    ipcMain.handle(IPC.ragReindex, async (_e, p: { model?: string } = {}) => {
      if (p?.model) settings.applyPatch({ rag: { model: p.model } });
      const r = await rag.reindex();
      console.log(`[rag] reindex finished: ${r.records} records, failed=${r.failed}`);
      return rag.status();
    });
    /**
     * Bind a pre-chunked knowledge base. The dialog returns a folder; loading is
     * attempted immediately so the UI can report "569 块 / 69 篇" or the reason
     * it failed, rather than the user finding out mid-interview that nothing was
     * ever read. A cancel returns null and leaves the binding untouched.
     */
    ipcMain.handle(IPC.ragBindKb, async (): Promise<ReturnType<typeof rag.status> | null> => {
      const r = await dialog.showOpenDialog({
        title: T().kbBindTitle,
        properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      const dir = r.filePaths[0];
      const res = rag.bindKb(dir);
      if (res.ok) {
        settings.applyPatch({ rag: { kbIndex: dir } });
        console.log(`[rag] KB bound: ${dir} (${res.chunks} chunks / ${res.docs} docs / ${res.aliases} aliases)`);
      } else {
        console.warn(`[rag] KB bind failed: ${res.error}`);
      }
      // the status carries res.error through kb.error, so the panel can show
      // the failure next to the path instead of reverting silently
      const st = rag.status();
      return res.ok ? st : { ...st, kb: { ...st.kb, configured: dir, loaded: false, error: res.error } };
    });
    ipcMain.handle(IPC.ragUnbindKb, () => {
      rag.unbindKb();
      settings.applyPatch({ rag: { kbIndex: '' } });
      console.log('[rag] KB unbound');
      return rag.status();
    });
    // the pairs a direct hit can serve — read from the live index, no embedding
    ipcMain.handle(IPC.ragQaList, (_e, p: { sessionId?: string } = {}) =>
      rag.listQa(p?.sessionId),
    );
    ipcMain.handle(IPC.notesGet, () => ({
      text: rag.notes.text,
      chars: rag.notes.chars,
      maxChars: 8000,
    }));
    ipcMain.handle(IPC.notesSet, (_e, p: { text: string }) => {
      const res = rag.notes.setNotes(String(p?.text ?? ''));
      // notes ride the stable prefix → prewarm the new prefix promptly
      if (res.ok) lastPrefix = null;
      // their 问:/答: blocks are prepared answers: keep the direct-hit records
      // in step with the text (replace-semantics on ref 'notes')
      if (res.ok) void rag.ingestNotes(rag.notes.text);
      return res;
    });
    ipcMain.handle(IPC.skillsList, () =>
      skills.list().map((s) => ({ name: s.name, trigger: s.trigger, description: s.description })),
    );

    // ---- 做题模式 (exam mode): screen → bank → answer ----
    // Staged so the cheapest trustworthy source answers first: a bank hit is
    // final for objective questions (no model, ~ms), the model only ever adds
    // explanation or handles what the bank does not have, and the web is the
    // last resort. Nothing here reads the interview session or the RAG index.
    const examControllers = new Map<string, AbortController>();

    /**
     * The session the renderer last asked about (llmAsk / speculative
     * prefetch). The whole-screen shot hotkey is main-initiated and carries no
     * session, so the exam pipeline borrows this id to give the shot the same
     * RAG material the spoken questions get.
     */
    let lastKnownSessionId = '';

    const examSend = (ev: ExamEvent): void => {
      if (examWin && !examWin.isDestroyed()) examWin.webContents.send(IPC.examEvent, ev);
      // The phones are a second audience for the same event, not a second
      // pipeline: the exam window may be closed, hidden or stealth and the
      // companion still gets everything.
      companion.publishExam(ev);
    };

    const examStatusView = (): ExamStatusView => ({
      scanning: examBanks.status.scanning,
      current: examBanks.status.current,
      banks: examBanks.reports().map((r) => ({
        subMode: r.subMode,
        dir: r.dir,
        entries: r.entries,
        mc: r.mc,
        unanswered: r.unanswered,
        files: r.files,
        scanned: r.parsed,
        ms: r.ms,
        skipped: r.skipped,
        duplicates: r.duplicates,
        conflicts: r.conflicts,
      })),
      table: examBanks.statusTable(),
    });

    const bankView = (entry: BankEntry, subMode: ExamSubMode, score: number): ExamBankCandidateView => ({
      subMode,
      stem: entry.stem,
      options: entry.options,
      answer: entry.answer,
      answerKey: entry.answerKey,
      explanation: entry.explanation,
      ref: entry.ref,
      section: entry.tags[0],
      score,
    });

    /**
     * Can the screen be read at all? Two independent paths exist (local OCR,
     * vision model) and neither is guaranteed to be set up, so say which is
     * missing instead of reporting 「no question found」 when the real problem is
     * that nothing can read the capture.
     */
    const examScreenReadable = (): { why?: string } => {
      const ocrWanted = settings.data.vision.ocrPrefilter && settings.data.exam?.preferOcr !== false;
      if (ocrWanted && isOcrConfigured()) return {};
      if (settings.getVisionConfig()) return {};
      const l = settings.data.llm;
      // Name the actual gap. Vision now inherits the text provider, so the
      // common cause is not "no vision key" but "the text provider has no
      // vision preset in the catalog" — a different fix, and the user should
      // not go looking for a field that is already filled.
      return {
        why: !l.baseUrl || !settings.getLlmApiKey()
          ? T().noModelAny
          : T().noModelVision(l.baseUrl),
      };
    };

    /** the vision model reads the capture; local OCR is tried first when set up */
    const readScreen = async (
      imageDataUrl: string,
      ac: AbortController,
      wholeScreen = false,
    ): Promise<{ text: string; via: 'ocr' | 'vision'; ambiguous?: string } | null> => {
      if (!wholeScreen && settings.data.vision.ocrPrefilter && settings.data.exam?.preferOcr !== false) {
        // OCR of a whole desktop reads every window on it, so it is only used
        // for the cropped region where "all the text here" really is the stem.
        const ocr = await ocrDataUrl(imageDataUrl);
        if (ocr.ok && decideRoute(ocr.text) === 'text') return { text: ocr.text, via: 'ocr' };
      }
      const vision = settings.getVisionConfig();
      if (!vision) return null;
      const text = await visionChat(
        { baseUrl: vision.baseUrl, model: vision.model, apiKey: vision.apiKey, proxyUrl: vision.proxyUrl },
        withScreenImage(buildTranscribeMessages(wholeScreen), imageDataUrl),
        ac.signal,
      );
      let clean = text.trim();
      if (!clean || /NO_QUESTION/.test(clean)) return null;
      // The reader was told to flag a second plausible question instead of
      // silently merging or guessing. Surfacing it is the difference between a
      // wrong answer with confidence and a wrong answer the user can catch.
      const am = clean.match(/^AMBIGUOUS:\s*(.+)$/m);
      const ambiguous = am?.[1]?.trim();
      if (am) clean = clean.replace(am[0], '').trim();
      return { text: clean, via: 'vision', ...(ambiguous ? { ambiguous } : {}) };
    };

    /**
     * The whole 做题 answer pipeline: screen → read → bank → (RAG material) →
     * model → web. Named (rather than inline in the IPC handler) because the
     * companion bridge drives the exact same pipeline headlessly — a phone-only
     * press of the ask hotkey must produce the identical answer, and a copy of
     * this body would be a second set of gates to drift. Every result leaves
     * through `send`, which fans out to the exam window, the phones, and — for
     * main-initiated shot requests (`payload.shot`) — the main window's turn
     * surface. A shot request has no owning window, so it opens with `begin`:
     * without it the exam window's requestId filter silently dropped the lot.
     */
    const runExamAsk = async (payload: ExamAskPayload): Promise<void> => {
      const t0 = Date.now();
      const send = (ev: ExamEvent): void => {
        examSend(ev);
        if (payload.shot && win && !win.isDestroyed()) win.webContents.send(IPC.examEvent, ev);
      };
      if (payload.shot) send({ requestId: payload.requestId, kind: 'begin' });
      const sendErr = (message: string): void =>
        send({ requestId: payload.requestId, kind: 'error', message });
      const ac = new AbortController();
      examControllers.set(payload.requestId, ac);
      const ms: Record<string, number> = {};
      try {
        // 1. the question as text
        let question = (payload.question ?? '').trim();
        let readVia: 'ocr' | 'vision' = 'vision';
        if (!question && payload.imageDataUrl) {
          send({ requestId: payload.requestId, kind: 'stage', stage: 'reading' });
          const canRead = examScreenReadable();
          const read =
            canRead.why === undefined
              ? await readScreen(payload.imageDataUrl, ac, !!payload.wholeScreen)
              : null;
          if (!read) {
            // two different failures, and the user needs to know which one: no
            // OCR/vision configured at all (a setup gap they can fix), versus a
            // capture that genuinely held no question — an empty `done` read as
            // a dead pipeline, so both now surface as an explicit error
            if (canRead.why) sendErr(canRead.why);
            else sendErr(payload.wholeScreen ? T().shotNoQuestionWhole : T().shotNoQuestionRegion);
            return;
          }
          question = read.text;
          readVia = read.via;
          ms.read = Date.now() - t0;
          if (read.ambiguous) {
            send({
              requestId: payload.requestId,
              kind: 'note',
              text: T().shotAmbiguous(read.ambiguous),
            });
          }
        }
        if (!question) {
          sendErr(payload.wholeScreen ? T().shotNoQuestionWhole : T().shotNoQuestionRegion);
          return;
        }
        send({
          requestId: payload.requestId,
          kind: 'question',
          text: question,
          via: payload.question ? 'typed' : readVia,
        });

        // 2. look it up in the bound banks
        send({ requestId: payload.requestId, kind: 'stage', stage: 'searching' });
        const screen = parseSingleQuestion(question);
        const asked = screen.stem || question;
        let subMode: ExamSubMode = payload.subMode;
        let verdict = examBanks.search(subMode, asked);
        if (verdict.mode === 'none') {
          // the user can leave 其他 on; the first bank that answers wins
          const alt = examBanks.searchAll(asked).find((x) => x.verdict.mode !== 'none');
          if (alt) {
            subMode = alt.mode;
            verdict = alt.verdict;
          }
        }
        ms.bank = Date.now() - t0 - (ms.read ?? 0);

        // shared with the audit harness: exact stem + objective entry + a letter
        // that anchors onto the screen + nothing contradicting it, or no free
        // answer at all (the model gets the bank as context instead)
        const wantsExplanation = !!(payload.instruction ?? '').trim() || !!payload.priorAnswer;
        const screenOptions = screen.options.map((o) => o.text);
        const decision = decideBankAnswer(verdict, screenOptions, { wantsExplanation });
        const best = decision.best;
        let bankBlock: string | undefined;
        let hitView: ExamBankCandidateView | undefined;
        let letter: string | undefined = decision.letter;
        if (best) {
          hitView = bankView(best.entry, subMode, best.score);
          bankBlock = formatBankBlock(best, screenOptions);
        }
        // a choice card needs at least two candidates; one is not a choice
        if (
          verdict.mode !== 'none' &&
          best &&
          decision.near.length > 1 &&
          (best.confidence !== 'exact' || decision.disagree)
        ) {
          send({
            requestId: payload.requestId,
            kind: 'ambiguous',
            candidates: decision.near.map((h) => bankView(h.entry, subMode, h.score)),
          });
        }

        // 3. an EXACT bank stem on an objective question IS the answer — say so
        // at once. Anything weaker goes through the model with the bank as
        // authority: a near-miss printed as a certainty would be answered wrong.
        const exactObjective = decision.direct;
        if (hitView && verdict.mode === 'bank' && exactObjective && !wantsExplanation) {
          send({ requestId: payload.requestId, kind: 'bank', hit: hitView, letter });
          ms.total = Date.now() - t0;
          send({
            requestId: payload.requestId,
            kind: 'done',
            text: hitView.answer,
            origin: 'bank',
            ms,
          });
          return;
        }
        if (hitView) send({ requestId: payload.requestId, kind: 'bank', hit: hitView, letter });

        // 4. model answer (bank as authority/hint), web only when the bank was silent
        send({ requestId: payload.requestId, kind: 'stage', stage: 'thinking' });
        const llmKey = settings.getLlmApiKey() ?? '';
        const llmCfg: LlmConfig = {
          baseUrl: settings.data.llm.baseUrl,
          model: settings.data.llm.model,
          apiKey: llmKey,
        };
        if (!llmKey && settings.data.llm.providerId !== 'ollama') {
          ms.total = Date.now() - t0;
          // the bank hit above is still a complete answer for the user
          if (hitView) {
            send({ requestId: payload.requestId, kind: 'done', text: hitView.answer, origin: 'bank', ms });
            return;
          }
          sendErr(T().noApiKey);
          return;
        }
        // local knowledge second: the bank was silent, so try the session's
        // RAG material (the same knowledge base spoken questions get). Only
        // when both local sources came up empty does the web get consulted —
        // and an unconfigured web must not read as a dead pipeline.
        let ragBlock: string | undefined;
        if (!hitView && lastKnownSessionId && rag.status().state === 'ready') {
          try {
            const rr = await rag.retrieve(asked, lastKnownSessionId);
            const topQa = rr.qa[0];
            if (topQa) ragBlock = `【知识库问答】${topQa.question}\n${topQa.answer}`;
            else if (rr.hits.length)
              ragBlock = rr.hits.map((h) => `[${h.source}${h.ref ? '|' + h.ref : ''}] ${h.text}`).join('\n');
          } catch {
            // a failed retrieval is just "local said nothing"; the model still answers
          }
          if (ragBlock) console.log(`[shot] rag context ${ragBlock.length} chars (session ${lastKnownSessionId})`);
        }
        let webLines: string[] | undefined;
        let origin: ExamOrigin = hitView ? 'bank+model' : ragBlock ? 'model+rag' : 'model';
        const ws = settings.data.webSearch;
        const webApiKey = settings.getWebSearchApiKey();
        const webDec = decideShotWeb({
          bankHit: !!hitView,
          ragHit: !!ragBlock,
          webFallback: !!settings.data.exam?.webFallback,
          webConfigured: !!(ws?.enabled && webApiKey),
        });
        if (webDec.run) {
          send({ requestId: payload.requestId, kind: 'stage', stage: 'searching-web' });
          const w = await webSearch({
            provider: ws!.providerId ?? DEFAULT_SEARCH_PROVIDER,
            apiKey: webApiKey!,
            query: asked.slice(0, 120),
            maxResults: ws!.maxResults,
            timeoutMs: ws!.timeoutMs,
          });
          ms.web = w.ms;
          if (w.hits.length) {
            webLines = formatWebLines(w.hits);
            origin = 'model+web';
          }
        } else if (webDec.hint) {
          send({
            requestId: payload.requestId,
            kind: 'note',
            text: T().shotWebMiss,
          });
        }
        const persona = settings.data.exam?.persona ?? defaultPersona();
        const messages = buildExamAskMessages({
          subMode,
          question,
          instruction: payload.instruction,
          bankBlock,
          ragBlock,
          personaBlock: subMode === 'personality' ? buildPersonaBlock(persona, {}) : undefined,
          priorAnswer: payload.priorAnswer,
          webLines,
        });
        const tAnswer = Date.now();
        // Stream the model's tokens instead of swallowing them: the exam window
        // already renders `delta` (it was built for this), the phone needs it
        // even more, and `done` below stays authoritative — its text replaces
        // whatever was streamed, so a missed or duplicated delta cannot corrupt
        // the answer that gets persisted.
        const r = await chatStream(llmCfg, messages, { onDelta: (t) => send({ requestId: payload.requestId, kind: 'delta', text: t }) }, ac.signal);
        ms.model = Date.now() - tAnswer;
        ms.total = Date.now() - t0;
        const text = r.text.trim();
        if (!text && hitView) {
          send({ requestId: payload.requestId, kind: 'done', text: hitView.answer, origin: 'bank', ms });
          return;
        }
        send({ requestId: payload.requestId, kind: 'done', text, origin, ms });
        console.log(
          `[exam] ${subMode} ${origin} in ${ms.total}ms` +
            ` (read=${ms.read ?? 0} bank=${ms.bank ?? 0} model=${ms.model ?? 0})`,
        );
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        sendErr((e as Error).message);
      } finally {
        examControllers.delete(payload.requestId);
      }
    };
    ipcMain.on(IPC.examAsk, (_e, payload: ExamAskPayload) => void runExamAsk(payload));

    ipcMain.on(IPC.examCancel, (_e, requestId: string) => {
      examControllers.get(String(requestId))?.abort();
      examControllers.delete(String(requestId));
    });

    // ---- LAN companion (手机显示) ----
    screenShotAsk = async (): Promise<{ ok: boolean; ms: number; seq: number }> => {
      const t0 = Date.now();
      const cap = await companion.captureAndPush();
      if (!cap.ok) {
        // Desktop Duplication produces no frames while the session is locked or
        // an RDP client is disconnected — say so rather than silently nothing.
        console.warn('[shot] 截图为空（桌面可能已锁定或会话已断开）');
        const requestId = `c${Date.now().toString(36)}`;
        const mirror = (ev: ExamEvent): void => {
          examSend(ev);
          if (win && !win.isDestroyed()) win.webContents.send(IPC.examEvent, ev);
        };
        mirror({ requestId, kind: 'begin' });
        mirror({ requestId, kind: 'error', message: T().shotCaptureEmpty });
        return { ok: false, ms: Date.now() - t0, seq: 0 };
      }
      const c = settings.data.companion;
      // dual-screen on → the paired device is the display; nothing pops here
      if (shouldRaiseLocalExamWindow(c)) openExamWindow();
      void runExamAsk({
        requestId: `c${Date.now().toString(36)}`,
        subMode: settings.getPublic().exam.subMode,
        imageDataUrl: cap.imageDataUrl,
        // nothing was cropped, so the reader has to locate the question first
        wholeScreen: true,
        // no window owns this request — announce with begin, mirror to the main window
        shot: true,
      });
      console.log(`[shot] 整屏 seq=${cap.seq} 抓屏=${cap.ms}ms → 已送题库/模型`);
      return { ok: true, ms: cap.ms, seq: cap.seq };
    };

    /**
     * ⑦ The session a phone is looking at is the renderer's current one. Cached
     * from `IPC.sessionsSave` rather than re-read: `st` fires on every state
     * change, and the file is written by this same path.
     */
    function ctlCurrentSession(): StoredSession | null {
      const file = ctlSessions;
      if (!file?.currentId) return null;
      return file.sessions.find((s) => s.id === file.currentId) ?? null;
    }

    /**
     * Apply one command the bridge has already authorized, validated and
     * budgeted. Two style ladders are main's own business (settings + a cold
     * prompt prefix); the rest belong to the renderer, which is the only place
     * that can start a capture, flip 连续回答, or ask a question with the live
     * transcript and material attached.
     */
    function runCompanionControl(cmd: ControlCommand): void {
      // `server.ts` ran parseControlArg before this, so the value's shape is
      // already pinned by the op
      const value = cmd.value;
      if (cmd.op === 'richness' || cmd.op === 'expertise') {
        settings.applyPatch(
          cmd.op === 'richness'
            ? { llm: { answerRichness: value as AnswerRichness } }
            : { llm: { answerExpertise: value as AnswerExpertise } },
        );
        markPromptPrefixCold('companion');
        console.log(`[companion-ctl] ${cmd.op}=${String(value)} applied`);
        return;
      }
      if (!win || win.isDestroyed()) {
        console.log(`[companion-ctl] ${cmd.op} dropped: no main window`);
        return;
      }
      if (cmd.op === 'capture') win.webContents.send(IPC.companionCtlCapture, value as boolean);
      if (cmd.op === 'continuous') win.webContents.send(IPC.companionCtlContinuous, value as boolean);
      if (cmd.op === 'ask') win.webContents.send(IPC.companionCtlAsk, value as string);
      console.log(`[companion-ctl] ${cmd.op}=${String(value)} sent to renderer`);
    }

    companion.attachControl({
      state: () => {
        const s = ctlCurrentSession();
        return {
          capturing,
          continuous: ctlContinuous,
          richness: settings.data.llm.answerRichness ?? DEFAULT_RICHNESS,
          expertise: settings.data.llm.answerExpertise ?? DEFAULT_EXPERTISE,
          session: s ? { id: s.id, name: s.name, answers: s.turns.length } : null,
        };
      },
      turns: (): StoredTurn[] => ctlCurrentSession()?.turns ?? [],
      run: runCompanionControl,
    });

    ipcMain.handle(IPC.companionState, () => companion.state());
    ipcMain.handle(IPC.companionApply, async (): Promise<CompanionState> => {
      await companion.apply();
      return companion.state();
    });
    ipcMain.handle(IPC.companionPair, async (): Promise<CompanionState> => {
      companion.startPairing();
      return companion.state();
    });
    ipcMain.handle(IPC.companionRevoke, async (_e, name: string): Promise<CompanionState> => {
      companion.revoke(String(name ?? ''));
      return companion.state();
    });
    ipcMain.handle(IPC.companionQr, () => companion.qrSvg());
    ipcMain.handle(IPC.companionShot, () => screenShotAsk?.() ?? Promise.resolve({ ok: false, ms: 0, seq: 0 }));
    /**
     * Narrow write channel for the connect window: it may only touch the
     * companion section. Handing it settings:set would let that window rewrite
     * API keys and restart the ASR engine.
     */
    ipcMain.handle(IPC.companionPatch, async (_e, patch: SettingsPatch['companion']) => {
      const was = !!settings.data.companion?.enabled;
      if (patch && typeof patch === 'object') settings.applyPatch({ companion: patch });
      await companion.apply();
      if (patch?.enabled !== undefined) syncConnectWindow(was, !!patch.enabled);
      return companion.state();
    });
    /**
     * Entering 双屏 raises the QR window; leaving it takes the window down with
     * the mode. Declared as a hoisted function because the settings handler
     * above is registered earlier in this scope than this block.
     */
    function syncConnectWindow(was: boolean, next: boolean): void {
      if (was === next) return;
      if (next) {
        const { win: w } = showConnectWindow(connectWin);
        connectWin = w;
      } else if (connectWin && !connectWin.isDestroyed()) {
        connectWin.hide();
      }
    }

    ipcMain.handle(IPC.connectOpen, async () => {
      const { win: w } = showConnectWindow(connectWin);
      connectWin = w;
      return companion.state();
    });
    ipcMain.on(IPC.connectClose, () => {
      if (connectWin && !connectWin.isDestroyed()) connectWin.hide();
    });
    // Bind the port only once the main app exists: before that there is nothing
    // worth showing, and a bridge listening during the wizard would hold a port
    // the user has not agreed to yet.
    void companion.apply();

    ipcMain.handle(IPC.examOpen, () => {
      openExamWindow();
      return true;
    });
    ipcMain.on(IPC.examClose, () => {
      if (examWin && !examWin.isDestroyed()) examWin.hide();
    });
    ipcMain.handle(IPC.examSetMode, (_e, subMode: ExamSubMode) => {
      if (!['aptitude', 'technical', 'personality', 'open'].includes(String(subMode))) return false;
      settings.applyPatch({ exam: { subMode } });
      return true;
    });
    ipcMain.handle(IPC.examStatus, () => examStatusView());
    ipcMain.handle(IPC.examBind, async (_e, p: { subMode: ExamSubMode }) => {
      const mode = (p?.subMode ?? 'aptitude') as ExamSubMode;
      const r = await dialog.showOpenDialog({ title: T().examBindTitle, properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      settings.applyPatch({ exam: { banks: { [mode]: r.filePaths[0] } as Partial<Record<ExamSubMode, string>> } });
      void examBanks.bind(mode, r.filePaths[0], (prog) => {
        if (examWin && !examWin.isDestroyed()) examWin.webContents.send(IPC.examProgress, prog);
      });
      return { dir: r.filePaths[0] };
    });
    ipcMain.handle(IPC.examRescan, async (_e, p: { subMode?: ExamSubMode }) => {
      const binds = (settings.data.exam?.banks ?? {}) as Partial<Record<ExamSubMode, string>>;
      if (p?.subMode) await examBanks.bind(p.subMode, binds[p.subMode]);
      else await examBanks.bindAll(binds);
      return examStatusView();
    });
    ipcMain.handle(IPC.examBankSearch, (_e, p: { subMode: ExamSubMode; question: string }) => {
      const mode = (p?.subMode ?? 'aptitude') as ExamSubMode;
      const v = examBanks.search(mode, String(p?.question ?? ''));
      const all = [v.best, ...v.others].filter(Boolean);
      return all.map((h) => ({ ...bankView(h!.entry, mode, h!.score), confidence: h!.confidence }));
    });
    ipcMain.handle(IPC.examPersonaSet, (_e, p: { persona: unknown }) => {
      const persona = p?.persona === null ? null : parsePersona(p?.persona);
      settings.applyPatch({ exam: { persona: persona === null ? (null as never) : persona ?? undefined } });
      return settings.getPublic();
    });
    ipcMain.handle(IPC.examPersonaResearch, async (_e, p: { role?: string; company?: string }) => {
      const role = String(p?.role ?? '').trim();
      const ws = settings.data.webSearch;
      const apiKey = settings.getWebSearchApiKey();
      const llmKey = settings.getLlmApiKey() ?? '';
      const llmCfg: LlmConfig = {
        baseUrl: settings.data.llm.baseUrl,
        model: settings.data.llm.model,
        apiKey: llmKey,
      };
      if (!llmKey && settings.data.llm.providerId !== 'ollama') {
        console.warn('[exam-persona] no LLM key');
        return null;
      }
      let webLines: string[] = [];
      if (ws?.enabled && apiKey) {
        const q = [role, p?.company, '性格测评 考察 特质 要求'].filter(Boolean).join(' ');
        const w = await webSearch({
          provider: ws.providerId ?? DEFAULT_SEARCH_PROVIDER,
          apiKey,
          query: q,
          maxResults: ws.maxResults,
        });
        webLines = formatWebLines(w.hits);
      }
      try {
        const r = await chatOnce(
          llmCfg,
          buildPersonaResearchMessages(role, p?.company, webLines),
          { maxTokens: 700, temperature: 0.2 },
        );
        const json = r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1);
        const persona = parsePersona(JSON.parse(json));
        if (!persona) return null;
        settings.applyPatch({ exam: { persona: { ...persona, role: role || persona.role } } });
        console.log(`[exam-persona] ${persona.targets.length} dims for ${role || '(none)'}`);
        return { ...persona, role: role || persona.role };
      } catch (e) {
        console.warn('[exam-persona] research failed:', (e as Error).message);
        return null;
      }
    });

    // ---- question gate (面试模式持续答) ----
    // Free heuristics decide the obvious cases; only a genuinely ambiguous line
    // costs one tiny classification call, and a slow provider can never block an
    // answer: the fallback is to answer, which is the pre-existing behaviour.
    ipcMain.handle(IPC.llmGate, async (_e, p: { requestId: string; line: string; recent?: string[] }) => {
      const line = String(p?.line ?? '').trim();
      const t0 = Date.now();
      const requestId = String(p?.requestId ?? '');
      const h = heuristic(line);
      if (h.verdict) {
        const cached = gateMemory.get(line.slice(0, 120));
        if (cached && cached !== 'pending') return { requestId, verdict: cached, via: 'heuristic', ms: 0 } as LlmGateResult;
        gateMemory.set(line.slice(0, 120), h.verdict);
        return { requestId, verdict: h.verdict, via: 'heuristic', ms: Date.now() - t0 } as LlmGateResult;
      }
      const apiKey = settings.getLlmApiKey();
      if (!apiKey && settings.data.llm.providerId !== 'ollama')
        return { requestId, verdict: 'answer', via: 'heuristic', ms: 0 } as LlmGateResult;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), GATE_TIMEOUT_MS);
      try {
        const r = await chatOnce(
          {
            baseUrl: settings.data.llm.baseUrl,
            model: settings.data.llm.model,
            apiKey: apiKey ?? '',
          },
          gateMessages(line, (p?.recent ?? []).slice(-6)),
          { maxTokens: 6, temperature: 0, signal: ac.signal },
        );
        const verdict = parseVerdict(r.text) ?? 'answer';
        gateMemory.set(line.slice(0, 120), verdict);
        const out: LlmGateResult = { requestId, verdict, via: 'model', ms: Date.now() - t0 };
        if (out.ms > GATE_TIMEOUT_MS) console.warn(`[gate] slow classifier ${out.ms}ms`);
        return out;
      } catch (e) {
        return { requestId, verdict: 'answer', via: 'heuristic', ms: Date.now() - t0 } as LlmGateResult;
      } finally {
        clearTimeout(timer);
      }
    });

    // ---- speculative retrieval (pipeline-latency ②) ----
    // The renderer only reports partials while continuous mode is ON, so this
    // side never needs to know about the mode. SPECULATIVE_RETRIEVAL is the
    // one-line kill switch: the whole benefit rests on "the final sentence
    // equals a spoken partial", which is engine behaviour — the hit counter
    // below is what decides whether this stays on.
    const SPECULATIVE_RETRIEVAL = true;
    const SPEC_DEBOUNCE_MS = 300;
    const SPEC_REUSE_WAIT_MS = 400;
    const specCache = new SpeculativeCache<RetrieveResult | null>();
    let specTimer: NodeJS.Timeout | undefined;
    let specHits = 0;
    let specMisses = 0;
    ipcMain.on(IPC.llmSpeculate, (_e, p: { text?: string; sessionId?: string }) => {
      if (!SPECULATIVE_RETRIEVAL) return;
      const text = String(p?.text ?? '').trim();
      if (!text) return;
      if (p?.sessionId) lastKnownSessionId = String(p.sessionId);
      if (specTimer) clearTimeout(specTimer);
      specTimer = setTimeout(() => {
        // speculation never spawns the worker or waits for a download
        if (rag.status().state !== 'ready') return;
        if (text.length < MIN_QUERY_CHARS) return;
        specCache.set(
          specKey(p?.sessionId, text),
          rag.retrieve(text, p?.sessionId).catch(() => null),
        );
      }, SPEC_DEBOUNCE_MS);
    });

    // ---- upgrade P1.5: optional native loopback capture ----
    ipcMain.on(IPC.nativeCaptureStart, (_e, deviceId?: string) => {
      if (process.platform !== 'win32') {
        win?.webContents.send(IPC.nativeCaptureError, 'native loopback is Windows-only');
        return;
      }
      nativeAudio
        .start('loopback', deviceId)
        .then(() => console.log('[native-audio] loopback capture started'))
        .catch((e: Error) => {
          console.warn('[native-audio] start failed:', e.message);
          win?.webContents.send(IPC.nativeCaptureError, e.message);
        });
    });
    ipcMain.on(IPC.nativeCaptureStop, () => {
      nativeAudio.stop();
    });

    // ---- region screenshot: capture full screen, let the user drag a region
    // on a STEALTH overlay that shows the capture as its (opaque) background —
    // avoids the transparent-window black-screen bug and is excluded from
    // recording via content protection. Returns the cropped image dataURL. ----
    let regionResolve: ((r: { x: number; y: number; width: number; height: number } | null) => void) | null = null;
    let pendingRegionImage: string | null = null;
    let regionWin: BrowserWindow | null = null;

    ipcMain.handle(IPC.regionImage, () => pendingRegionImage);
    ipcMain.on(IPC.regionRect, (_e, r) => {
      const f = regionResolve;
      regionResolve = null;
      regionWin?.close();
      f?.(r);
    });
    ipcMain.on(IPC.regionCancel, () => {
      const f = regionResolve;
      regionResolve = null;
      regionWin?.close();
      f?.(null);
    });

    ipcMain.handle(IPC.regionPick, async () => {
      const disp = screen.getPrimaryDisplay();
      const sf = disp.scaleFactor;
      const w = Math.round(disp.size.width * sf);
      const h = Math.round(disp.size.height * sf);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
      const src = sources.find((s) => s.display_id === String(disp.id)) ?? sources[0];
      if (!src) return null;
      const full = src.thumbnail;
      pendingRegionImage = full.toDataURL();

      const rect = await new Promise<{ x: number; y: number; width: number; height: number } | null>((resolve) => {
        regionResolve = resolve;
        const b = disp.bounds;
        const ov = new BrowserWindow({
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          frame: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          hasShadow: false,
          resizable: false,
          movable: false,
          fullscreenable: false,
          enableLargerThanScreen: true,
          webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true },
        });
        regionWin = ov;
        ov.setContentProtection(true); // selection overlay invisible to recording
        ov.setAlwaysOnTop(true, 'screen-saver');
        ov.on('closed', () => {
          if (regionResolve) {
            const f = regionResolve;
            regionResolve = null;
            f(null);
          }
          regionWin = null;
        });
        void ov.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(regionOverlayHtml(T().regionTip)));
      });

      const img = pendingRegionImage;
      pendingRegionImage = null;
      if (!rect || rect.width < 4 || rect.height < 4 || !img) return null;
      try {
        const cropped = full.crop({
          x: Math.round(rect.x * sf),
          y: Math.round(rect.y * sf),
          width: Math.round(rect.width * sf),
          height: Math.round(rect.height * sf),
        });
        return cropped.toDataURL();
      } catch (e) {
        console.error('[region] crop failed:', (e as Error).message);
        return null;
      }
    });
    ipcMain.handle(IPC.stealthSet, (_e, on: boolean) => {
      settings.applyPatch({ ui: { stealth: on } });
      applyStealth();
      return on;
    });
    ipcMain.on(IPC.winHide, () => win?.hide());
    ipcMain.on(IPC.appQuit, () => app.quit());

    // ---- LLM (R4): streaming answers; key stays in the main process ----
    // upgrade P1: per-kind routing + failover; the book remembers providers
    // that just failed so the next request reorders them to the back.
    const llmControllers = new Map<string, AbortController>();
    const llmFailures = new FailureBook();

    const resolvePrimaryEndpoint = (): Endpoint => ({
      baseUrl: settings.data.llm.baseUrl,
      model: settings.data.llm.model,
      apiKey: settings.getLlmApiKey() ?? '',
      label: 'primary',
      thinking: findPresetByEndpoint(settings.data.llm.baseUrl, settings.data.llm.model, 'text-llm')
        ?.thinking,
      thinkingLevel: settings.data.llm.thinking,
    });

    ipcMain.on(IPC.llmAsk, (_e, payload: LlmAskPayload) => {
      // a throw before the `work` chain is built must not become an unhandled
      // rejection: the renderer would wait for a done event that never comes
      void runAsk(payload).catch((e: Error) => {
        console.error('[llm] ask handler failed:', e.message);
        llmControllers.delete(payload.requestId);
        publishLlm({ requestId: payload.requestId, kind: 'error', message: e.message });
      });
    });
    const runAsk = async (payload: LlmAskPayload): Promise<void> => {
      if (payload.sessionId) lastKnownSessionId = payload.sessionId;
      const sendEv = (ev: LlmEvent): void => publishLlm(ev);
      const primary = resolvePrimaryEndpoint();
      // keyless primary is only valid for providers that need no key (Ollama)
      if (!primary.apiKey && settings.data.llm.providerId !== 'ollama') {
        sendEv({ requestId: payload.requestId, kind: 'error', message: T().noApiKey });
        return;
      }
      const ac = new AbortController();
      // pipeline-latency ④: the whole ask is timed against this; ttft is the
      // number the user actually feels (question received → first token out)
      const askT0 = Date.now();
      llmControllers.set(payload.requestId, ac);
      const isTranslate = payload.mode === 'translate';
      // session dual-slot material first; the global default KB only fills in
      // when the session has nothing (translate stays a clean pass-through)
      const hasMaterial = !!(payload.resume || payload.jd || payload.background);

      // "answer with multimodal": route through the vision provider (proxy-aware,
      // non-streaming). Otherwise stream from the text LLM (direct, fastest).
      // Resolved once and reused below, so the guard and the request can never
      // disagree about which vision endpoint was in effect.
      const visionCfg =
        settings.data.llm.answerWithVision && payload.mode !== 'translate'
          ? settings.getVisionConfig()
          : undefined;
      const useVision = !!visionCfg;

      // upgrade P3: /trigger skills steer free-ask behaviour — resolved before
      // retrieval so the knowledge base sees the real question, not the trigger
      let skillInstruction: string | undefined;
      let freeQuestion = payload.freeQuestion;
      if (payload.mode === 'free' && freeQuestion) {
        const skill = skills.match(freeQuestion);
        if (skill) {
          skillInstruction = skill.instruction;
          freeQuestion = skills.stripTrigger(freeQuestion, skill) ?? '';
          console.log(`[skills] matched ${skill.trigger} (${skill.name})`);
        }
      }

      // ---- knowledge-first answer routing ----
      // 1. prepared Q&A direct hit  → the answer is shown verbatim at once and
      //    the model only enriches it (no network, tens of ms)
      // 2. semantic recall hits     → normal RAG context
      // 3. nothing relevant         → BYOK web search (when configured), then
      //    the model answers from the retrieved pages
      // Served ONLY by an already-ready worker: a question must never block on
      // a model download. Free-ask goes through the same routing — that is
      // where a typed prepared question is most likely to hit.
      let ragContext: string[] | undefined;
      /** recalled blocks with unsettled figures — forces both out loud, never a pick */
      let ragConflicts: string[] = [];
      let factsHint: string | undefined;
      let qaHit: { question: string; answer: string } | undefined;
      /** ③ 先答后补: started unawaited during routing, consumed after done */
      let webPromise: Promise<WebSearchOutcome> | undefined;
      let webQuestion = '';
      let retrieveMs: number | undefined;
      let ttftMs: number | undefined;
      if (!isTranslate) {
        const q =
          payload.mode === 'free'
            ? freeQuestion ?? ''
            : payload.question || payload.recentTranscript?.at(-1) || '';
        // speculative reuse: exact text only, and an in-flight guess that has
        // not landed within the wait budget loses to a real retrieve
        let r: RetrieveResult;
        const specP = SPECULATIVE_RETRIEVAL ? specCache.get(specKey(payload.sessionId, q)) : undefined;
        const raced = specP ? await Promise.race([specP, after(SPEC_REUSE_WAIT_MS)]) : null;
        if (raced) {
          r = raced;
          specHits++;
          console.log(
            `[spec] hit ${specHits}/${specHits + specMisses}` + (VERBOSE_LOGS ? `: "${q.slice(0, 40)}"` : ''),
          );
        } else {
          if (specP) specMisses++;
          r = await rag.retrieve(q, payload.sessionId);
        }
        retrieveMs = r.ms;
        // read before the branch chain below: a prepared-answer direct hit skips
        // the `hits` branch, and a settled-figure warning must not be lost just
        // because the answer came from a Q&A pair
        ragConflicts = r.conflicts;
        // upgrade P3: recalled claimed facts keep long sessions self-consistent
        if (r.facts.length) factsHint = formatFactsHint(r.facts.map((f) => f.text));
        const top = r.qa[0];
        if (top) {
          qaHit = { question: top.question, answer: top.answer };
          sendEv({
            requestId: payload.requestId,
            kind: 'qa',
            hit: {
              question: top.question,
              answer: top.answer,
              ref: top.ref,
              score: top.score,
              exact: top.exact,
            },
          });
          console.log(
            `[rag] prepared answer hit (${top.exact ? 'literal' : 'semantic'} ${top.score}) in ${r.ms}ms`,
          );
        } else if (r.hits.length) {
          ragContext = r.hits.map(
            (h: RagHitView) => `[${h.source}${h.ref ? '|' + h.ref : ''}] ${h.text}`,
          );
        } else if (q.length >= MIN_QUERY_CHARS) {
          // a real question the knowledge base has nothing on — the web.
          // ③ 先答后补: NEVER awaited here; the answer starts on the model's
          // own knowledge and whatever the search returns is appended after
          // the stream completes. Too-short utterances still never leave.
          const ws = settings.data.webSearch;
          const apiKey = settings.getWebSearchApiKey();
          if (ws?.enabled && apiKey && !isTranslate) {
            webPromise = webSearch({
              provider: ws.providerId ?? DEFAULT_SEARCH_PROVIDER,
              apiKey,
              query: q,
              maxResults: ws.maxResults,
              timeoutMs: ws.timeoutMs,
            });
            webQuestion = q;
            sendEv({ requestId: payload.requestId, kind: 'web-pending' });
          }
        }
        if (ragContext || factsHint || qaHit || webPromise) {
          console.log(`[rag] retrieve ${r.ms}ms: qa=${r.qa.length} hits=${r.hits.length}`);
        }
      }

      const messages = buildAnswerMessages({
        mode: payload.mode,
        question: payload.question,
        freeQuestion,
        recentTranscript: payload.recentTranscript,
        answerLang: payload.answerLang ?? settings.data.llm.answerLang,
        history: payload.history,
        resume: isTranslate ? undefined : payload.resume,
        jd: isTranslate ? undefined : payload.jd,
        memo: isTranslate ? undefined : payload.memo,
        notes: isTranslate ? undefined : rag.notes.text,
        promptLayers: isTranslate ? undefined : promptLayers(),
        ragContext: isTranslate ? undefined : ragContext,
        ragConflicts: isTranslate ? undefined : ragConflicts,
        qaHit: isTranslate ? undefined : qaHit,
        consistencyHint: isTranslate ? undefined : factsHint,
        skillInstruction,
        background: isTranslate ? undefined : payload.background || (hasMaterial ? undefined : knowledge.text),
      });

      const primaryCtx = {
        endpoint: primary,
        providerId: settings.data.llm.providerId,
      };
      const resolve = (presetId: string) =>
        resolveEndpointForPreset(presetId, {
          primary: primaryCtx,
          routeKeys: settings.getRouteKeys(),
          thinkingByPreset: settings.data.llm.thinkingByPreset,
        });
      const kind = classifyQuestion(payload.question || payload.recentTranscript?.at(-1) || '');
      const plan = llmFailures.reorder(
        planBackends({ mode: payload.mode, kind, routing: settings.data.llm.routing, primary: primaryCtx, resolve }),
      );

      // a real answer request refreshes the provider-side prefix cache itself —
      // but only when the primary endpoint is the one actually serving, since
      // the cache is per provider/model pair
      if (!isTranslate && !useVision && payload.mode !== 'free' && plan[0] === primary) {
        lastPrefix = stablePrefixFor(payload.resume || payload.background, payload.jd);
        lastPrefixActivity = Date.now();
      }

      // ③ the supplement call: small, non-streaming (so the NO_SUPPLEMENT
      // sentinel can be filtered out before it ever reaches the screen), and
      // it always closes the web-pending hint with web-done — success,
      // silence, failure or cancel alike. The main answer stands on its own:
      // a failed supplement stays silent.
      const runSupplement = async (p: Promise<WebSearchOutcome>, mainText: string): Promise<void> => {
        try {
          const w = await p;
          if (ac.signal.aborted) return;
          if (!w.hits.length) {
            console.warn(`[websearch] no hits (${w.error ?? 'empty'}) ${w.ms}ms`);
            return;
          }
          console.log(`[websearch] supplement: ${w.hits.length} hits ${w.ms}ms`);
          sendEv({ requestId: payload.requestId, kind: 'web', sources: webSources(w.hits) });
          const s = await chatOnce(
            {
              baseUrl: settings.data.llm.baseUrl,
              model: settings.data.llm.model,
              apiKey: primary.apiKey ?? '',
            },
            supplementMessages(webQuestion, mainText, formatWebLines(w.hits)),
            { maxTokens: 400, temperature: 0.3, signal: ac.signal },
          );
          const text = s.text.trim();
          if (text && !isNoSupplement(text)) {
            sendEv({ requestId: payload.requestId, kind: 'web-sup', text });
          }
        } catch (e) {
          console.warn('[websearch] supplement failed:', (e as Error).message);
        } finally {
          sendEv({ requestId: payload.requestId, kind: 'web-done' });
        }
      };

      const work: Promise<{
        text: string;
        usage?: ChatResult['usage'];
        endpoint?: Endpoint;
      }> = useVision
        ? visionChat(
            {
              baseUrl: visionCfg!.baseUrl,
              model: visionCfg!.model,
              apiKey: visionCfg!.apiKey,
              proxyUrl: visionCfg!.proxyUrl,
            },
            messages,
            ac.signal,
          ).then((text) => {
            sendEv({ requestId: payload.requestId, kind: 'delta', text });
            return { text };
          })
        : streamWithFallback({
            endpoints: plan,
            messages,
            onDelta: (text) => {
              if (ttftMs === undefined) ttftMs = Date.now() - askT0;
              sendEv({ requestId: payload.requestId, kind: 'delta', text });
            },
            onReasoning: (text) => sendEv({ requestId: payload.requestId, kind: 'reasoning', text }),
            signal: ac.signal,
            // a black-holed routed endpoint must not hang a live answer; only
            // the primary alone is trusted to take as long as it needs
            firstTokenTimeoutMs: plan.length > 1 ? 8000 : 0,
            onAttemptError: (ep, err, hadDelta) => {
              console.warn(
                `[llm] endpoint failed (${ep.label}, deltas=${hadDelta}): ${err.message}`,
              );
              llmFailures.markFailure(ep);
              if (!hadDelta && plan.length > 1) {
                const next = plan[plan.indexOf(ep) + 1];
                if (next) console.log(`[llm] falling back to ${next.label}`);
              }
            },
          });

      work
        .then((r) => {
          if (r.endpoint) llmFailures.markSuccess(r.endpoint);
          const u = r.usage;
          if (u) {
            // prewarm acceptance signal: after a warm, hit ≈ prefix length
            console.log(
              `[llm] done mode=${payload.mode} cache_hit=${u.prompt_cache_hit_tokens ?? '?'} cache_miss=${u.prompt_cache_miss_tokens ?? '?'}`,
            );
          }
          console.log(`[timings] mode=${payload.mode} retrieve=${retrieveMs ?? '-'}ms ttft=${ttftMs ?? '-'}ms`);
          sendEv({
            requestId: payload.requestId,
            kind: 'done',
            text: r.text,
            usage: u
              ? {
                  promptTokens: u.prompt_tokens,
                  completionTokens: u.completion_tokens,
                  promptCacheHit: u.prompt_cache_hit_tokens,
                  promptCacheMiss: u.prompt_cache_miss_tokens,
                }
              : undefined,
            timings: { retrieveMs, ttftMs },
          });
          if (webPromise) void runSupplement(webPromise, r.text).catch(() => undefined);
        })
        .catch((e: Error) => {
          if (webPromise) sendEv({ requestId: payload.requestId, kind: 'web-done' });
          if (ac.signal.aborted) return; // user cancelled — not an error
          console.error('[llm] request failed:', e.message);
          sendEv({ requestId: payload.requestId, kind: 'error', message: e.message });
        })
        .finally(() => llmControllers.delete(payload.requestId));
    };
    ipcMain.on(IPC.llmCancel, (_e, requestId: string) => {
      llmControllers.get(requestId)?.abort();
      llmControllers.delete(requestId);
    });

    // P1-5: fold a finished Q&A into the rolling interview memo. Async and
    // off the critical answer path — renderer serializes calls per session.
    ipcMain.handle(
      IPC.memoUpdate,
      async (
        _e,
        p: { memo: string; question: string; answer: string; sessionId?: string },
      ): Promise<string> => {
        const apiKey = settings.getLlmApiKey();
        if (!apiKey) return '';
        try {
          const r = await chatOnce(
            { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
            buildMemoUpdateMessages(p.memo ?? '', p.question ?? '', p.answer ?? ''),
            { maxTokens: 700, temperature: 0.2 },
          );
          const memo = clampMemo(r.text);
          // upgrade P3: refresh this session's claimed-fact vectors (off-path)
          if (p.sessionId && memo) {
            void rag
              .ingestFacts(p.sessionId, extractMemoFacts(memo))
              .then((res) => res && console.log(`[rag] facts ingest: ${res.added}/${res.total}`));
          }
          return memo;
        } catch (e) {
          console.warn('[memo] update failed:', (e as Error).message);
          return '';
        }
      },
    );

    // Cheap one-shot translation to Chinese (inline transcript 对照; off-session,
    // no history pollution). Uses the fast text model (deepseek-flash).
    ipcMain.handle(IPC.translateText, async (_e, text: string) => {
      const apiKey = settings.getLlmApiKey();
      if (!apiKey) throw new Error(T().noApiKeyShort);
      const r = await chatStream(
        { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
        buildTranslateMessages(text),
        { onDelta: () => {} },
      );
      return r.text;
    });

    // ---- R5: screenshot -> vision model. Our own window is excluded from
    // the capture automatically (content protection). ----
    ipcMain.on(
      IPC.shotAsk,
      (_e, payload: { requestId: string; question: string; background?: string; imageDataUrl?: string }) => {
      const sendEv = (ev: LlmEvent): void => publishLlm(ev);
      const vision = settings.getVisionConfig();
      if (!vision) {
        sendEv({
          requestId: payload.requestId,
          kind: 'error',
          message: T().noVision,
        });
        return;
      }
      const ac = new AbortController();
      llmControllers.set(payload.requestId, ac);
      // region mode provides a pre-cropped image; else capture the full screen
      const imgP = payload.imageDataUrl
        ? Promise.resolve(payload.imageDataUrl)
        : desktopCapturer
            .getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 900 } })
            .then((sources) => sources[0].thumbnail.toDataURL());
      imgP
        .then(async (dataUrl) => {
          // upgrade P2: OCR prefilter — text-rich REGION shots skip the vision
          // model entirely (fast text LLM, streamable). Optional + best-effort.
          const textKey = settings.getLlmApiKey();
          if (payload.imageDataUrl && settings.data.vision.ocrPrefilter && textKey) {
            const ocr = await ocrDataUrl(payload.imageDataUrl);
            if (ocr.ok && decideRoute(ocr.text) === 'text') {
              console.log(`[ocr] text-rich region (${ocr.text.length} chars in ${ocr.ms}ms) → text LLM`);
              const r = await chatStream(
                { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey: textKey },
                buildOcrAnswerMessages(ocr.text, payload.question, payload.background || knowledge.text),
                { onDelta: (text) => sendEv({ requestId: payload.requestId, kind: 'delta', text }) },
                ac.signal,
              );
              return r.text;
            }
          }
          return visionChat(
            { baseUrl: vision.baseUrl, model: vision.model, apiKey: vision.apiKey, proxyUrl: vision.proxyUrl },
            buildVisionMessages(payload.question, dataUrl, payload.background || knowledge.text),
            ac.signal,
          );
        })
        .then((text) => {
          sendEv({ requestId: payload.requestId, kind: 'delta', text });
          sendEv({ requestId: payload.requestId, kind: 'done', text });
        })
        .catch((e: Error) => {
          if (ac.signal.aborted) return;
          console.error('[vision] request failed:', e.message);
          sendEv({ requestId: payload.requestId, kind: 'error', message: e.message });
        })
        .finally(() => llmControllers.delete(payload.requestId));
    });

    // ---- ASR: warm the worker at launch (PLAN §6.3) ----
    asr.onEvent((ev: AsrEvent) => {
      if (ev.kind === 'segment') {
        const e2e = ev.timings.inferEndTs - ev.timings.speechEndTs;
        console.log(
          `[asr] #${ev.id} (${ev.lang ?? '?'}, ${ev.audioMs}ms audio, e2e ${e2e}ms)` +
            (VERBOSE_LOGS ? ` ${ev.text}` : ''),
        );
      } else if (ev.kind === 'ready') {
        console.log(`[asr] ready ep=${ev.ep} load=${ev.loadMs}ms warm=${ev.warmMs}ms gpuSuspect=${ev.gpuSuspect}`);
        if (process.env.MC_E2E_QUIT_ON_ASR_READY === '1') {
          setTimeout(() => app.quit(), 250);
        }
      } else if (ev.kind === 'error') {
        console.error(`[asr] error (fatal=${ev.fatal}): ${ev.message}`);
        // only fatal events belong in the support report — a transient
        // per-segment failure would flood the 50-entry buffer
        if (ev.fatal) recordDiagnosticError('asr', ev.message);
        if (ev.fatal) {
          // engine diagnostics are deliberately English (they end up in logs
          // and in the diagnostics report); the sentence AROUND them is the
          // part the user reads, so it gets localized here
          publishAsr({ ...ev, message: T().asrEngineFail(ev.message) });
          return;
        }
      } else if (ev.kind === 'status') {
        console.log(`[asr] status=${ev.state} queued=${ev.queuedSegments}`);
      }
      publishAsr(ev);
    });

    // First run (or MC_FORCE_ONBOARDING=1 for testing): the wizard owns the
    // whole startup — no overlay window, no ASR worker, no sidecar spawn.
    if (process.env.MC_FORCE_ONBOARDING === '1' || !settings.data.onboarding.completed) {
      openSetupWindow();
    } else {
      startMainApp();
    }
  });

  app.on('second-instance', () => {
    const target = setupWin ?? win;
    if (target?.isMinimized()) target.restore();
    target?.show();
    target?.focus();
  });

  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    tray.destroy();
    void asr.stop();
    void sidecar.stop();
    nativeAudio.stop();
    void companion.dispose();
    destroyConnectWindow(connectWin);
    connectWin = null;
    // the exam window hides instead of closing on ✕; without this explicit
    // destroy its close() handler would veto app.quit() forever
    if (examWin && !examWin.isDestroyed()) destroyExamWindow(examWin);
    examWin = null;
    void rag?.dispose(); // flush the pending index write, stop the embed worker
  });

  /**
   * Still a quit, tray or not: hiding the overlay does NOT close it, so this
   * only fires on a real teardown (app.quit() destroying the windows, or the
   * first-run wizard being closed before completion). A "close to tray" app
   * would return here instead — MeetingAssistant deliberately has no window
   * close button that leaves the app running headless without a window.
   */
  app.on('window-all-closed', () => {
    app.quit();
  });
}
